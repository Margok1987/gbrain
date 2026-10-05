/**
 * The cross-modal image arm on a text-only brain: a question that mentions
 * photos infers image modality, but a brain with no `embedding_image` rows
 * has nothing for that arm to search. It is skipped, so no multimodal embed
 * is attempted and no failed vector arm is reported while the text arm
 * answers. A brain that holds image vectors still tries the arm.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import { brainHasImageVectors, forgetImageVectorPresence } from '../src/core/search/image-vector-presence.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'show me the photos from the beach trip';
const embed = (text: string) => { const v = new Float32Array(1024); for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 1024]! += 1; return v; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'notes/beach-trip', page('note', 'Beach trip', 'We took photos at the beach trip in June and shared them with the family.'));
}, 120_000);

afterAll(async () => { await engine?.disconnect(); }, 60_000);

async function search(): Promise<{ slugs: string[]; meta: HybridSearchMeta | null }> {
  let meta: HybridSearchMeta | null = null;
  const rows = await hybridSearch(engine, Q, { sourceId, limit: 5, queryEmbedFn: embed, onMeta: m => { meta = m; } });
  return { slugs: rows.map(r => r.slug), meta };
}
const stages = (meta: HybridSearchMeta | null) => ((meta as { degraded?: Array<{ stage?: string } | string> } | null)?.degraded ?? []).map(d => typeof d === 'string' ? d : d.stage);

describe('cross-modal image arm', () => {
  test('a text-only brain skips it: the text arm answers and no vector arm is reported failed', async () => {
    forgetImageVectorPresence(engine);
    expect(await brainHasImageVectors(engine)).toBe(false);
    const { slugs, meta } = await search();
    expect(slugs).toContain('notes/beach-trip');
    expect(stages(meta)).not.toContain('vector_arm_failed');
  });

  test('a brain with image vectors still runs the image arm (here it fails open: no multimodal provider is configured)', async () => {
    const [chunk] = await engine.executeRaw<{ id: number }>('SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 LIMIT 1', ['notes/beach-trip']);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_image = $2::vector WHERE id = $1`, [chunk!.id, `[${Array.from(embed('beach'), x => x || 0).join(',')}]`]);
    forgetImageVectorPresence(engine);
    expect(await brainHasImageVectors(engine)).toBe(true);
    const { meta } = await search();
    expect(stages(meta)).toContain('vector_arm_failed');
    await engine.executeRaw('UPDATE content_chunks SET embedding_image = NULL WHERE id = $1', [chunk!.id]);
    forgetImageVectorPresence(engine);
  });
});
