/**
 * Facts arm for `query` (`search.query_facts_arm`, default off; gates in
 * docs/eval/decisions/query-facts-arm/). A correction saved with `remember`
 * lives in the facts table, which page search never ranks, so the stale page
 * text answers instead. With the key on, `query` adds the active facts that
 * match the question as rows of their own, inside the caller's row count and
 * token budget, and stamps a page row `superseded_claim` when a newer active
 * fact covers the same entity and typed claim slot as a fact taken from that
 * page.
 *
 * Matching: query terms against the fact text and entity (at least half of
 * the content terms), cosine against the query embedding hybrid search
 * already computed (no extra model call; skipped when there is none), and the
 * facts of the one entity page the query names. Matches are ordered newest
 * valid_from first. Read policy is recall's: source scope, active rows only,
 * audit rows excluded, and world-visible facts with non-private provenance
 * for remote callers.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';
import { privateProvenanceFilterFragment } from './private-visibility.ts';
import { namedEntity } from './entity-anchor.ts';
import { enforceTokenBudget, resultTokens } from './token-budget.ts';

export const QUERY_FACTS_ARM_KEY = 'search.query_facts_arm';
/** Fact rows added per query at most. */
export const MAX_FACT_ROWS = 3;
/** Cosine similarity a fact needs against the query embedding to count as a match on its own. */
export const FACT_COSINE_MIN = 0.6;
/** Share of the query's content terms a fact's text and entity must hold to match by keyword. */
const TERM_SHARE_MIN = 0.5;

const STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their',
  'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next', 'use', 'uses', 'tell']);

export interface FactsArmScope { sourceId?: string; sourceIds?: string[]; remote: boolean }

interface FactCandidate {
  id: number; fact: string; kind: string; entity_slug: string | null; source_id: string; source: string;
  valid_from: Date | string; valid_until: Date | string | null; claim_metric: string | null; claim_period: string | null;
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])].filter(t => t.length >= 3 && !STOPWORDS.has(t)).slice(0, 12);
}

