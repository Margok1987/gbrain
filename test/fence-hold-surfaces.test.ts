/**
 * #6188 PR1 (D6): one hold-repair router. Every surface maps a fence hold to
 * reading the page, editing the named fence and syncing; frontmatter holds keep
 * their repair preview; a mixed source names both. Remote callers get the
 * owner handoff (`tell_user_to_run`). Never frontmatter advice for a fence.
 */
import { describe, expect, test } from 'bun:test';
import { gitHoldDocs, gitHoldFix, gitHoldItem, holdRepairSteps, holdRescreenDue, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { coverageRoute, fileHeldField, heldFilesNotice, hostOperatorFix, recordRoute } from '../src/core/persistence/held-reads.ts';
import { heldFileDiagnostic, heldFileMessage, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { holdLine } from '../src/commands/sync-diagnostics.ts';
import { deriveNext } from '../src/core/agent-output.ts';
import { fenceMessage } from '../src/core/fence-repair/reasons.ts';
import { FENCE_VERSION } from '../src/core/fence-repair/refusal.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';

const location = { reason: 'holder_unresolved', fence: 'takes', section: 'body', rows: [3], columns: ['who'], line: 7 } as const;
const fenceHold = (extra: Partial<GitHoldRecord> = {}): GitHoldRecord => ({
  version: 1, source_id: 'notes-example', incarnation: 'inc', path: 'people/a-founder.md', source_path: 'people/a-founder.md', slug: 'people/a-founder', page_id: 12,
  code: 'invalid_fence', message: fenceMessage({ ...location, rows: [...location.rows], columns: [...location.columns] }), upstream_version: 'sha', observed_at: '2026-10-01T00:00:00.000Z',
  held_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', run_id: 'run', mode: 'managed',
  meta: { reason: 'holder_unresolved', recovery_version: RECOVERY_VERSION, fence: { ...location, rows: [...location.rows], columns: [...location.columns] }, fence_version: FENCE_VERSION },
  ...extra,
});
const frontmatterHold = (): GitHoldRecord => ({ ...fenceHold(), path: 'notes/broken.md', code: 'invalid_frontmatter',
  message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: RECOVERY_VERSION } });
const cli = { transport: 'cli' as const, isCallable: () => false, preapproved: () => false, routing: {} } as never;
const http = { transport: 'http' as const, isCallable: () => false, preapproved: () => false, routing: {} } as never;

describe('the per-hold fix', () => {
  test('a fence hold with a page reads it, then syncs; a new file lists the hold first; neither mentions frontmatter', () => {
    const withPage = gitHoldFix(fenceHold());
    expect(withPage.argv).toEqual(['gbrain', 'get', '--source', 'notes-example', '--', 'people/a-founder']);
    expect(withPage.then?.argv).toEqual(['gbrain', 'sync', '--source', 'notes-example', '--no-pull']);
    expect(withPage.why).toContain('the takes fence (body), row 3, column who, at line 7');
    expect(deriveNext(withPage, cli)).toBe('run');
    const missing = gitHoldFix(fenceHold({ page_id: null }));
    expect(missing.argv).toEqual(['gbrain', 'sources', 'status', 'notes-example', '--json']);
    for (const fix of [withPage, missing]) expect(JSON.stringify(fix)).not.toContain('repair frontmatter');
    expect(gitHoldFix(frontmatterHold()).argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'notes-example', '--include-ambiguous']);
  });

  test('items carry the fence location and the reason anchor; the hold line names the location and the sync', () => {
    const item = gitHoldItem(fenceHold());
    expect(item).toMatchObject({ code: 'invalid_fence', reason: 'holder_unresolved', fence: location, docs: 'docs/guides/write-refusals.md#fence-holder_unresolved' });
    expect(gitHoldDocs('invalid_fence', 'prepare_time')).toBe('docs/guides/write-refusals.md#fence-prepare_time');
    expect(gitHoldDocs('invalid_frontmatter', 'yaml_parse')).toBe('docs/guides/write-refusals.md#invalid_frontmatter-yaml_parse');
    const line = holdLine(item, 'Held');
    expect(line).toContain('invalid_fence (holder_unresolved) in the takes fence (body), row 3, column who, at line 7');
    expect(line).toContain('then gbrain sync --source notes-example --no-pull');
  });

  test('a fence hold an older fence screen wrote is re-screened; a current one only when retried or its bytes change', () => {
    expect(holdRescreenDue(fenceHold(), false)).toBe(false);
    expect(holdRescreenDue(fenceHold(), true)).toBe(true);
    expect(holdRescreenDue(fenceHold({ meta: { ...fenceHold().meta, fence_version: FENCE_VERSION - 1 } }), false)).toBe(true);
    expect(holdRescreenDue(fenceHold({ meta: { ...fenceHold().meta, fence_version: undefined } }), false)).toBe(true);
    expect(holdRescreenDue({ ...frontmatterHold(), code: 'frontmatter_slug_conflict' }, false)).toBe(true);
  });
});

