# Key files: Core Decide (System One)

[Subsystem index](../KEY_FILES.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.
The capability contract (API, providers, egress, extension points) is `docs/architecture/decide.md`.

- `src/core/ai/decide/types.ts` — The request/answer contract: `DECIDE_SLOTS`, `DecideMode` (`off`/`on`, advanced `shadow`), `EvidenceItem` (text + class + provenance), the question union (`noul`, `choice` with `options`, `score` with `levels`), answers mirroring the wire, `DecideRequest`/`DecideResult`, `DecideError` with a catalogued reason, and `thresholdValue` (noul p, the chosen label's probability, normalized score).

- `src/core/ai/decide/outcomes.ts` — The ONE vocabulary: per-slot receipt outcomes (plus `error`/`skipped` everywhere), `SKIP_REASONS`, `REFUSAL_CATALOG` (problem, cause, exact fix, docs anchor) and plain slot names. `recordReceipts` throws on an unknown outcome; the database has no CHECK constraint. `test/decide/docs-sync.test.ts` pins the table in `docs/architecture/decide.md`.

- `src/core/ai/decide/slots.ts` — `SLOT_SPECS`: lane, question kind, harmful direction (needs the action-precision gate), thresholded, call sites, egress classes, default `min_keep`, shadow sample, what-if reproducibility, question version, fail direction and `wired` (the delivery gate: unwired slots are refused with `slot_unavailable`).

- `src/core/ai/decide/config.ts` — Every `decide.*` key with its validator (`validateDecideConfigValue`, called by `gbrain config set`), and `readDecideConfig(snapshot)` (invalid stored values fall back to defaults; all default off). `pickDecideConfig` gives search the decide subset of the one config snapshot so all-off does no work. `enableDecideEvalOverride` is the only door for `GBRAIN_DECIDE_SLOTS`.

- `src/core/ai/decide/pack.ts` — Planner (64k per request, 32k state + longest question, 2x estimate with a digit floor, split before send, never truncate, rank-then-id order), `packShape`, and `runBatches` (≤16 in flight, one deadline, a 429 retry only when `retry-after` fits, background lanes drop to one worker after a 429, first failure stops queueing while started requests settle).

- `src/core/ai/decide/providers/typesafe.ts` — Pure System One wire adapter: `buildTypeSafeRequest`, `parseTypeSafeResponse` (every requested id, numeric and in range, and a resolved `model`, or the batch fails `malformed_response`), `classifyTypeSafeHttpError` (status only; `Unknown model` → `pinned_model_unavailable`).

- `src/core/ai/decide/providers/llm-structured.ts` — `llm:<provider:model>`: prompt + JSON schema through `chat()`, same parser, `llmCapability` (`structured` only for openai-compatible recipes that declare structured outputs), model identity from the provider snapshot or an endpoint fingerprint.

- `src/core/ai/decide/index.ts` — `runDecide(req, ctx)` (also `gateway.decide`): provider selection, egress gate, egress fallback as its own sub-decision, daily cap and remote share before sending, `BudgetTracker` reserve/record (kind `decide`, or `rerank` for S1 on), bounded batches, mixed-model rejection, one `decide_spend` row per request (failed and timed-out requests charged their estimate).

- `src/core/ai/decide/egress.ts` — `checkEgress`: consent per data class (or the reranker selection for S1 on), denied sources on every provider, private pages by one batched `privatePagesFilterFragment` query (with the #5525 derived-origin rule), facts by visibility (default private), conversation text private, missing provenance refused.

- `src/core/ai/decide/policy.ts` — `resolveSlotPolicy`: requested vs effective mode with a catalogued inactive cause, threshold precedence (override > adopted > newest local > reference), alias lookup via the last resolved model, margin `max(floor, 2*max(retest_sd, repack_sd))`, `min_keep` precedence, the action-precision gate and `force_on`, `policyFingerprint`; `driftReason` after a response; `readiness` strings.

- `src/core/ai/decide/protection.ts` — The canonical protection predicate for slots that remove or demote results (alias hit, exact lookup, exact title match, relational pin). Autocut keeps its own narrower preserve predicate so all-off output is unchanged.

- `src/core/ai/decide/evidence.ts` — S3's question and its one reducer (`reduceEvidence`, shared by production, qualify and what-if): protected and unjudged stay, below-threshold prune, the margin band holds, best-ranked pruned items return until `min_keep`; never reorders. `whatIfEvidence` replays receipts.

- `src/core/ai/decide/rerank-adapter.ts` — S1 transport for `search.reranker.model typesafe:*` (#5178 contract on the decide core): four-level score questions, normalized scores, stable ties, topN after all batches, status-only `RerankError`s, reported usage settled even when validation fails, mixed resolved models fail the call, `onMeta` reports the resolved model and rubric semantics.

- `src/core/ai/decide/store.ts` — `executeRaw` storage (no engine method): buffered receipts and spend rows with a background-work drainer (500 ms exit bound), `decide_state` (internal keys: receipt salt, S1 ownership), `receiptSalt` (insert-if-absent) + `hmacRef`, the 60 s cached daily spend, calibrations CRUD, aggregate receipt reads, retention pruning for the purge phase.

- `src/core/ai/decide/receipts.ts` — `buildReceiptRows`/`writeReceipts`: one row per question with HMAC hashes only, the thresholded value, outcome, reason, policy fingerprint, calibration ref and replay fields; fire-and-forget.

- `src/core/ai/decide/runtime.ts` — Per-query decide budget (`createQueryBudget`, `stageDeadlineMs`), shadow sampling, and detached shadow work under its own `BudgetTracker` with a bounded queue and a drainer.

- `src/core/ai/decide/calibrate.ts`, `dataset.ts`, `reference-calibrations.ts`, `schema.ts` — Threshold search, reliability/ECE, retest/repack sd, Wilson bound, `requiredN`, family-level `qualifyActions`; the dataset JSONL schema, frozen family split and `split_hash`, per-slot adapters and `--from` builders (S3: `longmemeval`, `jsonl`); shipped reference rows (empty until an eval records a win); the canonical DDL used by migrations 179-181 and the fresh-install fragment.

- `src/core/ai/decide/conflict.ts` — S9's question (`duplicate | supersede | independent`, state = the new fact, one choice per candidate), the ONE pair reducer `reduceConflict` (chosen duplicate at or above threshold → duplicate; else P(supersede) at or above `decide.slots.conflict.proposal_floor` → proposal; else independent), candidate eligibility (the `decideSingleFact` guards, self-exclusion, cosine ≥ 0.80), unordered pair keys, proposal direction and `sweepWindow` (stops at the first fact younger than 60 s).

- `src/core/ai/decide/sweep.ts` (+ `proposals-store.ts`) — `runConflictSweep`: per-source watermark in `decide_state` (first run records the max fact id unless `since`), deferred retries first (attempt cap 5), neighbours filtered BEFORE the k=5 limit by one `executeRaw` query, pairs deduped within the sweep and across sweeps (answered receipts by hashed pair subject, existing proposals), one background-lane request per fact, drift and inactive policy run with off behavior, pending `decide_proposals` rows in `on` mode only; never supersedes. `conflictSweepTail` is the `extract_facts` phase tail: undefined when the slot is off. `proposals-store.ts` holds the watermark, deferred, dedup and proposal SQL. Tests: `test/decide/conflict-sweep.serial.test.ts`.

- `src/core/ai/decide/datasets-conflict.ts` — `registerConflictDatasets()` (called by `src/commands/decide/writepath.ts`): the conflict dataset adapter (production request shape, no harmful-action reducer) and the `facts-fixtures` builder (labelled fact-pair JSONL; label `true` exactly for `duplicate`, the calibrated threshold).

- `src/core/facts/proposal-supersede.ts` — S9 accept/undo as a CHECKED supersede: old fact `expired_at`/`valid_until`/`superseded_by`, the struck `## Facts` row (file and DB body) and the proposal status apply as one unit with before/after state; a failed fence write leaves the proposal pending. Unmanaged brains: source-filesystem + page lock, one transaction that publishes the file last and restores it on a failed commit. Managed brains: coordinator mutation `decide_proposal` (dispatched by `persistence/service.ts`). Stale pairs are marked `stale`; undo refuses when either fact or the fence row changed. Tests: `test/decide/conflict-proposals.serial.test.ts`, `conflict-proposals-managed.serial.test.ts`.

- `src/commands/decide/proposals.ts` (registered in `src/commands/decide/writepath.ts`) — `gbrain decide sweep --slot conflict [--since] [--source] [--json]` and `gbrain decide proposals list|accept|reject|undo` (`--all-from <sweep id>` for accept/reject, `--json` everywhere); list shows both facts' text locally.

- `src/core/search/decide-stage.ts` — The search side of S1/S3: `resolveDecideSearchContext` (undefined when every slot is off), `applyEvidenceGate` (inside `sizeReturnPool` and the keyword-only path), `recordRerankReceipts`, `startRerankShadow` (Jev beside a non-Jev reranker, rank agreement), `decideKnobsPart` (search cache key), the S5 co-pack registry and the meta block (`meta.decide`).

- `src/commands/decide.ts` (+ `src/commands/decide/{calibrate,receipts,probe-query}.ts`, dispatch `src/cli/commands/decide.ts`) — `gbrain decide` status/probe/enable/disable/calibrate/qualify/calibrations/dataset/receipts; help and the key-only probe run without a brain; `enable` refuses unless the effective mode would be the requested one, writes the pinned id and consent, and owns S1's reranker keys so `disable` restores only what it still owns; `registerDecideSubcommand` for slot lanes. Tests: `test/decide/cli.test.ts`.

- `src/commands/doctor/checks/decide.ts` — `decide_health`: key, alias, inactive slots with cause and fix, drift, alias rollouts, 24 h error rate over 5%, exhausted budget, retired pinned model, `force_on`. Tests: `test/doctor-decide-health.test.ts`.
