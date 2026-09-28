import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../takes-fence.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { parseTimelineEntries } from '../link-extraction.ts';
import { extractTimelineFromContent, type ExtractedTimelineEntry } from '../timeline-extract.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { OperationError } from '../ops/contract.ts';

type CanonicalBody = Pick<ParsedPage, 'compiled_truth' | 'timeline'>;

/**
 * The caller's authority over the prior canonical content (#5567):
 * `editing` writers are bound to the observed revision or file preimage,
 * `preserving` writers regenerate or overwrite without that binding, and
 * `immutable` imports publish approved bytes they may never extend.
 */
export type ProjectionWriter = 'editing' | 'preserving' | 'immutable';

/**
 * How one stored timeline row relates to the write, judged at preparation:
 * `in_body` exactly matches a new bullet, `drifted` matches one only after
 * normalization, `removed` had a bullet in the prior body that the new body
 * dropped, and `database_only` has no bullet in either body.
 */
export type TimelineRowState = 'in_body' | 'drifted' | 'removed' | 'database_only';
export type TimelineRowAction = 'refresh_detail' | 'delete' | 'keep';

const KEEP_HISTORY: Record<TimelineRowState, TimelineRowAction> = {
  in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', database_only: 'keep',
};

/**
 *   row state      | editing        | preserving     | immutable
 *   ---------------+----------------+----------------+---------------
 *   in_body        | refresh_detail | refresh_detail | refresh_detail
 *   drifted        | delete         | delete         | delete
 *   removed        | delete         | delete         | delete
 *   database_only  | keep           | keep           | keep
 *
 * A coordinated write deletes only rows whose bullet the writer can see in the
 * prior or new body; a row with no bullet anywhere is history the writer is not
 * editing. Deletes and detail refreshes also require the row id and detail
 * pinned at preparation, so rows that change afterwards are left alone.
 */
const TIMELINE_DECISIONS: Record<ProjectionWriter, Record<TimelineRowState, TimelineRowAction>> = {
  editing: KEEP_HISTORY, preserving: KEEP_HISTORY, immutable: KEEP_HISTORY,
};

export function timelineRowAction(writer: ProjectionWriter, state: TimelineRowState): TimelineRowAction {
  return TIMELINE_DECISIONS[writer][state];
}

/** One normalization for prior-set membership, dedup and stored-row matching. */
function timelineKey(entry: { date: string; source?: string | null; summary: string }): string {
  return JSON.stringify([entry.date.slice(0, 10), sanitizeForJsonb(entry.source ?? '').trim(),
    sanitizeForJsonb(entry.summary).replace(/\s+/g, ' ').trim()]);
}

function exactTimelineKey(entry: { date: string; source?: string | null; summary: string }): string {
  return JSON.stringify([entry.date.slice(0, 10), sanitizeForJsonb(entry.source ?? ''), sanitizeForJsonb(entry.summary)]);
}

function canonicalTimeline(body: CanonicalBody, slug: string): Map<string, ExtractedTimelineEntry> {
  const safe = sanitizeRemoteBody([body.compiled_truth, body.timeline ?? ''].join('\n'));
  const timeline = new Map(extractTimelineFromContent(safe, slug).map(t => [timelineKey(t), t]));
  for (const t of parseTimelineEntries(safe)) timeline.set(timelineKey({ ...t, source: t.source ?? 'markdown' }), { ...t, source: t.source ?? 'markdown', slug });
  return timeline;
}

function canonicalTakeRows(body: CanonicalBody): Set<number> {
  return new Set([body.compiled_truth, body.timeline ?? ''].flatMap(field => parseTakesFence(field).takes.map(t => t.rowNum)));
}

