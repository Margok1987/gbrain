/**
 * Reference calibrations shipped in the binary: produced by the maintainer's
 * eval runs (docs/eval/system-one/), keyed by slot, call site, provider, model
 * and pack_shape, with dataset and split hashes. Used when a brain has no
 * local row; a local row always wins. An enabled slot records the calibration
 * it adopted (`decide.slots.<slot>.calibration`), so a newer binary never
 * silently switches it: `decide status` shows "newer reference available".
 *
 * Empty until a slot's eval records a win; the eval lane appends rows here.
 */
import type { DecideSlot } from './types.ts';

export interface ReferenceCalibration {
  /** Stable id, referenced as `ref:<id>`. */
  id: string;
  slot: DecideSlot;
  call_site: string;
  provider: string;
  model_resolved: string;
  threshold: number;
  min_keep: number | null;
  retest_sd: number;
  repack_sd: number;
  action_precision_lb: number | null;
  policy_fingerprint: string | null;
  pack_shape: string;
  dataset_hash: string;
  split_hash: string;
  /** Recorded eval verdict for the slot on this model. `enable --recommended` needs `win`. */
  verdict: 'win' | 'no_change' | 'regression' | 'not_measured';
  /** Binary version that shipped the row. */
  shipped_in: string;
}

export const REFERENCE_CALIBRATIONS: readonly ReferenceCalibration[] = [];
