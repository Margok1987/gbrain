/**
 * Hub dampening — pure weight, parse contract, backlink + graph-signal sites,
 * and the hybridSearch wire (PGLite, keyless).
 *
 * Pinned contracts:
 *   - hubWeight(1, H) = 1; hubWeight(H + 1, H) = 0.5; `off` / undefined = 1
 *   - normalizeHubDampening is the ONE parse contract (config + per-call)
 *   - applyBacklinkBoost with `off` is byte-identical to the undampened factor
 *   - dampening shrinks only lifts (factor > 1), never demotions
 *   - graph-signal lifts scale by the caller-visible degree map
 *   - hybridSearch threads `hubDampening` and stamps meta.hub_dampening
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { SearchResult, AdjacencyRow, HybridSearchMeta } from '../../src/core/types.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  dampenBoost,
  hubDampeningHashPart,
  hubWeight,
  normalizeHubDampening,
} from '../../src/core/search/hub-dampening.ts';
import { applyBacklinkBoost, hybridSearch } from '../../src/core/search/hybrid.ts';
import { applyGraphSignals, ADJACENCY_BOOST, CROSS_SOURCE_BOOST } from '../../src/core/search/graph-signals.ts';
import { knobsHash, resolveSearchMode, loadOverridesFromConfig } from '../../src/core/search/mode.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';

function row(slug: string, score: number, page_id: number): SearchResult {
  return {
    slug, page_id, title: slug, type: 'note' as const, chunk_text: slug,
    chunk_source: 'compiled_truth', chunk_id: page_id * 1000, chunk_index: 0, score, stale: false, source_id: 'default',
  };
}

describe('hubWeight', () => {
  test('degree <= 1 keeps the full lift; H + 1 halves it; 3H + 1 keeps 10%', () => {
    expect(hubWeight(0, 100)).toBe(1);
    expect(hubWeight(1, 100)).toBe(1);
    expect(hubWeight(101, 100)).toBeCloseTo(0.5, 12);
    expect(hubWeight(301, 100)).toBeCloseTo(0.1, 12);
  });

  test('off, undefined and invalid half degrees mean no dampening', () => {
    expect(hubWeight(10_000, 'off')).toBe(1);
    expect(hubWeight(10_000, undefined)).toBe(1);
    expect(hubWeight(10_000, Number.NaN)).toBe(1);
    expect(hubWeight(10_000, -5)).toBe(1);
  });

  test('non-finite degrees are treated as no links', () => {
    expect(hubWeight(Number.NaN, 10)).toBe(1);
    expect(hubWeight(Number.POSITIVE_INFINITY, 10)).toBe(1);
  });

  test('the c = 0.001 setting corresponds to H ≈ 31.6', () => {
    const H = 1 / Math.sqrt(0.001);
    for (const n of [1, 11, 33, 101, 1001]) {
      expect(hubWeight(n, H)).toBeCloseTo(1 / (1 + 0.001 * (n - 1) ** 2), 12);
    }
  });
});

describe('dampenBoost', () => {
  test('scales the excess over 1.0', () => {
    expect(dampenBoost(1.1, 101, 100)).toBeCloseTo(1.05, 12);
    expect(dampenBoost(1.1, 1, 100)).toBe(1.1);
  });
  test('never touches a demotion or a neutral factor', () => {
    expect(dampenBoost(0.95, 10_000, 10)).toBe(0.95);
    expect(dampenBoost(1, 10_000, 10)).toBe(1);
  });
});

describe('normalizeHubDampening', () => {
  test('accepts off spellings and in-range numbers', () => {
    expect(normalizeHubDampening('off')).toBe('off');
    expect(normalizeHubDampening('OFF')).toBe('off');
    expect(normalizeHubDampening('none')).toBe('off');
    expect(normalizeHubDampening(false)).toBe('off');
    expect(normalizeHubDampening(200)).toBe(200);
    expect(normalizeHubDampening('600')).toBe(600);
  });
  test('rejects everything else as unset', () => {
    for (const v of [0, -1, 0.5, 2_000_000, Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', null, undefined, {}, true]) {
      expect(normalizeHubDampening(v)).toBeUndefined();
    }
  });
  test('hash part is stable', () => {
    expect(hubDampeningHashPart('off')).toBe('off');
    expect(hubDampeningHashPart(200)).toBe('200.000');
  });
});

describe('applyBacklinkBoost with hub dampening', () => {
  test('off is byte-identical to the undampened factor and stamps the count', () => {
    const a = [row('a', 1, 1)];
    const b = [row('a', 1, 1)];
    const counts = new Map([[1, 5000]]);
    applyBacklinkBoost(a, counts);
    applyBacklinkBoost(b, counts, undefined, 'off');
    expect(b[0].score).toBe(a[0].score);
    expect(b[0].backlink_boost).toBe(a[0].backlink_boost);
    expect(b[0].backlink_count).toBe(5000);
    expect(b[0].backlink_hub_weight).toBeUndefined();
  });

  test('a hub loses most of its lift; a low-degree page keeps it', () => {
    const results = [row('hub', 1, 1), row('leaf', 1, 2)];
    const counts = new Map([[1, 20_000], [2, 3]]);
    applyBacklinkBoost(results, counts, undefined, 100);
    const [hub, leaf] = results;
    expect(hub.backlink_hub_weight).toBeLessThan(0.001);
    expect(hub.score).toBeLessThan(1.001);
    expect(leaf.backlink_hub_weight).toBeCloseTo(hubWeight(3, 100), 12);
    expect(leaf.score).toBeCloseTo(1 + 0.05 * Math.log(4) * hubWeight(3, 100), 12);
    expect(leaf.score).toBeGreaterThan(hub.score);
  });
});

describe('applyGraphSignals with hub dampening', () => {
  const ENGINE_STUB = {} as BrainEngine;
  test('adjacency and cross-source lifts scale by the degree weight', async () => {
    const results = [row('people/a', 10, 1), row('companies/hub', 9, 2), row('companies/leaf', 8, 3)];
    const adjacency = new Map<number, AdjacencyRow>([
      [2, { hits: 3, cross_source_hits: 2 }],
      [3, { hits: 3, cross_source_hits: 0 }],
    ]);
    let dampened = -1;
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => adjacency,
      hubHalfDegree: 100,
      degrees: new Map([[2, 101], [3, 1]]),
      onHubDampened: (n) => { dampened = n; },
    });
    const hub = results.find(r => r.slug === 'companies/hub')!;
    const leaf = results.find(r => r.slug === 'companies/leaf')!;
    expect(hub.graph_adjacency_boost).toBeCloseTo(1 + (ADJACENCY_BOOST - 1) * 0.5, 12);
    expect(hub.graph_cross_source_boost).toBeCloseTo(1 + (CROSS_SOURCE_BOOST - 1) * 0.5, 12);
    expect(hub.graph_hub_weight).toBeCloseTo(0.5, 12);
    expect(hub.score).toBeCloseTo(9 * hub.graph_adjacency_boost! * hub.graph_cross_source_boost!, 10);
    expect(leaf.graph_adjacency_boost).toBe(ADJACENCY_BOOST);
    expect(leaf.graph_hub_weight).toBeUndefined();
    expect(dampened).toBe(1);
  });

  test('without a degree map the lifts are undampened', async () => {
    const results = [row('people/a', 10, 1), row('companies/hub', 9, 2)];
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map<number, AdjacencyRow>([[2, { hits: 3, cross_source_hits: 0 }]]),
      hubHalfDegree: 10,
    });
    expect(results[1].graph_adjacency_boost).toBe(ADJACENCY_BOOST);
  });
});

describe('search.hub_dampening knob resolution', () => {
  test('config key parses through the one contract; bundles default off', () => {
    expect(resolveSearchMode({ mode: 'balanced' }).hub_dampening).toBe('off');
    const overrides = loadOverridesFromConfig({ 'search.hub_dampening': '200' });
    expect(overrides.hub_dampening).toBe(200);
    expect(loadOverridesFromConfig({ 'search.hub_dampening': 'garbage' }).hub_dampening).toBeUndefined();
    expect(resolveSearchMode({ mode: 'balanced', overrides }).hub_dampening).toBe(200);
    expect(resolveSearchMode({ mode: 'balanced', overrides, perCall: { hub_dampening: 'off' } }).hub_dampening).toBe('off');
  });

  test('off keeps every existing cache key; a half degree changes it', () => {
    const off = resolveSearchMode({ mode: 'balanced' });
    const on = resolveSearchMode({ mode: 'balanced', perCall: { hub_dampening: 200 } });
    const { hub_dampening: _drop, ...legacy } = off;
    expect(knobsHash(off)).toBe(knobsHash(legacy as typeof off));
    expect(knobsHash(on)).not.toBe(knobsHash(off));
  });
});

describe('hybridSearch wire (PGLite, keyless)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await importFromContent(engine, 'companies/hubco', 'hubco widget platform overview widget', { noEmbed: true });
    await importFromContent(engine, 'concepts/widget-pricing', 'widget pricing notes widget widget', { noEmbed: true });
    const links = [];
    for (let i = 0; i < 40; i++) {
      await importFromContent(engine, `meetings/m-${i}`, `routine sync ${i}`, { noEmbed: true });
      links.push({ from_slug: `meetings/m-${i}`, to_slug: 'companies/hubco', link_type: 'mentions_company' });
    }
    await engine.addLinksBatch(links);
  });
  afterAll(async () => { if (engine) await engine.disconnect(); });

  async function run(hubDampening: 'off' | number) {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearch(engine, 'widget', { limit: 5, hubDampening, onMeta: (m: HybridSearchMeta) => { meta = m; } } as never);
    return { results, meta };
  }

  test('dampening reduces the hub page backlink lift and stamps meta', async () => {
    const off = await run('off');
    const on = await run(10);
    const hubOff = off.results.find(r => r.slug === 'companies/hubco')!;
    const hubOn = on.results.find(r => r.slug === 'companies/hubco')!;
    expect(hubOff.backlink_count).toBe(40);
    expect(hubOn.backlink_hub_weight).toBeCloseTo(hubWeight(40, 10), 12);
    expect(hubOn.backlink_boost!).toBeLessThan(hubOff.backlink_boost!);
    expect(off.meta?.hub_dampening?.half_degree).toBe('off');
    expect(off.meta?.hub_dampening?.backlink_dampened).toBe(0);
    expect(on.meta?.hub_dampening?.half_degree).toBe(10);
    expect(on.meta?.hub_dampening?.backlink_dampened).toBeGreaterThan(0);
  });
});
