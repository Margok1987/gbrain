# #6188 consolidated implementation spec (approved 2026-10-06)

## Consolidated implementation plan

One coherent spec merging the plan body with every CEO, DX and Eng accepted obligation. Where they conflicted, the obligation won and the superseded text is gone. Taste-provisional items carry their IDs (T1-T6, TD1-TD2, TE1-TE2); the user decides them at the final gate, and the user challenges UC1-UC3 are marked where they apply.

### 1. Context

- Repo `garrytan/gbrain`, base master v0.60.95.0 (c5fb0201). Fix wave 10 (GBRA-51, `origin/capy/fix-wave-10`) lands first and makes fence location code-aware (`src/core/fence-scan.ts`; changes to `facts-fence.ts`, `takes-fence.ts`, `canonical-projections.ts`, `import-file.ts`). This PR builds on wave 10: the pure modules start now; edits to those files are made after wave 10 is on master, merged in with merge commits (never rebase).
- GBRA-41 will define `nextFreeRowNum` as "a number never seen before on this page". If this PR lands first it exports the allocator below with that contract (E40).

### 2. Problem (verified in code, 2026-10-06)

- `compileCanonicalProjections` throws `invalid_params` whenever a fence has any parser warning, a repeated marker, or duplicate row numbers (master `canonical-projections.ts:228-236`; wave 10 :268, :272, :275). Every coordinated writer reaches it through `prepareCanonicalProjections`: managed sync (`sync-prepare.ts:427`), put_page (`page-prepare.ts` ~:403), managed import (`import-prepare.ts:196`), reconcile (`reconcile-prepare.ts:70`), connector sync (`connector-sync.ts:1051`), file repair (`file-repair.ts:262`), company brain (`company-brain/profile.ts:124`), synthesize verify (`synthesize-verify.ts:1367`), and the export roundtrip calls `compileCanonicalProjections` directly (`shared-skills/migration-projection.ts:30`).
- Two more fence refusals exist: `take_row_collision` (wave 10 :301-304, thrown at prepare :328 and in publication :355) and the import-preparation withdrawal guard "A malformed fact fence contains a withdrawn claim." (`facts/withdrawal.ts:164-166`). Wave 10 adds the quoted-fence refusal in publication (`refuseQuotedFenceLoss`, :285-299).
- The managed screen (`screenFrozenImport`, `sync-screen.ts:84-115` → `screenSyncImport`, `sync-prepare.ts:155-177` → `screenImportContent`, `import-screen.ts:100-114`) checks size, frontmatter, slug and sanity, never fences. A malformed fence is admitted, fails in preparation, and the cursor blocks.
- `convertBlockedCursor` (`sync-run.ts:377-397`, run start only at :758-762) converts only what `isContentRefusal` recognizes (`import-screen.ts:174-179`); fence refusals are not recognized, so `--retry-failed` reproduces the block and no hold is written.
- Parser warning classes map onto the issue's failure table: `*_FENCE_UNBALANCED`, `*_TABLE_MALFORMED` (short rows, unknown kind/visibility/notability, invalid row number, non-numeric confidence/weight/claim value, row before header, no header), `*_ROW_NUM_COLLISION`, `TAKES_HOLDER_INVALID` (warning-only, the row is kept), `TAKES_FENCE_NEAR_MISS` (takes only; facts has no near-miss check). Parser warning strings embed row text (`facts-fence.ts:214,228`; `takes-fence.ts:300,309,339`).
- Layouts the strict parsers accept: facts rows of 9, 10 or 14 cells (9 = missing trailing context), takes rows of 6, 7 or 13 cells (6 = missing source); headers are recognized by containing `claim` and `kind`; cells are read positionally (takes resolution columns by header name).

### 3. Goal and the never-block guarantee

A malformed fence never blocks a sync. Most fences are fixed for free, inline, in the same write. The rest are held (the sync proceeds) and repaired after the sync by a resolver pass and then a frontier-LLM pass, under validation gates and a daily spend cap. A one-shot command clears the backlog, and doctor counts what is left.

Guarantee scope (E37): it holds for managed sync with the default `sync.holds=hold` and for legacy sync. Two documented exceptions keep blocking with typed fence text: `sync.holds=fail` (opt-in fail-closed; `loadSyncScreenRun` returns null, `sync-screen.ts:33`) and company-brain sources (UC3; they never hold and never rewrite repository files, `sync-run.ts:245`, `sync-prepare.ts:419-420`, `company-brain/profile.ts:116-119`).

Invariant 0 (blast radius): a fence that parses clean is never changed; on coordinated paths only content refused today changes; on legacy paths (T5) a fence that parses with warnings may be normalized in the stored body but never refused or held.

### 4. Design

```
 file bytes / put_page body / append-verb target page
        │
        ▼
 ┌──────────────────────────────────────────┐  pure, deterministic, free
 │ Tier 1  normalizeFences(page, ctx)        │  same function in: screen (freeze, prepare),
 │         validateFenceRepair (a)-(f)       │  importFromContent, append verbs (TD2)
 └───────────────┬──────────────────────────┘
       clean ────┴──► import continues; managed sync writes the normalized file back
       │              (overlay → writeback → Git effect); mirrors DB-only; company → source_writeback_required (UC3)
       │ residual
       ▼
 coordinated: managed sync → hold invalid_fence (cursor advances)   put_page/remember/... → typed refusal + fence_issues
 legacy (T5): import as today with fence_issues warning (no hold, no refusal)
 prepare-time or publication-time fence refusal (DB-dependent) → hold from receipt, same run
       │
       ▼
 ┌──────────────────────────────────────────┐  global maintenance phase fence_repair (T1)
 │ Tier 2  verified holders                  │  and gbrain repair fences (owner host only)
 │ Tier 3  frontier LLM, residual rows only  │  ledger-capped, memoized, time-budgeted
 └───────────────┬──────────────────────────┘
       gates (a)-(f) + Tier 1 fixed point on every tier's output
       pass → managed_file_repair (managed) / confined legacy write + backup + import (T2) /
              revision-bound put_page (DB-only) / database-only (mirror); hold clears in that write
       fail → stays held with the exact reason; never blocks
```

### 5. Modules and interfaces (E2, E17)

New (pure unless noted):
- `src/core/fence-repair/raw-rows.ts`: `extractRawRows(section)` returns fences with begin/end offsets (via wave 10 `locateOutsideCode`), the before-region (begin to end, or to section end when the end marker is missing), header row and a header→canonical column map (positional canonical layout when no header is recognizable), rows before the header, raw cell text (pipes unescaped as `parseRowCells` does), and structured issues. Never reads parser warning strings.
- `src/core/fence-repair/normalize.ts`: `normalizeFences(page: {compiled_truth; timeline}, ctx: FenceCtx)` → `{ page; fixes: FenceFix[]; residual: FenceIssue[] }`; `FENCE_RULES_VERSION` (stored as hold `fence_version`); `nextFreeRowNum(page, storedRows)` (E40).
- `src/core/fence-repair/validate.ts`: `validateFenceRepair(before, after, ctx & { tier; issues })` → `{ ok: true } | { ok: false; reason; gate; rows }`; `isFenceFixedPoint(page, ctx)`.
- `src/core/fence-repair/reasons.ts`: `FENCE_REASONS` (section 9) feeding `CODES.invalid_fence.reasons`, docs anchors and fix templates (D13).
- `src/core/fence-repair/llm.ts` (I/O): Tier 3 prompt, gateway call with no tools, single-table extraction, failure classification.
- `src/core/repair/fences.ts` (I/O): the `fences` repair kind (plan/apply, candidates, tiers, write-back).
- `src/core/budget/daily-ledger.ts` (I/O): the shared durable USD ledger (E11).
- `src/commands/doctor/checks/fence-integrity.ts` (I/O).

