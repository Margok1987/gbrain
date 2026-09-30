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

- `src/core/ai/decide/calibrate.ts`, `dataset.ts`, `reference-calibrations.ts`, `schema.ts` — Threshold search, reliability/ECE, retest/repack sd, Wilson bound, `requiredN`, family-level `qualifyActions`; the dataset JSONL schema, frozen family split and `split_hash`, per-slot adapters and `--from` builders (S3: `longmemeval`, `jsonl`; S6: `know-to-ask`, registered from `recall-needed.ts`); shipped reference rows (empty until an eval records a win); the canonical DDL used by migrations 179-181 and the fresh-install fragment.

- `src/core/ai/decide/recall-needed.ts` — S6 know-to-ask: the question (state = the user prompt, head-capped at 6,000 characters, plus the previous turn, tail-capped at 2,000, both conversation class), `recallReflex` (reflex fired; alias or exact-title identity hit) and the ONE reducer `reduceRecallNeeded` (fire only when the reflex was silent and p ≥ threshold; suppress only below `suppress_below` minus the margin and never over an identity hit; the band below `suppress_below` holds), plus the dataset adapter (harmful action = suppress) and the lazy `know-to-ask` builder registration. `suppress_below` joins the policy fingerprint.

- `src/core/context/recall-needed.ts` — S6 at the turn-context call site: `startRecallNeeded` runs concurrently with the reflex arms (config, policy, one decide call under an absolute 250 ms deadline from turn start; null when off, so all-off does one config read and nothing else); `applyRecallNeeded` runs after the reflex block is rendered and waits only until that deadline; on mode fires one keyword-only `hybridSearch` (limit 3, decide off, world-only safe chunks, the hook's source) only with ≥150 ms of `TURN_CONTEXT_SERVER_BUDGET_MS` left and must finish 40 ms before it, adding hits as `recall`-arm pointers, or suppresses the reflex window (hot facts stay). Every failure leaves the reflex result unchanged; receipts hash the session ref, never prompt text. `GBRAIN_DEBUG=1` prints the per-turn explain line. Tests: `test/decide/recall-needed.test.ts`, `test/decide/turn-context-s6.serial.test.ts`.

- `src/eval/brainbench/know-to-ask-dataset.ts` — `gbrain decide dataset --slot recall_needed --from know-to-ask <dir>` (`fixtures/` + `gold/`): one item per gold user turn, label `should_retrieve`, the reflex state replayed through the shipped path on a seeded in-memory brain (`slice` reflex:fired/silent, `protected` = identity hit), split by fixture, holdouts skipped.

- `src/core/search/decide-stage.ts` — The search side of S1/S3: `resolveDecideSearchContext` (undefined when every slot is off), `applyEvidenceGate` (inside `sizeReturnPool` and the keyword-only path), `recordRerankReceipts`, `startRerankShadow` (Jev beside a non-Jev reranker, rank agreement), `decideKnobsPart` (search cache key), the S5 co-pack registry and the meta block (`meta.decide`). `calibrationState` (60 s cached calibrations and last resolved models) is shared with S6.

- `src/commands/decide.ts` (+ `src/commands/decide/{calibrate,receipts,probe-query}.ts`, dispatch `src/cli/commands/decide.ts`) — `gbrain decide` status/probe/enable/disable/calibrate/qualify/calibrations/dataset/receipts; help and the key-only probe run without a brain; `enable` refuses unless the effective mode would be the requested one, writes the pinned id and consent, and owns S1's reranker keys so `disable` restores only what it still owns; `registerDecideSubcommand` for slot lanes. Tests: `test/decide/cli.serial.test.ts`; the operator guide's quickstart (`docs/guides/system-one.md`) is executed against a fixture transport by `test/decide/quickstart-doc.serial.test.ts`, and `test/decide/docs-sync.test.ts` pins its troubleshooting anchors to `REFUSAL_CATALOG`.

- `src/commands/doctor/checks/decide.ts` — `decide_health`: key, alias, inactive slots with cause and fix, drift, alias rollouts, 24 h error rate over 5%, exhausted budget, retired pinned model, `force_on`. Tests: `test/doctor-decide-health.test.ts`.
