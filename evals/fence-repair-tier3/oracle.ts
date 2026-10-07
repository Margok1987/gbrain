/**
 * The $0 oracle for the Tier 3 fence-repair eval (#6188 T4): every fixture
 * through the production path (`run-case.ts`) with a scripted model, to
 * prove the labels before any paid run.
 *
 * - repairable: the model answers with the ground-truth rows; the repair
 *   must pass every gate and equal `expected` byte for byte. Fixtures tagged
 *   `no_row_numbers` also run with the `#` cells left empty (prompt rule 3);
 *   Tier 1 must then number them to the same result.
 * - gate_limited: the ground-truth answer must be rejected by a gate.
 * - adversarial/ambiguous: the probe (a wrong guess) must be accepted, which
 *   shows only the model can keep the page held.
 * - adversarial/unrecoverable: the probe (an invented value) must be rejected.
 *
 * Every fixture must also reach Tier 3 with the residual reason its class names.
 */
import { __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../../src/core/budget/daily-ledger.ts';
import { attemptStore } from '../../src/core/fence-repair/attempts.ts';
import { analyzeFences } from '../../src/core/fence-repair/repair-tiers.ts';
import { extractRawRows, primaryFence } from '../../src/core/fence-repair/raw-rows.ts';
import type { Tier3Request } from '../../src/core/fence-repair/llm.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { Fixture } from './generate-fixtures.ts';
import { fixtureTarget, runCase } from './run-case.ts';

const REASON_OF: Record<string, string | null> = {
  short_row_trailing: 'short_row', short_row_gap: 'short_row', no_header: 'no_header', row_before_header: 'row_before_header',
  extra_cells: 'extra_cells', header_unmapped: 'header_unmapped', mixed: null,
};

export type AnswerFn = (f: Fixture, req: Tier3Request, variant: 'as_written' | 'blank_numbers') => string;

/** The scripted answer: the probe, or the expected page's rows at the sent positions under the expected header. */
export const oracleAnswers: AnswerFn = (f, req, variant) => {
  if (f.probe) return f.probe;
  const expected = f.expected!;
  const text = req.section === 'body' ? expected.compiled_truth : expected.timeline;
  const fence = primaryFence(extractRawRows(text, req.section), req.kind)!;
  const header = text.slice(fence.header!.start, fence.header!.end);
  const sep = fence.separators[0]!;
  const rows = req.rows.map(r => {
    const row = fence.rows[r.occurrence]!;
    const line = text.slice(row.start, row.end);
    return variant === 'blank_numbers' ? line.replace(/^\|\s*\d+\s*\|/, '|  |') : line;
  });
  return [header, text.slice(sep.start, sep.end), ...rows].join('\n');
};

const result = (text: string): ChatResult => ({ text, blocks: [], stopReason: 'end',
  usage: { input_tokens: 600, output_tokens: 120, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-4-7', providerId: 'anthropic' });

export async function runOracle(fixtures: readonly Fixture[], answer: AnswerFn): Promise<string[]> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [src] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  const deps = { ledger: dailyLedger(engine, FENCE_REPAIR_LEDGER), store: attemptStore(engine), model: 'anthropic:claude-opus-4-7', capSource: 'default' as const,
    perPageUsd: 0.05, perDayUsd: 1000, timeoutMs: 30_000, now: () => new Date() };
  const violations: string[] = [];
  try {
    for (const f of fixtures) {
      const variants: Array<'as_written' | 'blank_numbers'> = f.set === 'repairable' && f.tags.includes('no_row_numbers') ? ['as_written', 'blank_numbers'] : ['as_written'];
      for (const variant of variants) {
        const run = variant === 'as_written' ? f : { ...f, id: `${f.id}~blank` };
        const analysis = await analyzeFences(engine, fixtureTarget(run), { pageId: null });
        if (analysis.status !== 'llm') {
          violations.push(`${f.id}: the free tiers returned ${analysis.status}${analysis.status === 'manual' ? ` (${analysis.reason})` : ''}; it must reach Tier 3`);
          continue;
        }
        const want = REASON_OF[f.cls];
        if (want && !analysis.residual.some(i => i.reason === want)) violations.push(`${f.id}: residual ${analysis.residual.map(i => i.reason).join(',')} lacks ${want}`);
        const byFence = new Map(analysis.requests.map(req => [`${req.kind}:${req.section}`, answer(f, req, variant)]));
        __setChatTransportForTests(async opts => {
          const first = String(opts.messages[0]!.content);
          const m = /^Fence: (facts|takes) \((body|timeline) section\)/.exec(first);
          return result(byFence.get(`${m?.[1]}:${m?.[2]}`) ?? '');
        });
        const out = await runCase(engine, src!.incarnation, run, deps);
        const tag = `${f.id}${variant === 'blank_numbers' ? ' (# left empty)' : ''}`;
        if (process.env.ORACLE_VERBOSE) console.error(`${tag}: ${out.outcome} ${out.reason ?? ''} ${out.gate ?? ''} residual=${out.residual.join(',')} requests=${out.requests}`);
        if (f.set === 'repairable') {
          if (out.outcome !== 'repaired') violations.push(`${tag}: ground truth held (${out.reason}${out.gate ? `, gate ${out.gate} rows ${out.rows.join(',')}` : ''})`);
          else if (out.after!.compiled_truth !== f.expected!.compiled_truth || out.after!.timeline !== f.expected!.timeline) {
            violations.push(`${tag}: repaired page differs from expected:\n--- got\n${out.after!.compiled_truth}${out.after!.timeline}\n--- want\n${f.expected!.compiled_truth}${f.expected!.timeline}`);
          }
        } else if (f.set === 'gate_limited') {
          if (out.outcome === 'repaired' || !out.gate) violations.push(`${tag}: expected a gate rejection, got ${out.outcome} ${out.reason ?? ''}`);
        } else if (f.adversarial === 'ambiguous') {
          if (out.outcome !== 'repaired') violations.push(`${tag}: the ambiguous probe was rejected (${out.reason}${out.gate ? `, gate ${out.gate}` : ''}); the gates can already hold it`);
        } else if (out.outcome === 'repaired') violations.push(`${tag}: the unrecoverable probe was accepted`);
      }
    }
  } finally {
    __setChatTransportForTests(null);
    await engine.disconnect();
  }
  return violations;
}
