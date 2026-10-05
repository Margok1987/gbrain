# Pinned questions: B5 verdict

Pinned questions ship **opt-in**. The B5 safety gate passes with zero leakage on PGLite and Postgres. The
benefit gate does not pass against query plus a reader: accuracy is at the ceiling for every arm, and pinned
answers are not cheaper per correct answer until a pin has been read about 240 times. Pinned answers are
3.3 to 14.5 times cheaper than running `think` on every read. The feature does nothing until the owner pins a
question, and no pin is created by default.

Measured build: gbrain a4267eed7 (the `capy/mpw-integration` branch). Stage: dev.

## Benefit gate

The cost counted is total lifecycle dollars per correct, fresh answer: the first answer, every refresh
attempt, delivered read tokens and every model call. The workload is seeded and has 6 entities and
4 write batches. Each entity has a widget-factory city, and later batches correct some of those cities.
After each batch, every question is read 1 or 10 times, depending on the frozen reads-per-write ratio.

| Reads per write | Arm | Reads | Correct | Stale-wrong | Dollars | Dollars per correct |
|---|---|---|---|---|---|---|
| 1 | pinned | 24 | 24 | 0 | 0.0559 | 0.00233 |
| 1 | query + reader | 24 | 24 | 0 | 0.0127 | 0.00053 |
| 1 | think | 24 | 24 | 0 | 0.1828 | 0.00762 |
| 10 | pinned | 240 | 240 | 0 | 0.1262 | 0.00053 |
| 10 | query + reader | 240 | 240 | 0 | 0.1270 | 0.00053 |
| 10 | think | 240 | 240 | 0 | 1.8355 | 0.00765 |

- Pinned lifecycle split: $0.048 went to the first answers and 14 refresh attempts, and $0.0079 (1 read per
  write) or $0.078 (10 reads per write) went to reader tokens over the fresh sentences.
- Break-even: pinned overtakes query + reader after about 240 reads per pin (242 and 237 in the two runs).
  Both arms hand the reader about the same number of tokens per read, so a pin saves little at read time.
  The cost of keeping the answer current is repaid slowly.
- Against on-demand `think`, pinned is cheaper at both ratios: 3.3 times at 1 read per write and 14.5 times
  at 10.

**Ceiling.** Every arm answered every read correctly. The workload rewrites the evidence page when a city is
corrected, so no arm had a superseded value to repeat (stale-wrong is 0 everywhere). This run cannot show an
accuracy or freshness advantage. It decides on cost alone.

### Models

- Answer and refresh model: `anthropic:claude-opus-4-7`. This is gbrain's default for questions
  (`models.standing_questions`, which resolves to the deep tier).
- `think` arm: the same default model.
- Reader for the pinned and query arms: `anthropic:claude-sonnet-5-5`, the fixed reader of the B suites.
- Retrieval is keyword-only for all three arms, because the harness brain has no embedding key.

Metered spend: $2.34 of the $40 cap.

## Safety gate

`test/helpers/pinned-questions-scenarios.ts` passes 33 of 33 scenarios on PGLite
(`test/pinned-questions-safety.test.ts`) and 33 of 33 on live Postgres
(`test/e2e/pinned-questions-postgres.test.ts`). The full `bun run ci:ubicloud` gate passes on the integrated
tree. The suite covers:

- Zero leakage to restricted grants on search, query, list_pages, get_page, get_versions, context_pack and
  recall.
- No answer text in pages, chunks, versions, history or export.
- Read-time staleness for edits, soft and hard deletes, forget, clock expiry, supersession, visibility changes,
  takes, timeline entries and owner edits.
- Refresh that never publishes over a concurrent edit, a duplicate worker, a crash between publication stages
  or a failure.
- The consent, keyless, budget and no-worker states, and the operator journeys over MCP.

## Reproduce

```bash
bun evals/pinned-questions/benefit-gate.ts --plan --json --entities 6 --batches 4 --reader-model anthropic:claude-sonnet-5-5
bun evals/pinned-questions/benefit-gate.ts --run --yes --max-usd 40 --entities 6 --batches 4 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --json
```

`verdict.json` carries the full run report, and `decision.json` records the arms, models, workload and
budget.
