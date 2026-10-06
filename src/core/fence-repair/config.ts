/**
 * #6188: the inline fence normalization switch. `fences.normalize` (default
 * true, opt-out) lets Tier 1 rewrite a fixable facts or takes fence on write
 * paths; false restores refusing (coordinated writers) or storing as written
 * (legacy importers). It is read only when a write actually has something to
 * normalize, so a clean write never pays the config read.
 */
import type { BrainEngine } from '../engine.ts';

export const FENCES_NORMALIZE_KEY = 'fences.normalize';
/** Every `fences.*` key `gbrain config set` accepts. */
export const FENCE_CONFIG_KEYS: readonly string[] = [FENCES_NORMALIZE_KEY];

const TRUE = /^(true|1|on|yes)$/i;
const FALSE = /^(false|0|off|no)$/i;

/** Null when the value is valid for the key; otherwise the refusal text (nothing is written). */
export function validateFenceConfigValue(key: string, value: string): string | null {
  if (!FENCE_CONFIG_KEYS.includes(key)) return `Unknown config key "${key}". fences keys: ${FENCE_CONFIG_KEYS.join(', ')}. Nothing was written.`;
  if (TRUE.test(value.trim()) || FALSE.test(value.trim())) return null;
  return `${key} must be true or false (got "${value}"). Nothing was written.`;
}

/** The effective switch: on unless explicitly set false. A config read error keeps the default (on). */
export async function fencesNormalizeEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  try {
    const value = await engine.getConfig(FENCES_NORMALIZE_KEY);
    return !(typeof value === 'string' && FALSE.test(value.trim()));
  } catch {
    return true;
  }
}
