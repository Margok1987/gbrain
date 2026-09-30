/**
 * Fix wave 4 lane B: connector data safety on managed and unmanaged brains,
 * PGLite here and PostgreSQL through test/e2e/connector-holds.test.ts.
 *  - #5752: an emoji at the Gmail body cap imports, and a re-run admits nothing.
 *  - connector item holds on Gmail and GitHub (#5752, #5740).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { createConnectorFixture, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { addThread, fakeGmail, gmailFetch } from './helpers/connector-holds-fixture.ts';
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