Types: `FenceCtx = { pageVisibility: 'private'|'world'; storedRows?: StoredRowMap; verifiedHolders?: Map<string,string>; takesPackKinds?: readonly string[]; hiddenRows?: Set<number> }`; `FenceIssue = { fence: 'facts'|'takes'; section: 'body'|'timeline'; row: number|null; column: string|null; reason: FenceReason; allowed?: readonly string[] }`; `FenceFix = { fence; section; row; column; class: FixClass }`. All location-only.

### 6. Tier 1 rules (each fix carries a class used in receipts, holds and previews)

Every rule edits or moves raw cell text; no rule re-renders a table (E18).

| Class | Rule |
|---|---|
| `close_fence` | Missing end marker: insert it after the last contiguous table row following the begin marker, only when every raw row of the before-region ends up inside the fence; two row blocks separated by a blank line or prose → residual `split_rows` (manual). A table under an end marker with no begin marker is never guessed (residual `missing_begin`, manual). |
| `marker_form` | Takes only (E20): two-dash near-miss markers (`<!-- gbrain:takes:begin -->`) → canonical three-dash form, only when a pipe table follows the near-miss marker (after blank lines); otherwise residual. Facts two-dash markers parse clean and are untouched. |
| `renumber` | Row `0`, negative or non-numeric numbers, and duplicates (within a fence and across both sections) are renumbered. Prior-aware: when two rows share a number, the row whose (row number, claim) matches the stored canonical row keeps it; the first occurrence keeps it only as a tiebreak. New numbers come from `nextFreeRowNum` = max(every fence row, live and struck, both sections; stored `takes.row_num` for the page; stored `facts.row_num` for the slug) + 1, so a freed number is never reused. A header without a `#` column mints numbers the same way. Residual `superseded_ambiguous` (manual) when any row's context `superseded by #N` names a duplicated N. Hidden rows (remote callers) are never renumbered. |
| `column_default` (T6) | A required facts column absent from the whole header gets the write default (`confidence 1.0`, `notability medium`, `visibility private`). Rows short only in tolerated trailing cells already parse and are untouched. A row short in a required or free-text middle position → residual `short_row` (Tier 3). Takes missing `weight` → residual `weight_missing` (manual; no default exists). (E19) |
| `header_alias` | A non-canonical header whose columns all map to canonical columns (`holder`/`who`, `confidence`/`weight` for takes, `type`→`kind`, `date`→`since`, etc.) is rewritten to the canonical header and raw cells are moved into canonical order. Any unmappable column → residual `header_unmapped` (Tier 3). Layouts: facts 9/10/14, takes 6/7/13. |
| `enum_synonym` | notability `critical`/`very_high`/`highest` → `high`, `very_low`/`minor` → `low`; visibility `internal`/`team`/`confidential`/`restricted`/`secret`/`shared` → `private`; `public` → `world` only when `effectiveVisibility(page)` is `world`, else `private`; case/whitespace variants of canonical values. Any other word → residual `enum_unmapped` (manual). |
| `kind_map` | Facts: `proposal`/`suggestion`/`hypothesis` → `idea`; `opinion`/`view`/`insight`/`assessment`/`frame` → `belief`; `promise`/`pledge` → `commitment`; `meeting`/`launch`/`announcement`/`milestone` → `event`; everything else (including `partnership`, `funding`, `investment`, `role`, `signal`, `claim`, `observation`, literal `[kind]`) → `fact`, with `original kind: <word>` appended to the row's `context` after existing text (so `superseded by #N` and `forgotten:` parsing is unchanged). Takes: only `assessment`/`recommendation`/`strategic position`/`opinion`/`view` → `take`, `prediction`/`forecast` → `bet`, `guess`/`intuition` → `hunch`; any other word, and any kind the active schema pack declares in `takes_kinds` that the parser does not accept, → residual `takes_kind_unsupported` (manual, no Tier 3 spend; Tier 3 never chooses a takes kind). The original takes word survives in Git history, page version history or the legacy backup, not the receipt. |
| `holder_alias` | `system`/`assistant`/`ai`/`agent`/`gbrain`/`model` → `brain`. Display names → residual `holder_unresolved` (Tier 2). |
| `confidence_format` | `85%` → `0.85`; numeric confidence/weight strings with stray whitespace. Out-of-range numbers → residual `confidence_out_of_range` (manual). |

Manual-only residual classes (`missing_begin`, `split_rows`, `repeated_marker`, `takes_in_facts`, `superseded_ambiguous`, `enum_unmapped`, `weight_missing`, `confidence_out_of_range`, `claim_value_invalid`, `takes_kind_unsupported`, and `holder_unresolved` after a Tier 2 miss) carry a fix naming exactly what to edit (location only) and are never sent to Tier 3.

Properties: idempotent (`normalize(normalize(x)) = normalize(x)`); clean pages byte-identical; outputs are fixed points.

### 7. Validator: gates (a)-(f)

`validateFenceRepair` is the single gate every tier passes before anything is written. Gates (b), (c), (e) and (f) are computed over the raw-row extraction of the before-region, never over strict-parser output.

- (a) `still_invalid`: the after-page parses with zero warnings under the strict parsers and passes the compile checks (no repeated marker outside code, row numbers unique across the page).
- (b) `claim_changed`: the multiset of claim cells (strikethrough kept as written, whitespace collapsed) is identical.
- (c) `row_number_changed`: every row number that was valid and unique before still exists and carries the same claim.
- (d) `visibility_loosened`: a row that parsed `private` is never `world`; an invalid or missing visibility becomes `world` only through the `public`-on-a-world-page rule.
- (e) `row_count_changed`: the raw row count is unchanged (only header/separator lines may differ) and every raw row of the before-region sits inside the after-fence.
- (f) `cell_changed` (TE2 definition, E22): per row, a non-claim cell that was valid in its column keeps its column and text (whitespace collapsed); a misaligned cell may move to another column with unchanged text; text changes only where an issue names that row and column and the new text comes from a named rule (`kind_map`, `enum_synonym`, `confidence_format`, `holder_alias`, the verified resolver, `column_default`, header reorder). A changed holder must be `brain`/`world` via `holder_alias` or equal `ctx.verifiedHolders.get(beforeHolder)`; any other Tier 3 holder fails (f).
- Fixed point (E14): before any write, `normalizeFences(after)` reports zero fixes.

