/**
 * Repair steps in the doctor remediation plan and run (fix wave 3, Lane D).
 *
 * Every registered `gbrain repair` kind is previewed brain-wide; a kind with
 * pending items becomes a PROTECTED, local-only step that needs the user's
 * agreement (`--include-repairs`). Repair steps are independent of the brain
 * score target: `--target-score` governs job steps only, and an included
 * repair step always runs to completion. A paid step (one that may queue
 * embeddings or call a paid chat model) is not started when its estimate
 * exceeds the remaining budget; free steps still run. A `spends: 'llm'` step
 * runs with what is left of the cap as its paid-model allowance, under the
 * caller's own budget tracker, and its actual model spend is reconciled into
 * the caller's accounting once. Repairs run in-process on the brain host through the
 * same runner `gbrain repair` uses, never as Minion jobs. Explicit-only kinds
 * are never planned or run here: the plan lists them with their preview
 * command, and `runRepairSteps` refuses a supplied step that names one. A kind
 * whose preview fails (a statement timeout on a large brain, #6000) is
 * reported with its preview command and left out; the other kinds still plan.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../repair/core.ts';
import { AUTO_REPAIR_REGISTRY, explicitKindRequired, repairApplyCommand, repairMayEmbed, repairRunner, repairSpec, type RepairKindSpec } from '../repair/registry.ts';
import { cliRenderContext, renderAction, type RenderedAction } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';
import { isStatementTimeoutError } from '../retry-matcher.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';

export interface RepairPlanStep {
  step: number;
  id: string;
  kind: RepairKind;
  affected: number;
  /** The exact command that applies this step alone. */
  command: string;
  requires_user_agreement: true;
  protected: true;
  /** May spend: on embeddings (a model is configured and the kind embeds under these flags), or on a paid chat model (`spends: 'llm'`). */
  paid: boolean;
  /** `effect`: the persistence consumer embeds after publication, so the estimate is charged against the cap up front. `none`: never embeds. */
  embeds: 'effect' | 'inline' | 'none';
  /** USD estimate (embeddings plus `llm_usd`); null when the step is paid and a model price is unknown. */
  est_usd_cost: number | null;
  /** `spends: 'llm'` kinds only: the paid chat model part of `est_usd_cost` (null when that model is unpriced under a user-set cap). */
  llm_usd?: number | null;
  lifetime_ids: number;
  checks: string[];
  rationale: string;
}

export type RepairStepStatus = 'completed' | 'stopped' | 'failed' | 'budget_refused' | 'budget_exhausted';

export interface RepairStepResult {
  id: string;
  kind: RepairKind;
  status: RepairStepStatus;
  applied: number;
  skipped: number;
  message?: string;
}

/** A kind whose preview threw: it is not planned, and its preview command shows the error again. */
export interface RepairPreviewFailure { kind: RepairKind; code: 'timeout' | 'preview_failed'; message: string; why: string; fix: RenderedAction }

function repairPreviewFailure(kind: RepairKind, error: unknown): RepairPreviewFailure {
  const timeout = isStatementTimeoutError(error);
  return {
    kind,
    code: timeout ? 'timeout' : 'preview_failed',
    message: redactConnectionInfo(error instanceof Error ? error.message : String(error)).slice(0, 300),
    why: timeout
      ? `The ${kind} preview ran past the database statement timeout (GBRAIN_STATEMENT_TIMEOUT), so this kind was neither planned nor run; the other kinds are unaffected.`
      : `The ${kind} preview failed, so this kind was neither planned nor run; the other kinds are unaffected.`,
    fix: renderAction({
      ...readFix(`Re-runs the read-only ${kind} preview on the brain host; it changes nothing and shows the error again.`, { argv: ['gbrain', 'repair', kind] }),
      verify: { argv: ['gbrain', 'doctor', '--remediation-plan', '--json'] },
    }, cliRenderContext()),
  };
}