const day = (v: Date | string | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/** The active facts that match `query`, newest valid_from first (at most MAX_FACT_ROWS). */
export async function matchQueryFacts(engine: BrainEngine, query: string, scope: FactsArmScope, queryEmbedding?: Float32Array | null): Promise<FactCandidate[]> {
  const terms = queryTerms(query);
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
  const params: unknown[] = [sources, [...AUDIT_ROW_SOURCES]];
  const base = `f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
    AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[])
    ${scope.remote ? `AND f.visibility = 'world' AND ${privateProvenanceFilterFragment('f')}` : ''}`;
  const cols = 'f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.claim_metric, f.claim_period';
  const found = new Map<number, FactCandidate>();
  if (terms.length) {
    const rows = await engine.executeRaw<FactCandidate & { haystack: string }>(
      `WITH q AS (SELECT NULLIF(replace(plainto_tsquery($3::regconfig, $4)::text, ' & ', ' | '), '')::tsquery AS q)
       SELECT ${cols}, lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) AS haystack
       FROM facts f, q WHERE ${base} AND q.q IS NOT NULL
         AND to_tsvector($3::regconfig, f.fact || ' ' || replace(COALESCE(f.entity_slug, ''), '-', ' ')) @@ q.q
       ORDER BY ts_rank_cd(to_tsvector($3::regconfig, f.fact || ' ' || replace(COALESCE(f.entity_slug, ''), '-', ' ')), q.q) DESC, f.valid_from DESC
       LIMIT 50`, [...params, getFtsLanguage(), terms.join(' ')]);
    const need = Math.max(Math.min(2, terms.length), Math.ceil(terms.length * TERM_SHARE_MIN));
    for (const r of rows) if (terms.filter(t => r.haystack.includes(t)).length >= need) found.set(Number(r.id), r);
  }
  if (queryEmbedding && queryEmbedding.length) {
    const model = getEmbeddingModel();
    const lit = `[${Array.from(queryEmbedding).join(',')}]`;
    const rows = await engine.executeRaw<FactCandidate & { similarity: number }>(
      `SELECT ${cols}, 1 - (f.embedding <=> $3::vector) AS similarity FROM facts f
       WHERE ${base} AND f.embedding IS NOT NULL AND f.embedding_model = $4 AND f.embedded_text_hash = md5(f.fact)
         AND vector_dims(f.embedding) = $5
       ORDER BY f.embedding <=> $3::vector LIMIT 10`, [...params, lit, model, queryEmbedding.length]).catch(() => []);
    for (const r of rows) if (Number(r.similarity) >= FACT_COSINE_MIN) found.set(Number(r.id), r);
  }
  const entity = await namedEntity(engine, query, { sourceIds: sources, excludePrivate: scope.remote }).catch(() => null);
  if (entity) {
    const rows = await engine.executeRaw<FactCandidate>(
      `SELECT ${cols} FROM facts f WHERE ${base} AND f.entity_slug = $3 ORDER BY f.valid_from DESC, f.id DESC LIMIT ${MAX_FACT_ROWS}`,
      [...params, entity.slug]);
    for (const r of rows) found.set(Number(r.id), r);
  }
  return [...found.values()]
    .sort((a, b) => new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime() || Number(b.id) - Number(a.id))
    .slice(0, MAX_FACT_ROWS);
}

function factRow(f: FactCandidate, score: number): SearchResult {
  const from = day(f.valid_from);
  const until = day(f.valid_until);
  return {
    slug: f.entity_slug ?? `facts/${f.id}`, page_id: 0, title: f.entity_slug ? `Saved fact about ${f.entity_slug}` : 'Saved fact', type: 'note',
    chunk_text: `Saved fact (${f.kind}; valid from ${from ?? 'unknown'}${until ? ` to ${until}` : ''}; provenance: ${f.source}): ${f.fact}`,
    chunk_source: 'compiled_truth', chunk_id: -Number(f.id), chunk_index: 0, score, stale: false, source_id: f.source_id,
    fact_row: { id: Number(f.id), valid_from: new Date(f.valid_from).toISOString(), valid_until: f.valid_until ? new Date(f.valid_until).toISOString() : null },
  } as SearchResult;
}

/**
 * Stamp `superseded_claim` on page rows whose page is the source of an older
 * fact for the same entity and typed claim slot as a newer matched fact.
 * Untyped claims are never compared.
 */
async function stampSupersededClaims(engine: BrainEngine, results: SearchResult[], facts: FactCandidate[]): Promise<void> {
  const typed = facts.filter(f => f.entity_slug && f.claim_metric);
  const pages = results.filter(r => !r.fact_row && r.slug);
  if (!typed.length || !pages.length) return;
  const rows = await engine.executeRaw<{ id: number; source_markdown_slug: string; source_id: string; entity_slug: string; claim_metric: string; claim_period: string | null; valid_from: Date | string }>(
    `SELECT f.id, f.source_markdown_slug, f.source_id, f.entity_slug, f.claim_metric, f.claim_period, f.valid_from FROM facts f
     WHERE f.source_markdown_slug = ANY($1::text[]) AND f.entity_slug = ANY($2::text[]) AND f.claim_metric IS NOT NULL`,
    [[...new Set(pages.map(r => r.slug))], [...new Set(typed.map(f => f.entity_slug!))]]);
  for (const r of pages) {
    for (const old of rows.filter(o => o.source_markdown_slug === r.slug && o.source_id === (r.source_id ?? o.source_id))) {
      const newer = typed.find(f => f.entity_slug === old.entity_slug && f.claim_metric === old.claim_metric
        && (!f.claim_period || !old.claim_period || f.claim_period === old.claim_period)
        && Number(f.id) !== Number(old.id) && new Date(f.valid_from).getTime() > new Date(old.valid_from).getTime());
      if (newer) { r.superseded_claim = { fact_id: Number(newer.id), valid_from: new Date(newer.valid_from).toISOString() }; break; }
    }
  }
}

export interface FactsArmOpts extends FactsArmScope {
  tokenBudget?: number;
  queryEmbedding?: Float32Array | null;
  /** The caller's row count (explicit limit or the mode's default), read only when a fact matches. */
  rowCap?: () => Promise<number>;
}

/**
 * The facts arm: matched facts appended as rows in spare capacity only (free
 * slots under the caller's row count, and what the pages leave of the token
 * budget), so no page row is ever displaced; superseded page claims stamped.
 * No match, no spare capacity or any error: the results unchanged.
 */
export async function applyFactsArm(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts): Promise<SearchResult[]> {
  try {
    const facts = await matchQueryFacts(engine, query, opts, opts.queryEmbedding);
    if (!facts.length) return results;
    const free = ((await opts.rowCap?.().catch(() => 0)) ?? 0) - results.length;
    if (free <= 0) return results;
    const pages = results.map(r => ({ ...r }));
    const floor = pages.reduce((m, r) => (Number.isFinite(r.score) && r.score < m ? r.score : m), pages[0]?.score ?? 1);
    let rows = facts.slice(0, free).map((f, i) => factRow(f, floor - (i + 1) * 1e-6));
    if (opts.tokenBudget) {
      let left = opts.tokenBudget - enforceTokenBudget(pages, opts.tokenBudget).meta.used;
      rows = rows.filter(r => { const cost = resultTokens(r); if (cost > left) return false; left -= cost; return true; });
    }
    if (!rows.length) return results;
    const merged = [...pages, ...rows];
    await stampSupersededClaims(engine, merged, facts).catch(() => undefined);
    return merged;
  } catch {
    return results;
  }
}

/**
 * `search.query_facts_arm`: on by default (gates 1b and 2 passed,
 * docs/eval/decisions/query-facts-arm/); 'false' | 'off' | '0' | 'no' turns it
 * off. A config read error leaves it off.
 */
export async function queryFactsArmEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(QUERY_FACTS_ARM_KEY))?.trim().toLowerCase();
    return !(raw === 'false' || raw === 'off' || raw === '0' || raw === 'no');
  } catch {
    return false;
  }
}
