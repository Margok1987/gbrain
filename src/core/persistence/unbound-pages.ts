/**
 * Database-only pages and their slug-derived canonical path (fix wave 3,
 * #5254 collision resolution). A page written while its source had no
 * canonical owner is stored without a recorded origin: no `source_path` and no
 * `source_uri`. After the source is bound, a canonical file can appear at the
 * page's slug-derived path; `gbrain sources reconcile` then previews both sides
 * against that path instead of refusing for want of a recorded origin.
 *
 * Contract for the #5254 durable classification: `isDatabaseOnlyPage` is the
 * one predicate reconcile consults; narrow it to the page-level
 * `unbound_source` marker where that marker exists.
 */
import { join } from 'node:path';

export function isDatabaseOnlyPage(page: { source_path?: string | null; source_uri?: string | null }): boolean {
  return !page.source_path?.trim() && !page.source_uri?.trim();
}

/** `<source root>/<slug>.md`, the path an import of that file would give the same slug. */
export function slugDerivedMarkdownPath(root: string, slug: string): string {
  return join(root, `${slug}.md`);
}
