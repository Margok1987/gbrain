# Fix wave 3: derived data, sync and embeddings

Your brain's graph, timeline and tags now match your notes after every kind of extraction, not only after a per-file sync. Edits cost less to embed, and a one-line change no longer re-embeds the whole page. Images that were imported without their picture vector or text can be rebuilt with one command. Two new doctor checks find old timeline leftovers and files that collide on one page. You can set a timezone for times written without one, and you can opt in to dating undated notes by their first git commit.

| What changed | What you notice |
| --- | --- |
| Removed dated bullets leave the timeline on every extraction path | `gbrain extract --stale`, `gbrain extract` (file or database walk) and syncs after several unextracted edits no longer keep old timeline rows |
| Full-walk link extraction replaces links | Deleting a wikilink and running `gbrain extract links` removes the edge |
| One-time timeline cleanup | `gbrain extract timeline --prune-orphans [--dry-run]` removes rows an earlier version of a page produced; doctor's `timeline_orphans` check tells you when to run it |
| Cheaper edits | Unchanged chunks keep their vectors on re-import; in a 40-page test, a one-sentence edit to 20 pages embedded 31 chunks instead of 110 (21K tokens instead of 48K) with the same search results |
| Frontmatter tag removal works | Remove a tag from frontmatter, sync, and it leaves the database; tags added by enrichment or `add_tag` stay (brains using managed persistence keep add-only tags) |
| Extraction failures are visible | A failed post-sync extraction prints a stderr line and sets `extract_error` on the sync result |
| Faster small syncs on big brains | A one-file sync no longer loads metadata for every page in every source |
| Image repair | `gbrain embed --stale --images [--source <id>] [--dry-run] [--json]` rebuilds images missing a visual vector or OCR text |
| Slug collisions are reported | Doctor's `slug_collisions` check names files that map to one page and which one is indexed |
| Brain timezone | `gbrain config set brain.timezone America/New_York` sets the timezone for frontmatter times written without an offset. The default stays UTC |
| Git dates for undated notes (opt-in) | `gbrain config set sync.git_first_commit_dates true` dates undated notes by their first commit on a full import, instead of the clone time |

### Itemized changes

- **Timeline reconciliation on every path (#5170, #4649).** `retractRemovedTimelineEntries` (`src/core/timeline-extract.ts`) now proves ownership against every stored `page_versions` text of the page, parsed by both timeline parsers. A row is retracted when some earlier version produced it and the current text does not. Rows that no version produced, such as enrichment, meeting fan-out and `--infer-dates` anchors, are never touched, and neither are event-page projections. The version scan runs only when the page holds a row its current text does not produce. The following paths all reconcile: `extract --stale`, the file-walk and database-walk `gbrain extract timeline`, the per-slug cycle extract and sync's inline hook. Reported by @rodrigo-kiko (#5170) and @jarospm (#4649).
- **One-time prune (#4649).** `gbrain extract timeline --prune-orphans [--source-id <id>] [--dry-run] [--json]` runs the same reconciliation over every page with timeline rows and never inserts. The read-only doctor check `timeline_orphans` samples 500 pages and points at the command. Rows that no stored version can account for are kept, as the review candidates #5170 asked for.
- **Full-walk link replacement.** `gbrain extract links|all` (file walk) replaces each page's own markdown-derived links through `replacePageFileLinks`, the per-file sync contract. Other producers' edges survive. A file with no page row is skipped and not stamped.
- **A16: scoped link metadata.** The post-sync link hook reads its files first. It then loads page metadata only for the changed pages and their link endpoints in the sync's source. The whole-brain load runs only for DB meeting and attendance origins.
- **A15: extraction errors surface.** `extractLinksForSlugs` and `extractTimelineForSlugs` return per-page `errors`. Sync logs a stderr line with the `gbrain extract --stale` fix and returns `extract_error` on `SyncResult`. Failed pages stay stale.
- **A13: chunk vector reuse.** An inline markdown re-import reuses a stored vector for a chunk with the same source and exact text when all of these hold:
  - the old index is sealed;
  - the page's embedding signature, contextual mode and corpus generation are unchanged;
  - under the title wrapper, the title is unchanged;
  - neither the old nor the new body holds protected fences.

  Prepared, `--no-embed`, `--force-rechunk` and post-commit-embedding imports reuse nothing. Matched measurement: two PGLite brains, 40 guide pages, 74 heading queries, OpenAI `text-embedding-3-small`, one-sentence edits to 20 pages. Reuse re-embedded 31 chunks (21,278 tokens), and re-embedding everything took 110 chunks (47,719 tokens). hit@1 was 0.473 vs 0.473, hit@5 0.743 vs 0.743 and MRR 0.586 vs 0.585. Top-5 results were identical for 73 of 74 queries. The minimum cosine between the brains' vectors was 0.998, which is the provider's run-to-run variation.
- **A14: tag provenance.** Migration v170 adds `tags.tag_source`. Frontmatter tags go through `addTag(..., { tagSource: 'frontmatter' })`, and the importer deletes rows still marked 'frontmatter' once the tag leaves the frontmatter. Every other `addTag` stamps 'added', which no import deletes, so `reindex --markdown` keeps enrichment tags. Legacy NULL rows are adopted only while the frontmatter still lists them. Brains using managed persistence keep add-only tags, because their canonical files render the union of stored and incoming tags.
- **Image sweep.** `gbrain embed --stale --images` (`src/core/embed-stale-images.ts`) selects the pages that the importer's hash-skip considers incomplete:
  - an unsealed or stale projection;
  - no `embedding_image`;
  - no OCR text while `GBRAIN_EMBEDDING_IMAGE_OCR=true`.

  It resolves each file from the source checkout (`default` falls back to `sync.repo_path`, and subpath scopes resolve against the git root) and passes it back to `importImageFile`. It requires `GBRAIN_EMBEDDING_MULTIMODAL=true`, and failures exit non-zero. Image pages already record `source_path` on every path, so audit item A9 was fixed before this wave.
- **Doctor `slug_collisions`.** The check walks each live source checkout with the sync walker, groups paths by the slug the importer would assign, and reports each group with its indexed path.
- **`brain.timezone`.** Offset-less frontmatter datetimes are read in this IANA zone on import and in the `effective_date` backfill, with correct DST handling. The key is validated by `gbrain config set`; when it is unset or invalid, UTC applies. Date-only values stay UTC calendar dates, and the host timezone never matters. The YAML parser marks naive timestamps so their wall-clock reading survives typing.
- **Git first-commit fallback (opt-in).** With `sync.git_first_commit_dates=true`, `runImport` handles first sync, `sync --full` and `gbrain import`. It maps paths to their first-commit author date in one `git log --diff-filter=A` pass. The fallback anchor for an undated new page is the earliest of birth time, mtime and first-commit date. Shallow clones and git failures keep the file timestamps. The setting is opt-in because `effective_date` feeds recency-intent ranking and since/until filters, and no in-repo eval measures that effect. Incremental sync is not covered and keeps file timestamps; the gain there is limited to a pull of long-unsynced history.
