/**
 * `gbrain repair fences` (#6188): repairs malformed facts and takes fences.
 * Skeleton: the kind is registered so the CLI, the cycle phase and the
 * surfaces can wire to it; the plan and apply land next.
 *
 * Per-item outcomes (RepairItemOutcome) this kind returns:
 *   - `repaired` (applied): detail `{ tier, classes, mode, path?, slug }`, `llm_usd` for a Tier 3 repair.
 *   - `held` (not applied): `reason` is a FenceReason (gate, llm_*, budget_exhausted, llm_disabled, no_pricing,
 *     manual-only residual, ...), detail `{ tier, mode, path?, slug, gate?, rows? }`.
 *   - `skipped` (not applied): `reason` owner_unavailable | sync_in_progress | changed_since_read | changed_since_preview.
 */
import type { FenceTier } from '../fence-repair/types.ts';
import type { RepairHandler, RepairPlan } from './core.ts';

/** The fences result's `verification` (report hook): what the run did and what is left, for the CLI and the cycle phase report. */
export interface FenceRepairVerification {
  /** Candidates the plan found (after selection). */
  candidates: number;
  repaired_by_tier: Record<Exclude<FenceTier, 'manual'>, number>;
  /** Candidates still waiting after the run, by reason (manual-only residuals, gates, budget, ...). */
  held_by_reason: Record<string, number>;
  /** Oldest unresolved `invalid_fence` hold in scope (ISO), or null. */
  oldest_hold_at: string | null;
  /** Successful Tier 3 repairs in this run and the USD per repair (null when none). */
  llm_repairs: number;
  llm_usd_per_repair: number | null;
  /** The scan behind the plan did not finish. */
  partial: boolean;
}

export const fencesRepair: RepairHandler = {
  kind: 'fences',
  outcomeItemsLimit: 200,
  async plan(): Promise<RepairPlan> {
    return { items: [], residuals: {}, llm: { usd: 0, cap_remaining_usd: null }, scan: { fresh_at: null, partial: true } };
  },
  async apply() {
    return false;
  },
};
