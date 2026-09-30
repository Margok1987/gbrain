/**
 * v0.32.2 fence backfill on a managed brain.
 *
 * Protects: on a managed brain the backfill publishes each entity page's
 * facts fence through the coordinator and adopts the legacy fact rows in
 * place (managed_maintenance_adopt_fact_fence), for file-backed and
 * database-only pages alike.
 * Fails when: the phase writes fence files into the managed worktree or
 * runs a raw `UPDATE facts` (the managed writer guard refuses it and the
 * orchestrator chain wedges), when adoption inserts duplicate rows instead
 * of keeping the legacy ids and vectors, or when it expires a
 * conversation-extractor row on the same page.
 * Seams: none; `managedBrain` and the migration's exported `__testing` phases.
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __testing } from '../src/commands/migrations/v0_32_2.ts';
import type { OrchestratorOpts } from '../src/commands/migrations/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { maintenancePreflight, submitFactFenceAdoption } from '../src/core/persistence/prepared-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const OPTS: OrchestratorOpts = { yes: true, dryRun: false, noAutopilotInstall: true };

async function factRows(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT id, row_num, source_markdown_slug, fact, expired_at, embedding::text AS embedding, embedded_at::text AS embedded_at,
            source_session, confidence, notability, context FROM facts WHERE id = ANY($1::integer[]) ORDER BY id`, [ids]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: legacy facts are fenced through the coordinator and adopted in place`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const adopted = [...seed.legacyFactIds, ...seed.dbOnlyFactIds];
      const before = await factRows(engine, [...adopted, seed.extractorFactId]);
      const [{ n: factCount }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');

      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
      expect(phase.detail).toContain('scanned=3 fenced=3 pages=2');
      expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=2' });

      const after = await factRows(engine, [...adopted, seed.extractorFactId]);
      expect(after.map(r => [Number(r.id), r.row_num, r.source_markdown_slug, r.expired_at])).toEqual([
        [seed.legacyFactIds[0], 2, LEGACY_FILE_SLUG, null],
        [seed.legacyFactIds[1], 3, LEGACY_FILE_SLUG, null],
        [seed.dbOnlyFactIds[0], 1, LEGACY_DB_ONLY_SLUG, null],
        [seed.extractorFactId, 1, LEGACY_FILE_SLUG, null],
      ]);
      for (let i = 0; i < after.length; i++) {
        for (const key of ['fact', 'embedding', 'embedded_at', 'source_session', 'confidence', 'notability', 'context']) {
          expect(after[i][key]).toEqual(before[i][key]);
        }
      }
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts'))[0].n).toBe(factCount);

      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [2, 'Alice example founded Acme example'], [3, 'Alice example moved to Lisbon']]);
      const dbOnly = (await engine.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(dbOnly.page.compiled_truth).facts.map(f => f.rowNum)).toEqual([1]);
      expect(existsSync(join(root, `${LEGACY_DB_ONLY_SLUG}.md`))).toBe(false);

      const rerun = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(rerun).toMatchObject({ status: 'complete' });
      expect(rerun.detail).toContain('scanned=0 fenced=0 pages=0');
      expect(await factRows(engine, [...adopted, seed.extractorFactId])).toEqual(after);
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: the adoption intent refuses a taken position and a duplicate assignment, changing nothing`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const before = await factRows(engine, [...seed.legacyFactIds, seed.extractorFactId]);
      const content = replaceOrInsertFactsFence(serializePageToMarkdown(snapshot.page, snapshot.tags), renderFactsTable([
        { rowNum: 1, claim: 'Alice example founded Acme example', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'high', active: true }]));
      const attempt = (assignments: Array<{ id: number; row_num: number }>) => submitFactFenceAdoption(engine, authority, LEGACY_FILE_SLUG,
        { content, expectedRevision: snapshot.revision, assignments, file: true });
      await expect(attempt([{ id: seed.legacyFactIds[0], row_num: 1 }])).rejects.toMatchObject({ code: 'revision_conflict' });
      await expect(attempt([{ id: seed.legacyFactIds[1], row_num: 1 }])).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(attempt([{ id: seed.legacyFactIds[0], row_num: 1 }, { id: seed.legacyFactIds[1], row_num: 1 }]))
        .rejects.toMatchObject({ code: 'invalid_params' });
      expect(await factRows(engine, [...seed.legacyFactIds, seed.extractorFactId])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: exhausted request IDs refuse the adoption up front with the capacity command`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const before = await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds]);
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'failed' });
      expect(phase.detail).toStartWith('queue_capacity: Write capacity exhausted: principal permanent request IDs (0 used of 0).');
      expect(phase.detail).toContain('gbrain config set persistence.limits.principal_lifetime_ids ');
      expect(await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE operation='submit_job'")).toEqual([]);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '0');
    } });
  }, 120_000);
}