/** Validate a canonical body and compile its provider-free projections. */
export function compileCanonicalProjections(page: ParsedPage, slug: string, sourceId: string) {
  const fields=[page.compiled_truth,page.timeline ?? ''];
  for(const field of fields) for(const marker of [FACTS_FENCE_BEGIN,FACTS_FENCE_END,TAKES_FENCE_BEGIN,TAKES_FENCE_END]) {
    if(field.split(marker).length>2) throw new OperationError('invalid_params','Each canonical body section must contain at most one facts fence and one takes fence.');
  }
  const factSets=fields.map(parseFactsFence),takeSets=fields.map(parseTakesFence);
  if ([...factSets,...takeSets].some(set=>set.warnings.length)) throw new OperationError('invalid_params','A canonical facts or takes fence cannot be parsed losslessly.');
  const facts=factSets.flatMap(set=>set.facts),takes=takeSets.flatMap(set=>set.takes);
  for(const rows of [facts,takes]) if(new Set(rows.map(row=>row.rowNum)).size!==rows.length) {
    throw new OperationError('invalid_params','Canonical row numbers must be unique across the entire page.');
  }
  return { factRows: extractFactsFromFenceText(facts,slug,sourceId), takes, timeline: canonicalTimeline(page,slug) };
}

function takeCollision(): OperationError {
  return new OperationError('take_row_collision', 'A takes fence row number is already used by a different take that is not in this page\'s canonical fence.',
    'Renumber the new takes row, or add the existing take to the fence with a revision-bound put_page.');
}

/**
 * Prepare provider-free projections outside publication. `prior` is the
 * caller's snapshot at its observed revision; stored timeline rows and take
 * row numbers are pinned here so the publication transaction only removes
 * what this writer actually edited.
 */
