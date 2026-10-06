import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { gitHoldFix, holdRepairSteps, readGitHoldListing, readGitImageHoldCounts, readSyncHoldPolicy } from '../../../core/persistence/sync-holds.ts';
import { coverageRoute, readHeldCoverage } from '../../../core/persistence/held-reads.ts';
import { fenceReceiptLocation } from '../../../core/fence-repair/refusal.ts';
import { agentFix } from '../check-fix.ts';
import { isContentRefusal } from '../../../core/import-screen.ts';

const SAMPLE_PATHS = 5;

/**
 * #5988: files a Git source holds instead of importing (unreadable or
 * ambiguous frontmatter, a conflicting slug, over-size, an operator content
 * reject, and #6188 a facts or takes fence that cannot be imported). Connector
 * holds stay on `connector_held_items`. Warns per source with the missing and
 * stale counts, the first paths with their code and next step (the check is
 * host-only, so paths never reach a remote caller), and each source's next
 * step from the hold router (D6: frontmatter repair preview, the fence edit
 * and sync, or both); fails once a source carries more holds than
 * `sync.hold_escalate_count`, the same count rule that escalates a sync result.
 * Unsupported-image holds (#5493) are listed but never escalate.
 */
export async function gitHeldFilesCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const [coverage, policy] = await Promise.all([readHeldCoverage(engine, sourceIds ? { sourceIds } : {}), readSyncHoldPolicy(engine)]);
    const listing = new Map((await readGitHoldListing(engine, coverage.map(source => source.source_id), SAMPLE_PATHS)).map(entry => [entry.sourceId, entry.holds]));
    const images = await readGitImageHoldCounts(engine, coverage.map(source => source.source_id));
    const sources = coverage.map(source => {
      const route = coverageRoute(source);
      const steps = holdRepairSteps(source.source_id, route);
      return { source_id: source.source_id, held: source.missing + source.stale, stale: source.stale, missing: source.missing, ...(route.fences ? { fences: route.fences } : {}),
        first: (listing.get(source.source_id) ?? []).map(hold => ({ path: hold.path, code: hold.code, ...(hold.meta.reason ? { reason: hold.meta.reason } : {}), why: gitHoldFix(hold).why })),
        escalated: source.missing + source.stale - (images.get(source.source_id) ?? 0) > policy.escalateCount,
        status: `gbrain sources status ${source.source_id}`, repair: route.others ? `gbrain repair frontmatter --source ${source.source_id}` : `gbrain sync --source ${source.source_id} --no-pull`,
        argv: steps.argv, next: steps.text };
    });
    const held = sources.reduce((sum, source) => sum + source.held, 0);
    const details = { held, source_ids: sources.map(source => source.source_id), sources: sources.map(({ argv: _argv, ...source }) => source), escalate_count: policy.escalateCount,
      docs: 'docs/guides/repair.md#held-files' };
    if (!held) return { name: 'git_held_files', status: 'ok', message: 'No Git source files are held.', details };
    const escalated = sources.filter(source => source.escalated);
    const single = sources.length === 1 ? sources[0]! : undefined;
    const fenceOnly = sources.every(source => source.fences === source.held);
    const lines = sources.map(source => `${source.source_id}: ${source.held} held (${source.stale} page(s) keep an older revision, ${source.missing} file(s) have no page), `
      + `first: ${source.first.map(hold => `${hold.path} [${hold.code}${hold.reason ? `/${hold.reason}` : ''}]`).join(', ')}`);
    return {
      name: 'git_held_files', status: escalated.length ? 'fail' : 'warn', details,
      message: `${held} file(s) in Git sources are held and not imported; the rest of each sync continues. ${lines.join('; ')}. `
        + (escalated.length ? `Escalated: ${escalated.map(source => source.source_id).join(', ')} hold more than ${policy.escalateCount} files (sync.hold_escalate_count), so a generator or an upgrade is likely writing or reading them wrong; fix the cause first. ` : '')
        + 'A page whose newer file is held is read-only for put_page until the file is repaired, so do not retry a refused write. '
        + `Inspect with ${sources.map(source => source.status).join('; ')}; then ${sources.map(source => `${source.source_id}: ${source.next}`).join('; ')}.`,
      fix: single
        ? agentFix(single.argv, fenceOnly ? `Lists each held file of ${single.source_id} with the fence and reason that hold it; edit that fence in the file, commit, then run gbrain sync --source ${single.source_id} --no-pull.`
          : 'Previews the minimal line fix for each held file (or names the line to fix by hand) and prints the hash-bound apply command; it writes nothing.', 'git_held_files', { docs: 'docs/guides/repair.md#held-files' })
        : agentFix(fenceOnly ? ['gbrain', 'sources', 'status', '--json'] : ['gbrain', 'repair', 'frontmatter'],
          fenceOnly ? 'Lists each held file with the fence and reason that hold it; edit that fence in the file, commit, then sync its source with --no-pull.'
            : 'Previews the minimal line fix for each held file (or names the line to fix by hand) and prints the hash-bound apply command; it writes nothing. Fence holds are listed by gbrain sources status and fixed by editing the named fence.',
          'git_held_files', { docs: 'docs/guides/repair.md#held-files' }),
    };
  } catch (error) {
    return { name: 'git_held_files', status: 'warn', fix_unavailable_reason: 'check_errored',
      message: `Git source holds could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { held: 0, health: 'unknown' } };
  }
}

/**
 * Sources whose unfinished managed sync cursor is stopped on a failed content refusal (fixed by the next sync, which converts it in place).
 * `fence` marks a source whose refusal is a facts or takes fence (#6188); it is held and fixed by editing the fence, not by frontmatter repair.
 */
export async function contentBlockedSources(engine: BrainEngine): Promise<Array<{ source_id: string; fence: boolean }>> {
  const rows = await engine.executeRaw<{ source_id: string; error_code: string | null; error_message: string | null; error_detail: unknown }>(`SELECT c.completed_keys->0->>'sourceId' AS source_id,
      r.error_code, r.error_message, r.error_detail FROM op_checkpoints c JOIN persistence_requests r ON r.request_id::text = c.completed_keys->0->'pending'->>'requestId'
      AND r.source_id = c.completed_keys->0->>'sourceId'
    WHERE c.op = 'managed-sync' AND COALESCE(c.completed_keys->0->>'done','false') <> 'true' AND r.state IN ('failed','conflict','cancelled')
    ORDER BY 1`).catch(() => []);
  const out = new Map<string, boolean>();
  for (const row of rows) {
    const fence = fenceReceiptLocation(row) !== null;
    if (fence || isContentRefusal(row.error_code, row.error_message)) out.set(row.source_id, (out.get(row.source_id) ?? false) || fence);
  }
  return [...out].map(([source_id, fence]) => ({ source_id, fence }));
}

/**
 * #5988 `gbrain post-upgrade` line: a source blocked by one file recovers on
 * its next sync (scheduled or manual) without ledger surgery. The line names
 * the command that does it now and the repair preview for the backlog, plus
 * the hook refresh when an older hook is installed (held files already appear
 * as the `git_held_files` finding). Null when neither applies.
 */
export async function frontmatterHoldsBannerNote(engine: BrainEngine): Promise<string | null> {
  const { outdatedFrontmatterHooks } = await import('./frontmatter-hook.ts');
  const [blocked, hooks] = await Promise.all([contentBlockedSources(engine), outdatedFrontmatterHooks(engine).catch(() => [])]);
  const parts: string[] = [];
  const ids = blocked.filter(source => !source.fence).map(source => source.source_id);
  if (ids.length) {
    parts.push(`${ids.length} source(s) are blocked by a file gbrain could not import (${ids.join(', ')}). The next scheduled or manual sync recovers a blocked source `
      + `automatically; to do it now run ${ids.map(id => `gbrain sync --source ${id} --no-pull`).join('; ')}. The file is then held and the rest of the source imports; `
      + `inspect it with ${ids.map(id => `gbrain sources status ${id}`).join('; ')} and preview the backlog fix with ${ids.map(id => `gbrain repair frontmatter --source ${id}`).join('; ')} (writes nothing; ask the user before applying)`);
  }
  if (hooks.length) parts.push(`an older frontmatter pre-commit hook is installed; refresh it with ${hooks.map(hook => hook.fix.join(' ')).join('; ')}`);
  return parts.length ? `frontmatter_holds: ${parts.join('. ')}. Recipe: docs/guides/repair.md#held-files` : null;
}

/**
 * #6188 `gbrain post-upgrade` line, separate from the frontmatter one: a
 * source blocked by a malformed facts or takes fence (a typed receipt or the
 * message an older gbrain stored) recovers on its next sync with no command:
 * the file is held and the rest of the source imports. Null when none is.
 */
export async function fenceHoldsBannerNote(engine: BrainEngine): Promise<string | null> {
  const ids = (await contentBlockedSources(engine)).filter(source => source.fence).map(source => source.source_id);
  if (!ids.length) return null;
  return `fence_holds: ${ids.length} source(s) are blocked by a file whose facts or takes fence gbrain could not import (${ids.join(', ')}). The next scheduled or manual sync `
    + `recovers each automatically; to do it now run ${ids.map(id => `gbrain sync --source ${id} --no-pull`).join('; ')}. The file is then held and the rest of the source imports; `
    + `${ids.map(id => `gbrain sources status ${id}`).join('; ')} names the file, fence and reason. Read the page with gbrain get --source <id> -- <slug>, edit that fence in the file, `
    + 'commit, and sync again; frontmatter repair does not change fences. Recipe: docs/guides/live-sync.md#held-files';
}
