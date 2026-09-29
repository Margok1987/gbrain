/**
 * #4694: the title/slug-mentioned-in-query boost (#5676) only fired for
 * entity/event intent, and both of the reporter's shapes ("Which board
 * document is the <title> that we signed last spring?", "Which document is
 * <title>?") classify as general. Under intents without an exact-match
 * boost, a MULTI-token title or slug tail mentioned in the query now gets a
 * bounded boost; one-token titles stay excluded there (too generic).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  applyTitleMentionBoost,
  TITLE_MENTION_BOOST,
  weightsForIntent,
} from '../../src/core/search/intent-weights.ts';
import { classifyQuery } from '../../src/core/search/query-intent.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

const row = (slug: string, title: string, score = 1): SearchResult => ({
  slug, title, page_id: 1, type: 'note', chunk_text: title, chunk_source: 'compiled_truth',
  chunk_id: 1, chunk_index: 0, score, stale: false, source_id: 'default',
} as SearchResult);

describe('applyTitleMentionBoost', () => {
  test("the reporter's query shapes classify as general", () => {
    expect(classifyQuery('Which board document is the Harbor Street Lease Amendment that we signed last spring?').intent).toBe('general');
    expect(classifyQuery('Which document is Harbor Street Lease Amendment?').intent).toBe('general');
    expect(weightsForIntent('general').exactMatchBoost).toBe(1.0);
  });

  test('a multi-token title mentioned in a general question is boosted', () => {
    const results = [row('notes/harbor-lease', 'Harbor Street Lease Amendment'), row('notes/other', 'Parking Permit Renewal')];
    applyTitleMentionBoost(results, 'Which board document is the Harbor Street Lease Amendment that we signed last spring?');
    expect(results[0].score).toBe(TITLE_MENTION_BOOST);
    expect(results[0].exact_match_boost).toBe(TITLE_MENTION_BOOST);
    expect(results[1].score).toBe(1);
  });

  test('the slug tail counts when the title does not', () => {
    const results = [row('notes/harbor-street-lease', 'HSL-2')];
    applyTitleMentionBoost(results, 'where is the harbor street lease draft');
    expect(results[0].score).toBe(TITLE_MENTION_BOOST);
  });

  test('one-token titles and partial mentions are not boosted', () => {
    const results = [row('notes/mingtang', 'Mingtang'), row('notes/harbor-lease', 'Harbor Street Lease Amendment')];
    applyTitleMentionBoost(results, 'what happened at mingtang about the harbor street lease');
    expect(results.map(r => r.score)).toEqual([1, 1]);
  });
});

describe('general-intent question ranks the mentioned title first (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  async function seed(slug: string, title: string, text: string, dim: number) {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: text } as any);
    const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, snap, [{
      chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: basisEmbedding(dim, 1536), token_count: 10,
    }] as any, { seal: true });
  }

  test('"Which document is Harbor Street Lease Amendment?"', async () => {
    await seed('notes/harbor-lease', 'Harbor Street Lease Amendment', 'Signed amendment extending the term and adjusting rent.', 5);
    await seed('notes/lease-summary', 'Lease Summary', 'Summary of every lease the board signed, including the harbor street site.', 6);
    const out = await hybridSearch(engine, 'Which document is Harbor Street Lease Amendment?', {
      // Closer to the summary page (cosine 0.8 vs 0.6): unboosted, the summary wins.
      queryEmbedFn: () => { const v = new Float32Array(1536); v[5] = 0.6; v[6] = 0.8; return v; },
      reranker: { enabled: false, topNIn: 0, topNOut: null } as any,
    });
    expect(out[0].slug).toBe('notes/harbor-lease');
    expect(out[0].exact_match_boost).toBe(TITLE_MENTION_BOOST);
  }, 60_000);
});
