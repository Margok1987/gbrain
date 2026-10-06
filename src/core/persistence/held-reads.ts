/**
 * #5988 read-time hold signals. A page whose newer file sync holds keeps its
 * last good revision, and a held new file has no page at all, so an agent
 * answering from reads must learn that coverage is partial:
 *
 * - `get_page` carries `file_held` (code, reason, key, line, since, fix, docs;
 *   the file path for trusted local callers only).
 * - search and query hits for such a page carry `stale` (held_since, last_indexed_revision).
 * - retrieval meta carries `held_files` per source in scope (held new files
 *   missing, held modified files stale) and a `held_files` degraded notice.
 *
 * Cost: one indexed lookup (`op_checkpoints_sync_hold_page_idx`) for the pages
 * a call returns and one read of the per-source summary rows in scope, each
 * cached per request. Remote callers get codes, counts and flags, never paths,
 * and a fix addressed to the brain host operator.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action, Notice } from '../agent-output.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP, gitHoldDocs, gitHoldFix, holdRepairSteps, type GitHoldCode, type GitHoldReason, type GitHoldRecord, type HoldRepairRoute } from './sync-holds.ts';
import type { FenceMessageLocation } from '../fence-repair/reasons.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export interface HeldPage { record: GitHoldRecord; revision: string | null }

/**
 * Held files of the sources in a read scope: new files with no page (`missing`) and pages whose newer file is held (`stale`);
 * `fences` (present only when some are) counts the #6188 `invalid_fence` holds among them, which route to a fence edit instead of frontmatter repair.
 */
export interface HeldCoverage { source_id: string; missing: number; stale: number; fences?: number }

/** `get_page.file_held`. */
export interface FileHeld {
  code: GitHoldCode;
  reason?: GitHoldReason;
  key?: string;
  line?: number;
  /** #6188 `invalid_fence`: fence, section, reason and problem classes (row numbers for trusted local callers only). */
  fence?: FenceMessageLocation;
  since: string;
  /** Source-relative file path; trusted local callers only. */
  path?: string;
  fix: Action;
  docs: string;
}

/** A search or query hit whose page's newer file is held. */
export interface StaleHit { held_since: string; last_indexed_revision: string | null }

const requestCache = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Memoizes one read per request (the OperationContext); without a request object it just runs. */
function cached<T>(request: object | undefined, key: string, read: () => Promise<T>): Promise<T> {
  if (!request) return read();
  let entries = requestCache.get(request);
  if (!entries) requestCache.set(request, entries = new Map());
  if (!entries.has(key)) entries.set(key, read());
  return entries.get(key) as Promise<T>;
}

/** The current-incarnation holds naming these pages, with each page's revision: one indexed read. */
export function readHeldPages(engine: Exec, pageIds: number[], request?: object): Promise<Map<number, HeldPage>> {
  const ids = [...new Set(pageIds.filter(id => Number.isInteger(id)))].sort((a, b) => a - b);
  if (!ids.length) return Promise.resolve(new Map());
  return cached(request, `pages:${ids.join(',')}`, async () => {
    const rows = await engine.executeRaw<{ record: GitHoldRecord; revision: string | null }>(`SELECT h.completed_keys->0 AS record, p.knowledge_revision::text AS revision
      FROM op_checkpoints h
      JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      LEFT JOIN pages p ON p.id::text=h.completed_keys->0->>'page_id'
      WHERE h.op=$1 AND (h.completed_keys->0->>'page_id')=ANY($2::text[])
      ORDER BY h.fingerprint`, [GIT_HOLD_OP, ids.map(String)]);
    const out = new Map<number, HeldPage>();
    for (const row of rows) {
      const id = Number(row.record.page_id);
      if (!out.has(id)) out.set(id, { record: row.record, revision: row.revision });
    }
    return out;
  });
}

/** Per-source held-file counts in a read scope (sources with none are absent): one read of the summary rows. */
export function readHeldCoverage(engine: Exec, scope: { sourceId?: string; sourceIds?: string[] }, request?: object): Promise<HeldCoverage[]> {
  const ids = scope.sourceIds ?? (scope.sourceId !== undefined && scope.sourceId !== ALL_SOURCES ? [scope.sourceId] : null);
  if (ids && !ids.length) return Promise.resolve([]);
  return cached(request, `coverage:${ids ? [...ids].sort().join(',') : '*'}`, async () => {
    const rows = await engine.executeRaw<{ source_id: string; count: number | string; stale: number | string; fences: number | string }>(`SELECT s.id AS source_id,
        COALESCE((h.completed_keys->0->>'count')::int,0) AS count, COALESCE((h.completed_keys->0->>'stale')::int,0) AS stale,
        COALESCE((h.completed_keys->0->>'fences')::int,0) AS fences
      FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
      WHERE h.op=$1 AND s.archived IS NOT TRUE AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))
        AND COALESCE((h.completed_keys->0->>'count')::int,0)>0
      ORDER BY s.id`, [GIT_HOLD_SUMMARY_OP, ids]);
    return rows.map(row => {
      const count = Number(row.count), stale = Math.min(Number(row.stale), count), fences = Math.min(Number(row.fences), count);
      return { source_id: row.source_id, missing: count - stale, stale, ...(fences ? { fences } : {}) };
    });
  });
}

/** D6: which repair a held source needs, from its counts. */
export function coverageRoute(source: HeldCoverage): HoldRepairRoute {
  const fences = source.fences ?? 0;
  return { fences, others: Math.max(0, source.missing + source.stale - fences) };
}

function repairArgv(sourceId: string): string[] {
  return ['gbrain', 'repair', 'frontmatter', '--source', sourceId];
}

