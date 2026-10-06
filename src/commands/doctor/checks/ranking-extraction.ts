/**
 * Ranking and extraction settings: the brain's inbound-degree shape next to
 * the resolved hub-dampening half degree, and which LLM extraction prompts
 * resolve relative dates against the source's observation date.
 *
 * Both are informational (status ok): they report state and the next step,
 * never a recommended value — a degree histogram is not a relevance prior.
 */

import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';
import { loadSearchModeConfig, resolveSearchMode } from '../../../core/search/mode.ts';
import { getExtractorVariant, isConsumerDateGroundingOn } from '../../../core/facts/extract.ts';

async function runHubDegreeShape(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const modeInput = await loadSearchModeConfig(engine);
    const halfDegree = resolveSearchMode({ mode: modeInput.mode, overrides: modeInput.overrides }).hub_dampening;
    const [row] = await engine.executeRaw<{ pages: number; p50: number | null; p90: number | null; p99: number | null; max: number | null; above: number }>(
      `WITH d AS (
         SELECT p.id, COUNT(DISTINCT l.from_page_id)::int AS n
         FROM pages p LEFT JOIN links l ON l.to_page_id = p.id AND l.from_page_id <> p.id
           AND l.link_source IS DISTINCT FROM 'mentions'
         WHERE p.deleted_at IS NULL GROUP BY p.id)
       SELECT COUNT(*)::int AS pages,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS p50,
         percentile_disc(0.9) WITHIN GROUP (ORDER BY n) AS p90,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY n) AS p99,
         MAX(n) AS max,
         COUNT(*) FILTER (WHERE $1::float8 > 0 AND n > $1::float8 + 1)::int AS above
       FROM d`, [typeof halfDegree === 'number' ? halfDegree : 0]);
    const shape = `inbound links per page p50 ${row?.p50 ?? 0}, p90 ${row?.p90 ?? 0}, p99 ${row?.p99 ?? 0}, max ${row?.max ?? 0} over ${row?.pages ?? 0} pages`;
    const setting = typeof halfDegree === 'number'
      ? `hub dampening at half degree ${halfDegree}: ${row?.above ?? 0} page(s) keep less than half of their backlink/graph lift.`
      : 'hub dampening is off (search.hub_dampening).';
    checks.push({
      name: 'hub_degree_shape',
      status: 'ok',
      message: `${shape}; ${setting} To see whether hub pages crowd a query, run gbrain search "<query>" --explain and read each row's backlink inbound count and hub weight.`,
    });
  } catch {
    checks.push(checkError('hub_degree_shape', 'read the inbound link degree shape'));
  }
  return checks;
}

export const hubDegreeShapeEntry: DoctorEntry = {
  name: 'hub_degree_shape',
  emits: ['hub_degree_shape'],
  run: runHubDegreeShape,
};

/** Prompts grounded by default with fact extraction, and the ones that need the setting set on explicitly. */
const DEFAULT_CONSUMERS = 'fact extraction, dream synthesis, extract_atoms and propose_takes';
const OPT_IN_LABEL = 'life chronicle events';

async function runExtractionDateGrounding(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const [variant, optIn] = await Promise.all([getExtractorVariant(engine), isConsumerDateGroundingOn(engine, 'chronicle')]);
  const reextract = 'Facts extracted before this was on keep their original wording; re-extract a source only with the user\'s consent (gbrain extract-conversation-facts --source-id <id> --dry-run previews it).';
  checks.push({
    name: 'extraction_date_grounding',
    status: 'ok',
    message: !variant.dateGrounding
      ? 'extraction.date_grounding is off: extraction prompts keep relative dates ("last week") as written. Dated pages still store their facts at the page date.'
      : optIn
        ? `Relative dates resolve against each source's observation date in ${DEFAULT_CONSUMERS}, and in ${OPT_IN_LABEL} (set on explicitly). ${reextract}`
        : `Relative dates resolve against each source's observation date in ${DEFAULT_CONSUMERS} (the default). ${OPT_IN_LABEL} keep their current prompt unless extraction.date_grounding is set to true. ${reextract}`,
  });
  return checks;
}

export const extractionDateGroundingEntry: DoctorEntry = {
  name: 'extraction_date_grounding',
  emits: ['extraction_date_grounding'],
  run: runExtractionDateGrounding,
};
