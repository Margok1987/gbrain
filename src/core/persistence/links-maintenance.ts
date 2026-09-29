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
 * Derive markdown links with put_page's contract: the page's own derived edges
 * are replaced by what its current text supports, other producers' edges stay.
 * `slugs` (a sync's committed imports) are re-derived regardless of their
 * watermark, because a concurrent sweep may have stamped them mid-sync before
 * their link targets existed; then pages whose watermark is stale follow. Each
 * page's links and watermark commit together, bound to the revision that was
 * read; a page edited meanwhile, or with unresolved attendance, stays stale.
 * Timeline rows are canonical projections the persistence coordinator already
 * wrote with the page, so they are not touched here. Runs in the process that
 * owns the brain (the sync owner, or a PGLite serve for delegated work), so
 * both engines take the same path.
 */
export async function extractManagedStaleLinks(engine: BrainEngine,
  opts: { sourceId?: string; slugs?: readonly string[]; maxPages?: number; signal?: AbortSignal } = {}): Promise<ManagedLinkExtraction> {
  const result: ManagedLinkExtraction = { pages: 0, created: 0, removed: 0, skipped: 0, remaining: 0 };
  const versionTs = LINK_EXTRACTOR_VERSION_TS;
  const maxPages = opts.maxPages ?? Infinity;
  const done = new Set<string>();
  const derive = async (slug: string, sourceId: string, stamp?: string) => {
    opts.signal?.throwIfAborted();
    done.add(`${sourceId}\0${slug}`);
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot) return;
    const prepared = await prepareAutomaticLinks(engine, slug, snapshot.page, sourceId);
    const outcome = await engine.transaction(async tx => {
      await tx.lockPageKeys(prepared.pageKeys);
      const current = await tx.readPageSnapshot(slug, { sourceId });
      if (current?.revision !== snapshot.revision) return null;
      const written = await prepared.apply(tx);
      if (written.errors) return null;
      const at = stamp ?? new Date().toISOString();
      await tx.markPagesExtractedBatch([{ slug, source_id: sourceId, extractedAt: at }], at);
      return written;
    });
    if (!outcome) { result.skipped++; return; }
    result.pages++;
    result.created += outcome.created;
    result.removed += outcome.removed;
  };
  const budget = () => result.pages + result.skipped < maxPages;
  if (opts.slugs?.length && opts.sourceId) {
    for (const slug of new Set(opts.slugs)) { if (!budget()) break; await derive(slug, opts.sourceId); }
  }
  let afterPageId = 0;
  while (budget()) {
    const rows = await engine.listStalePagesForExtraction({ batchSize: 25, afterPageId, sourceId: opts.sourceId, versionTs });
    if (!rows.length) break;
    for (const row of rows) {
      if (!budget()) break;
      afterPageId = row.id;
      if (done.has(`${row.source_id}\0${row.slug}`)) continue;
      await derive(row.slug, row.source_id, row.updated_at.getTime() >= Date.parse(versionTs) ? row.updated_at_iso : versionTs);
    }
  }
  result.remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs });
  return result;
}
