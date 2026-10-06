/**
 * #6188 PR1: a malformed facts or takes fence never blocks a managed sync; the
 * file is held. A fence the screen refuses is held at freeze; a fence refused
 * only while being prepared against the stored page (a stored-row collision)
 * is held in the same invocation from its failed receipt; a cursor an older
 * release blocked converts on the next sync with no `--retry-failed`.
 * `sync.holds=fail` keeps blocking, with the typed refusal. Holds, results,
 * receipts and printed output carry locations only, never a claim, holder or
 * kind. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { gitHoldStatusLines, readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { gitHeldFilesCheck, fenceHoldsBannerNote, frontmatterHoldsBannerNote } from '../src/commands/doctor/checks/git-holds.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { printSyncResult, type SyncOpts, type SyncResult } from '../src/commands/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-holds-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };

// Unique strings that must never leave the file: a claim, a holder and a kind.
const CLAIM = 'Sentinelclaimzq7 ships quarterly', HOLDER = 'Sentinelholderzq7 Example', KIND = 'sentinelkindzq7';
const SECRETS = [CLAIM, HOLDER, KIND, 'Sentinelclaimzq7', 'Sentinelholderzq7'];
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const take = (n: number, claim = 'Synthetic take', who = 'brain', kind = 'take') => `| ${n} | ${claim} | ${kind} | ${who} | 0.7 | 2026-01 | chat |`;
const takesPage = (title: string, ...rows: string[]) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${T}\n${TH}\n${rows.join('\n')}\n${TE}\n`;
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;
const MALFORMED = takesPage('Malformed', take(1, CLAIM, HOLDER));

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = `fence-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const lastCommit = async () => (await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
  const failedRequests = () => engine.executeRaw<{ request_id: string; error_code: string; error_message: string | null; error_detail: Record<string, unknown> | null }>(
    "SELECT request_id::text AS request_id,error_code,error_message,error_detail FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict') ORDER BY sequence", [id]);
  const ledger = () => engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys::text LIKE $1", [`%${id}%`]);
  const storedTake = async (slug: string, rowNum: number, claim: string) => engine.transaction(tx => withCoordinatedWrite(tx, [id], () => tx.executeRaw(
    `INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) SELECT id,$3,$4,'take','brain',0.5 FROM pages WHERE source_id=$1 AND slug=$2`, [id, slug, rowNum, claim]), TEST_WRITE_ATTRIBUTION));
  return { id, root, write, sync, holds, lastCommit, failedRequests, ledger, storedTake };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); }
      finally { await disposePersistenceConsumer(engine); await engine.unsetConfig('sync.holds'); }
    }
  });
}

const printed = (result: SyncResult) => { let out = ''; printSyncResult(result, { write: (text: string) => { out += text; return true; } } as NodeJS.WriteStream); return out; };
const expectNoSecrets = (text: string) => { for (const secret of SECRETS) expect(text).not.toContain(secret); };

test('a malformed fence among clean files: the sync finishes, holds that file with its location, and the fix imports it', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'people/malformed.md': MALFORMED });
  const head = git(s.root, 'rev-parse', 'HEAD');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 2, held_count: 1, holds_outstanding: 1 });
  expect(await s.lastCommit()).toBe(head);
  expect(await engine.getPage('people/malformed', { sourceId: s.id })).toBeNull();
  expect(result.held![0]).toMatchObject({ path: 'people/malformed.md', code: 'invalid_fence', reason: 'holder_unresolved', stale: false,
    fence: { reason: 'holder_unresolved', fence: 'takes', section: 'body', rows: [1], columns: ['who'] }, docs: 'docs/guides/write-refusals.md#fence-holder_unresolved' });
  // A new file has no page to read: the fix lists the hold, then the sync that imports the corrected file. Never frontmatter advice.
  expect(result.held![0]!.fix.argv).toEqual(['gbrain', 'sources', 'status', s.id, '--json']);
  expect(result.held![0]!.fix.then?.argv).toEqual(['gbrain', 'sync', '--source', s.id, '--no-pull']);
  expect(result.holds_fix!.argv).toEqual(['gbrain', 'sources', 'status', s.id, '--json']);
  for (const text of [JSON.stringify(result.held), result.holds_fix!.why]) expect(text).not.toContain('repair frontmatter');
  const text = printed(result);
  expect(text).toContain('Held people/malformed.md: invalid_fence (holder_unresolved) in the takes fence (body), row 1, column who, at line');
  expect(text).toContain(`gbrain sync --source ${s.id} --no-pull`);
  const status = (await readGitHoldStatuses(engine, [s.id])).get(s.id)!;
  const lines = gitHoldStatusLines(s.id, status).join('\n');
  expect(lines).toContain('people/malformed.md: invalid_fence (holder_unresolved) in the takes fence (body)');
  // Privacy sentinel: no claim, holder or kind text in holds, results, printed output or status.
  const rows = await engine.executeRaw<{ completed_keys: unknown }>("SELECT completed_keys FROM op_checkpoints WHERE op LIKE 'sync-hold%' AND fingerprint LIKE $1", [`${s.id}:%`]);
  for (const blob of [JSON.stringify(rows), JSON.stringify(result), text, lines, JSON.stringify(status)]) expectNoSecrets(blob);
  // Doctor routes a fence-only source to the status read and the sync, never to frontmatter repair.
  const doctor = await gitHeldFilesCheck(engine, [s.id]);
  expect(doctor).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'sources', 'status', s.id, '--json'] } });
  expect(doctor.message).toContain(`gbrain sync --source ${s.id} --no-pull`);
  expect(doctor.message).not.toContain('repair frontmatter');
  // retry-held names the fence edit for what still refuses.
  expect((await retryHeld(engine, s.id, { dryRun: false })).next_action).toContain('edit the fence');

  s.write('people/malformed.md', takesPage('Malformed', take(1, 'Synthetic take', 'world'))); commit(s.root, 'fix the holder');
  const fixed = await s.sync();
  expect(fixed).toMatchObject({ status: 'synced', added: 1 });
  expect(await s.holds()).toEqual([]);
  expect(await engine.getPage('people/malformed', { sourceId: s.id })).not.toBeNull();
}), 180_000);

test('forced probe: a fence that passes the screen but collides with a stored take is held in the same invocation', () => each(async engine => {
  const s = await source(engine, { 'people/probe.md': takesPage('Probe', take(1)), 'notes/a.md': note('A') });
  expect((await s.sync()).status).toBe('first_sync');
  const before = (await engine.readPageSnapshot('people/probe', { sourceId: s.id }))!.revision;
  await s.storedTake('people/probe', 2, 'Database-only take');
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, CLAIM)));
  s.write('notes/b.md', note('B'));
  const head = commit(s.root, 'collide with a stored take');
  const result = await s.sync();
  // One invocation: synced, the checkpoint advanced, one hold, one failed receipt, no failure-ledger row.
  expect(result).toMatchObject({ status: 'synced', added: 1, held_count: 1 });
  expect(await s.lastCommit()).toBe(head);
  const failed = await s.failedRequests();
  expect(failed).toHaveLength(1);
  expect(result.converted_from_failed).toEqual([failed[0]!.request_id]);
  expect(failed[0]).toMatchObject({ error_code: 'take_row_collision', error_detail: { origin: 'fence', fence: { version: 1, reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2] } } });
  expect(failed[0]!.error_message).toMatch(/^Fence stored_row_collision: in the takes fence \(body\), row 2\./);
  expect(await s.ledger()).toEqual([]);
  expect(result.held![0]).toMatchObject({ path: 'people/probe.md', code: 'invalid_fence', reason: 'prepare_time', stale: true,
    fence: { reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2] }, docs: 'docs/guides/write-refusals.md#fence-prepare_time' });
  // A page exists, so the fix reads it first.
  expect(result.held![0]!.fix.argv).toEqual(['gbrain', 'get', '--source', s.id, '--', 'people/probe']);
  expect((await engine.readPageSnapshot('people/probe', { sourceId: s.id }))!.revision).toBe(before);
  expect(await engine.executeRaw('SELECT row_num,claim FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY row_num', [s.id, 'people/probe']))
    .toEqual([{ row_num: 1, claim: 'Synthetic take' }, { row_num: 2, claim: 'Database-only take' }]);
  for (const blob of [JSON.stringify(result), printed(result), JSON.stringify(failed)]) expectNoSecrets(blob);
  // The next run neither re-admits the held bytes nor mints another receipt.
  expect(await s.sync()).toMatchObject({ status: 'up_to_date', holds_outstanding: 1 });
  expect(await s.failedRequests()).toHaveLength(1);
}), 180_000);

test('sync.holds=fail blocks with the typed refusal; the next sync after the upgrade converts the legacy receipt with no --retry-failed', () => each(async engine => {
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'people/malformed.md': MALFORMED, 'notes/ok.md': note('Ok') });
  const blocked = await s.sync();
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'invalid_params', count: 1 }] });
  expect(blocked.managedWrite?.message ?? '').toMatch(/^Fence holder_unresolved: in the takes fence \(body\)/);
  const [failed] = await s.failedRequests();
  // The exact text a pre-#6188 release stored for this refusal, with no durable detail.
  await engine.executeRaw('UPDATE persistence_requests SET error_message=$2,error_detail=NULL WHERE request_id=$1::uuid',
    [failed!.request_id, 'A canonical facts or takes fence cannot be parsed losslessly.']);
  expect((await fenceHoldsBannerNote(engine)) ?? '').toContain(`gbrain sync --source ${s.id} --no-pull`);
  expect((await frontmatterHoldsBannerNote(engine)) ?? '').not.toContain(s.id);
  await engine.unsetConfig('sync.holds');
  const converted = await s.sync();
  expect(converted.converted_from_failed).toEqual([failed!.request_id]);
  expect(converted).toMatchObject({ status: 'first_sync', held_count: 1 });
  expect(converted.held![0]).toMatchObject({ path: 'people/malformed.md', code: 'invalid_fence', fence: { fence: 'takes', section: 'body' } });
  expect(await engine.getPage('notes/ok', { sourceId: s.id })).not.toBeNull();
  expect(await fenceHoldsBannerNote(engine)).toBeNull();
}), 180_000);

test('a legacy stored-row receipt holds the same bytes from the receipt; a compacted receipt converts only through the re-screen', () => each(async engine => {
  const s = await source(engine, { 'people/probe.md': takesPage('Probe', take(1)) });
  await s.sync();
  await s.storedTake('people/probe', 2, 'Database-only take');
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, 'Incoming take'))); commit(s.root, 'collide');
  await engine.setConfig('sync.holds', 'fail');
  expect((await s.sync()).status).toBe('blocked_by_failures');
  const [failed] = await s.failedRequests();
  await engine.executeRaw('UPDATE persistence_requests SET error_message=$2,error_detail=NULL WHERE request_id=$1::uuid',
    [failed!.request_id, "A takes fence row number is already used by a different take that is not in this page's canonical fence."]);
  await engine.unsetConfig('sync.holds');
  const converted = await s.sync();
  expect(converted).toMatchObject({ status: 'synced', held_count: 1, converted_from_failed: [failed!.request_id] });
  // The legacy message named no section; it comes from the refused bytes.
  expect(converted.held![0]).toMatchObject({ code: 'invalid_fence', reason: 'prepare_time', fence: { reason: 'stored_row_collision', fence: 'takes', section: 'body' } });

  // Compacted (message dropped, no detail): the re-screen of malformed bytes holds them...
  await engine.setConfig('sync.holds', 'fail');
  const t = await source(engine, { 'people/malformed.md': MALFORMED });
  expect((await t.sync()).status).toBe('blocked_by_failures');
  const [compacted] = await t.failedRequests();
  await engine.executeRaw('UPDATE persistence_requests SET error_message=NULL,error_detail=NULL,compacted=true WHERE request_id=$1::uuid', [compacted!.request_id]);
  await engine.unsetConfig('sync.holds');
  expect(await t.sync()).toMatchObject({ status: 'first_sync', held_count: 1, converted_from_failed: [compacted!.request_id] });

  // ...but an arbitrary invalid_params receipt, compacted or not, is never a fence hold: the cursor stays blocked.
  await engine.setConfig('sync.holds', 'fail');
  const u = await source(engine, { 'notes/ok.md': note('Ok') });
  u.write('notes/draft.md', MALFORMED);
  expect((await u.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  const [arbitrary] = await u.failedRequests();
  await engine.executeRaw("UPDATE persistence_requests SET error_message='The value is invalid.',error_detail=NULL WHERE request_id=$1::uuid", [arbitrary!.request_id]);
  await engine.unsetConfig('sync.holds');
  u.write('notes/draft.md', note('Now clean'));
  expect((await u.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  await engine.executeRaw('UPDATE persistence_requests SET error_message=NULL,compacted=true WHERE request_id=$1::uuid', [arbitrary!.request_id]);
  expect((await u.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  expect(await u.holds()).toEqual([]);
}), 240_000);

test('dry run lists the fence hold a real run would write and writes nothing', () => each(async engine => {
  const s = await source(engine, { 'people/malformed.md': MALFORMED, 'notes/ok.md': note('Ok') });
  const dry = await s.sync({ dryRun: true });
  expect(dry).toMatchObject({ status: 'dry_run', would_hold_count: 1 });
  expect(dry.would_hold![0]).toMatchObject({ path: 'people/malformed.md', code: 'invalid_fence', fence: { fence: 'takes', section: 'body' } });
  expectNoSecrets(JSON.stringify(dry));
  expect(await s.holds()).toEqual([]);
  expect(await engine.getPage('notes/ok', { sourceId: s.id })).toBeNull();
}), 180_000);

test('a bulk group whose middle member fails on a stored-row collision is held and the rest of the group commits in one invocation', () => each(async engine => {
  if (engine.kind !== 'postgres') return;
  const files: Record<string, string> = { 'people/probe.md': takesPage('Probe', take(1)) };
  const s = await source(engine, files);
  await s.sync();
  await s.storedTake('people/probe', 2, 'Database-only take');
  // Manifest order puts the colliding page between three files before it and three after it.
  for (let i = 0; i < 3; i++) { s.write(`notes/n${i}.md`, note(`N${i}`)); s.write(`zz/z${i}.md`, note(`Z${i}`)); }
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, 'Incoming take')));
  const head = commit(s.root, 'a group with one colliding member');
  const result = await s.sync({ bulk: { enabled: true, reason: null, size: 8, maxTxnMs: 15_000 } });
  expect(result).toMatchObject({ status: 'synced', added: 6, held_count: 1 });
  expect(result.held![0]).toMatchObject({ path: 'people/probe.md', reason: 'prepare_time' });
  expect(await s.lastCommit()).toBe(head);
  expect(await s.ledger()).toEqual([]);
  // The colliding page was admitted as a member of a bulk group, not on the single path.
  const [grouped] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='people/probe.md' AND intent ? 'group'", [s.id]);
  expect(grouped!.n).toBeGreaterThan(0);
}), 180_000);
