# Pinned questions: B5 verdict

Pinned questions ship **on**. On a workload where corrections arrive as new notes and the old notes stay as
written, pinned answers were right on 98.6% of reads, against 51.4% for query plus a reader and 79.2% for
`think` on every read. They went stale-wrong on 0% of reads, against 48.6% and 20.8%. The safety gate passes
with zero leakage, including 48 restricted-grant probes on this workload. The main caveat is retrieval: pinned
refresh anchors its evidence on the pin's entity, newest first, and the other two arms have no scope to anchor
on, so part of the gap comes from that.

"On" means the refresh phase, publishing and `context_pack` delivery of fresh pinned answers are on by default.
Pinning a question is still the consent for its paid refresh (plan C1), so gbrain creates no pin by itself and
a brain with no pins makes no model call. No shipped default changed between run 1 and run 2; the verdict
moved from opt-in to default-on.

Measured build: gbrain baadfc04 (the `capy/mpw-integration` branch). Stage: dev.

## Benefit gate

The decision rule was set before run 2: if pinned beats query plus a reader on accuracy or freshness without
leakage, it ships default-on; otherwise opt-in stands. Pinned beats it on both.

### Run 2: corrections appended as new evidence (deciding run)

The workload is seeded (seed 42) and has 6 entities and 12 write batches, which is 13 writes per entity. Each
entity has a widget-factory city, and corrections arrive as dated notes while the older notes stay as written.
Batch 4 adds two conflicting notes in one week, and the later note corrects the earlier one. Batch 6 delivers
the update through `remember`. Batch 7 withdraws it with `forget`, and the answer reverts. Batch 10 makes the
newest note private. After each batch every question is read 1, 10 or 100 times, depending on the frozen
reads-per-write ratio. The cost counted is total lifecycle dollars: the first answer, every refresh attempt,
delivered read tokens and every model call.

| Arm | Accuracy | Stale-wrong | Freshness lag (batches) | Correct at change | Lifecycle $ |
|---|---|---|---|---|---|
| pinned, default model (Opus 4.7) | 0.986 | 0.000 | 0.017 | 0.983 | 0.649 |
| pinned, Sonnet 5.5 refresh | 0.958 | 0.014 | 0.050 | 0.950 | 0.415 |
| query + reader | 0.514 | 0.486 | 0.583 | 0.483 | — |
| think | 0.792 | 0.208 | 0.250 | 0.783 | — |

Freshness lag is the mean number of write batches before an answer reflects one of the 60 value changes.
Correct at change is the share of those changes answered correctly in the batch they happened.

Dollars per correct answer:

| Reads per write | Pinned (Opus 4.7) | Pinned (Sonnet 5.5) | Query + reader | Think |
|---|---|---|---|---|
| 1 | 0.00961 | 0.00681 | 0.00234 | 0.03061 |
| 10 | 0.00138 | 0.00141 | 0.00234 | 0.03061 |
| 100 | 0.00056 | 0.00087 | 0.00234 | 0.03061 |

- Pinned spends more total dollars than query plus a reader until about 147 reads per pin (163 with the Sonnet
  refresh model). Because it is right twice as often, it is already cheaper per correct answer at 10 reads per
  write, and at 100 it costs a quarter as much.
- Pinned is 3.2 times cheaper than `think` per correct answer at 1 read per write, 22 times at 10 and 55 times
  at 100, and it is also more accurate.
- The Sonnet refresh model cuts lifecycle cost by 36% ($0.415 against $0.649) for 2.8 points of accuracy.
  It returned non-JSON on 2 of 72 refreshes; each time the pin kept its previous answer, which counts against
  it.
- Withdrawal is the weakest event. After `forget` in batch 7, 1 of 6 default-model answers and 2 of 6 Sonnet
  answers missed the revert.
- Leakage: 48 probes through a restricted MCP grant that cannot read private pages, covering search,
  `get_page`, `context_pack` and `questions_status`, found 0 leaks.

**Retrieval asymmetry.** Pinned refresh anchors retrieval on the pin's scope: the entity page first, then
pages that link to it or name it, newest first, with question and synthesis pages excluded. Query plus a
reader uses ordinary keyword retrieval, and `think` uses its own gather. Every arm is keyword-only because the
harness brain has no embedding key. Query plus a reader fails here the way it does in real use: once notes
pile up, keyword ranking treats every note that mentions the entity's city alike and often misses the newest.

**Diagnostic attempt before the fix.** The first run-2 attempt, on 183fee7f, found pinned no better than query
plus a reader (0.528 and 0.542 accuracy against 0.514). Pinned refresh retrieval had the same newest-note
blind spot. baadfc04 fixed it in `src/core/questions/refresh.ts` with a regression test. The attempt is
recorded in `verdict.json` as a diagnostic and was not a decision input.

#### Models

- Answer and refresh model: `anthropic:claude-opus-4-7`, gbrain's default for questions
  (`models.standing_questions`, which resolves to the deep tier). The cost-lever arm refreshes with
  `anthropic:claude-sonnet-5-5`.
- `think` arm: the same default model.
- Reader for the pinned and query arms: `anthropic:claude-sonnet-5-5`, the fixed reader of the B suites.

Metered spend for run 2: $5.92 of the $10 cap ($2.98 for the deciding run and $2.93 for the diagnostic
attempt).

### Run 1: corrections rewrite the evidence page

Measured build: gbrain a4267eed7. Verdict at the time: opt-in. Run 1 found that the benefit gate did not pass
against query plus a reader. Accuracy was at the ceiling for every arm, and pinned answers did not cost less
per correct answer until a pin had been read about 240 times.

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

#### Models

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
# Run 2 (deciding)
bun evals/pinned-questions/appended-gate.ts --plan --json --entities 6 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5
bun evals/pinned-questions/appended-gate.ts --run --yes --max-usd 7 --entities 6 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5 --json

# Run 1
bun evals/pinned-questions/benefit-gate.ts --run --yes --max-usd 40 --entities 6 --batches 4 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --json
```

`verdict.json` carries both run reports and the diagnostic attempt, and `decision.json` records the arms,
models, workloads, decision rule and budget.

## Changelog

- 2026-10-05, run 2: appended-corrections workload on baadfc04. Pinned beats query plus a reader on accuracy
  and freshness with zero leakage, so the verdict moves from opt-in to default-on.
- 2026-10-05, run 1: rewrite workload on a4267eed7. Every arm hit the accuracy ceiling and pinned did not win
  on cost against query plus a reader, so pinned questions shipped opt-in.
