/**
 * #6188 `fence_integrity`: per source, the malformed facts and takes fences
 * still waiting, counted once each across three origins (an `invalid_fence`
 * sync hold, a stored page whose fence fails the coordinated fence step, a
 * working-tree file not yet synced) and split by the tier that would clear
 * it (deterministic Tier 1, resolver, model, manual edit); the oldest
 * unresolved hold's age; and the 7-day trend of fences Tier 1 normalized with
 * its top writers, warning at `FENCE_NORMALIZATION_WARN_7D`.
 *
 * Each run first advances the stored census within a bounded scan
 * (`GBRAIN_DOCTOR_FENCE_TIMEOUT_MS`, default 10 s), then reports the stored
 * summary. A census the scan did not finish is `partial` and never reports
 * ok; the next run resumes where it stopped. Output is location only: slugs,
 * paths, fences, rows, reasons and tiers, never a cell value.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { runFenceCensus, summarizeFenceCensus, type SourceCensus, type TierCounts } from '../../../core/fence-repair/census.ts';
import { readTrend, type TrendEntry } from '../../../core/fence-repair/census-store.ts';
import { readFenceRepairCaps } from '../../../core/fence-repair/config.ts';
import { STRUCTURED_WRITE_ADVICE } from '../../../core/fence-repair/report.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../../../core/budget/daily-ledger.ts';

/**
 * A source whose writers made Tier 1 normalize this many pages or files in
 * the last 7 days warns: something keeps emitting malformed fences, and each
 * normalized write returns a page that differs from what was sent.
 */
export const FENCE_NORMALIZATION_WARN_7D = 20;
const TREND_DAYS = 7;
const DOCS = 'docs/guides/write-refusals.md#invalid_fence';

/** `GBRAIN_DOCTOR_FENCE_TIMEOUT_MS` (default 10 s): the wall-clock bound of one census scan. */
export function fenceScanTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_FENCE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

interface SourceTrend { source_id: string; normalized_7d: number; by_day: Array<{ day: string; count: number }>; top_writers: Array<{ writer: string; count: number }> }

function sourceTrend(sourceId: string, days: readonly TrendEntry[]): SourceTrend {
  const writers = new Map<string, number>();
  for (const day of days) for (const [writer, n] of Object.entries(day.writers)) writers.set(writer, (writers.get(writer) ?? 0) + n);
  return { source_id: sourceId, normalized_7d: days.reduce((sum, day) => sum + day.count, 0), by_day: days.map(day => ({ day: day.day, count: day.count })),
    top_writers: [...writers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([writer, count]) => ({ writer, count })) };
}

const tiers = (counts: TierCounts) => (['deterministic', 'resolver', 'llm', 'manual'] as const).filter(t => counts[t]).map(t => `${t} ${counts[t]}`).join(', ');

function sourceLine(census: SourceCensus, now: number): string {
  const parts = [census.holds.total ? `${census.holds.total} held file(s)` : '', census.pages.total ? `${census.pages.total} stored page(s)` : '',
    census.files.total ? `${census.files.total} unsynced file(s)` : ''].filter(Boolean);
  const age = census.oldest_hold_at ? `; oldest hold ${Math.max(0, Math.round((now - Date.parse(census.oldest_hold_at)) / 3_600_000))} h old` : '';
  return `${census.source_id}: ${parts.join(', ')} (by tier: ${tiers(census.by_tier)})${age}`;
}

/** The next step for one source, from the PR1/PR2 contract: holds and files are edited and synced, stored pages are read and written again. */
function sourceFix(census: SourceCensus) {
  if (census.holds.total) {
    return agentFix(['gbrain', 'sources', 'status', census.source_id, '--json'], `Lists each held file of ${census.source_id} with the fence, section, rows and reason; `
      + `read its page with gbrain get --source ${census.source_id} -- <slug>, edit that fence in the file, commit, then run gbrain sync --source ${census.source_id} --no-pull.`,
    'fence_integrity', { docs: DOCS });
  }
  const page = census.sample.find(c => c.bucket === 'page');
  if (census.pages.total && page) {
    return agentFix(['gbrain', 'get', '--source', census.source_id, '--', page.key], `Reads ${page.key}; write it again with put_page so gbrain normalizes a fixable fence `
      + `(it reports fences_normalized), or correct the fence the refusal names first. ${STRUCTURED_WRITE_ADVICE}`, 'fence_integrity', { docs: DOCS });
  }
  return agentFix(['gbrain', 'sync', '--source', census.source_id, '--no-pull'], `Syncs ${census.source_id}: a fixable fence is rewritten and committed, and any other `
    + 'is held with its fence, rows and reason (gbrain sources status names them) so you can edit that fence and sync again.', 'fence_integrity', { docs: DOCS });
}

