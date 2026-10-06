/**
 * hub_degree_shape and extraction_date_grounding doctor checks.
 *
 * Protects: the degree-shape check reports the inbound-link percentiles and
 * how many pages the resolved half degree dampens by more than half, never a
 * recommended value; the date-grounding check names the setting and its
 * consumers; both stay informational (ok) and categorized.
 * Seams: none; in-memory PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractionDateGroundingEntry, hubDegreeShapeEntry } from '../src/commands/doctor/checks/ranking-extraction.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const ctx = () => ({ engine, args: [], progress: { heartbeat() {} } }) as unknown as DoctorContext;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('companies/hub-example', { type: 'company', title: 'Hub', compiled_truth: 'hub' });
  const links = [];
  for (let i = 0; i < 12; i++) {
    await engine.putPage(`meetings/m-${i}`, { type: 'meeting', title: `M${i}`, compiled_truth: 'sync' });
    links.push({ from_slug: `meetings/m-${i}`, to_slug: 'companies/hub-example', link_type: 'mentions_company' });
  }
  await engine.addLinksBatch(links);
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); });

describe('hub_degree_shape', () => {
  test('off: reports the shape and that dampening is off', async () => {
    const [check] = (await hubDegreeShapeEntry.run(ctx())) as Check[];
    expect(check.status).toBe('ok');
    expect(check.message).toContain('max 12');
    expect(check.message).toContain('hub dampening is off');
    expect(categorizeCheck('hub_degree_shape')).toBe(categorizeCheck('graph_coverage'));
  });

  test('on: counts pages above the half degree, recommends nothing', async () => {
    await engine.setConfig('search.hub_dampening', '5');
    const [check] = (await hubDegreeShapeEntry.run(ctx())) as Check[];
    expect(check.message).toContain('half degree 5: 1 page(s)');
    expect(check.message).not.toMatch(/set .*hub_dampening/);
    await engine.setConfig('search.hub_dampening', 'off');
  });
});

describe('extraction_date_grounding', () => {
  test('fact extraction is grounded by default; the other prompts only when set on; false turns it off', async () => {
    const [byDefault] = (await extractionDateGroundingEntry.run(ctx())) as Check[];
    expect(byDefault.message).toContain('fact extraction, dream synthesis, extract_atoms and propose_takes (the default)');
    expect(byDefault.message).toContain('life chronicle events keep their current prompt unless extraction.date_grounding is set to true');
    await engine.setConfig('extraction.date_grounding', 'true');
    const [on] = (await extractionDateGroundingEntry.run(ctx())) as Check[];
    expect(on.message).toContain('and in life chronicle events (set on explicitly)');
    await engine.setConfig('extraction.date_grounding', 'false');
    const [off] = (await extractionDateGroundingEntry.run(ctx())) as Check[];
    expect(off.message).toContain('is off');
    expect(categorizeCheck('extraction_date_grounding')).toBe(categorizeCheck('graph_coverage'));
  });
});
