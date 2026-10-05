/**
 * Pinned questions (C4) on PGLite: the B5 offline safety gate, operator
 * journeys and the dream.auto_think migration. Scenarios live in
 * test/helpers/pinned-questions-scenarios.ts and also run on live Postgres
 * (test/e2e/pinned-questions-postgres.test.ts). Stub model; no network.
 */
import { afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerPinnedQuestionSuite } from './helpers/pinned-questions-scenarios.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'pq-safety-home-'));
const priorHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
  if (priorHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
}, 60_000);

registerPinnedQuestionSuite('pglite', () => engine);