/** The check's verdict after a bounded census scan. */
export async function fenceIntegrityResult(engine: BrainEngine, opts: { timeoutMs?: number; now?: () => Date } = {}): Promise<Omit<Check, 'name'>> {
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? fenceScanTimeoutMs();
  const runs = await runFenceCensus(engine, { deadline: now().getTime() + timeoutMs, now });
  const census = await summarizeFenceCensus(engine, undefined, runs);
  const from = new Date(now().getTime() - (TREND_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const trendRows = await readTrend(engine, census.map(c => c.source_id), from);
  const trend = census.map(c => sourceTrend(c.source_id, trendRows.get(c.source_id) ?? []));
  const caps = await readFenceRepairCaps(engine);
  const today = await dailyLedger(engine, FENCE_REPAIR_LEDGER, { now }).readDay().catch(() => null);
  const waiting = census.filter(c => c.total);
  const partial = census.filter(c => !c.scan.complete);
  const noisy = trend.filter(t => t.normalized_7d >= FENCE_NORMALIZATION_WARN_7D);
  const total = waiting.reduce((sum, c) => sum + c.total, 0);
  const details = {
    total, partial: partial.length > 0, partial_sources: partial.map(c => c.source_id), sources: census, trend, warn_at_normalized_7d: FENCE_NORMALIZATION_WARN_7D,
    model_repair: { max_usd_per_page: caps.perPageUsd, max_usd_per_day: caps.perDayUsd, spent_today_usd: today?.committedUsd ?? null, reserved_today_usd: today?.reservedUsd ?? null },
    timeout_ms: timeoutMs, docs: DOCS,
  };
  if (!total && !partial.length && !noisy.length) {
    return { status: 'ok', details, message: census.length ? `No malformed facts or takes fence is held, stored or waiting in a checkout (${census.length} source(s) scanned).` : 'No sources to scan.' };
  }
  const at = now().getTime();
  const sentences: string[] = [];
  if (total) {
    sentences.push(`${total} malformed facts or takes fence(s) wait: ${waiting.map(c => sourceLine(c, at)).join('; ')}. `
      + 'Deterministic ones are rewritten losslessly the next time the file syncs or the page is written; the others need the named fence edited (none of them blocks a sync).');
    if (waiting.some(c => c.by_tier.llm)) sentences.push(caps.perDayUsd === 0
      ? 'Model repair spend is off (fences.repair.max_usd_per_day 0).'
      : `Model repair caps: $${caps.perPageUsd.toFixed(2)} per page, $${caps.perDayUsd.toFixed(2)} per day${today ? ` ($${today.committedUsd.toFixed(2)} spent today)` : ''}.`);
  }
  if (noisy.length) {
    sentences.push(`Writers keep sending malformed fences: ${noisy.map(t => `${t.source_id} had ${t.normalized_7d} normalized in ${TREND_DAYS} days`
      + `${t.top_writers.length ? ` (top writers: ${t.top_writers.map(w => `${w.writer} ${w.count}`).join(', ')})` : ''}`).join('; ')} (warns at ${FENCE_NORMALIZATION_WARN_7D}). `
      + `Fix the generator; a normalized page differs from what was sent. ${STRUCTURED_WRITE_ADVICE}`);
  }
  if (partial.length) {
    sentences.push(`PARTIAL CENSUS: the scan of ${partial.map(c => c.source_id).join(', ')} did not finish within ${timeoutMs / 1000}s, so more fences may be malformed; `
      + 'run gbrain doctor --only fence_integrity again to resume it (raise GBRAIN_DOCTOR_FENCE_TIMEOUT_MS for a larger share per run).');
  }
  const first = waiting[0];
  const fix = first ? sourceFix(first)
    : partial.length ? agentFix(['gbrain', 'doctor', '--only', 'fence_integrity', '--json'], 'Resumes the fence census where the last scan stopped and reports what it found.', 'fence_integrity', { docs: DOCS })
      : agentFix(['gbrain', 'sources', 'status', noisy[0]!.source_id, '--json'], `Shows ${noisy[0]!.source_id}'s recent sync result, including fences_normalized with sample paths, so you can find what writes the malformed fences.`,
        'fence_integrity', { docs: DOCS });
  return { status: 'warn', details, fix, message: sentences.join(' ') };
}

async function runFenceIntegrity(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('fence_integrity');
  try {
    checks.push({ name: 'fence_integrity', ...await fenceIntegrityResult(engine) });
  } catch (error) {
    checks.push({ name: 'fence_integrity', status: 'warn', fix_unavailable_reason: 'check_errored', details: { health: 'unknown' },
      message: `The fence census could not run: ${error instanceof Error ? error.message : String(error)}. Fence health is unknown; run gbrain doctor --only fence_integrity again.` });
  }
  return checks;
}

export const fenceIntegrityEntry: DoctorEntry = { name: 'fence_integrity', emits: ['fence_integrity'], run: runFenceIntegrity };