describe('source-level routing (sync results, doctor, read notices, retry-held)', () => {
  test('fence-only, frontmatter-only and mixed sources name the right steps', () => {
    const fences = holdRepairSteps('notes-example', { fences: 2, others: 0 });
    expect(fences.argv).toEqual(['gbrain', 'sources', 'status', 'notes-example', '--json']);
    expect(fences.text).toContain('gbrain sync --source notes-example --no-pull');
    expect(fences.text).not.toContain('frontmatter');
    const frontmatter = holdRepairSteps('notes-example', { fences: 0, others: 2 });
    expect(frontmatter.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'notes-example']);
    expect(frontmatter.text).not.toContain('fence');
    const mixed = holdRepairSteps('notes-example', { fences: 1, others: 1 });
    expect(mixed.text).toContain('gbrain repair frontmatter --source notes-example');
    expect(mixed.text).toContain('gbrain sync --source notes-example --no-pull');
  });

  test('remote callers get the owner handoff for each kind, with no path', () => {
    const fence = hostOperatorFix([{ source_id: 'notes-example', route: { fences: 1, others: 0 } }], 'Held.');
    expect(deriveNext(fence, http)).toBe('tell_user_to_run');
    expect(fence.user_message).toContain("'gbrain sync --source notes-example --no-pull'");
    expect(fence.user_message).not.toContain('repair frontmatter');
    const frontmatter = hostOperatorFix([{ source_id: 'notes-example' }], 'Held.');
    expect(frontmatter.user_message).toContain("'gbrain repair frontmatter --source notes-example' on the brain host");
    const remote = fileHeldField({ record: fenceHold(), revision: 'r1' }, true);
    expect(remote.path).toBeUndefined();
    expect(remote.fence).toEqual({ ...location, rows: [] });
    expect(remote.fix.actor).toBe('host_admin');
    expect(fileHeldField({ record: fenceHold(), revision: 'r1' }, false)).toMatchObject({ path: 'people/a-founder.md', fence: location });
    expect(recordRoute(fenceHold())).toEqual({ fences: 1, others: 0 });
  });

  test('the held_files notice routes a fence-only source to the status read and the sync', () => {
    const coverage = [{ source_id: 'notes-example', missing: 0, stale: 2, fences: 2 }];
    expect(coverageRoute(coverage[0]!)).toEqual({ fences: 2, others: 0 });
    const local = heldFilesNotice(coverage, false)!;
    expect(local.fix!.argv).toEqual(['gbrain', 'sources', 'status', 'notes-example', '--json']);
    expect(local.fix!.why).toContain('gbrain sync --source notes-example --no-pull');
    const remote = heldFilesNotice(coverage, true)!;
    expect(remote.fix!.actor).toBe('host_admin');
    expect(remote.fix!.user_message).not.toContain('repair frontmatter');
    // A frontmatter-only source keeps its preview.
    expect(heldFilesNotice([{ source_id: 'notes-example', missing: 1, stale: 0 }], false)!.fix!.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'notes-example']);
  });

  test('write refusals over a held fence file and a blocked fence receipt name the fence edit, never frontmatter', () => {
    const held = heldFileDiagnostic(heldFileMessage('drift', 'invalid_fence'), 'notes-example')!;
    expect(held.suggestion).toContain('gbrain sync --source notes-example --no-pull');
    expect(held.suggestion).not.toContain('repair frontmatter');
    expect(heldFileDiagnostic(heldFileMessage('drift', 'invalid_frontmatter'), 'notes-example')!.suggestion).toContain('gbrain repair frontmatter --source notes-example');
    const blocked = writeFailureDiagnostic('invalid_params', fenceHold().message);
    expect(blocked).toMatchObject({ reason: 'invalid_fence', message: fenceHold().message });
    expect(blocked.suggestion).toContain('the takes fence (body), row 3');
    expect(writeFailureDiagnostic('invalid_params', 'The value is invalid.').reason).toBe('invalid_params');
  });
});
