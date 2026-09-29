import type { BrainEngine } from '../engine.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';

export interface ManagedLinkExtraction { pages: number; created: number; removed: number; skipped: number; remaining: number; }

/** `gbrain extract --stale` on a managed brain, locally or inside the PGLite owner. */
export async function runManagedStaleExtraction(engine: BrainEngine, opts: { sourceId?: string; dryRun?: boolean }): Promise<ManagedLinkExtraction> {
  if (!opts.dryRun) return extractManagedStaleLinks(engine, { sourceId: opts.sourceId });
  const remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS });
  return { pages: 0, created: 0, removed: 0, skipped: 0, remaining };
}

export function formatManagedStaleExtraction(result: ManagedLinkExtraction, dryRun: boolean): string {
  if (dryRun) return `(dry run) ${result.remaining} page(s) need link extraction. Run without --dry-run to extract.`;
  return `Extract --stale: ${result.created} link(s) created, ${result.removed} removed from ${result.pages} page(s).` +
    ' Timeline entries are written with each page by the persistence coordinator.' +
    (result.skipped ? ` Skipped ${result.skipped} page(s) edited during extraction or with unresolved attendance; they stay stale.` : '') +
    (result.remaining ? ` ${result.remaining} page(s) remain stale.` : '');
}

/**
 * Derive markdown links for pages whose extraction watermark is stale, with
 * put_page's contract: the page's own derived edges are replaced by what its
 * current text supports, other producers' edges stay. Each page's links and
 * watermark commit together, bound to the revision that was read; a page
 * edited meanwhile, or with unresolved attendance, stays stale. Timeline rows
 * are canonical projections the persistence coordinator already wrote with
 * the page, so they are not touched here. Runs in the process that owns the
 * brain (the sync owner, or a PGLite serve for delegated work), so both
 * engines take the same path.
 */
export async function extractManagedStaleLinks(engine: BrainEngine,
  opts: { sourceId?: string; maxPages?: number; signal?: AbortSignal } = {}): Promise<ManagedLinkExtraction> {
  const result: ManagedLinkExtraction = { pages: 0, created: 0, removed: 0, skipped: 0, remaining: 0 };
  const versionTs = LINK_EXTRACTOR_VERSION_TS;
  const maxPages = opts.maxPages ?? Infinity;
  let afterPageId = 0;
  while (result.pages + result.skipped < maxPages) {
    opts.signal?.throwIfAborted();
    const rows = await engine.listStalePagesForExtraction({ batchSize: 25, afterPageId, sourceId: opts.sourceId, versionTs });
    if (!rows.length) break;
    for (const row of rows) {
      if (result.pages + result.skipped >= maxPages) break;
      opts.signal?.throwIfAborted();
      afterPageId = row.id;
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
      if (!snapshot) continue;
      const prepared = await prepareAutomaticLinks(engine, row.slug, snapshot.page, row.source_id);
      const stamp = row.updated_at.getTime() >= Date.parse(versionTs) ? row.updated_at_iso : versionTs;
      const outcome = await engine.transaction(async tx => {
        await tx.lockPageKeys(prepared.pageKeys);
        const current = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
        if (current?.revision !== snapshot.revision) return null;
        const written = await prepared.apply(tx);
        if (written.errors) return null;
        await tx.markPagesExtractedBatch([{ slug: row.slug, source_id: row.source_id, extractedAt: stamp }], stamp);
        return written;
      });
      if (!outcome) { result.skipped++; continue; }
      result.pages++;
      result.created += outcome.created;
      result.removed += outcome.removed;
    }
  }
  result.remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs });
  return result;
}