export async function prepareCanonicalProjections(engine: BrainEngine, page: ParsedPage, slug: string, sourceId: string,
  prior: PageSnapshot | null, writer: ProjectionWriter): Promise<(tx: BrainEngine) => Promise<void>> {
  const { factRows, takes, timeline } = compileCanonicalProjections(page, slug, sourceId);
  const priorTimeline = prior ? new Set(canonicalTimeline(prior.page, slug).keys()) : new Set<string>();
  const exactIncoming = new Map([...timeline.values()].map(t => [exactTimelineKey(t), sanitizeForJsonb(t.detail ?? '')]));
  const stored = prior ? await engine.executeRaw<{ id: number; date: string; source: string; summary: string; detail: string }>(
    `SELECT id,date::text AS date,source,summary,detail FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL`, [prior.page.id]) : [];
  const pinned = stored.map(row => {
    const key = timelineKey(row);
    const state: TimelineRowState = exactIncoming.has(exactTimelineKey(row)) ? 'in_body' : timeline.has(key) ? 'drifted'
      : priorTimeline.has(key) ? 'removed' : 'database_only';
    return { ...row, action: timelineRowAction(writer, state) };
  });
  const deletions = JSON.stringify(pinned.filter(row => row.action === 'delete')
    .map(({ id, date, source, summary, detail }) => ({ id, date, source, summary, detail })));
  const refreshes = JSON.stringify(pinned.filter(row => row.action === 'refresh_detail')
    .map(row => ({ id: row.id, detail: row.detail, next: exactIncoming.get(exactTimelineKey(row)) }))
    .filter(row => row.next !== row.detail));
  const priorTakes = prior ? canonicalTakeRows(prior.page) : new Set<number>();
  const newTakes = JSON.stringify(takes.filter(t => !priorTakes.has(t.rowNum)).map(t => ({ row_num: t.rowNum, claim: t.claim, kind: t.kind, holder: t.holder })));
  const takeRowsGone = [...priorTakes].filter(n => !takes.some(t => t.rowNum === n));
  const collides = async (db: BrainEngine, pageId: number) => (await db.executeRaw(`SELECT 1 FROM takes k
    JOIN jsonb_to_recordset($2::text::jsonb) AS n(row_num integer,claim text,kind text,holder text) ON n.row_num=k.row_num
    WHERE k.page_id=$1 AND (k.claim,k.kind,k.holder) IS DISTINCT FROM (n.claim,n.kind,n.holder) LIMIT 1`, [pageId, newTakes])).length > 0;
  if (prior && await collides(engine, prior.page.id)) throw takeCollision();
  return async tx=>{
    const snapshot=await tx.readPageSnapshot(slug,{sourceId});
    if (!snapshot) return;
    // Fact IDs in permanent receipts remain meaningful when a canonical row is
    // removed/replaced. Expire and detach its row position instead of deleting it.
    const incoming=JSON.stringify(factRows.map(f=>({row_num:f.row_num,fact:f.fact,visibility:f.visibility})));
    await tx.executeRaw(`UPDATE facts f SET expired_at=COALESCE(expired_at,now()),row_num=NULL
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS n(row_num integer,fact text,visibility text)
        WHERE n.row_num=f.row_num AND n.fact=f.fact AND n.visibility=f.visibility)`,[sourceId,slug,incoming]);
    if (factRows.length) {
      await tx.insertFacts(factRows,{source_id:sourceId}); // gbrain-allow-direct-insert: canonical fence projection shares the journal publication transaction
      for (const fact of factRows) await tx.executeRaw(`UPDATE facts SET kind=$4,notability=$5,context=$6,
        valid_from=COALESCE($7::timestamptz,valid_from),valid_until=$8::timestamptz,expired_at=$9::timestamptz,
        source=$10,confidence=$11,claim_metric=$12,claim_value=$13,claim_unit=$14,claim_period=$15
        WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3`,
      [sourceId,slug,fact.row_num,fact.kind,fact.notability,fact.context,fact.valid_from?.toISOString()??null,
        fact.valid_until?.toISOString()??null,fact.expired_at?.toISOString()??null,fact.source,fact.confidence,
        fact.claim_metric??null,fact.claim_value??null,fact.claim_unit??null,fact.claim_period??null]);
    }
    const pageId=snapshot.page.id;
    if (await collides(tx,pageId)) throw takeCollision();
    await tx.executeRaw('DELETE FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])',[pageId,takeRowsGone]);
    if (takes.length) await tx.addTakesBatch(takes.map(t=>takesPreparation.toBatchInput(pageId,t,
      t.active?null:Number(t.source?.match(/superseded by #(\d+)/)?.[1])||null)));
    // Full canonical versions include resolution fields; a revert restores those
    // fields from Markdown too, without the ordinary immutable-resolution API.
    for (const take of takes) await tx.executeRaw(`UPDATE takes SET resolved_at=$3::timestamptz,
      resolved_quality=$4,resolved_outcome=$5,resolved_source=$6,resolved_value=$7,resolved_unit=$8,resolved_by=$9
      WHERE page_id=$1 AND row_num=$2`,[pageId,take.rowNum,take.resolvedAt??null,take.resolvedQuality??null,
        take.resolvedQuality==='correct'?true:take.resolvedQuality==='incorrect'?false:null,
        take.resolvedEvidence??null,take.resolvedValue??null,take.resolvedUnit??null,take.resolvedBy??null]);
    // Event-page references have a different canonical origin and remain intact.
    await tx.executeRaw(`DELETE FROM timeline_entries t USING jsonb_to_recordset($2::text::jsonb) AS d(id integer,date date,source text,summary text,detail text)
      WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=d.id AND t.date=d.date AND t.source=d.source
        AND t.summary=d.summary AND t.detail=d.detail`,[pageId,deletions]);
    // New rows carry their Markdown detail on insert; pinned rows refresh only from their preimage.
    for (const entry of timeline.values()) await tx.addTimelineEntry(slug,entry,{sourceId});
    await tx.executeRaw(`UPDATE timeline_entries t SET detail=r.next FROM jsonb_to_recordset($2::text::jsonb) AS r(id integer,detail text,next text)
      WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=r.id AND t.detail=r.detail`,[pageId,refreshes]);
  };
}
