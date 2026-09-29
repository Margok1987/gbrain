# Fix wave 3: managed-path lifecycle (slug collisions, renames, links, extract --stale)

Branch `capy/fw3-managed-lifecycle`, based on `origin/master` at `045a613` (v0.59.18.0).
No version bump and no CHANGELOG entry; the integrator owns both.

The gbrain-evals lifecycle experiment (`feat/lifecycle-experiment`, report
`docs/benchmarks/2026-09-29-lifecycle.md`, harness
`eval/runner/lifecycle-experiment.ts`) found four failures on every build, all
on a fresh `gbrain init` brain. A fresh brain uses the managed write path
(`src/core/persistence/*`). The #5668 fixes live on the library path in
`import-file.ts` and `commands/sync.ts`, and the managed path never reaches
them.

## Root causes and fixes

### 1. Slug collision blocked the whole sync

**Cause.** `discoverManagedSync` froze one identity per manifest entry.
`notes/Foo Bar.md` and `notes/foo-bar.md` both froze as "new page at
`notes/foo-bar`". The first one committed. The second then failed
`freezeEntry`'s revision check (`revision_conflict: A page changed after this
sync cursor was enumerated`), and the bystander after it never imported.
Later full syncs failed discovery with `page_identity_changed` (another origin
occupies the slug). The #5668 `collidingSlugOwner` rule in `importFromContent`
never ran, because managed preparation passes no `sourceRoot`, and discovery
failed before preparation anyway.

**Fix (`sync-discovery.ts`).** Imports whose origin has no page yet now claim
their slug together, and the claims are settled after every entry has a slug:

- A live page whose own file is still in the tree keeps the slug. The
  newcomer is skipped.
- Otherwise, the file named like the slug wins, else the first path.
- The losers leave the manifest and are reported on the result as
  `slugCollisions` (`{slug, kept, skipped[]}`). `printSyncResult` prints one
  line per collision. This is the library path's `skip_reason:
  slug_collision`: informational, and the sync exits 0 and advances its
  checkpoint.
- Suppose the slug is held by a page whose origin has vanished, meaning the
  origin was deleted in this run, is soft-deleted, or is absent from the
  tree. Then the winner takes that page over (same id and history) instead of
  racing a deletion.
- Origins for one slug that differ only by case or by separator spelling
  (`Notes/x.md` and `notes/x.md`, or a historical `notes\x.md`) still refuse
  with `page_identity_changed`. This keeps the existing
  `persistence-sync-origin-native` contract. The one exception is a case-only
  respelling whose old file this same sync removes.
- Code files keep exact per-origin identity. The claim logic is
  Markdown-only.

The managed rule differs from the library rule in one case. When an existing
live page owns the slug and a new exactly-named file appears, the library path
lets the exactly-named file take the page over. The managed path keeps the
current owner. That rule exists on the library path because filesystem
extraction reads `<slug>.md`. Managed extraction reads the database, so the
stable owner wins. When both files are new, the exactly-named file wins on
both paths.

### 2. A rename lost its inbound links, and old slugs did not resolve

**Cause.** Managed discovery turned every Git rename into a delete of the old
page plus a create of a new one. No `updateSlug` ran, so no `slug_aliases` row
was written. The new page had a new id, so inbound links, which are page-id
foreign keys, pointed at the soft-deleted page. `get_page` already follows
`slug_aliases` (`ops/pages.ts`), so the alias read side was fine. The write
never happened.

**Fix.**
- `sync-discovery.ts`: a Git-detected rename (delta or working tree) to an
  unoccupied slug becomes one import entry that carries `renameFrom` (old
  origin, slug, page id and revision), and the delete entry is dropped.
- `sync-run.ts` `freezeEntry` also checks the rename's source page (id,
  revision, origin) and counts the commit in `renamed`.
- `sync-prepare.ts` prepares the file against the page where it currently
  stands, and locks the old slug as an additional page key. At publication,
  inside the coordinator transaction, it calls `tx.updateSlug(old, new)`,
  which keeps the page id and inbound links, writes `old -> new` to
  `slug_aliases`, and moves withdrawn-claim subjects. It then re-prepares and
  applies the file content at the new slug. An implicit (not frontmatter)
  type is re-inferred from the new path, the same result a fresh import
  there gives. Without that, the move would write `type:` back into the
  user's file and dirty the work tree.
- `links-preparation.ts` (managed `prepareAutomaticLinks`): a link written
  against an old slug is retargeted to the live canonical page through
  `slug_aliases`. Editing `notes/b.md`, which still says
  `[[people/erin-example]]`, keeps the edge. The legacy extractors already
  do this through `loadSlugAliasTargets`.

### 3. PGLite with a live `gbrain serve`: 0–1 of 8 links

**Cause.** Managed sync never extracted links at all. Its result carried
`pagesAffected: []`, and it returned before the library path's inline
extraction. On Postgres, links came only from the operator's follow-up
`gbrain extract --stale`. That command committed its link batch before the
timeline write hit the writer guard, which gave 5 of 8. On PGLite with a live
server, `extract --stale` could not open the database at all, so the result
was 0. The occasional single edge came from the serve's idle sweep.

**Fix.** New module `src/core/persistence/links-maintenance.ts`. Its
`extractManagedStaleLinks` derives links for pages with a stale extraction
watermark using `prepareAutomaticLinks`, which is put_page's replace
contract: the page's own derived edges are replaced, and other producers'
edges stay. It stamps `links_extracted_at` in the same transaction. The work
is bound to the revision it read, so an edited page or unresolved attendance
stays stale. `performManagedSync` calls it once the checkpoint commits
(unless `noExtract` is set), in the process that owns the brain. That process
is the serve process for delegated PGLite syncs, so both engines take the
same path, and forward references inside one run resolve. The pages the run
imported are re-derived whatever their watermark says. A serve's idle sweep
can stamp a page in the middle of a sync, before that page's link targets
exist, and then the page would no longer look stale. The harness caught this
once: a Postgres MCP cell had `notes/b` at 5/8, and a regression test now
covers it. The result carries
`links`. An extraction failure leaves pages stale and does not fail the
already-committed sync. Timeline rows are not written here, because the
coordinator already projects them with each page (`canonical-projections.ts`).

### 4. `gbrain extract --stale` refused in 240 of 240 attempts

**Cause.** There were two causes. On managed brains, `extractStaleFromDB`
writes `timeline_entries` directly, and the database writer guard
(`writer-guard-schema.ts`) rejects that with `writer_coordinator_required`.
On PGLite with a live owner, the command tried to open the locked database.

**Fix.**
- `commands/extract.ts`: on a managed brain, the `--stale` branch goes to
  `runManagedExtractStale` in `commands/extract-stale-delegate.ts`. That
  function calls `runManagedStaleExtraction`, which runs links and the
  watermark through the coordinator-safe path; timeline rows are already
  projected by the coordinator. `--dry-run` and `--json` are supported.
- With a live PGLite owner, `cli.ts` delegates `extract --stale` to the owner
  through a new local administration operation, `writer_extract_stale`
  (`admin-contract.ts`, `administration.ts`). Only a trusted CLI registration
  can call it; a remote stdio credential gets `permission_denied`. It
  requires activated managed persistence.
- The sync nudge ("run 'gbrain extract --stale'") now names a command that
  works, and managed syncs stamp their own pages, so the nudge normally no
  longer fires.

### Title wikilinks (`[[Exa Cheng]]`)

This is intended behavior, and nothing was changed. A bare `[[Name]]` gets a
direct candidate only for the root slug `exa-cheng`. Cross-folder resolution
by basename, which is what `[[Exa Cheng]]` → `people/exa-cheng` needs, is
opt-in through `link_resolution.global_basename`
(`GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME`). It is documented in
`docs/guides/capabilities.md` and the #972 notes in `link-extraction.ts`.
Doctor reports how many edges the flag would add. The lifecycle harness runs
with the default, so its two presence-control title links correctly stay
unresolved. For gbrain-evals: turn the flag on in the harness to get a
working near-name presence control.

## Lifecycle harness, before and after

Setup: `bun eval/runner/lifecycle-experiment.ts --gbrain-repo <checkout>
--builds <label>=<sha> --concurrency 4`, with Postgres from `pgvector/pgvector:pg16`
using trust auth. Build `base` is `045a613` (origin/master). Build `fix` is the branch
head's code (`7e83676`); the table below comes from that run.

| Contract | base (master) | fix |
|---|---|---|
| Slug-collision vault (CLI, both engines) | 1/3 imported, sync exit 1 | 2/3 imported (collision loser skipped and reported), sync exit 0 |
| Renamed page keeps its inbound link (`noteb->erin`) | missing in 6/6 cells | present in 6/6 cells |
| Old slug of moved or renamed page resolves | 0/2 in 6/6 cells | 2/2 in 6/6 cells |
| Edges, PGLite MCP stdio / HTTP | 0/8, 0/8 | 6/8, 6/8 |
| Edges, Postgres MCP stdio / HTTP | 5/8, 5/8 | 6/8, 6/8 |
| Edges, local CLI (both engines) | 6/9 | 7/9 |
| `extract --stale` refused (5 per cell) | 30 of 30 | 0 of 30 |
| Missing edges left | title links + `noteb->erin` (+5 on PGLite MCP) | only the two title links (`global_basename` off by design) |

Every other row (withdrawal, leaks, outage recovery, timeline 4/4 and 3/3)
is unchanged. The PGLite MCP cells gained leak-probe coverage, from 12/17 to
15/17 probes with a working control, because link probes now have links to
show.

The harness counts one "acknowledged write lost" per CLI cell under `fix`.
That is `foobarspace`, the collision loser: the vault sync now exits 0, so
the harness treats every file in it as acknowledged, but the skipped file is
deliberately not imported (the #5668 contract). `base` scored 0 on that row
only because the sync failed, so nothing counted as acknowledged. If the
harness should score a reported `slug_collision` skip as expected rather than
as lost, that is a scorer change in gbrain-evals.

## Tests

- `test/persistence-managed-lifecycle.test.ts` (new) runs on PGLite, and on
  Postgres with `DATABASE_URL`. It covers: collision skip with a bystander
  and re-report on `--full`; an existing owner keeping its slug; same-slug
  takeover and case-only respelling; refusal of case-only new pairs; a rename
  keeping its page id, inbound link and alias (plus a frontmatter-id move and
  alias-aware re-extraction); a rename with an edit; managed-sync link
  derivation with forward references and link removal; and `extract --stale`
  through `runExtract` on a managed brain. Of these, 7 of 8 fail on the
  baseline code. The case-refusal test pins behavior that already existed.
- `test/persistence-sync-stdio-owner.serial.test.ts` adds real-CLI delegation
  of `extract --stale` to a resident PGLite owner, and refusal of the
  operation to a remote stdio credential.
- Existing suites stay green: `persistence-managed-sync`,
  `persistence-sync-origin-native.serial`, `persistence-sync-failures.serial`,
  `persistence-sync-options.serial`, `persistence-sync-company.serial`,
  `persistence-sync-receipt-diagnostics`, `derived-link-reconciliation`,
  `extract-stale`, `persistence-administration` and
  `mcp-administration-guidance`. `bun run typecheck` and `bun run verify`
  (55/55) are green.
- Module-size ceilings grew by +1 for `src/cli.ts` and +3 for
  `src/commands/sync.ts`, recorded in `scripts/module-size-limits.tsv`. The
  printing and the delegate code live in sibling modules
  (`sync-diagnostics.ts`, `extract-stale-delegate.ts`).

## Merge seams for the integrator

- **Draft PR #5689 (fix wave 2, unmerged)** touches the same managed-sync
  hunks (`sync-discovery.ts`, `sync-prepare.ts` and `sync-run.ts` origin
  checks, which it moves to `sameSyncOrigin`/`syncOriginScope`). It also
  ships #5609, a managed branch inside `extractStaleFromDB` that publishes
  links, `unrecordedCanonicalTimeline` and the watermark under
  `withCoordinatedWrite`. When both land:
  - Keep this branch's identity-claim loop, but compare origins with
    `sameSyncOrigin` where this branch uses `syncOriginPath(...) ===`. That
    applies to the rename-source checks in `freezeEntry`, `sync-prepare`'s
    `recordedOrigin`, and the claim loop.
  - For `extract --stale`, choose one managed path. This branch routes
    managed brains before `extractStaleFromDB` (in `runExtract`), so #5609's
    in-function branch would become unreachable. If #5609's timeline
    back-projection (`unrecordedCanonicalTimeline`) should run too, call it
    from `extractManagedStaleLinks` inside the same transaction, or route to
    #5609's branch and keep only this branch's owner delegation
    (`writer_extract_stale`) and post-sync extraction.
- **Derived data/sync sibling (#5170)** rewrites `extractStaleFromDB`'s
  replace semantics. This branch does not edit that function; it only adds
  the early managed-brain dispatch in `runExtract`.
- **Import identity sibling (#5675)** changes `import-file.ts`, which this
  branch does not edit. The managed collision rule is in discovery.

## Known limits (not fixed here)

- A rename whose file content also changes re-projects facts at the new slug.
  Fact rows carrying the old `source_markdown_slug` are not moved; the
  library path's `updateSlug` has the same behavior.
- On full syncs with no Git delta, a move is still a delete plus a create.
  Only Git-detected renames (commit delta or working tree) keep page
  identity. Frontmatter-id moves detected by content are left to the
  library-path logic.
- Delegated `gbrain call get_backlinks` with a live `gbrain serve`, the older
  non-persistence serve, still refuses on the lock. The harness reads through
  MCP, so this does not affect its numbers.
