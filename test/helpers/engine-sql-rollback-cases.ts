/**
 * Per-domain write-then-throw rollback cases for the engine-sql executor
 * (refactor wave 1, EO1 / T-G1). Each W1-core domain commit adds its case.
 *
 * A case seeds state outside the transaction THROUGH THE SAME DOMAIN on the
 * root engine (so a long-lived engine's executor has been used before the
 * transaction starts), performs one migrated domain write through the
 * TRANSACTION CLONE (so the write resolves the clone's
 * `engineSql`), and reads the observed value back. The runner asserts:
 *   - inside the transaction the write is visible to the clone,
 *   - on Postgres a concurrent pool read during the transaction does not see it,
 *   - after the body throws, the value equals the seeded value.
 * A regression that caches the executor on the engine (bound to the pool at
 * connect time) makes the write commit outside the transaction and fails.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';

export interface RollbackCase {
  domain: string;
  seed(engine: BrainEngine): Promise<void>;
  write(tx: BrainEngine): Promise<void>;
  observe(engine: BrainEngine): Promise<unknown>;
}

const SLUG = 'notes/engine-sql-rollback-alice-example';

async function seedPage(engine: BrainEngine): Promise<void> {
  await engine.putPage(SLUG, { type: 'note', title: 'Rollback probe', compiled_truth: 'body' });
}

export const ROLLBACK_CASES: RollbackCase[] = [
  {
    domain: 'salience',
    async seed(engine) {
      await seedPage(engine);
      await engine.setEmotionalWeightBatch([{ slug: SLUG, source_id: 'default', weight: 0.25 }]);
    },
    async write(tx) {
      const changed = await tx.setEmotionalWeightBatch([{ slug: SLUG, source_id: 'default', weight: 0.75 }]);
      expect(changed).toBe(1);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ w: number }>(
        `SELECT emotional_weight::float8 AS w FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
      return Number(rows[0]?.w ?? 0);
    },
  },
];

class Rollback extends Error {}

/** Register one test per case and transaction entry point. */
export function defineRollbackCases(opts: {
  getEngine: () => BrainEngine;
  entryPoints: ReadonlyArray<'transaction' | 'transactionDirect'>;
  concurrentPoolRead: boolean;
}): void {
  for (const c of ROLLBACK_CASES) {
    for (const entry of opts.entryPoints) {
      test(`${c.domain}: a write through engine.${entry}() that then throws is rolled back`, async () => {
        const engine = opts.getEngine();
        await c.seed(engine);
        const before = await c.observe(engine);
        const err = await engine[entry](async (tx) => {
          await c.write(tx);
          expect(await c.observe(tx)).not.toEqual(before);
          if (opts.concurrentPoolRead) expect(await c.observe(engine)).toEqual(before);
          throw new Rollback('rollback probe');
        }).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Rollback);
        expect(await c.observe(engine)).toEqual(before);
      }, 15_000);
    }
  }
}
