/**
 * #5680: the worst-case authorization of an embedding migration — the sum of
 * each planned provider request's maximum input, computed with the gateway's
 * own request plan (embed-batch-plan.ts) over the texts the run will send:
 * the provider probes, every stale chunk grouped per page and wrapped as the
 * drain wraps it, every stale fact in the fact backfill's batches, the
 * completion smoke-check queries, and the reranker probe when the run
 * switches rerankers. The per-request ceiling is additive over texts, so a
 * batch split or retry of the same texts settles from the same headroom.
 */
import type { BrainEngine } from './engine.ts';
import { embedRequestCeilings, rerankRequestMaxInputTokens } from './ai/embed-batch-plan.ts';
import { wrapChunkTextsForStoredMode } from './embedding-context.ts';
import type { CRMode } from './types.ts';
import { readContentChunksEmbeddingDim } from './embedding-dim-check.ts';
import { falseStampPageWhere } from './embedding-invalidation.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from './search/embedding-column.ts';
import { eligibleFactEmbedding, staleFactEmbedding } from './facts/embedding-identity.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import { EMBED_PROBE_TEXT } from './embed-stale.ts';
import { loadPricingOverrides } from './budget/budget-tracker.ts';
import { usageCostUsd } from './budget/reservation-cost.ts';
import type { EmbeddingMigrationPlan } from './embedding-migration.ts';
import type { MigrationWorstCase } from './embedding-migration-budget.ts';

export const MIGRATION_PROBE_TEXT = 'gbrain embedding migration probe';
export const RERANKER_PROBE = {
  query: 'gbrain reranker migration probe',
  documents: ['gbrain reranker migration probe document a', 'gbrain reranker migration probe document b'],
} as const;
/** The drain's projection-readiness probe and its signature-drift probe. */
const DRAIN_PROBES = 2;
/** verifySearchRoundTrip embeds up to 3 sample queries of at most 160 UTF-16 units (≤ 3 UTF-8 bytes each). */
const SMOKE_QUERIES = 3;
const SMOKE_QUERY_MAX_TOKENS = 160 * 3;
/** embedStaleFacts' default batch size. */
const FACT_BATCH = 100;
const SCAN_PAGE = 2000;

interface ChunkRow { page_id: number; chunk_index: number; chunk_text: string; chunk_source: string | null; title: string | null; contextual_retrieval_mode: CRMode | null }
interface FactRow { id: string; source_id: string; fact: string }

async function eachStalePage(engine: BrainEngine, plan: EmbeddingMigrationPlan, visit: (texts: string[]) => void): Promise<void> {
  const column = (await readContentChunksEmbeddingDim(engine)).exists
    ? quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name)
    : null;
  const stale = column === null ? 'true' : `p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
    AND (cc.${column} IS NULL OR p.embedding_signature IS NULL OR p.embedding_signature <> $1
      OR (cc.${column} IS NOT NULL AND ${falseStampPageWhere(column, 1, 2)}))`;
  let page: ChunkRow[] = [];
  const flush = () => { if (page.length) visit(wrapChunkTextsForStoredMode(page[0], page)); page = []; };
  let after = { page: 0, chunk: -1 };
  for (;;) {
    const rows = await engine.executeRaw<ChunkRow>(`SELECT cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
        p.title, p.contextual_retrieval_mode
      FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE ($1::text IS NOT NULL AND $2::text IS NOT NULL) AND ${stale}
        AND (cc.page_id > $3 OR (cc.page_id = $3 AND cc.chunk_index > $4))
      ORDER BY cc.page_id, cc.chunk_index LIMIT ${SCAN_PAGE}`,
    [`${plan.to_model}:${plan.to_dims}`, plan.to_model, after.page, after.chunk]);
    for (const row of rows) {
      if (page.length && page[0].page_id !== row.page_id) flush();
      page.push(row);
    }
    if (rows.length < SCAN_PAGE) break;
    after = { page: rows[rows.length - 1].page_id, chunk: rows[rows.length - 1].chunk_index };
  }
  flush();
}

async function eachStaleFactBatch(engine: BrainEngine, plan: EmbeddingMigrationPlan, visit: (texts: string[]) => void): Promise<void> {
  let batch: FactRow[] = [];
  const flush = () => { if (batch.length) visit(batch.map(row => row.fact)); batch = []; };
  let after = { source: '', id: '0' };
  for (;;) {
    const rows = await engine.executeRaw<FactRow>(`SELECT f.id::text AS id, f.source_id, f.fact FROM facts f
      WHERE ($1::text IS NULL OR f.source_id=$1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}
        AND (f.source_id > $5 OR (f.source_id = $5 AND f.id > $6::bigint))
      ORDER BY f.source_id, f.id LIMIT ${SCAN_PAGE}`,
    [null, [...AUDIT_ROW_SOURCES], plan.to_model, plan.to_dims, after.source, after.id]);
    for (const row of rows) {
      if (batch.length && (batch[0].source_id !== row.source_id || batch.length === FACT_BATCH)) flush();
      batch.push(row);
    }
    if (rows.length < SCAN_PAGE) break;
    after = { source: rows[rows.length - 1].source_id, id: rows[rows.length - 1].id };
  }
  flush();
}

export async function planMigrationWorstCase(engine: BrainEngine, plan: EmbeddingMigrationPlan, opts: { rerankerModel?: string } = {}): Promise<MigrationWorstCase> {
  const envCap = Number.parseInt(process.env.GBRAIN_EMBED_MAX_BATCH_TOKENS ?? '', 10);
  const ceilings: number[] = [];
  const add = (texts: string[]) => {
    if (texts.length) ceilings.push(...embedRequestCeilings(texts, plan.to_model, Number.isFinite(envCap) && envCap > 0 ? envCap : undefined));
  };
  add([MIGRATION_PROBE_TEXT]);
  for (let i = 0; i < DRAIN_PROBES; i++) add([EMBED_PROBE_TEXT]);
  for (let i = 0; i < SMOKE_QUERIES; i++) ceilings.push(SMOKE_QUERY_MAX_TOKENS);
  await eachStalePage(engine, plan, add);
  await eachStaleFactBatch(engine, plan, add);
  const embedTokens = ceilings.reduce((sum, n) => sum + n, 0);
  const rerankTokens = opts.rerankerModel ? rerankRequestMaxInputTokens(RERANKER_PROBE.query, RERANKER_PROBE.documents) : 0;
  const overrides = await loadPricingOverrides(engine);
  const embedUsd = usageCostUsd(plan.to_model, embedTokens, 0, 'embed', overrides);
  const rerankUsd = opts.rerankerModel ? usageCostUsd(opts.rerankerModel, rerankTokens, 0, 'rerank', overrides) : 0;
  return {
    requests: ceilings.length + (opts.rerankerModel ? 1 : 0),
    input_tokens: embedTokens + rerankTokens,
    usd: embedUsd === null || rerankUsd === null ? null : embedUsd + rerankUsd,
  };
}
