/**
 * decide runtime safety: the per-query decide budget and detached shadow work.
 *
 * Query budget: decide.query_budget_ms bounds ALL decide work of one `query`
 * request (S2 wait, S1 rerank, the S3/S5 and S4 stage); later stages get the
 * remainder and skip with `late`. `think` gets the same budget per call.
 *
 * Shadow isolation: detached shadow work runs in its own budget scope (a
 * dedicated BudgetTracker, not the ambient request tracker), behind a bounded
 * in-flight queue, and registers with the background-work drain so the CLI's
 * bounded teardown awaits it. Coordination is per process.
 */
import { BudgetTracker } from '../../budget/budget-tracker.ts';
import { registerBackgroundWorkDrainer } from '../../background-work.ts';
import { withBudgetTracker } from '../gateway.ts';

/** Stages below this remainder skip with `late` rather than start a call that cannot finish. */
export const MIN_STAGE_MS = 50;

export interface DecideQueryBudget {
  deadlineAt: number;
  remaining(now?: number): number;
}

export function createQueryBudget(budgetMs: number, now = Date.now()): DecideQueryBudget {
  const deadlineAt = now + budgetMs;
  return { deadlineAt, remaining: (t = Date.now()) => Math.max(0, deadlineAt - t) };
}

/** The deadline one stage may use: its own timeout capped by what the query budget has left, or null (`late`). */
export function stageDeadlineMs(budget: DecideQueryBudget | undefined, stageTimeoutMs: number, now = Date.now()): number | null {
  const left = budget ? budget.remaining(now) : stageTimeoutMs;
  const ms = Math.min(stageTimeoutMs, left);
  return ms < MIN_STAGE_MS ? null : ms;
}

const MAX_SHADOW_IN_FLIGHT = 8;
const inFlight = new Set<Promise<unknown>>();

/** Deterministic-enough sampling; tests pass `random`. */
export function sampled(rate: number, random: () => number = Math.random): boolean {
  return rate >= 1 || (rate > 0 && random() < rate);
}

/**
 * Start detached shadow work. Returns false (and runs nothing) when the
 * bounded queue is full. The work runs under its own BudgetTracker so a
 * foreground call near its cap is never charged for shadow spend.
 */
export function runShadow(fn: () => Promise<void>): boolean {
  if (inFlight.size >= MAX_SHADOW_IN_FLIGHT) return false;
  const tracker = new BudgetTracker({ label: 'decide.shadow' });
  const p = withBudgetTracker(tracker, fn).catch(() => { /* shadow never surfaces errors */ });
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return true;
}

export function shadowInFlight(): number {
  return inFlight.size;
}

export async function drainShadow(timeoutMs: number): Promise<{ unfinished: number }> {
  if (inFlight.size === 0) return { unfinished: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); });
  try {
    const r = await Promise.race([Promise.allSettled([...inFlight]).then(() => 'done' as const), bound]);
    return r === 'timeout' ? { unfinished: inFlight.size } : { unfinished: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Shadow work drains before the receipts sink (order 6) so its receipts are buffered in time.
registerBackgroundWorkDrainer({ name: 'decide-shadow', order: 5.5, drain: (timeoutMs) => drainShadow(Math.min(timeoutMs, 1000)) });