/**
 * The fix a remote caller relays (`tell_user_to_run`): only the brain host
 * operator can inspect and repair held files. A source without a route, or
 * with frontmatter-style holds, names the frontmatter repair preview; a source
 * with fence holds names the status read, the fence edit and the sync (D6).
 */
export function hostOperatorFix(sources: ReadonlyArray<{ source_id: string; route?: HoldRepairRoute }>, why: string): Action {
  const frontmatter = sources.filter(source => !source.route || source.route.others > 0).map(source => `'${repairArgv(source.source_id).join(' ')}'`);
  const fences = sources.filter(source => source.route && source.route.fences > 0).map(source => source.source_id);
  const first = sources[0]!;
  const parts = [
    ...(frontmatter.length ? [`Please run ${frontmatter.join(', ')} on the brain host to preview the fixes, then apply them.`] : []),
    ...(fences.length ? [`Some held files have a facts or takes table gbrain cannot import: on the brain host run ${fences.map(id => `'gbrain sources status ${id}'`).join(', ')} to see which file and table, edit that table and commit, then run ${fences.map(id => `'gbrain sync --source ${id} --no-pull'`).join(', ')}.`] : []),
  ];
  return { argv: first.route ? holdRepairSteps(first.source_id, first.route).argv : repairArgv(first.source_id), consent: [], actor: 'host_admin', requires_exclusive: false, why,
    user_message: `Some files in your brain could not be imported, so answers from it can miss or show outdated notes. ${parts.join(' ')}` };
}

/** The route of one hold record. */
export function recordRoute(record: Pick<GitHoldRecord, 'code'>): HoldRepairRoute {
  return record.code === 'invalid_fence' ? { fences: 1, others: 0 } : { fences: 0, others: 1 };
}

/** `get_page.file_held` for a page whose newer file is held; the path only for trusted local callers. */
export function fileHeldField(held: HeldPage, remote: boolean): FileHeld {
  const { record } = held;
  const fix = remote
    ? hostOperatorFix([{ source_id: record.source_id, route: recordRoute(record) }], `The canonical file of this page is held (${record.code}${record.meta.reason ? `, ${record.meta.reason}` : ''}): sync cannot import its newer version, so this page shows its last good revision and is read-only for put_page until the brain host operator repairs the file.`)
    : gitHoldFix(record);
  const fence = record.meta.fence ? (remote ? { ...record.meta.fence, rows: [] } : record.meta.fence) : undefined;
  return { code: record.code, ...(record.meta.reason ? { reason: record.meta.reason } : {}), ...(record.meta.key ? { key: record.meta.key } : {}),
    ...(record.meta.line !== undefined ? { line: record.meta.line } : {}), ...(fence ? { fence } : {}), since: record.held_at, ...(remote ? {} : { path: record.path }),
    fix, docs: gitHoldDocs(record.code, record.meta.reason) };
}

/**
 * Stamps `stale` on hits whose page's newer file is held (one indexed read)
 * and returns the per-source coverage of the read scope. Hits are mutated in
 * place; callers pass their own copies.
 */
export async function stampHeldHits(engine: Exec, hits: Array<{ page_id?: number; stale?: boolean | StaleHit }>, scope: { sourceId?: string; sourceIds?: string[] },
  request?: object): Promise<HeldCoverage[]> {
  const coverage = await readHeldCoverage(engine, scope, request);
  if (!coverage.some(source => source.stale > 0) || !hits.length) return coverage;
  const held = await readHeldPages(engine, hits.flatMap(hit => typeof hit.page_id === 'number' ? [hit.page_id] : []), request);
  for (const hit of hits) {
    const page = typeof hit.page_id === 'number' ? held.get(hit.page_id) : undefined;
    if (page) hit.stale = { held_since: page.record.held_at, last_indexed_revision: page.revision };
  }
  return coverage;
}

/** The `held_files` notice for a read whose scope has held files; null when it has none. */
export function heldFilesNotice(coverage: HeldCoverage[], remote: boolean): Notice | null {
  if (!coverage.length) return null;
  const missing = coverage.reduce((sum, source) => sum + source.missing, 0), stale = coverage.reduce((sum, source) => sum + source.stale, 0);
  const per = coverage.map(source => `${source.source_id}: ${source.missing} missing, ${source.stale} stale`).join('; ');
  const why = `Coverage is partial: sync holds ${missing + stale} file(s) it cannot import (${per}). `
    + `${missing} held new file(s) have no page, so their content is absent from this result; ${stale} page(s) whose newer file is held show their last good revision (hits carry stale). `
    + 'Treat a missing or outdated answer as "held", never as "the brain has nothing on this".';
  const ids = coverage.map(source => source.source_id);
  if (remote) return { code: 'held_files', kind: 'degraded', why: `${why} Only the brain host operator can inspect and repair held files.`,
    fix: hostOperatorFix(coverage.map(source => ({ source_id: source.source_id, route: coverageRoute(source) })), 'The repair preview on the brain host proposes each fix and writes nothing until the operator applies it.') };
  const single = coverage.length === 1 ? holdRepairSteps(ids[0]!, coverageRoute(coverage[0]!)) : null;
  const fix: Action = single
    ? { argv: single.argv, consent: [], actor: 'agent', requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'status', ids[0]!, '--json'] },
      why: coverageRoute(coverage[0]!).fences
        ? `gbrain sources status ${ids[0]} lists each held file; ${single.text}.`
        : `Previews the fix for each held file in source ${ids[0]} (gbrain sources status ${ids[0]} lists them); nothing is written until a hash-bound apply.` }
    : { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: `Doctor lists the held files of each source with its next step (${coverage.map(source => holdRepairSteps(source.source_id, coverageRoute(source)).commands[0]).join('; ')}).` };
  return { code: 'held_files', kind: 'degraded', why, fix };
}