/**
 * Brain-wide preview of every kind `--all` runs; kinds with nothing pending are omitted.
 * With `onPreviewError`, a kind whose preview throws is reported there and left out, and the
 * rest still plan; without it the error propagates. `registry` replaces the registered kinds (tests).
 */
export async function planRepairSteps(engine: BrainEngine, opts: {
  noEmbed?: boolean; kinds?: readonly RepairKind[]; onPreviewError?: (failure: RepairPreviewFailure) => void; registry?: readonly RepairKindSpec[];
} = {}): Promise<RepairPlanStep[]> {
  const scope = await resolveRepairScope(engine);
  const runner = await repairRunner(engine, { apply: false, noEmbed: opts.noEmbed, logger: { info() {}, warn() {}, error() {} }, registry: opts.registry });
  const steps: RepairPlanStep[] = [];
  for (const spec of opts.registry?.filter(entry => !entry.explicit_only) ?? AUTO_REPAIR_REGISTRY) {
    if (opts.kinds && !opts.kinds.includes(spec.kind)) continue;
    let preview: RepairResult;
    try {
      preview = await runner.run(spec.kind, scope);
    } catch (error) {
      if (!opts.onPreviewError) throw error;
      opts.onPreviewError(repairPreviewFailure(spec.kind, error));
      continue;
    }
    // contextual-mode stamps only sealed pages; pages the safe-chunks step re-seals become eligible during the run.
    const unlocked = spec.kind === 'contextual-mode' && steps.some(step => step.kind === 'safe-chunks') ? Number(preview.residuals.unsealed_projection ?? 0) : 0;
    if (!preview.affected && !unlocked) continue;
    const embedPaid = repairMayEmbed(spec, opts.noEmbed) && runner.embeddingModel !== undefined;
    const embedUsd = embedPaid ? preview.cost.embedding_usd : 0;
    const llmUsd = spec.spends === 'llm' ? preview.cost.llm_usd ?? null : undefined;
    steps.push({ step: steps.length + 1, id: `repair:${spec.kind}`, kind: spec.kind, affected: preview.affected + unlocked,
      command: repairApplyCommand(spec.kind, { noEmbed: opts.noEmbed }), requires_user_agreement: true, protected: true,
      paid: embedPaid || llmUsd !== undefined, embeds: spec.embeds,
      est_usd_cost: embedUsd === null || llmUsd === null ? null : embedUsd + (llmUsd ?? 0), ...(llmUsd !== undefined ? { llm_usd: llmUsd } : {}),
      lifetime_ids: preview.cost.lifetime_ids, checks: spec.checks,
      rationale: `${preview.affected} item(s) pending for gbrain repair ${spec.kind}${unlocked ? `, plus up to ${unlocked} after safe-chunks re-seals them` : ''}` });
  }
  return steps;
}

/**
 * Apply repair steps in order. `remainingUsd()` is the budget still available
 * (undefined = no cap); a paid step whose estimate exceeds it (or cannot be
 * estimated under a cap) is refused before it starts and the run continues
 * with the next step. Only a trusted local caller may run repairs, and a step
 * naming an explicit-only kind refuses the whole run before any step starts.
 *
 * A `spends: 'llm'` step reserves only its embedding part up front, runs with
 * what is left as its paid-model allowance (`maxLlmUsd`) under the caller's
 * tracker (never inside `stepBudget`), and afterwards charges the part of its
 * actual model spend (`cost.llm_usd`) that `spentUsd()` did not already rise
 * by during the step, so spend the caller's tracker metered counts once.
 */
