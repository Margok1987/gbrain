/**
 * The `query` op's post-retrieval arms, applied after hybrid search and the
 * declared-name fan-out, before the CRAG grade: entity anchoring
 * (`search.entity_anchoring`, default off, search/entity-anchor.ts) and then
 * the facts arm (`search.query_facts_arm`, default on, search/facts-arm.ts).
 * With both off the rows pass through unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import { anchorOpResults } from './entity-anchor.ts';
import { applyFactsArm, queryFactsArmEnabled } from './facts-arm.ts';

export async function applyQueryArms(engine: BrainEngine, p: Record<string, unknown>, query: string, results: SearchResult[],
  scope: PageReadScope & { filtered: boolean; evidencePlan: boolean; remote: boolean; queryEmbedding: Float32Array | null; rowCap: () => Promise<number> }): Promise<SearchResult[]> {
  const anchored = await anchorOpResults(engine, p, query, results, scope);
  if (p.offset || scope.filtered || p.since || p.until || p.lang || p.symbol_kind || p.near_symbol || !await queryFactsArmEnabled(engine)) return anchored;
  return applyFactsArm(engine, query, anchored, {
    sourceId: scope.sourceId, sourceIds: scope.sourceIds, remote: scope.remote, queryEmbedding: scope.queryEmbedding, rowCap: scope.rowCap,
    tokenBudget: !scope.evidencePlan && typeof p.token_budget === 'number' ? p.token_budget : undefined,
  });
}
