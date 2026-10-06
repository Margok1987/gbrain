/**
 * `gbrain repair fences` (#6188): repairs malformed facts and takes fences.
 * Skeleton: the kind is registered so the CLI, the cycle phase and the
 * surfaces can wire to it; the plan and apply land next.
 */
import type { RepairHandler, RepairPlan } from './core.ts';

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
