# decide: the System One capability contract

`decide` is GBrain's provider-agnostic decision layer: typed questions over
typed evidence, answered by TypeSafe's Jev (the first provider) or by any
configured chat model (`llm:<provider:model>`), with receipts, calibration,
qualification, drift protection and one egress contract. Code owns every
threshold. This page is the contract slot lanes build on; the operator guide
is `docs/guides/system-one.md`.

Every slot is `off` or `on`. `shadow` exists for diagnostics only (receipts,
no behavior change) and nothing requires passing through it. A slot requested
`on` that cannot act (no calibration, drift, a changed policy, the
action-precision gate, missing consent) runs with **off behavior** for that
call, writes a receipt with the reason, and shows `on (inactive: <reason>)`
plus the one fix command in `gbrain decide status` and `gbrain doctor`.

## API

```ts
import { runDecide } from 'src/core/ai/decide/index.ts';   // or gateway.decide(req, ctx)

const result = await runDecide({
  slot: 'evidence',            // DecideSlot
  callSite: 'search',          // calibrations and receipts key on (slot, call site)
  state: { query: { text: q, class: 'query' } },           // shared, sent once per batch
  questions: [{
    id: 'evidence:0', kind: 'noul', rank: 0,                  // noul | choice (options) | score (levels)
    instructions: 'Does `candidate` contain evidence that helps answer `query`?',
    inputs: { candidate: { text, class: 'candidates', slug, source_id } },
  }],
  deadlineMs: 1500,            // bounds the whole logical decision (all batches)
}, { engine, config });        // engine: egress page check, spend ledger, daily cap
```

- **Questions** are a discriminated union (`src/core/ai/decide/types.ts`):
  `noul` (a probability), `choice` (`options: Record<label, description>`),
  `score` (`levels: string[]`). Ids are stable and code-only.
- **Answers** mirror the wire: `{kind:'noul', p}`, `{kind:'choice', choice,
  confidence, probabilities}`, `{kind:'score', score, normalized, confidence,
  probabilities}`. `thresholdValue(answer)` is the number a threshold compares.
- **Result**: `decision_id, provider, model_alias, model_resolved, answers,
  refused, fallback?, usage, cost_usd, latency_ms, batches, lane`.
- **Failure** throws `DecideError` with a catalogued `reason` (`timeout`,
  `rate_limited`, `provider_error`, `malformed_response`, `mixed_model`,
  `budget_exhausted`, `no_key`, `no_provider`, `pinned_model_unavailable`,
  `payload_too_large`, `late`, `llm_capability`). The caller takes its slot's
  documented fail direction. Partial answers are never used: a missing id or
  a non-numeric or out-of-range value fails the whole decision.
- **Evidence items** carry provenance (`class`, `source_id`, and `slug`,
  `fact_id` or `transcript_ref`, plus `visibility` for facts). Items with
  missing provenance are refused before serialization.

## Providers

| Provider | Wire | Identity | Spend |
|---|---|---|---|
| `typesafe:jev-1.13.0` (pinned default; `jev-latest`/`jev-preview` accepted with a doctor warning) | `POST /v1/systemone`, Bearer `TYPESAFE_API_KEY` (alias `JEV_TYPESAFE_API_KEY`) | response `model` | `decide_spend` row per request, `BudgetKind` `decide` (S1 `on`: `rerank`) |
| `llm:<provider:model>` | `chat()` with a JSON schema; answers strictly validated by the same parser | provider-reported snapshot, else requested id + endpoint fingerprint | once, by `chat()`, kind `chat`, purpose `decide:<slot>` |

Within one logical decision, mixed resolved model ids fail it (`mixed_model`).
`on` refuses an `llm:` route whose path ignores structured output
(`llm_capability`). Key presence never selects a provider.

## Packing and runtime

`pack.ts`: shared state once per batch, one question per candidate, a
conservative 2x token estimate with a digit floor, split before send (64k per
request, 32k for state plus the longest question), never truncate evidence,
questions ordered by rank then id. `runBatches`: at most `decide.max_concurrency`
(hot, default 16) or `decide.background_concurrency` (background, default 4)
requests in flight under one deadline; a 429 `retry-after` is honored once only
when it fits the deadline; background lanes drop to one worker after a 429.
`runtime.ts`: `decide.query_budget_ms` bounds all decide work of one query
(`stageDeadlineMs`, stages skip with `late`); detached shadow work runs under
its own `BudgetTracker`, behind a bounded queue, drained at CLI exit.

`unpacked.ts` `runDecideUnpacked`: slots whose answers must not depend on
co-packed neighbours (S7 windows, S8 claim units) send one question per request
as one logical decision (one decision id and deadline, a process-wide
background-lane cap, per-question failure reasons so a slot can require
complete coverage).

`packShape(slot, coPacked, {unpacked})` names the request shape a calibration
is valid for; `on` refuses a calibration with a different shape
(`pack_shape_mismatch`).

## Policy, calibration and qualification

