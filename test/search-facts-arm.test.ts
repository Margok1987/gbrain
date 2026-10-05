/**
 * Facts arm for `query` (`search.query_facts_arm`, search/facts-arm.ts): with
 * the key on, an active fact that matches the question comes back as a row of
 * its own inside the row count and budget; a remote caller never sees a
 * private fact; page-unit delivery passes the fact row through as written;
 * a page whose typed claim a newer fact covers is stamped superseded_claim;
 * with the key off the rows are unchanged. PGLite, keyword-only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { QUERY_FACTS_ARM_KEY, matchQueryFacts, queryTerms } from '../src/core/search/facts-arm.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'Where is the Forge offsite booked?';
const query = async (params: Record<string, unknown> = {}) => await handleToolCall(engine, 'query', { query: Q, expand: false, use_cache: false, source_id: sourceId, limit: 6, ...params }) as SearchResult[];
const remote = async (params: Record<string, unknown>) => {
  const auth = { token: 't', clientId: 'facts-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
  const r = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 6, ...params }, { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  for (let i = 0; i < 6; i++) {
    await putPage(engine, sourceId, `conversations/chat-${i}`, page('conversation', `chat ${i}`, `**User:** Notes on Forge part ${i}. By the way, the Forge offsite is booked in Santa Fe.\n\n**Assistant:** Noted.`, `date: 2025-07-0${i + 1}\n`));
  }
  await engine.insertFact({ fact: 'The Forge offsite is booked in Missoula.', kind: 'fact', entity_slug: 'forge', source: 'user correction, 2025-07-12', visibility: 'world', valid_from: new Date('2025-07-12T00:00:00Z') }, { source_id: sourceId });
  await engine.insertFact({ fact: 'The Forge offsite budget is a secret.', kind: 'fact', entity_slug: 'forge', source: 'private note', visibility: 'private', valid_from: new Date('2025-07-13T00:00:00Z') }, { source_id: sourceId });
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('facts arm', () => {
  test('query terms drop stopwords and short words', () => {
    expect(queryTerms(Q)).toEqual(['forge', 'offsite', 'booked']);
  });

  test('off (unset or false): no fact rows, rows unchanged', async () => {
    const unset = await query();
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    const off = await query();
    expect(JSON.stringify(off.map(r => [r.slug, r.chunk_text]))).toBe(JSON.stringify(unset.map(r => [r.slug, r.chunk_text])));
    expect(unset.some(r => r.fact_row)).toBe(false);
  });

  test('on: the matching fact is a row of its own, newest first, inside the same row count', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    const off = await query();
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const on = await query();
      expect(on).toHaveLength(off.length);
      const facts = on.filter(r => r.fact_row);
      expect(facts.map(r => r.fact_row!.valid_from.slice(0, 10))).toEqual(['2025-07-13', '2025-07-12']);
      expect(facts[1]!.chunk_text).toContain('Missoula');
      expect(facts[1]!.chunk_text).toContain('valid from 2025-07-12');
      expect(facts[0]!.chunk_text).toContain('secret');
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on, remote: a private fact never comes back; the world fact does', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const text = await remote({});
      expect(text).toContain('Missoula');
      expect(text).not.toContain('secret');
      expect(await matchQueryFacts(engine, Q, { sourceIds: [sourceId], remote: true })).toHaveLength(1);
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on, return_unit page: the fact row passes through as written and counts in the budget', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const rows = await query({ return_unit: 'page', token_budget: 2000 }) as Array<SearchResult & { delivered?: { reason?: string } }>;
      const fact = rows.find(r => r.fact_row && r.chunk_text.includes('Missoula'))!;
      expect(fact.delivered?.reason).toBe('saved_fact');
      expect(fact.chunk_text.startsWith('Saved fact')).toBe(true);
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on: a page whose typed claim a newer fact covers is stamped superseded_claim; untyped pages are not', async () => {
    const old = await engine.insertFact({ fact: 'Forge offsite city is Santa Fe', kind: 'fact', entity_slug: 'forge', source: 'extracted', visibility: 'world', valid_from: new Date('2025-07-01T00:00:00Z') }, { source_id: sourceId });
    await engine.executeRaw(`UPDATE facts SET source_markdown_slug = 'conversations/chat-0', claim_metric = 'offsite_city', expired_at = now() WHERE id = $1`, [old.id]);
    const newer = await engine.insertFact({ fact: 'The Forge offsite city is now Missoula, booked last week', kind: 'fact', entity_slug: 'forge', source: 'user correction', visibility: 'world', valid_from: new Date('2025-07-14T00:00:00Z') }, { source_id: sourceId });
    await engine.executeRaw(`UPDATE facts SET claim_metric = 'offsite_city' WHERE id = $1`, [newer.id]);
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const rows = await query({ limit: 10 });
      const stamped = rows.filter(r => r.superseded_claim);
      expect(stamped.map(r => r.slug)).toEqual(['conversations/chat-0']);
      expect(stamped[0]!.superseded_claim!.fact_id).toBe(newer.id);
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });
});
