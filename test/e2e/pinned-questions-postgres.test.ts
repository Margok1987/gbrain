/**
 * Pinned questions (C4) on LIVE Postgres (and PgBouncer when the lane points
 * DATABASE_URL at the pooler): the same B5 offline safety gate, operator
 * journeys and dream.auto_think migration scenarios the PGLite suite runs
 * (test/helpers/pinned-questions-scenarios.ts). Stub model; no network.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/pinned-questions-postgres.test.ts
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { registerPinnedQuestionSuite } from '../helpers/pinned-questions-scenarios.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;
const home = mkdtempSync(join(tmpdir(), 'pq-e2e-home-'));
const priorHome = process.env.GBRAIN_HOME;

d('pinned questions (live Postgres)', () => {
  beforeAll(async () => {
    process.env.GBRAIN_HOME = home;
    engine = await setupDB();
  }, 120_000);

  afterAll(async () => {
    await teardownDB();
    if (priorHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  });

  registerPinnedQuestionSuite('postgres', () => engine);
});