`policy.ts` `resolveSlotPolicy(inputs)` returns requested and effective mode,
the inactive cause, provider, lookup model, threshold and its source, the
calibration, `min_keep`, the margin and the policy fingerprint.

- Threshold precedence: `decide.slots.<slot>.threshold` (operator override;
  never drift-demoted; does not bypass the gate) > the adopted calibration
  (`decide.slots.<slot>.calibration`, written by `enable`/`adopt`) > the newest
  local `decide_calibrations` row for (slot, call site, provider, model) > a
  shipped reference row (`reference-calibrations.ts`).
- Alias providers look up calibrations under the model most recently resolved
  in receipts. After a response, a resolved id different from the calibration
  demotes that call (`driftReason` → `model_drift`).
- Margin: `max(decide.margin_floor, 2 * max(retest_sd, repack_sd))`. A
  harmful-direction answer inside the margin takes the no-change outcome
  `margin_hold`.
- Harmful-direction slots need a qualified calibration:
  `action_precision_lb` (family-level Wilson 95% lower bound after the
  production reducer) at least `decide.slots.<slot>.min_action_precision`
  (0.90), bound to the policy fingerprint (threshold, margin rule, floors,
  protections, question version, call site, pack shape). A mismatch is
  `policy_changed`. `decide.slots.<slot>.force_on` bypasses the gate and is
  always listed by doctor. `insufficient_n` names the n needed (35 at 0.90).

`calibrate.ts` holds the math; `dataset.ts` the JSONL schema, the frozen
family split (`split_hash`) and per-slot adapters that build production-shaped
requests.

## Receipts, spend and state

`store.ts` reads and writes through `engine.executeRaw` (no engine method).
`decision_receipts` rows hold hashes only (`subject_ref`, `state_hash`,
`question_hash` are HMAC-SHA256 under a per-brain salt kept in `decide_state`,
which no config surface reads), the thresholded number, the outcome, and the
fields replay needs (`protected`, `rank`, `min_keep`, `decision_id`).
Receipts and spend rows are buffered and flushed fire-and-forget, registered
with the background-work drain (500 ms bound at CLI exit). Retention:
`decide.receipts.retention_days` (7), pruned by the cycle `purge` phase. The
daily cap sums `decide_spend` for the UTC day (third-party only; cached 60 s;
soft in both directions); remote-triggered spend is capped by
`decide.budget.remote_share`.

### Outcome vocabulary (canonical: `src/core/ai/decide/outcomes.ts`)

<!-- decide-outcomes:begin -->
| Slot | Plain name | Outcomes |
|---|---|---|
| rerank | search reranking | kept |
| intent | query routing | override, fallback_regex |
| evidence | evidence gate | kept, pruned, margin_hold |
| answerable | abstention | pass, abstain, margin_hold, incomplete |
| injection | injection signal | demoted, kept |
| recall_needed | know-to-ask | fire, no_fire, suppress, margin_hold |
| triage | dream triage | pass, reject, margin_hold |
| grounding | claim support | pass, quarantine, insufficient_context, margin_hold |
| conflict | contradiction | duplicate, proposal, independent |
<!-- decide-outcomes:end -->

Every slot may also record `error` or `skipped`, with `error_reason` from
`SKIP_REASONS`. Refusals and inactive causes come from `REFUSAL_CATALOG`
(problem, cause, exact fix, docs anchor). `test/decide/docs-sync.test.ts`
pins this table to the code.

## Egress (one contract for every path)

`egress.ts` `checkEgress`: a third-party provider receives a data class only
with consent (`decide.egress.typesafe.<class>`, written by `gbrain decide
enable` after it shows what leaves the machine; for S1 `on`, the reranker
selection is the consent for query and candidate text, as with Voyage).
`decide.egress.deny_sources` applies to every provider. Private content never
leaves without `decide.egress.private=allow`: page candidates are checked by
one batched query per decision with `privatePagesFilterFragment` (including
the #5525 derived-origin rule), facts by their own visibility (default
private), conversation text is private. Refused questions are answered by
`decide.egress_fallback` (an `llm:` route) as their own sub-decision, else take
the fail direction. `llm:` follows today's chat egress rules.

## Trust

`decide` is not an MCP operation. Remote callers reach slots only through
`query`/`think`; their spend is counted as remote. `gbrain decide` is local
CLI only (`thinClient: 'refuse'`); calibrate, receipts review and proposal
acceptance never run for a remote caller.

## Fixed by design versus configurable