Failures carry `reason`, the gate letter and the rows. Messages never carry claim text, holder names or cell values.

### 8. Tier 1 on every write path

**Screen (E8).** `screenImportContent` gains a fence step after the frontmatter checks and a mode: `coordinated` (managed sync freeze `screenFrozenImport` and its dry run, managed sync prepare `screenSyncImport`, managed import, `managed_file_repair`'s screen, coordinated put_page) refuses a residual with `invalid_fence`; `lenient` (legacy sync `holdRefusedImport`, `importFromFile`, legacy put_page) returns importable plus `fence_issues`. With `fences.normalize=false` a fixable fence is treated as residual on coordinated paths (E26). The step early-exits when neither section contains `gbrain:facts:` or `gbrain:takes:` (E32). The screen runs without the stored-row map; its verdict does not depend on it.

**`importFromContent` order (E7).** After the screen: normalize the incoming sections with Tier 1 (stored-row map loaded only when a `renumber` fix is planned), then `mergeHiddenFactRowsIntoBody` (remote callers), then `preserveWithdrawnFenceRows`, then hash and prepare. The content hash covers the normalized body. Coordinated residual → typed refusal with `fence_issues`; legacy residual → stored as today with the same `fence_issues` as a warning (T5). A normalizer or validator exception → `invalid_fence`/`normalizer_failed` on coordinated paths (logged, gbrain version recorded) and the un-normalized body with a warning on legacy paths (E38). Result field `fences_normalized` (D12).

**Managed sync write-back.** A normalized body differs from the parsed file, so the existing `overlay` → `writeback` writes the normalized file under `expectedBeforeHash` and the Git target effect commits it (`sync-prepare.ts:418-434`). Read-only mirrors keep the fix in the database (`mirror_read_only`, `:422`). Company-brain sources refuse with `source_writeback_required` for a Tier-1-fixable fence and `invalid_fence` for a residual, each with a fix naming fence, row, column and "fix in the repository and commit" (UC3).

**Compile backstop and typed sites.** `compileCanonicalProjections` throws typed `invalid_fence` at each site: `repeated_marker`, `unparseable`, `row_collision`; publication-time `quoted_fence_rows` (wave 10 `refuseQuotedFenceLoss`); `stored_row_collision` (`take_row_collision`, E4); and `assertPreparedFactWithdrawals` throws `withdrawn_claim_in_malformed_fence` (E6).

**Prior takes (TE1, E5).** When the prior snapshot's takes fence parses with warnings, `prepareCanonicalProjections` counts the page's stored `takes.row_num` as prior canonical rows, so a normalized existing row is an update and not a collision.

**Normalize before compile elsewhere.** `synthesize-verify.ts:1364-1375` normalizes the verified body before `prepareCanonicalProjections`. The export roundtrip (`migration-projection.ts:30`) refuses typed `invalid_fence` with fix `gbrain repair fences --slug <slug>` instead of normalizing (E16).

**Write verbs.** put_page, put_pages, capture, extractor and dream writes go through `importFromContent` and report `fences_normalized`. Append verbs `remember`, `extract_facts`, `takes_add`/`takes_update` and `facts relink` normalize the target page's existing fence with the same normalizer and gates in the same coordinated write and report `fences_normalized` (TD2, D20); a residual target fence refuses `invalid_fence`/`target_fence_malformed` with the fence location and the state fix (D19) at `memory-prepare.ts:94-100` (which today throws `storage_error`, E25), `facts-prepare.ts:118-122`, `page-edit.ts:94-97` (refuse only), `facts/relink-publish.ts:174` and `relink-reasons.ts:18` (refuse only for residuals), forget (refuse only), and takes writes through the backstop. No message claims "gbrain doctor names the page" unless `fence_integrity` does. No LLM call on any foreground write (UC2).

**Coaching (D21).** A write whose fence was normalized returns `[gbrain notice fence_normalized kind=coaching]` once, naming rows and classes (no values), stating that the stored page differs from what was sent and must be re-read with `get_page` before editing, and naming `remember`/`takes_add` as the structured path. Remote refusals and notices name only the caller's rows, never rows restored by the hidden-row merge.

### 9. Refusal contract

- Code: `CODES.invalid_fence` in `src/core/error-registry.ts` (E24): `class: 'caller'` (content refusal, not server fault), `legacy_error: 'invalid_params'`, `reasons` from `FENCE_REASONS`, default suggestion and read-only fix. Every refusal is built with `legacy_error: 'invalid_params'` except `stored_row_collision`, which keeps wire `take_row_collision` (E3). Wire codes stay inside `WRITE_ERROR_CODES` and connector `CONTENT_CODES`.
- Message grammar: `Fence <reason>: in the <fence> fence (<section>), row(s) N, column(s) C, at line L.` followed by a location-only fix sentence. `contentRefusalFromReceipt` parses it back to `invalid_fence` and its reason; `LEGACY_CONTENT_MESSAGES` adds the three legacy compile messages, the withdrawal-guard message and the `take_row_collision` message; `isContentRefusal` recognizes all of them.
- Structured data (D16, D18): refusals, holds and repair outcomes carry `fence: { fence, section, rows, columns, classes, tier, auto_retry, next_attempt_after }` and `line` (file line of the first bad row); refusals carry `fence_issues: [{ fence, section, row, column, class, allowed }]` (`allowed` is schema vocabulary) and a suggestion naming `remember`, `takes_add` or `resolve_slugs` where relevant.
- Fix by state (D17, E35) without changing `deriveNext`: auto-repair pending and maintenance active on the owner → `why` says no action is needed and gives `next_attempt_after`, argv is the read-only preview; maintenance inactive → the preview and apply commands; manual-only → preview whose listing names the exact edit (`agent` locally, `host_admin` remotely); `budget_exhausted`, `llm_disabled`, `no_pricing` → `actor: 'agent'`, `consent: ['paid']`, the exact config or `pricing set` command (renders `ask_user`); `owner_unavailable` → the owner-host command; remote callers get a `user_message` saying whether it clears automatically, with `fix.next = tell_user_to_run`.
- Agent contract fixtures distinguish a refused caller write (agent corrects and resubmits with a new request id) from a stored file hold (owner-host repair).

`FENCE_REASONS` (tier, `auto_retry`, actor, fix template, docs anchor per reason; drift-tested against the registry and `docs/guides/write-refusals.md` anchors):
- Screen residual: `header_unmapped`, `no_header`, `row_before_header`, `short_row`, `extra_cells` (Tier 3); `holder_unresolved` (Tier 2, then manual); `missing_begin`, `split_rows`, `repeated_marker`, `takes_in_facts`, `superseded_ambiguous`, `enum_unmapped`, `weight_missing`, `confidence_out_of_range`, `claim_value_invalid`, `takes_kind_unsupported` (manual).
- Preparation and publication: `unparseable`, `row_collision`, `quoted_fence_rows`, `stored_row_collision`, `withdrawn_claim_in_malformed_fence`, `target_fence_malformed`, `prepare_time`, `normalizer_failed`.
- Repair runs: `llm_unavailable`, `llm_empty`, `llm_refused`, `llm_malformed`, `llm_truncated`, `llm_disabled`, `budget_exhausted`, `no_pricing`, `ledger_unavailable`, `owner_unavailable`, `owner_cli_required`, `sync_in_progress`, `time_budget`, `changed_since_read`, `changed_since_preview`.
- Gates: `still_invalid` (a), `claim_changed` (b), `row_number_changed` (c), `visibility_loosened` (d), `row_count_changed` (e), `cell_changed` (f).

Every refusal switch site gets an `invalid_fence` branch whose text names fence, row, column and `gbrain repair fences` (never frontmatter) and the planned tier and next attempt: `syncContentRefusal` (`sync-prepare.ts:128-139`), page-prepare refusal text (`page-prepare.ts:371-377`), `contentRefusalFromReceipt` (`import-screen.ts:133-153`), `gitHoldFix`/`gitHoldDocs` (`sync-holds.ts:249-285`), `managedImportRefusal` (`import-prepare.ts:57-63`), frontmatter repair listing (`repair/frontmatter.ts:166-175`, defers to `repair fences`), failed-writes routing (`repair/failed-writes.ts:71-79`). Connector classification stays `content` through the wire code (test).

### 10. Managed sync: holds and conversions

- `GitHoldCode` gains `invalid_fence`; `GitHoldReason` gains the fence reasons; `GitHoldMeta` gains `fence_version` and the D16 `fence` object. Hold messages are location-only.
- Re-screen (E23): one `holdRescreenDue(record)` predicate used by managed discovery (`sync-discovery.ts:285-288`) and legacy `planHoldRescreen` (`commands/sync/holds.ts:116-118`) re-screens a hold when its blob or bytes change, when `sources retry-held` asks, or when `recovery_version` or `fence_version` is older than the running gbrain's. Under T5 legacy sync never writes fence holds.
- Hold from receipt (prepare-time): `convertBlockedCursor` holds the entry when the failed receipt is any typed fence refusal or legacy fence message, even if the re-screen admits the same bytes; the hold is written from the receipt's location-only message with reason `prepare_time` plus the receipt's reason.
- Same run (E10): the conversion hook sits at the terminal-failure branch of the managed sync loop (`sync-run.ts` :861-873, reached by the single path and by `groupStep`'s failed member, :577-587). It waits for the source's unfinished requests within the run's existing wait budget, converts at most once per request, writes no failure-ledger row for a converted request, records the conversion with `recordSyncConversion`, and continues the same invocation. If lane requests are still running it returns `partial` (`writer_pending`), never `blocked_by_failures`; the next run's start-of-run conversion holds it.
- Upgrade: an already-blocked cursor whose failed receipt carries a legacy fence message converts on its next run with no command (the issue's 40-hour stall).
- Escalation: fence holds count toward `holds_escalated`, which only flags.
- Dry run (D28): `gbrain sync --dry-run` reports `would_normalize` (paths and classes) beside `would_hold`, carried by `syncHoldJsonFields`, and writes nothing. The listed normalization is planned; preparation may allocate different new row numbers (stored rows).
- Sync result: `fences_normalized` (`count`, `by_class`, `writers`, `sample_paths` for trusted local callers, `common_prefix`, `fix`) with writers by receipt principal when known and by common path prefix otherwise, plus a coaching `fix.why` modeled on `recovered_frontmatter` (D12, D31). Counts accumulate in the cursor and are flushed once per run to the per-source per-UTC-day trend row (E33).

### 11. Legacy paths (T5, T2)

Unmanaged sync, `importFromFile` and legacy put_page import a residual fence's body as today (bad rows skipped and reported) after Tier 1, never refuse or hold for a fence, and return `fence_issues` as a warning. `docs/guides/live-sync.md` corrects "Managed and legacy sync behave the same" for fences. Tier 2/3 still repair the files: automatic legacy write-back (T2) re-reads the file and requires the planned before-hash (else `changed_since_read`), confines the path with `confinedRepairTarget` (`file-repair.ts:88-104`), writes a backup with `createFrontmatterBackup` (`brain-writer.ts:138`), imports with `importFromFile`, and records an "uncommitted fence repair" notice (shown by `sources status` and `fence_integrity` with the exact `git add`/`git commit` command) until the path is committed.

### 12. Tier 2 and Tier 3: the `fences` repair kind

Registered in `REPAIR_KINDS` (`repair/core.ts:26`) and `SPECS` (`repair/registry.ts`) with `checks: ['fence_integrity']`, `embeds: 'effect'`, `preview_bound: true` (new spec field, independent of `explicit_only`, D8), `spends: 'llm'` (new, D10). Not `explicit_only` and no destructive consent (T3): `--all`, `doctor --remediate` and the cycle run it.

**Candidates per source.** `invalid_fence` holds; DB pages whose stored fence fails strict parsing, found by an incremental scan (watermark on `pages.updated_at`, index `idx_pages_updated_at_desc`, plus a one-time resumable keyset backfill over `id`, both in `op_checkpoints`); DB-only and connector pages; and working-tree files of checkout-backed sources through a resumable first walk reusing `scanBrainSources` and afterwards only files changed since the last walked commit plus dirty files (mtime watermark for non-Git sources), `partial` when a deadline stops it (E34).

**Per candidate.**
1. Skip the source while its managed sync cursor is unfinished, and skip any path a queued or running managed-sync request references (reason `sync_in_progress`, E9). On a non-owner host skip with `owner_unavailable` (counted, not an error).
2. Re-read the current bytes (file for holds and files, page snapshot for DB pages) and run Tier 1.
3. Tier 2: for each `holder_unresolved` row, `resolveStrictEntityReference` (`entities/resolve.ts:319`) without the `sameName` arm, accepting only `people/` or `companies/` results, with `excludePrivate: true` on world pages (E12). A miss stays residual. Results feed `ctx.verifiedHolders`.
4. Tier 3, only for Tier 3 residual reasons and only when `fences.repair.llm` is true: send the header and residual rows (the whole fence only for fence-level issues), the canonical schema, residual reason codes and the page's visibility; never valid rows, never the rest of the page; no tools. Model `models.fence_repair`, resolved through `resolveModel` tier `deep` and listed in `gbrain models` `PER_TASK_KEYS` (D11; T4 may change the default). Repaired rows are spliced back. One paid attempt plus at most one corrective re-ask (failed gate letter and row numbers) inside the per-page cap, per attempt-memo key (content sha256, model, `fence_version`, prompt version); a rejected key is not retried until one changes; transient provider errors do not consume the memo. Distinct failures: `llm_unavailable` (timeout, 429, 5xx), `llm_empty`, `llm_refused`, `llm_malformed` (no table or prose outside it), `llm_truncated` (finish reason not stop, rejected even if it parses).
5. Spend: before a call the estimate (from fence size) is checked against `fences.repair.max_usd_per_page` and the ledger's daily remainder (and any lower `--max-usd`); over either → hold names the estimate, the cap and the exact `gbrain config set` command. The ledger reserves before dispatch and settles actual tokens after; failed and retried calls settle against it. Unpriced model: metered at `FALLBACK_PRICING` (Sonnet tier, `cycle/budget-meter.ts:49`) with the warn-and-run notice and `pricing set` command under default caps; refused with `noPricingGuidance` under a user-set cap.
6. `validateFenceRepair` gates (a)-(f) and the fixed point. Failure keeps the hold/candidate with the reason, gate and rows ("LLM repair rejected by gate X; needs a manual edit at rows N").
7. Write-back: managed sources through `submitManagedFileRepair` (exact bytes, import, hold clear and Git effect in one coordinated write, bound to the file's before-hash and page revision); legacy sources per section 11 (T2); DB-only pages through a revision-bound put_page; read-only mirrors database-only (`mirror_read_only`). Receipt actor `fence-repair` with tier, fix classes and rows/columns, model (Tier 3), before/after sha256 and cost; no cell values. Commit subject `gbrain: repair fence in <path> (<classes>)`; a batched commit lists one path and its classes per body line.

**Worker principal (E15).** The first build step proves `managed_file_repair` admission from the maintenance worker's authority and principal (`file-repair.ts:176-181,217`). If refused, managed candidates are held with `owner_cli_required` routed to `gbrain repair fences`, while DB-only and legacy candidates still repair.

**Command.** `gbrain repair fences [--source <id>] [--only <path>]... [--skip <path>]... [--slug <slug>] [--apply [--expect <hash>]] [--no-llm] [--max-usd <n>] [--diff] [--json] [--limit <n>]`.
- Preview (default, read-only, no model call): per candidate path/slug, reasons, rows and classes, planned tier (`deterministic`/`resolver`/`llm`/`manual`), estimated LLM cost, the total versus the remaining daily cap, and the preview hash (bound to the selection, Codex DX #6). Tier 1/2 show the exact diff (one sample per tier by default; every diff with `--diff` or `--json`, D14); Tier 3 rows say "rewritten by <model> at apply time, gated by (a)-(f)". The printed `apply_command` always includes `--expect` and the selection.
- `--apply --expect <hash>` applies exactly the previewed set (`changed_since_preview` for anything whose bytes or revision moved); bare `--apply` (from `--all`, `doctor --remediate`, the cycle) applies the current plan.
- `--max-usd <n>` (TD1) is accepted only for kinds whose spec has `spends: 'llm'`; it lowers the cap below the remaining daily ledger and never raises it. The `repair.ts:94-98` refusal and help (`:65-67`) become kind-aware; `--expect` and `--diff`/`--only`/`--skip` parser checks (`:125-131`) accept preview-bound kinds and `fences`.
- Result: the shared runner's `complete` keeps its meaning; the fences result adds `repaired`, `remaining` by reason, `scan: { fresh_at, partial }`, `cost.llm_usd` (null only for an unpriced model under a user-set cap) and `cost.llm_cap_remaining_usd`, `details.tiers`. Verification re-checks fence integrity over the selected scope and separates unresolved damage from pending publication and an outstanding legacy commit; a run where every Tier 3 proposal is rejected never reports fixed (Codex DX #4).
- Budget stop (D15): when the ledger refuses the next call during apply, the run stops with `stopped.reason = budget_exhausted`, exit 1, a message naming spent and cap, the reset time (next 00:00 UTC, ISO), the pages waiting, and `gbrain config set fences.repair.max_usd_per_day <n>` as a fix with `consent: ['paid']`. A run that ends with only manual-only residuals exits 0 with `residuals` set.
- MCP callers cannot reach Tier 3 or a file write by any path.
- Cost surfaces (D10): `repairMaySpend` counts `spends: 'llm'`; the `gbrain repair` summary prints "Kinds that may call a paid model" with estimate and remaining cap; `planRepairSteps` includes `llm_usd` in `est_usd_cost` and `paid`; `runRepairSteps` refuses the step when the estimate exceeds the remaining `--max-usd`.

### 13. Cycle phase `fence_repair` (T1)

`PHASE_SCOPE.fence_repair = 'global'` (so it is in `MAINTENANCE_PHASES` and never in `SOURCE_FRESHNESS_PHASES` or queued per-source payloads), placed after `sync` in `ALL_PHASES` with the matching `runCycle` dispatch block, classified `writes` in `MANAGED_PHASE_TABLE`. The wrapper runs the `fences` kind through `runRepair` in auto mode across sources (no rule logic of its own), gated by `fences.repair.enabled` and `fences.repair.llm`, under the daily ledger across ticks. Time budget (E13): stop at the smaller of 300 s and one third of the maintenance job's remaining deadline, per-call timeout, resume from the repair cursor, `stopped.reason = time_budget`. The phase report lists candidates, fixed per tier, held per reason, USD spent, the oldest unresolved fence hold's age and USD per successful Tier 3 repair. Repairs run only on the canonical owner host.

### 14. Spend ledger (E11)

`src/core/budget/daily-ledger.ts` over the existing `budget_ledger` and `budget_reservations` tables (migration v012; no schema migration): scope `llm_repair`, resolver `fences`, `local_date` = UTC date. `reserve(estimate)` is one conditional upsert that succeeds only if `reserved_usd + committed_usd + estimate <= cap_usd`, plus a reservation row with `expires_at`; `settle(id, actual)` moves the amount to `committed_usd` (an overrun is recorded); `release(id)`; reclaim of expired held reservations runs before each reserve. A ledger error means no call (`ledger_unavailable`). Atomic across the cycle and the CLI. The helper is generic (scope/resolver parameters) so auto_drain can adopt it later. `graduation-inventory.ts:33,171` text is updated (reservations now have a writer; discarding them at graduation remains correct because they expire).

### 15. Doctor `fence_integrity`, wave check, banner

- `fence_integrity` (per source): `invalid_fence` holds, DB pages and files whose fences fail strict parsing, split by planned tier, from the stored per-source summary plus at most a bounded scan (`partial` status); oldest hold age; USD per successful repair; a 7-day normalization trend and top writers with a warning at the named, documented threshold constant (D34); outstanding legacy commits. `ok` at 0; `warn` otherwise with the exact preview command and `repairForCheck` wiring so `doctor --remediation-plan` lists the `fences` step (with `llm_usd`). Explains when Tier 3 is off or over budget. A finding the cycle repairs is described as "repaired automatically by the next maintenance run", never "after the user agrees".
- `WAVE_CHECKS` entry (`doctor/wave-checks.ts:51`): `resolution: 'repair'`, remote-safe impact line (no path or claim), count from details.
- `POST_UPGRADE_NOTES` entry (`doctor/upgrade-banner.ts:34`, separate from `frontmatterHoldsBannerNote`): sources blocked by an `invalid_fence` or legacy fence receipt; the next sync recovers them with no command; `gbrain sync --source <id> --no-pull` does it now; the malformed-fence count and when the maintenance run repairs them; the preview and pause commands.

### 16. Configuration (D29, D11; all default on, opt-out)

Registered in `KNOWN_CONFIG_KEYS` (`config.ts:1215`) and validated at `config set` (booleans; non-negative numbers, 0 = no Tier 3 spend): `fences.normalize` (true; inline write paths only, E26), `fences.repair.enabled` (true; the cycle phase), `fences.repair.llm` (true; Tier 3), `fences.repair.max_usd_per_page` (0.05), `fences.repair.max_usd_per_day` (1.00). Model override `models.fence_repair` (no `fences.repair.model`). `sync.holds=fail` keeps fail-closed blocking with the typed code. Every opt-out command printed in docs, notices and the migration note is tested.

### 17. Surfaces and routing

- One hold repair router (D6) maps hold codes to repair commands (`invalid_fence` → `gbrain repair fences --source <id>`, frontmatter codes → `gbrain repair frontmatter ...`; a mixed source names both) and every surface uses it: `gitHoldFix`, `buildHoldReport.holds_fix` (`sync-holds.ts:466`), `hostOperatorFix`/`repairArgv` (`held-reads.ts:94-103`), `heldFileDiagnostic` (`verb-errors.ts:24`), doctor `git_held_files` repair/fix/docs (`git-holds.ts:28,43`), the `frontmatter_holds:` banner (`:78`), `sources retry-held` (`sources-retry-held.ts:72`), `managed_file_repair` refusals (`file-repair.ts:80-96,188,221`), `gbrain sync --help`, `gbrain sources --help`. A single-file hold's fix points at that file's preview (`--only`).
- `holdLine` renders "in the <fence> fence (<section>), row(s) N, column(s) C, at line L".
- Remote/MCP callers see fence holds through existing status surfaces with `tell_user_to_run` naming the owner-host command (Codex CEO #7).

### 18. Privacy

`FenceIssue`/`FenceFix` come from structured raw-row data, never parser warning strings. Receipts carry fix class, row and column only. Commit messages carry path and classes only. Holder resolution on world pages excludes private pages. Sentinel test: a unique claim, holder and kind string never appears in hold rows, refusals, receipts, sync results, notices, doctor output, commit messages or logs. Docs and fixtures use synthetic placeholder content; the E2 skill edit adds no real names (D32).

### 19. Docs, notices, release plumbing

`docs/guides/repair.md#fences`: a real-output walkthrough (volatile values masked, synthetic content) covering banner, converting sync, `sources status`, preview, apply and doctor ok, plus inspect/undo guidance (Git commit, page version history, legacy backup; turning settings off stops future repairs and does not undo past ones), checked line by line by `test/fence-walkthrough.test.ts` (D22, Codex DX #8). A fence format reference (facts 9/10/14 and takes 6/7/13 columns, allowed kinds, notability, visibility, holder forms, row-number rules, one valid example per fence, what gbrain normalizes versus never guesses) generated from parser constants and linked from every `invalid_fence` anchor (D23). `docs/guides/live-sync.md` (fence holds; T5 correction), `docs/guides/write-refusals.md` (what a fence hold carries, an anchor per reason, generalized `changed_since_preview`), `docs/guides/error-codes.md` (generated), `docs/guides/troubleshooting.md` symptom row, `docs/guides/spend-controls.md` Tier 3 gate row (USD ledger, caps, off switch, posture not consulted), `docs/guides/facts-relink.md:117` and `relink-reasons.ts:18` name `gbrain repair fences`, AGENTS.md "Sync held a file" (fence holds clear automatically, `repair fences` needs no extra consent, raising spend is the user's call), `REPAIR_HELP`/sync/sources help (D24). `skills/_brain-filing-rules.md` takes section recommends `takes_add` and canonical holder forms (E2, no real names). `skills/migrations/v<version>.md` in the shape of `v0.60.47.0.md`: finish the upgrade; blocked sources recover by themselves (or now with `gbrain sync --source <id> --no-pull`); what is rewritten automatically and how to preview or pause; the first maintenance run repairs every malformed fence it finds, rewriting and committing files, with the `fence_integrity` count, the preview command and `gbrain config set fences.repair.enabled false` to pause first (D25); what stays held; Tier 3 sends only fence rows to the configured chat provider under the default caps with `gbrain config set fences.repair.llm false` as the opt-out; undo guidance; which steps need the user (D27). Two `BEHAVIOR_CHANGES` rows (D26): "malformed fences no longer block sync; fixable ones are rewritten and committed, the rest held" with `gbrain config set fences.normalize false`, and automatic repair sending only fence rows to the configured chat model under the default caps with `gbrain config set fences.repair.llm false` and the T4 measured rates. KEY_FILES entries, CHANGELOG, llms regeneration, `cli-flag-registry.generated.ts` (D30), plugin stamps. Version and migration numbers are picked when the PR is next in the merge train; no schema migration is expected.

### 20. Tests (tier in brackets; value cards in the test-plan artifact)

- `test/fence-repair-raw-rows.test.ts` [unit]: layouts, positional fallback, escapes; differential: rows the strict parsers accept equal rows the extractor marks valid over every existing fence fixture (E21).
- `test/fence-repair-normalize.test.ts` [unit]: one fixture per issue failure class (synthetic content); every rule and residual class from section 6; prior-aware renumbering (stored second occurrence keeps its number; freed highest number not reused; superseded ambiguity residual; hidden rows untouched); visibility synonyms on both page visibilities; `marker_form` prose false positive and facts two-dash untouched; a 9-cell facts row byte-identical; middle-cell gap residual; `header_alias` keeps timestamp and confidence text; out-of-table and pack-declared takes kinds residual; manual-only classes carry exact edit text; Invariant 0 fuzz over every existing fence fixture; idempotence; location-only sentinel.
- `test/fence-repair-validate.test.ts` [unit]: one adversarial fixture per gate with reason and letter; a `close_fence` fixture passes; split blocks fail (e) and the remote strip output exposes no row text; Tier 3 stubs that change a valid weight, holder, since date, source, confidence or context fail (f); a realigned middle-gap row passes (TE2); holder verification (bare first name with one `people/<name>-*` page residual, ambiguous basename residual, alias-exact resolves); fixed point.
- `test/fence-reasons-drift.test.ts` [unit]: table ↔ registry reasons ↔ anchors; each reason renders a fix with argv or user_message. `test/fence-format-reference.test.ts` [unit]: doc ↔ constants.
- `test/import-screen.test.ts` [unit, extend]: coordinated vs lenient; kill switch; receipt grammar; legacy messages.
- `test/import-fence-normalize.test.ts` [unit, PGLite + Postgres arm]: ordering (remote private row kept, E7); coordinated typed refusal with `fence_issues`; legacy stored with identical warning; containment on both paths; `fences_normalized` golden shared with sync.
- `test/fence-refusal-sites.test.ts` [unit, PGLite]: each typed site (repeated marker, unparseable, row collision, quoted rows, stored row collision, withdrawal guard) and receipt recovery; `facts-withdrawal-fingerprint-once.test.ts:68` extended with the canonical assertion.
- `test/persistence-sync-fence-holds.test.ts` [unit PGLite + Postgres arm in `test/postgres-unit-arms.txt`]: a manifest with one fixable, one unfixable and ordinary files finishes `synced`; the fixable file is rewritten and committed, the unfixable one held and visible in `sources status`, the rest imported; dry run lists both and leaves files byte-identical; mirror DB-only; company-brain blocks with each code; `sync.holds=fail` blocks typed; upgrade conversion of a stored legacy receipt without `--retry-failed`; prepare-time forced probe (screen passes, preparation fails) finishes `synced` with one hold and one receipt; same-run conversion single and bulk in one invocation; still-running lane yields `partial` then holds next run; no failure-ledger row for a converted request; prior takes semantics (TE1); per-run trend flush; maintenance phase during an unfinished cursor writes nothing.
- `test/connector-item-holds.test.ts` [unit, extend]: fence refusal classified `content`.
- `test/fence-write-verbs.test.ts` [unit, PGLite]: D19 per verb; D20 (remember on a page with a missing end marker saves the fact and reports `close_fence`; residual refuses typed); `edit_page`/forget refuse only; D21 notice golden and absence; synthesize-verify on a fixable fence succeeds; export roundtrip refuses typed.
- `test/daily-ledger.test.ts` [unit PGLite + Postgres arm]: reserve/refuse at cap; settle actual (overrun recorded); TTL reclaim; UTC rollover with an injected clock; unpriced fallback under default cap and refusal under a user cap; ledger error means no call; concurrent reservers never exceed the cap (Postgres).
- `test/fence-repair-llm.test.ts` [unit]: transport stub receives no valid-row claim text; no tools; model from `models.fence_repair`; each failure reason; corrective re-ask; memo (second run spends $0 on an unchanged rejected file; transient errors do not consume it); prompt-bytes golden.
- `test/repair-fences.test.ts` [unit, PGLite]: preview without a model call (tiers, estimate, hash); printed apply command runs; `--expect` exact set and `changed_since_preview`; bare `--apply`; `--only`/`--skip`/`--slug` bound into the hash; `--diff` line counts; `--max-usd` lowers only and `repair timeline --max-usd 1` is refused with the doctor route; budget stop message and exit 1; residual-only exit 0; every-proposal-rejected journey never reports fixed; managed, legacy (before-hash, symlink refused, backup, uncommitted notice appears and clears after commit), DB-only and mirror write-back; whole-source candidate (unreached file listed and fixed); incremental scan with a stored watermark; MCP cannot reach Tier 3; commit subject single and batched; JSON goldens with `cost.llm_usd` and `details.tiers`; `doctor --remediate --max-usd 0.01` refuses the fences step.
- `test/cycle-fence-repair.test.ts` [unit, PGLite]: phase gates (`enabled=false`, `llm=false`, daily cap across ticks); never in queued per-source payloads; time budget stop and resume; non-owner host `owner_unavailable`; `sync_in_progress` skip; `owner_cli_required` contingency branch. `test/managed-phase-matrix.test.ts` and `test/core/cycle.serial.test.ts` [extend]: table entries and ALL_PHASES order.
- `test/e2e/fence-repair-postgres.test.ts` [E2E]: worker-principal admission of `managed_file_repair` (first build step); a multi-source brain repairs a held fence on the next maintenance run; two concurrent appliers at the cap.
- `test/doctor-fence-integrity.test.ts` [unit]: counts by tier, clears to ok after apply, partial scan, trend threshold at the constant and not below, remediation plan step with `llm_usd`; `test/post-upgrade-banner.test.ts` [extend] banner for a stored legacy fence receipt (remote line has no path or claim); `test/behavior-change-notice.test.ts` [extend] both rows for an upgraded brain and none for a fresh install.
- `test/sync-hold-surfaces.test.ts` [extend]: router for fence-only, frontmatter-only and mixed sources on every surface; D16 goldens; D17 rendered `next` per state on CLI and HTTP (autopilot active and inactive); remote status read returns the handoff fix; sentinel privacy test.
- Config, models, flags, docs: every printed opt-out command succeeds and invalid values are refused with nothing written; `gbrain models --json` lists `models.fence_repair` and setting it changes the stub's model; `test/cli-flag-validation.test.ts` freshness; `test/error-catalogue.test.ts` anchors; llms freshness; privacy check on the skill diff; `test/fence-walkthrough.test.ts` (walkthrough lines; commands-to-green ≤ 1, commands-to-repaired 2, files repaired per tier, USD with the stubbed model, D33).
- Every regression test is proved with `scripts/check-test-discriminates.sh`; every new `testBackends()` file is laned (`bun run check:postgres-lanes`).

### 21. Eval (T4)

Before ship, run Tier 3 on synthetic malformed-fence fixtures (no real names), one per Tier 3 residual class, each with a hand-written expected repair, using the newest frontier Opus, GPT, Sonnet and Fable models at run time per the project eval rules (no older generations, no gpt-5.4-mini). Report gate-pass rate, false-accept rate (gates pass but the output differs from the expected repair), rejection reasons and USD per repaired page; confirm or change the default tier; mirror the verdict into gbrain-evals in a paired PR; the PR body and the second BEHAVIOR_CHANGES row report the rates and the D33 boomerang numbers.

### 22. Build order inside the one PR (E39; each step green at its commit)

1. Spike: worker-principal admission E2E for `managed_file_repair` (decides E15's branch).
2. Pure core: `fence-repair/raw-rows.ts`, `normalize.ts`, `validate.ts`, `reasons.ts` with their unit tests (starts before wave 10 lands).
3. After wave 10 is on master (merge commit): refusal typing at every site, registry entry, receipt grammar, `isContentRefusal`; connector and withdrawal tests. From here a fence defect is a recognized content refusal.
4. Conversions: hold from receipt (prepare-time) and same-run conversion in `sync-run.ts`. From here a fence defect never blocks managed sync, even before Tier 1 exists.
5. Screen fence step with modes, `importFromContent` ordering and containment, managed write-back, holds meta and re-screen predicate, dry run, prior takes (TE1), `sync.holds=fail` and company tests.
6. Write verbs (D19-D21), synthesize-verify, export roundtrip.
7. Ledger helper and tests.
8. `fences` repair kind (Tier 2/3, CLI, cost surfaces, write-back paths).
9. Cycle phase (global, time budget, owner and sync-idle skips).
10. Surfaces: router, fix by state, structured location, doctor, wave check, banner, behavior rows, config keys, models key.
11. Docs, walkthrough, format reference, migration note, generated files; T4 eval and the gbrain-evals paired PR.

### 23. Delivery and the GBRA-40 merge queue

- One PR from `capy/6188-fence-holds`, opened with Capy's PR tool so CI and merge callbacks reach this thread.
- Heads-up messages before coding: GBRA-51 (overlapping fence files; this PR merges wave 10 in after it lands), GBRA-45 (`sync-run.ts`/`sync-prepare.ts`/`sync-screen.ts` are in its lane-tuning area), GBRA-41 (`nextFreeRowNum` contract), GBRA-40 (merge slot after wave 10).
- Bring master in with merge commits; never rebase or force-push.
- Gate ahead of turn: while the PR in front is merging, run the full Ubicloud gate (`UBI_OWNER=gbra54`, watched background operation, after `scripts/ubicloud/ubi-runner.sh usage`, VM count sized to free quota under 512 vCPU, teardown at the end) on this branch merged with that PR's head and stamped with the version it will get.
- When next in line: stamp master VERSION + 1 PATCH, take the next free migration number if any, sync every version stamp and the PR title; a stamp-only difference from the gated tree needs no new full gate (`git diff <gated-head> <head>` shows only version strings), but GitHub CI must be green on the exact head, including the full E2E tier.
- Send GBRA-40 the PR number, head SHA and version once every check is green on that exact head. This thread never merges its own PR.

### 24. Taste-provisional index

T1 global maintenance lane (section 13); T2 legacy automatic write-back (section 11); T3 `repair fences` not explicit-only, no destructive consent (section 12); T4 Tier 3 measurement before ship (section 21); T5 lenient legacy (sections 8, 11); T6 header-level defaults (section 6 `column_default`); TD1 `--max-usd` lowers only, LLM kinds only (section 12); TD2 inline Tier 1 for append verbs (section 8); TE1 stored takes rows as prior (section 8); TE2 gate (f) per-row content preservation (section 7). User challenges at the gate: UC1 (held pages not indexed until repaired), UC2 (no LLM on the write path), UC3 (company-brain still blocks).

### 25. NOT in scope

See the "NOT in scope" section above; it is the complete list for this plan.

---

## Suppressed findings (appendix, confidence 3-4)

- (4/10) `pages.updated_at` may not move when only projections change, so a page whose stored fence is fixed by a projection-only path could be missed by the watermark until the backfill pass revisits it. The one-time backfill and the file walk cover it; not promoted.
- (4/10) `budget_reservations` is discarded at engine graduation (`graduation-inventory.ts:171`); a reservation held during a graduation underestimates spend for at most its TTL. Not promoted.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan Phase 1) | Scope & strategy | 1 (plan Review record; not in gstack log) | issues_open | SELECTIVE EXPANSION; 36 accepted obligations; 3 user challenges |
| Outside Review | Codex CLI gpt-6-astra (CEO, DX phases; Eng dispatched by parent) | Independent 2nd opinion | 2 recorded in plan + Eng pending | CEO completed, DX completed, Eng run by parent | CEO 8 concerns, DX 8 concerns |
| Eng Review | `/plan-eng-review` (via /autoplan Phase 3, this file) | Architecture & tests (required) | 1 (not persisted to gstack log; parent closes) | issues_open | 160 issues (16 arch, 11 quality, 3 perf, 130 test gaps all assigned), 2 critical gaps (both closed by obligations) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped (no UI scope) | — |
| DX Review | `/plan-devex-review` (via /autoplan Phase 2.5) | Developer experience gaps | 1 (plan Review record) | issues_open | score: 6.0/10 → 8.4/10, TTHW: unbounded → under 2 min to green |

- **OUTSIDE COVERAGE:** CEO phase Codex completed (8 concerns); DX phase Codex completed (8 concerns); Eng phase Codex is dispatched by the parent and not reflected here (pending, not clean).
- **CROSS-MODEL:** not computed in this file (needs the parent's Eng Codex result); single-voice critical findings to confirm: E7 hidden-row expiry, E9 maintenance write during an active sync.
- **VERDICT:** NOT CLEARED: Eng Review has open issues mapped to accepted obligations (issues_open) and awaits the final approval gate; eng review required.

**UNRESOLVED DECISIONS:**


## Addendum: Eng outside-voice obligations (apply on top of sections 1-25)

- **Protection-boundary gate (g)** (Codex Eng #1, confirmed by probe: trailing prose hidden by an unclosed fence becomes visible after close_fence). Everything `sanitizeRemoteBody`/wave 10 `protectedRegions` hides before a repair stays hidden after it, except rows that move into a valid fence. `close_fence` applies only when nothing but blank lines follows the last table row up to the end of the section (or the next fence/heading boundary that the protected region already ends at); otherwise the issue is manual-only residual. Tests: remote `get_page`, search and chunk text expose no trailing prose that was protected before.
- **Durable structured refusal payload** (Codex Eng #13). The fence location/reason data rides in a bounded, versioned field of the receipt's durable error detail (remote-filtered), so prepare-time holds, replay and HTTP responses keep it after receipt compaction; compacted legacy failures convert only by re-screening the current bytes, never by message text alone, and an arbitrary legacy `invalid_params` failure is never classified as a fence hold. Test: compacted receipt → conversion re-screens; arbitrary invalid_params stays blocked.
- **Unpriced-model metering is an estimated ceiling** (Codex Eng #8). Under default caps an unpriced Tier 3 model is metered at the highest chat rate in the canonical price table (not Sonnet), with `max_output_tokens` bounded and every provider attempt reserved; docs and notices call this an estimated ceiling and name `gbrain pricing set` to make it exact; under a user-set cap it refuses with `noPricingGuidance` (owner rule: new models must run by default). Test.
- **Ledger and attempt-memo crash safety** (Codex Eng #9). One atomic claim per (candidate key, memo key) with states claimed → dispatched → settled → published; settle is idempotent and bound to the reservation's UTC day; uncertain usage (crash after dispatch) settles at the reserved maximum; two appliers cannot both attempt the same candidate; memo, claim and scan-cursor state are exempt from the 7-day `op_checkpoints` purge (or stored where the purge does not apply). Crash-injection tests at each state boundary.
- **Budget composition under doctor** (Codex Eng #10). `doctor --remediate` passes its remaining allowance into the fences run; the repair never opens a nested `withBudgetTracker` that replaces the caller's tracker; actual LLM spend is reconciled into remediation accounting without double-charging embedding reservations. Test: two individually affordable steps whose combined spend exceeds the doctor cap stop at the cap.
- **Foreground overhead budget** (Codex Eng #15). A body with no fence marker substring does zero extra work and zero extra queries; stored prior rows load lazily only for a page whose fence needs renumbering; one shared scan per file between screen and prepare. Benchmark on a 10k-file managed catch-up of mostly clean files: query count unchanged and throughput within 2% of master, reported in the PR body.
- **Census honesty** (Codex Eng #14). A partial or stale scan never reports `fence_integrity` ok; the file walk resumes from a persisted cursor instead of restarting at the prefix. Test: damage beyond several scan deadlines is eventually found.
- **Row-number history limit stated** (Codex Eng #6). "Never reused" is guaranteed over numbers visible in both fence sections and stored takes/facts rows; numbers whose only evidence was deleted before this release are a documented limit closed by GBRA-41's durable high-water mark (TODO). Renumbering is also residual when a takes `source` cell's `superseded by #N` names a duplicated N. Test for the takes-source case.