export async function runRepairSteps(engine: BrainEngine, steps: RepairPlanStep[], opts: {
  remote: boolean; noEmbed?: boolean; remainingUsd: () => number | undefined;
  /** Reserve spend the consumer will make after publication (effect kinds), and settle paid-model spend no tracker metered. */
  charge?: (usd: number) => void;
  /** What the caller has accounted so far (tracker spend plus charges); without it, a step's whole model spend is charged. */
  spentUsd?: () => number;
  /** True once the run's budget tracker fired, even if a callee swallowed the throw. */
  exhausted?: () => boolean;
  /** Runs one in-process paid step under a tracker capped at what is left after reservations. */
  stepBudget?: <T>(run: () => Promise<T>) => Promise<T>;
  onStep?: (step: RepairPlanStep, result: RepairStepResult) => void;
  /** Replaces the registered kinds (tests). */
  registry?: readonly RepairKindSpec[];
}): Promise<RepairStepResult[]> {
  if (opts.remote !== false) throw new OperationError('permission_denied', 'Repair steps are PROTECTED: only a trusted local caller on the brain host can run them.',
    'On the brain host, run: gbrain doctor --remediation-plan');
  const explicit = steps.find(step => repairSpec(step.kind, opts.registry)?.explicit_only);
  if (explicit) throw explicitKindRequired(explicit.kind);
  const { BudgetExhausted } = await import('../budget/budget-tracker.ts');
  const scope = await resolveRepairScope(engine);
  const runner = await repairRunner(engine, { apply: true, noEmbed: opts.noEmbed, registry: opts.registry });
  const results: RepairStepResult[] = [];
  for (const step of steps) {
    const base = { id: step.id, kind: step.kind, applied: 0, skipped: 0 };
    let result: RepairStepResult;
    const remaining = opts.remainingUsd();
    if (step.paid && remaining !== undefined && (step.est_usd_cost === null || step.est_usd_cost > remaining)) {
      result = { ...base, status: 'budget_refused', message: step.est_usd_cost === null
        ? `Not started: its ${step.llm_usd === null ? 'paid-model' : 'embedding'} cost cannot be estimated and a --max-usd cap is set ($${remaining.toFixed(2)} remaining).`
        : `Not started: estimated $${step.est_usd_cost.toFixed(4)} exceeds the $${remaining.toFixed(4)} remaining under --max-usd.` };
    } else if (step.paid && opts.exhausted?.()) {
      result = { ...base, status: 'budget_refused', message: 'Not started: the --max-usd budget ran out earlier in this run.' };
    } else {
      const llm = step.llm_usd !== undefined;
      if (step.paid && step.embeds === 'effect' && step.est_usd_cost) opts.charge?.(step.est_usd_cost - (step.llm_usd ?? 0));
      const spentBefore = opts.spentUsd?.() ?? 0;
      try {
        const applied = llm ? await runner.run(step.kind, scope, { maxLlmUsd: opts.remainingUsd() })
          : step.paid && step.embeds === 'inline' && opts.stepBudget ? await opts.stepBudget(() => runner.run(step.kind, scope)) : await runner.run(step.kind, scope);
        if (llm) opts.charge?.(Math.max(0, (applied.cost.llm_usd ?? 0) - ((opts.spentUsd?.() ?? 0) - spentBefore)));
        result = { ...base, applied: applied.applied, skipped: applied.skipped,
          status: applied.stopped?.reason === 'budget_exhausted' ? 'budget_exhausted' : applied.stopped ? 'stopped' : applied.complete ? 'completed' : 'stopped',
          ...(applied.stopped ? { message: applied.stopped.message } : {}) };
        // A callee (for example the stale-embedding pass) may swallow BudgetExhausted; the tracker still knows.
        if (step.paid && step.embeds === 'inline' && opts.exhausted?.()) result = { ...result, status: 'budget_exhausted',
          message: 'The --max-usd budget ran out during the step; re-sealed pages keep their text, and the rest of their embeddings resume with the printed resume command or gbrain embed --stale.' };
      } catch (error) {
        if (error instanceof BudgetExhausted) result = { ...base, status: 'budget_exhausted', message: `Budget exhausted during the step: ${error.message}` };
        else result = { ...base, status: 'failed', message: error instanceof Error ? error.message.slice(0, 300) : String(error) };
      }
    }
    results.push(result);
    opts.onStep?.(step, result);
  }
  return results;
}
