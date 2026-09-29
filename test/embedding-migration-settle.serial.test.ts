/**
 * #5680 — the embedding migration authorization reserves each provider request
 * at its maximum input size, settles it to the provider's reported usage, and
 * refuses a cap below the worst case before any vector is dropped.
 *
 * Authoring gate:
 * 1. Protects the durable `--max-cost-usd` contract: debits settle to reported
 *    usage (missing usage keeps the maximum), settles serialize and are
 *    idempotent, overshoot stops dispatch, and the printed worst-case
 *    authorization is both sufficient and enforced before invalidation.
 * 2. Fails when settle is a no-op again (the #5680 stall: projection recovery
 *    drops every vector, then the ceiling-only debits exhaust the cap), when
 *    the settle loses a concurrent update, or when the cap check moves after
 *    the destructive step.
 * 3. Existing recovery tests pin only the pre-dispatch debit and resume
 *    retention; none settles a permit or compares the cap with a worst case.
 * 4. No new seam: the existing embed transport stub reports usage.
 * Serial: the gateway transport and configuration are process-global.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { setupDB, teardownDB } from './e2e/helpers.ts';
import { testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, embed, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { planEmbeddingMigration, readMigrationState, runSchemaTransition } from '../src/core/embedding-migration.ts';
import { readContentChunksEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { authorizeMigrationBudget } from '../src/core/embedding-migration-budget.ts';
import { invokeAI, withAIInvocationGuard, type AIInvocation } from '../src/core/ai/invocation-guard.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';

const model = 'openai:text-embedding-3-small';
const dimensions = 8;
const RATE_PER_MTOK = 1;
const usd = (tokens: number, rate = RATE_PER_MTOK) => tokens * rate / 1_000_000;
const call = (maxInputTokens: number): AIInvocation => ({ kind: 'embedding', operation: 'synthetic', model, maxInputTokens });
const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0 });
const vector = () => Array.from({ length: dimensions }, (_, i) => (i + 1) / 10);

class ExitSignal extends Error { constructor(public code: number) { super(`exit ${code}`); } }

for (const kind of testBackends()) {
  describe(`embedding migration budget settlement (${kind})`, () => {
    let engine: BrainEngine;
    let originalDimensions: number;
    let originalIdentity: Array<{ key: string; value: string }>;
    let transportCalls = 0;
    let reportedTokens = 0;

    const budget = async () => (await readMigrationState(engine)).state!.budget!;
    const plan = () => planEmbeddingMigration(engine, { to: model, dim: dimensions });

    function stubTransport(tokensOf = (value: string) => Math.ceil(value.length / 4)) {
      transportCalls = 0;
      reportedTokens = 0;
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
        transportCalls++;
        const tokens = values.reduce((sum, value) => sum + tokensOf(value), 0);
        reportedTokens += tokens;
        return { values, warnings: [], embeddings: values.map(vector), usage: { tokens } };
      });
    }

    async function seedPages(count: number) {
      for (let i = 0; i < count; i++) {
        const text = `Synthetic settlement page ${i}. ${'Alpha beta gamma delta. '.repeat(40)}`;
        await engine.putPage(`settle-${i}`, { type: 'note', title: `Synthetic ${i}`, compiled_truth: text });
        await installFixtureChunks(engine, `settle-${i}`, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text,
          embedding: new Float32Array(dimensions).fill(0.2) }]);
      }
      await engine.executeRaw('UPDATE pages SET embedding_signature=NULL');
      await engine.executeRaw("UPDATE content_chunks SET model='synthetic:legacy-model'");
    }

    async function cli(args: string[]) {
      const home = mkdtempSync(join(tmpdir(), 'migration-settle-'));
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));
      const out: string[] = [];
      const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
      const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
      let code = -1;
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
          try {
            await runMigrateEmbeddings(engine, ['--to', model, '--dim', String(dimensions), ...(args.includes('--reranker') ? [] : ['--reranker', 'off']), '--yes', ...args],
              { exit: (value: number): never => { throw new ExitSignal(value); } });
          } catch (error) {
            if (!(error instanceof ExitSignal)) throw error;
            code = error.code;
          }
        });
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
      return { code, text: out.join('\n') };
    }

    const vectors = () => engine.executeRaw<{ slug: string; embedding: string | null }>(
      'SELECT p.slug, cc.embedding::text AS embedding FROM content_chunks cc JOIN pages p ON p.id=cc.page_id ORDER BY p.slug');

    beforeAll(async () => {
      if (kind === 'postgres') engine = await setupDB();
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      originalDimensions = (await readContentChunksEmbeddingDim(engine)).dims!;
      originalIdentity = await engine.executeRaw("SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions')");
      await runSchemaTransition(engine, dimensions);
    }, 60_000);
    beforeEach(async () => {
      if (kind === 'pglite') await resetPgliteState(engine as PGLiteEngine);
      else {
        await engine.executeRaw('TRUNCATE facts, pages, fact_withdrawals, page_projection_jobs CASCADE');
        await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%' OR key='pricing.overrides'");
      }
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', String(dimensions));
      await engine.setConfig('pricing.overrides', JSON.stringify({ [model]: RATE_PER_MTOK }));
      resetGateway();
      configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
      stubTransport();
    });
    afterAll(async () => {
      __setEmbedTransportForTests(null); resetGateway();
      await runSchemaTransition(engine, originalDimensions);
      await engine.executeRaw("DELETE FROM config WHERE key IN ('embedding_model','embedding_dimensions','pricing.overrides')");
      for (const row of originalIdentity) await engine.setConfig(row.key, row.value);
      if (kind === 'postgres') await teardownDB(); else await engine.disconnect();
    });

    test('a request reserves its maximum and settles to the reported usage', async () => {
      const debit = await authorizeMigrationBudget(engine, await plan(), 1);
      await withAIInvocationGuard(debit, () => invokeAI(call(40_000), async () => 'ok', () => usage(1_000)));
      const settled = await budget();
      expect(settled.requests).toBe(1);
      expect(settled.debited_usd).toBeCloseTo(usd(1_000), 12);
      expect(Object.keys(settled.pending ?? {})).toEqual([]);
    });

    test('a response without usage keeps the maximum debit', async () => {
      const debit = await authorizeMigrationBudget(engine, await plan(), 1);
      await withAIInvocationGuard(debit, () => invokeAI(call(40_000), async () => 'ok', () => null));
      expect((await budget()).debited_usd).toBeCloseTo(usd(40_000), 12);
    });

    test('settle is idempotent per attempt and a crash between reserve and settle keeps the maximum', async () => {
      const current = await plan();
      const debit = await authorizeMigrationBudget(engine, current, 1);
      const permit = await debit(call(40_000));
      await permit.settle(usage(1_000));
      const once = await budget();
      await permit.settle(usage(1));
      expect(await budget()).toEqual(once);
      const crashed = await debit(call(40_000));
      await authorizeMigrationBudget(engine, current, 1);
      await crashed.settle(usage(1));
      const resumed = await budget();
      expect(resumed.debited_usd).toBeCloseTo(usd(1_000) + usd(40_000), 12);
      expect(resumed.requests).toBe(2);
      expect(Object.keys(resumed.pending ?? {})).toHaveLength(1);
    });

    test('concurrent settles serialize on the migration state row', async () => {
      const debit = await authorizeMigrationBudget(engine, await plan(), 1);
      const permits = [];
      for (let i = 0; i < 6; i++) permits.push(await debit(call(40_000)));
      await Promise.all(permits.map((permit, i) => permit.settle(usage(100 * (i + 1)))));
      const settled = await budget();
      expect(settled.requests).toBe(6);
      expect(settled.debited_usd).toBeCloseTo(usd(100 * 21), 12);
      expect(Object.keys(settled.pending ?? {})).toEqual([]);
    });

    test('a retried request settles the sum of its attempts across a batch split', async () => {
      const debit = await authorizeMigrationBudget(engine, await plan(), 1);
      const reserved: number[] = [];
      let attempts = 0;
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
        attempts++;
        if (values.length > 1) throw new Error("Invalid 'input': maximum request size is 300000 tokens per request.");
        return { values, warnings: [], embeddings: values.map(vector), usage: { tokens: 10 } };
      });
      await withAIInvocationGuard(async request => { reserved.push(request.maxInputTokens!); return debit(request); },
        () => embed(['a'.repeat(400), 'b'.repeat(400)], { embeddingModel: model, dimensions }));
      expect(attempts).toBe(3);
      expect(reserved).toHaveLength(3);
      const settled = await budget();
      expect(settled.requests).toBe(3);
      expect(settled.debited_usd).toBeCloseTo(usd(reserved[0]) + usd(10) + usd(10), 12);
    });

    test('usage above the reservation debits actual, records the overshoot and stops dispatch', async () => {
      const debit = await authorizeMigrationBudget(engine, await plan(), 1);
      await withAIInvocationGuard(debit, () => invokeAI(call(100), async () => 'ok', () => usage(1_000)));
      const over = await budget();
      expect(over.debited_usd).toBeCloseTo(usd(1_000), 12);
      expect(over.overshoot_usd).toBeCloseTo(usd(900), 12);
      let dispatched = false;
      await expect(withAIInvocationGuard(debit, () => invokeAI(call(100), async () => { dispatched = true; }, () => usage(1))))
        .rejects.toThrow(/exceeded its reservation/);
      expect(dispatched).toBe(false);
      expect((await budget()).requests).toBe(1);
    });

    test('a cap equal to the printed worst-case authorization completes the migration', async () => {
      const rate = 1_000;
      await engine.setConfig('pricing.overrides', JSON.stringify({ [model]: rate }));
      await seedPages(5);
      const preview = await cli(['--dry-run']);
      expect(preview.code).toBe(0);
      const printed = /Worst-case authorization: \$(\d+(?:\.\d+)?)/.exec(preview.text);
      expect(printed).not.toBeNull();
      expect(preview.text).toContain('retries and batch splits settle from the same headroom');
      stubTransport(value => Buffer.byteLength(value, 'utf8'));
      const run = await cli(['--max-cost-usd', printed![1], '--json']);
      expect(run.text).toContain('"status": "completed"');
      expect(run.code).toBe(0);
      expect((await vectors()).every(row => row.embedding !== null)).toBe(true);
      const receipt = JSON.parse((await engine.getConfig('embedding_migration.completed'))!);
      expect(receipt.budget.debited_usd).toBeCloseTo(usd(reportedTokens, rate), 9);
      expect(receipt.verify_search.status).toBe('pass');
    });

    test('chunks created by projection recovery count toward the printed worst case', async () => {
      const rate = 1_000;
      await engine.setConfig('pricing.overrides', JSON.stringify({ [model]: rate }));
      await seedPages(2);
      const body = Array.from({ length: 60 }, (_, i) => `Synthetic unsealed paragraph ${i}. ${'Epsilon zeta eta theta. '.repeat(12)}`).join('\n\n');
      await engine.putPage('settle-unsealed', { type: 'note', title: 'Synthetic unsealed', compiled_truth: body });
      const [unsealed] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p
        WHERE p.slug='settle-unsealed' AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
          AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)`);
      expect(unsealed.n).toBe(1);
      const preview = await cli(['--dry-run']);
      const printed = /Worst-case authorization: \$(\d+(?:\.\d+)?)/.exec(preview.text);
      expect(printed).not.toBeNull();
      expect(Number(printed![1])).toBeGreaterThan(usd(Buffer.byteLength(body, 'utf8'), rate));
      stubTransport(value => Buffer.byteLength(value, 'utf8'));
      const run = await cli(['--max-cost-usd', printed![1], '--json']);
      expect(run.text).toContain('"status": "completed"');
      expect(run.code).toBe(0);
      const rows = await vectors();
      expect(rows.filter(row => row.slug === 'settle-unsealed').length).toBeGreaterThan(1);
      expect(rows.every(row => row.embedding !== null)).toBe(true);
    });

    test('an unpriced reranker switch still enforces the known embedding worst case', async () => {
      await seedPages(5);
      const before = await vectors();
      const preview = await cli(['--dry-run', '--reranker', 'nan:rerank']);
      expect(preview.text).toMatch(/Worst-case authorization: \$\d/);
      expect(preview.text).toContain('nan:rerank has no price');
      const run = await cli(['--max-cost-usd', '0.001', '--reranker', 'nan:rerank']);
      expect(run.code).toBe(1);
      expect(run.text).toContain('embedding_budget_below_worst_case');
      expect(transportCalls).toBe(0);
      expect(await vectors()).toEqual(before);
    });

    test('a cap near the estimate completes instead of dropping every vector and stalling', async () => {
      await seedPages(5);
      const run = await cli(['--max-cost-usd', '0.15', '--json']);
      expect(run.text).toContain('"status": "completed"');
      expect(run.code).toBe(0);
      expect((await vectors()).every(row => row.embedding !== null)).toBe(true);
    });

    test('a cap below the worst case refuses before any vector is dropped, naming cap, worst case and the raising flag', async () => {
      await seedPages(5);
      const before = await vectors();
      const run = await cli(['--max-cost-usd', '0.001']);
      expect(run.code).toBe(1);
      expect(transportCalls).toBe(0);
      expect(await vectors()).toEqual(before);
      expect(run.text).toContain('embedding_budget_below_worst_case');
      expect(run.text).toContain('cap is $0.001');
      const worst = /worst-case authorization is \$(\d+(?:\.\d+)?)/.exec(run.text);
      expect(worst).not.toBeNull();
      expect(Number(worst![1])).toBeGreaterThan(0.001);
      const raise = /--max-cost-usd (\d+(?:\.\d+)?) --yes/.exec(run.text);
      expect(raise).not.toBeNull();
      expect(Number(raise![1])).toBeGreaterThanOrEqual(Number(worst![1]));
      expect(run.text).toContain('write-refusals.md#embedding_budget_below_worst_case');
      expect(run.text).not.toContain('--max-cost $0.00');
      const json = await cli(['--max-cost-usd', '0.001', '--json']);
      const envelope = JSON.parse(json.text.slice(json.text.indexOf('{\n  "status": "refused"'), json.text.lastIndexOf('}') + 1));
      expect(envelope).toMatchObject({ status: 'refused', reason: 'embedding_budget_below_worst_case', error: 'embedding_budget_below_worst_case', cap_usd: 0.001 });
      expect(envelope.suggestion).toBe(`gbrain migrate embeddings --to ${model} --dim ${dimensions} --max-cost-usd ${envelope.required_cap_usd.toFixed(2)} --yes`);
      expect(envelope.docs).toEndWith('docs/guides/write-refusals.md#embedding_budget_below_worst_case');
      expect(transportCalls).toBe(0);
      expect(await vectors()).toEqual(before);
    });
  });
}
