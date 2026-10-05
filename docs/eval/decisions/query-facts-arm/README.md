# Facts arm in query: preregistered gates

Not built and not measured. The gates below were written and pushed before any code or gated run. The arm will
sit behind `search.query_facts_arm`, which is off by default. With the key off, `query` returns what it returns
today.

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
