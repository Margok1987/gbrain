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

- `src/core/ai/decide/calibrate.ts`, `dataset.ts`, `reference-calibrations.ts`, `schema.ts` — Threshold search, reliability/ECE, retest/repack sd, Wilson bound, `requiredN`, family-level `qualifyActions`; the dataset JSONL schema, frozen family split and `split_hash`, per-slot adapters (choice slots add `positive(item, answer)` for the calibration label; items with `state.call_site` belong to that call site only, filtered by `--call-site`) and `--from` builders (S3: `longmemeval`, `jsonl`; S2/S4/S5 in their slot modules); shipped reference rows (empty until an eval records a win); the canonical DDL used by migrations 179-181 and the fresh-install fragment.

- `src/core/search/decide-stage.ts` — The search side of S1/S3 (and the S3-shaped request S5 rides, with or without S3 on): `resolveDecideSearchContext` (undefined when every slot is off), `applyEvidenceGate` (inside `sizeReturnPool` and the keyword-only path), `recordRerankReceipts`, `startRerankShadow` (Jev beside a non-Jev reranker, rank agreement), `decideKnobsPart` (search cache key), the S5 co-pack registry and the meta block (`meta.decide`). `resolveAndLaunchDecide` resolves the context and launches S2 at hybridSearch entry; S4 on the `query` op starts inside `applyEvidenceGate`, concurrent with the S3/S5 request.

- `src/core/ai/decide/intent.ts` — S2: the search (`QueryIntent`) and think (`temporal | knowledge_update | other`) choice questions and `reduceIntent` (override only above threshold, on a known label that differs from the regex label and does not tie it; regex is the default and tie source), the intent dataset adapter (items carry `state.call_site`, never sent) and the `longmemeval` (question_type) and `brainbench` (relational) builders.

- `src/core/ai/decide/answerable.ts` — S4: one probability question over the top-k evidence (`answerableK`: k = min(10, n), shrunk to fit 32k, 0 = fail open), `reduceAnswerable` (pass, incomplete coverage, margin_hold, deterministic identity/strong-grade signal → pass, else abstain), the dataset adapter/harmful-action reducer and the `longmemeval` abstention builder.

- `src/core/ai/decide/injection.ts` — S5: the per-candidate question, `reduceInjection` (flag at threshold, never protected or unjudged) and `demoteFlagged` (flagged below clean items of the same evidence class, top `cut` and the rest reordered separately, nothing dropped), the co-packed dataset adapter and the `injection-fixtures` builder (#5178 known cases in `test/fixtures/decide/injection-cases.jsonl`).

- `src/core/search/decide-retrieval.ts` — Search-path wiring for S2 (`launchSearchIntent`/`applySearchIntent`: wait bound `decide.slots.intent.wait_ms`, late answers keep the regex label and land as `late` receipts; `askIntent`/`settleIntent` shared with think), S4 on the query op (`startQueryAnswerability`, `meta.answerability`), the S5 co-pack handler, `candidateItem`, and `rerankEgressDenied` (the Jev reranker skips a query with a candidate from `decide.egress.deny_sources`). Imports decide-stage for types only.

- `src/core/think/decide.ts` — Think wiring: `startThinkDecide` (undefined when S2 and S4 are off) launches the S2 think and search questions before gather; `trajectoryIntent` awaits the think answer at most `wait_ms` after gather; `answerability` asks S4 over final pages and sendable takes (private takes and trajectory make coverage incomplete) and returns an abstention only on `abstain`; `thinkAbstainResult` lists the nearest pages and skips synthesis.

- `src/commands/decide.ts` (+ `src/commands/decide/{calibrate,receipts,probe-query}.ts`, dispatch `src/cli/commands/decide.ts`) — `gbrain decide` status/probe/enable/disable/calibrate/qualify/calibrations/dataset/receipts; help and the key-only probe run without a brain; `enable` refuses unless the effective mode would be the requested one, writes the pinned id and consent, and owns S1's reranker keys so `disable` restores only what it still owns; `registerDecideSubcommand` for slot lanes. Tests: `test/decide/cli.test.ts`.

- `src/commands/doctor/checks/decide.ts` — `decide_health`: key, alias, inactive slots with cause and fix, drift, alias rollouts, 24 h error rate over 5%, exhausted budget, retired pinned model, `force_on`. Tests: `test/doctor-decide-health.test.ts`.