| Knob | Value | Configurable |
|---|---|---|
| Request / state+question token limits | 64k / 32k | no (provider limits) |
| Max concurrent batches | 16 hot, 4 background | `decide.max_concurrency`, `decide.background_concurrency` (1-16) |
| Margin floor | 0.05 | `decide.margin_floor` |
| S3 judged candidates | first 50 of the return pool (tail kept) | no (`EVIDENCE_MAX_CANDIDATES`) |
| S3 `min_keep` | 3 | `decide.slots.evidence.min_keep` |
| Per-query decide budget | 1500 ms | `decide.query_budget_ms` |
| Per-decision timeout (hot) | 1500 ms | `decide.timeout_ms` |
| Shadow in-flight queue | 8 | no |
| Retest sample | 50 families, 3 repeats | `decide.calibrate.retest_n` |
| S7 window | whole turns, about 1,500 chars; a turn over 24,000 chars splits at paragraphs (marked); at most 256 windows per transcript (more → today's triage) | no (`TRIAGE_WINDOW_CHARS`, `TRIAGE_TURN_SPLIT_CHARS`, `TRIAGE_MAX_WINDOWS`) |
| S7 decision deadline / segment map | 60 s per transcript; top 8 windows, 300-char quotes | no |
| S8 source windows / coverage floor | 3 per claim; 0.25 of the claim's content words | no (`GROUNDING_MAX_WINDOWS`, `GROUNDING_KEYWORD_FLOOR`) |
| S8 deadlines | 30 s per page, 10 min per dream phase | no |
| S4 k, S6 budgets | per slot lane | documented with each slot |

## Extension points for slot lanes

- `SLOT_SPECS[slot].wired` (`slots.ts`): flip when the slot is wired at its
  call site with tests; unwired slots are refused (`slot_unavailable`).
- `registerEvidenceCoPack(handler)` (`src/core/search/decide-stage.ts`): add
  questions to the S3 packed request (S5): `questions(query, candidates,
  policy)` with ids prefixed `<slot>:`, and `apply(pool, result, policy, ctx)`
  returning the pool (never below the S3 `min_keep` cut) and receipt outcomes.
- `registerDatasetAdapter(adapter)` / `registerDatasetBuilder(source, builder)`
  (`dataset.ts`): production-shaped requests, harmful-action reducers, and
  `gbrain decide dataset --from <source>` builders.
- `registerDecideSubcommand(name, run, help)` (`src/commands/decide.ts`):
  `proposals`, `sweep`, `judge-agreement`. Lane modules that register
  subcommands, what-if reducers or dataset adapters are imported by
  `loadDecideLanes()` (write path: `src/commands/decide/writepath.ts`).
- `SlotDatasetAdapter.unpacked` / `aggregate: 'max'` (`dataset.ts`): calibrate
  and qualify send one request per question and fold several questions into
  one item value (S7 transcript = max window).
- `registerWhatIfReducer(slot, reducer)` (`src/commands/decide/receipts.ts`)
  for slots whose reducer replays exactly (S7, S8).
- `writeReceipts(engine, input)` (`receipts.ts`) and the per-request
  `DecideSearchContext` (`req.decide` in hybrid search) for search-path slots;
  `resolveSlotPolicy`, `stageDeadlineMs`, `runShadow` and `sampled` for all.
- `enableDecideEvalOverride()` (`config.ts`): eval commands opt in to
  `GBRAIN_DECIDE_SLOTS`, which never bypasses consent, egress or the cap.

## How to add a slot

1. Add its spec in `slots.ts` (lane, question kind, harmful, call sites,
   egress classes, defaults, fail direction) and its outcomes in
   `outcomes.ts` (then update the table above).
2. Build questions with provenance; call `runDecide` under the slot's
   deadline (`stageDeadlineMs`); catch `DecideError` and take the fail
   direction.
3. Write ONE pure action reducer shared by production, `qualify` and evals;
   honor `margin`, floors and the protection predicate (`protection.ts`) where
   the slot can remove or demote content.
4. Resolve the policy once per request (`resolveSlotPolicy`), check
   `driftReason` after the response, and write receipts for every outcome,
   including skipped and error rows.
5. Register a dataset adapter so `calibrate`/`qualify` use the production
   shape; add unit, PGLite and all-off golden tests; flip `wired`.

### Example: a custom slot on either provider

```ts
const policy = resolveSlotPolicy({ cfg, slot, callSite: 'search', packShape: packShape(slot), calibrations, hasTypesafeKey });
if (policy.effective === 'off') return todaysPath();          // off, or on (inactive: reason)
const deadline = stageDeadlineMs(queryBudget, cfg.timeoutMs);
if (deadline === null) return todaysPath();                    // `late`
try {
  const r = await runDecide({ slot, callSite: 'search', state, questions, deadlineMs: deadline, provider: policy.provider }, { engine, config: cfg });
  if (driftReason(policy, r.model_resolved)) return todaysPath(); // model_drift receipt
  const outcomes = reduce(r.answers, policy);                  // shared reducer
  void writeReceipts(engine, { slot, mode: 'on', callSite: 'search', lane: 'hot', provider: policy.provider, policy, result: r, questions, state, outcomes });
  return apply(outcomes);
} catch (err) {
  return todaysPath();                                         // fail direction; error receipt
}
```

The same code runs on `typesafe:jev-1.13.0` and `llm:ollama:<model>`; only the
calibration row (keyed by provider and resolved model) differs.
