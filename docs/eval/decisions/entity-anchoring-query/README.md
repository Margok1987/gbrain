# Entity-anchored retrieval in query and search: verdict

Not yet measured. The gates below were written and pushed before any gated run. The change sits behind
`search.entity_anchoring`, which is off by default; with the key off, `query` and `search` return what they
returned before.

## The change

Some questions name one entity and ask for its current state: "Which city does acme-example build widgets in
now?" For these, `query` and `search` put the entity page first, then pages that link to it or name it,
newest first, ahead of the organic rows. The row count and the token budget stay what the caller asked for.
The code is `src/core/search/entity-anchor.ts`. Pinned-question refresh already used this anchoring, and both
callers now share it (`entityAnchoredPages`).

- **Detection is deterministic and makes no model call.** It needs a current-state cue in the query ("now",
  "currently", "latest", "these days" and similar) and exactly one entity page whose title the query mentions
  as a token run. That page must be a person, company, organization, fund, project, deal or concept, and the
  caller must be able to read it. With no entity or several entities, nothing changes.
- **Read safety.** Every row the change adds comes from `getChunkWindows`, which re-authorizes each page under
  the caller's scope: source, deleted, projection, archived source, quarantine, private pages and safe chunks.
  A page in the organic set keeps its row and moves up.
- **Scope.** Anchoring applies to plain queries only. It is skipped with `offset`, `types`, `since`, `until`,
  `lang`, `symbol_kind` or `near_symbol`, and on the keyword-only `search` path. Anchored rows take at most
  half the rows.
- **Touch points.** The change is additive in the op layer, and `hybridSearch` ranking is untouched:
  - `src/core/ops/search.ts`: one guarded call each in `search` (after the declared-name fan-out) and in
    `query` (after the fan-out, before the CRAG grade).
  - `src/core/search/entity-anchor.ts` (new).
  - `src/core/questions/refresh.ts`: `anchoredSlugs` now calls the shared function with the same SQL.
  - `src/core/types.ts`: the optional `SearchResult.entity_anchored` field.
  - `src/core/config.ts`: the key registration.

## Gates (preregistered)

1. **Seeded workload.** This is the appended-corrections workload from
   `docs/eval/decisions/c4-pinned-questions/` (run 3).
   - Setup: seeds 42, 7 and 1234; 6 entities; 12 write batches; `voyage:voyage-4` embeddings after every
     batch; balanced search.
   - Arms: the `query` op (expansion off) with `search.entity_anchoring` on and off, read by the B-suite
     reader `anthropic:claude-sonnet-5-5` at equal tokens. The budget is 200 tokens of rows in rank order,
     the same as run 3's query + reader arm.
   - Sensitivity arms, reported but not decisive: the same two arms at full evidence (16 rows).
   - Metrics, as in run 3: accuracy, stale-wrong rate, freshness lag in batches, correct at change and
     dollars per correct answer.
   - **Rule:** the key-on arm wins gate 1 if, in every seed, its accuracy is higher or its mean freshness lag
     is lower, and its accuracy is lower in no seed.
2. **No regression on the existing evals that cover `query`**, each run through the `query` op with the key
   on and off. Each reports how many questions triggered anchoring, because a corpus where it never fires
   proves nothing:
   - NamedThingBench and the relational retrieval-quality fixture (`test/fixtures/retrieval-quality/`),
     hermetic and keyword-only.
   - The LongMemEval nightly fixture (`test/fixtures/longmemeval-nightly.jsonl`), ingested the way
     `gbrain eval longmemeval` ingests it.
   - **Rule:** with the key on, no question's top-10 recall is lower than with the key off.
   - The `gbrain eval longmemeval` command itself calls `hybridSearch` directly, so the key cannot change it.
3. **Harness lane.** This is run by the harness lane, not here: dev slices (LongMemEval knowledge-update,
   PersonaMem, BEAM dev), then confirmation on validation. The harness must retrieve through the `query` op
   (or `gbrain query`) with `search.entity_anchoring=true` for the change to apply.

**Decision.** The key becomes default-on only if gates 1 and 2 pass here and gate 3 passes in the harness
lane. Until then it stays off. The cap for gates 1 and 2 is $10.

## Changelog

- 2026-10-05: gates preregistered before any gated run.
