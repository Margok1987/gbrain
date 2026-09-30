/**
 * engine-sql/chunks.ts keeps one fragment copy of the shared
 * `currentSpaceChunkPredicate` (embedding-invalidation.ts), because engine-sql
 * composes with sqlFragment and bans hand-numbered `$n`
 * (docs/designs/refactor-wave-1/w1-inventory.md, chunks). This pins the two
 * texts together so an edit to one cannot silently leave the other behind:
 * the fragment rendered at its placeholder positions must equal the shared
 * builder's text, and bind exactly (model, dims).
 */
import { describe, expect, test } from 'bun:test';
import { currentSpaceChunkPredicate } from '../src/core/embedding-invalidation.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { currentSpaceChunkFragment } from '../src/core/engine-sql/chunks.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';

describe('engine-sql chunks: currentSpaceChunkFragment', () => {
  for (const column of ['embedding', 'embedding_voyage']) {
    test(`renders currentSpaceChunkPredicate's exact text for ${column}`, () => {
      const { text, params } = renderFragment(currentSpaceChunkFragment(column, 'voyage:voyage-4', 1024));
      expect(text).toBe(currentSpaceChunkPredicate(quoteIdentifier(column), 1, 2));
      expect(params).toEqual(['voyage:voyage-4', 1024]);
    });
  }
});
