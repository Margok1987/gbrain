# Facts arm in query: gates and verdict

The facts arm is built and stays off. It sits behind `search.query_facts_arm` (default off), measured at
garrytan/gbrain@16288b95c. Gate 1 failed as preregistered and gate 2 passed. With the key off, `query` returns
exactly what it returned before the arm existed.

## Result

**Gate 1 failed.** In the B2 corrections suite's forget-then-remember arm, the key moved the stale-answer rate
from 92% to 4-6%. Corrected-value accuracy went from 0% to 1% after one unrelated write and stayed at 0% after
five. The rule needed it higher at both checkpoints.

The reader named the correction in 158 of the 200 answers after it (0 of 200 with the key off), and still kept the old value. A
remembered fact is dated when it is saved. In this suite that date is the day of the run, after every
question's simulated date. So the reader judged the correction not yet in effect and answered with the old
value. The fixed judge scored those answers wrong rather than stale. A typical answer was "Saltgrass Tacos. The
correction to The Green Fork is only valid from 2026-10-05, which is after the 2025-05-11 question date."

Corrected-value accuracy and stale-answer rate per 100 items, reader `claude-sonnet-5-5`:

| Arm | Key | Before correction | After 1 write | After 5 writes |
|---|---|---|---|---|
| forget-then-remember | off | 100% / 0% | 0% / 92% | 0% / 92% |
| forget-then-remember | on | 100% / 0% | 1% / 4% | 0% / 6% |
| edit-sync | off and on | 100% / 0% | 100% / 0% | 100% / 0% |
| append | off and on | 100% / 0% | 100% / 0% | 100% / 0% |

Edit-sync and append lose nothing with the key on. Both are at 100% with the key off too, so these checks
can only rule out a loss; they cannot show a gain.

**A diagnostic, not a gate.** It was chosen after gate 1's cells ran, so it cannot change the decision. In
these runs `remember` received the correction's own timestamp as `valid_from`, which `remember` accepts on
this branch. That changes the written fact, not the query path. With the fact dated when it took effect, the
key-off arm already answered 92% correctly (8% stale), and the key-on arm answered 100% correctly (0% stale)
at both checkpoints. A future preregistered gate on correction-dated writes would test this directly.

**Gate 2 passed, though the formal gate is close to vacuous.** On NamedThingBench (12 questions), the
relational fixture (38) and the LongMemEval nightly fixture (10), no question's recall@10 is lower with the key
on. These corpora hold no saved facts, so the arm never fired. The runs are hermetic and keyword-only, so the arm
matched by terms and named entity, not by embedding. Two diagnostic copies seed one saved fact per question:

- NamedThingBench: fired 11 of 12 times and lost nothing (recall@10 0.917 both ways).
- Relational: fired 38 of 38 times and lost recall@10 on 2 questions (mean 1.000 off, 0.974 on). Fact rows
  take a page slot when the row count is already full.

With the key off, gate-2 output matches garrytan/gbrain@a87c3e2af exactly, apart from wall-clock recency scores
and random revision ids.

Metered spend was $26.05 against a $40 cap:

- Gate 1 runs: $25.56.
- Two 6-probe smokes: $0.14.
- A duplicate run stopped after 30 probes and not used: $0.35.

Records are in `decision.json` (what was tested and how) and `verdict.json` (what happened). The gbrain-evals
mirror carries the two bench flags the gate-1 runs used (`--gbrain-search-config`, `--remember-valid-from`) as a
patch.

**Decision.** `search.query_facts_arm` stays off by default.

## Preregistration

The sections below were written and pushed in garrytan/gbrain@a87c3e2af, before any code or gated run, and are
unchanged.

## Why

A correction made through `remember` does not win in `query`. In the B2 corrections suite's forget-then-remember
arm (gbrain-evals `eval/workload-suites`, `bun run eval:corrections`), 0 of 100 answers were correct and about
90 repeated the stale value. Two things cause this:

- The remembered fact does not surface when the question is worded differently from the fact.
- The page text that still states the old value ranks first.

`query` reads pages and chunks only. Facts are reachable through `recall`, but `query` never ranks them.

## The change

With the key on, `query` adds a facts arm:

- **Candidates.** Active facts only: not expired, not superseded, and valid now. They are filtered by the
  caller's read policy, the same way `recall` filters them: source scope, private facts withheld from remote
  callers, and the takes holder allow-list.
- **Matching.** Facts are matched to the query by embedding similarity and keyword, then ordered newest
  `valid_from` first among matches.
- **Delivery.** Matched facts are added as fact rows inside the caller's token budget and row count. Facts never
  enlarge either.
- **Superseded page claims.** A page row is stamped `superseded_claim` when a newer active fact covers the same
  entity and slot. Slot here means the typed claim columns: `claim_metric`, plus `claim_period` when both rows
  carry it. Pages without typed claims are never stamped.
- **No model call** is added on the read path.

The touch points will be additive in the `query` op, as with entity anchoring. `hybridSearch` ranking is left
alone.

## Gates

1. **B2 corrections** (gbrain-evals `eval/workload-suites`, `bun run eval:corrections`).
   - Setup: the forget-then-remember arm, run at the measured build with `search.query_facts_arm` on and off.
     Same seed (`corrections-v1`, seed 20261006, 100 items), same reader and same retrieval budget as the B2
     preregistration.
   - Metrics: corrected-value accuracy and stale-answer rate after 1 and after 5 unrelated writes.
   - **Rule:** the key-on arm wins gate 1 if its corrected-value accuracy is higher at both checkpoints and its
     stale-answer rate is not higher at either.
   - In the same run, the edit-sync and append arms must not lose more than 2 points of corrected-value accuracy
     with the key on.
2. **No regression on the evals that cover `query`.** These are the corpora used for entity anchoring
   (`evals/entity-anchoring/regression.ts`): NamedThingBench, the relational retrieval-quality fixture and the
   LongMemEval nightly fixture, run through the `query` op with the key on and off.
   - Recall@10 is computed over page rows only.
   - **Rule:** no question's recall@10 is lower with the key on.
   - Each corpus reports how often the facts arm added a row.
3. **Harness lane (optional, recommended).** LongMemEval knowledge-update and PersonaMem dev slices, retrieving
   through the `query` op with the key on and off.

**Decision.** The key becomes default-on only if gates 1 and 2 pass, and gate 3 too if it runs. Until then it
stays off. The spend cap is set before the gate 1 run.

## Changelog

- 2026-10-05: gates preregistered before any code or gated run.
- 2026-10-06: built at 16288b95c and gated. Gate 1 failed, gate 2 passed, and the key stays off.
