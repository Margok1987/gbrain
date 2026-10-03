/**
 * v0.42.x — Life Chronicle (#2390) backfill op (Phase A.8).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const mkCtx = (): OperationContext => ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);
const LONG = 'B'.repeat(120);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'chronicle_extract'`);
  await engine.executeRaw(`DELETE FROM pages WHERE type IN ('meeting','diary')`);
});

describe('chronicle_backfill op', () => {
  test('dry-run counts eligible meetings without enqueuing', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await engine.putPage('life/diary/d1', { type: 'diary', title: 'd1', compiled_truth: LONG }); // excluded
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), { dry_run: true }) as { eligible: number; enqueued: number };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(0);
  });

  test('enqueues one chronicle_extract per eligible meeting', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { eligible: number; enqueued: number; errors: unknown[] };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(2);
  });

  test('unscoped backfill enqueues each page under its own source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('meetings/default-src', { type: 'meeting', title: 'default', compiled_truth: LONG });
    await engine.putPage('meetings/other-src', { type: 'meeting', title: 'other', compiled_truth: LONG }, { sourceId: 'other-src' });
    const ctx = { engine, remote: false } as unknown as OperationContext;

    const r = await operationsByName.chronicle_backfill.handler(ctx, {}) as { eligible: number; enqueued: number; errors: unknown[] };

    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: { slug: string; sourceId: string } }>(
      `SELECT data FROM minion_jobs WHERE name='chronicle_extract' ORDER BY data->>'slug'`
    );
    expect(jobs.map((j) => j.data)).toEqual([
      { slug: 'meetings/default-src', sourceId: 'default' },
      { slug: 'meetings/other-src', sourceId: 'other-src' },
    ]);
  });

  // #5329: repeat runs used to enqueue the same head pages forever.
  test('#5329: repeat runs with a small limit progress through every page, then enqueue nothing', async () => {
    for (const n of [1, 2, 3]) await engine.putPage(`meetings/m${n}`, { type: 'meeting', title: `m${n}`, compiled_truth: LONG });
    type R = { enqueued: number; already_enqueued: number };
    const run = async () => await operationsByName.chronicle_backfill.handler(mkCtx(), { limit: 1 }) as R;
    for (let i = 0; i < 3; i++) expect((await run()).enqueued).toBe(1);
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE name = 'chronicle_extract'`);
    const again = await run();
    expect(again.enqueued).toBe(0);
    expect(again.already_enqueued).toBe(3);
    const slugs = await engine.executeRaw<{ slug: string }>(`SELECT data->>'slug' AS slug FROM minion_jobs WHERE name = 'chronicle_extract' ORDER BY 1`);
    expect(slugs.map(r => r.slug)).toEqual(['meetings/m1', 'meetings/m2', 'meetings/m3']);
  });

  test('#5329: an edited page is swept again; a dead job does not block a retry', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await operationsByName.chronicle_backfill.handler(mkCtx(), {});
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG + ' edited' });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead' WHERE name = 'chronicle_extract' AND data->>'slug' = 'meetings/m2'`);
    const dry = await operationsByName.chronicle_backfill.handler(mkCtx(), { dry_run: true }) as { eligible: number; already_enqueued: number };
    expect(dry.already_enqueued).toBe(0);
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { enqueued: number; already_enqueued: number };
    expect(r.enqueued).toBe(2);
    expect(r.already_enqueued).toBe(0);
  });
});
