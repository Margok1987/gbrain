/**
 * Fix wave 4 lane B: connector data safety on managed and unmanaged brains,
 * PGLite here and PostgreSQL through test/e2e/connector-holds.test.ts.
 *  - #5752: an emoji at the Gmail body cap imports, and a re-run admits nothing.
 *  - connector item holds on Gmail and GitHub (#5752, #5740).
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { readAllSourceHolds } from '../src/core/connectors/item-holds-store.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { createConnectorFixture, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { addThread, fakeGitHub, fakeGmail, githubHoldsFetch, gmailFetch } from './helpers/connector-holds-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const account = 'reader@example.com';
const gmailConfig = { kind: 'google', g_account: account, g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

async function gmailSource(engine: BrainEngine, managed: boolean) {
  const f = await source(engine, gmailConfig);
  if (!managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  return { ...f, cfg: parseGoogleSourceConfig(gmailConfig, f.dir) };
}

async function lastRun(engine: BrainEngine, id: string) {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]);
  return (await readManagedConnectorState(engine, id, row.incarnation)).last_run;
}

test('#5752: an emoji straddling the Gmail body cap imports, and the next run admits nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await gmailSource(engine, true);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60001', Date.now() - 3_600_000, 'x'.repeat(7_999) + '\u{1F600}' + 'y'.repeat(40));
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    const first = await run();
    expect(first).toMatchObject({ added: 1 });
    const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1', [f.id]);
    expect(page.compiled_truth.isWellFormed()).toBe(true);
    expect(page.compiled_truth).toContain('x'.repeat(7_999));
    await disposePersistenceConsumer(engine);
    const second = await run();
    expect(second).toMatchObject({ added: 0, modified: 0 });
    expect(await lastRun(engine, f.id)).toMatchObject({ page_admissions: 0 });
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

const githubConfig = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' };
const issueAt = (n: number) => `2026-02-0${n}T00:00:00Z`;

async function githubSource(engine: BrainEngine, managed: boolean) {
  const f = await source(engine, githubConfig);
  if (!managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  return { ...f, cfg: parseGitHubSourceConfig(githubConfig, f.dir) };
}

async function sourceHolds(engine: BrainEngine, id: string) {
  return (await readAllSourceHolds(engine, { sourceIds: [id] }))[0]?.held ?? [];
}

test('#5740: a GitHub item failing 3 runs is held, the watermark advances past it, and retry-held clears it on recovery', async () => withEnv(env, async () => {
  for (const engine of engines) for (const managed of [false, true]) {
    const f = await githubSource(engine, managed);
    const fx = fakeGitHub();
    fx.issues = [1, 2, 3].map(n => ({ number: n, title: `Synthetic issue ${n}`, body: `Body ${n}`, updated_at: issueAt(n) }));
    fx.failDetail.set(2, 422);
    const run = (extra: Record<string, unknown> = {}) => runGitHubSync(engine, f.id, f.cfg, { ...options, ...extra }, githubHoldsFetch(fx));
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 1; i <= 3; i++) {
        const result = await run();
        expect(result.status).toBe('partial');
        await disposePersistenceConsumer(engine);
      }
      const held = await sourceHolds(engine, f.id);
      expect(held.map(h => ({ key: h.key, code: h.code, class: h.class, title: h.meta.title }))).toEqual([
        { key: 'acme-example/app#2', code: 'http_4xx', class: 'content', title: 'Synthetic issue 2' }]);
      // Run 4 skips the held item, so the sweep completes and the cursor moves past it.
      const fourth = await run();
      expect(fourth.status).not.toBe('partial');
      expect(fourth.connectorHolds).toEqual({ held: 1, newly_held: 0, retry_command: `gbrain sources retry-held ${f.id}` });
      await disposePersistenceConsumer(engine);
      fx.since.length = 0;
      await run();
      expect(fx.since).toEqual([issueAt(3)]);
      const [row] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
      expect(row.last_sync_at).not.toBeNull();
      await disposePersistenceConsumer(engine);
      // The provider recovers; retry-held re-attempts the held item on the next run and success clears it.
      fx.failDetail.delete(2);
      const retry = await retryHeld(engine, f.id);
      expect(retry.items).toEqual([expect.objectContaining({ key: 'acme-example/app#2', action: 'retry_scheduled' })]);
      fx.detailFetches.length = 0;
      await run();
      expect(fx.detailFetches).toContain(2);
      expect(await sourceHolds(engine, f.id)).toEqual([]);
      await disposePersistenceConsumer(engine);
    } finally { errors.mockRestore(); }
  }
}), 180_000);

async function waiting(engine: BrainEngine, sourceId: string, remote = false) {
  const { handleToolCall } = await import('../src/mcp/server.ts');
  return await handleToolCall(engine, 'open_loops', { group_by: 'counterparty', source_id: sourceId }, remote
    ? { remote: true, sourceId, auth: { allowedSources: [sourceId] } } as never : { sourceId }) as Record<string, any>;
}

test('Gmail holds (managed and unmanaged): held after 3 runs, the floor passes it, sources status, doctor and waiting show it, retry-held clears it', async () => withEnv(env, async () => {
  const { readConnectorSourceStatuses, connectorStatusLines } = await import('../src/core/persistence/connector-status.ts');
  const { connectorHeldItemsCheck } = await import('../src/commands/doctor/checks/connector-holds.ts');
  for (const engine of engines) for (const managed of [false, true]) {
    const f = await gmailSource(engine, managed);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60101', Date.now() - 2 * 3_600_000);
    addThread(fx, 'a1b2c3d4e5f60202', Date.now() - 3 * 3_600_000);
    fx.failThreads.set('a1b2c3d4e5f60202', 400);
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    for (let i = 1; i <= 3; i++) {
      expect((await run()).status).toBe('partial');
      await disposePersistenceConsumer(engine);
    }
    const [held] = await sourceHolds(engine, f.id);
    expect(held).toMatchObject({ key: 'a1b2c3d4e5f60202', state: 'held', code: 'http_4xx', class: 'content', attempts: 3,
      meta: { sender: null, subject: null, upstream_at: null } });
    // Run 4 skips the held thread; the backfill finishes around it and the source is fresh.
    fx.fetched.length = 0;
    const fourth = await run();
    expect(fourth.status).not.toBe('partial');
    expect(fourth.connectorHolds).toMatchObject({ held: 1 });
    expect(fx.fetched).not.toContain('a1b2c3d4e5f60202');
    await disposePersistenceConsumer(engine);
    const [src] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(src.last_sync_at).not.toBeNull();
    const status = (await readConnectorSourceStatuses(engine)).get(f.id)!;
    expect(status.held.map(h => h.key)).toEqual(['a1b2c3d4e5f60202']);
    const lines = connectorStatusLines(f.id, status).join('\n');
    expect(lines).toContain('1 held item(s)');
    expect(lines).toContain(`gbrain sources retry-held ${f.id}`);
    const doctor = await connectorHeldItemsCheck(engine);
    expect(doctor).toMatchObject({ name: 'connector_held_items', status: 'warn' });
    expect(doctor.details?.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: f.id, held: 1 })]));
    // Unknown upstream date counts as inside the window: coverage is partial, and the empty answer says so.
    const answer = await waiting(engine, f.id);
    expect(answer.completeness).toBe('partial');
    expect(answer.held).toEqual([expect.objectContaining({ key: 'a1b2c3d4e5f60202', retry_command: `gbrain sources retry-held ${f.id}` })]);
    expect(answer.text).toContain('No open loops found, but coverage is partial: 1 held item(s)');
    expect(answer.text).not.toContain('You are clean');
    // retry-held: --dry-run changes nothing; the real request survives until the next sync, which re-attempts and clears it.
    expect((await retryHeld(engine, f.id, { dryRun: true })).items).toEqual([expect.objectContaining({ action: 'would_retry' })]);
    fx.failThreads.delete('a1b2c3d4e5f60202');
    fx.fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fx.fetched).not.toContain('a1b2c3d4e5f60202');
    await disposePersistenceConsumer(engine);
    expect((await retryHeld(engine, f.id)).scheduled).toBe(1);
    expect((await retryHeld(engine, f.id)).scheduled).toBe(1);
    expect((await run()).status).not.toBe('partial');
    expect(fx.fetched).toContain('a1b2c3d4e5f60202');
    await disposePersistenceConsumer(engine);
    expect(await sourceHolds(engine, f.id)).toEqual([]);
    expect((await waiting(engine, f.id)).completeness).toBe('complete');
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='connector-hold-retry'")).toEqual([]);
    expect((await retryHeld(engine, f.id)).next_action).toBe(`No held items for ${f.id}.`);
  }
}), 240_000);

test('a lone surrogate in a Gmail identity field refuses with invalid_connector_text and is held after 3 runs; prose is sanitized', async () => withEnv(env, async () => {
  for (const engine of engines) for (const managed of [false, true]) {
    const f = await gmailSource(engine, managed);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60303', Date.now() - 3_600_000, 'Prose with a lone \uD83D surrogate.', 'Subject \uDE00 lone');
    addThread(fx, 'a1b2c3d4e5f60404', Date.now() - 2 * 3_600_000);
    fx.threads.get('a1b2c3d4e5f60404')!.messages[0].id = 'bad\uD800id';
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    for (let i = 1; i <= 3; i++) {
      expect((await run()).status).toBe('partial');
      await disposePersistenceConsumer(engine);
    }
    const [held] = await sourceHolds(engine, f.id);
    expect(held).toMatchObject({ key: 'a1b2c3d4e5f60404', code: 'invalid_connector_text', class: 'content', meta: { subject: 'Subject a1b2c3d4e5f60404' } });
    const pages = await engine.executeRaw<{ compiled_truth: string; title: string }>('SELECT compiled_truth,title FROM pages WHERE source_id=$1', [f.id]);
    expect(pages).toHaveLength(1);
    expect(pages[0].compiled_truth.isWellFormed()).toBe(true);
    expect(pages[0].title.isWellFormed()).toBe(true);
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

test('legacy gmail_fail_counts carry over once as held items with unknown metadata (unmanaged)', async () => withEnv(env, async () => {
  const { writeFileSync } = await import('node:fs');
  const { googleStateFile, readGoogleState } = await import('../src/core/google/google-source.ts');
  for (const engine of engines) {
    const f = await gmailSource(engine, false);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60505', Date.now() - 3_600_000);
    writeFileSync(googleStateFile(f.dir), JSON.stringify({ gmail_history_id: null, gmail_backfill_floor_ms: null, gmail_backfill_done: false, gmail_newest_ms: null,
      calendar_sync_token: null, contacts_sync_token: null, last_full_at: null, gmail_fail_counts: { a1b2c3d4e5f60505: 3 } }));
    await runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    expect(fx.fetched).not.toContain('a1b2c3d4e5f60505');
    expect(readGoogleState(f.dir).gmail_fail_counts).toBeUndefined();
    expect(await sourceHolds(engine, f.id)).toEqual([expect.objectContaining({ key: 'a1b2c3d4e5f60505', legacy: true, code: 'legacy_poison',
      meta: { sender: null, subject: null, title: null, upstream_at: null } })]);
    expect((await waiting(engine, f.id)).completeness).toBe('partial');
  }
}), 120_000);
