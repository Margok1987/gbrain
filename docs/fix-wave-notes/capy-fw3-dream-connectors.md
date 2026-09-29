# Fix wave 3: dream cycle, synthesis and connectors

Branch `capy/fw3-dream-connectors`. The items come from the write-path audit (section C), the leftovers noted on #5666 and #5685 (both by @garrytan), and issue #5425 by @clatyceo. Each fix has a test that failed before the change.

## Concepts

**C-4: one concept page per concept.** `synthesize_concepts` normalized nothing, so "Network Effects", "network-effects" and "concepts/network-effects" became three groups, and one of them was written as `concepts/network effects`, a slug with a space in it. Refs now go through `slugifySegment` and `validatePageSlug` before grouping. Refs that normalize to nothing are dropped, and an atom that names a concept twice counts once. Pages that older runs wrote under invalid slugs are not migrated. (`test/cycle/synthesize-concepts-identity.test.ts`)

**C-5: concept narratives no longer degrade.** Each concept page now records a `member_hash`, taken over the member atoms and the synthesis model. When the hash hasn't changed, the phase skips the page without spending anything or writing a new version. When the budget runs out or the model errors, the existing LLM narrative stays in place instead of being replaced by a template stub. Fallback pages are retried on the next cycle. The human-owned test now checks that a page is refreshed when its member set changes, and skipped when it doesn't.

## Dream ownership and write-back

**C-8: human pages are not stamped as dream output.** The provenance stamp now applies only to pages a child created, meaning pages whose `created_at` is at or after the child's first `put_page` for that slug. Pages that already carry the stamp keep it. This covers the database stamp, the reverse-written markdown file and the managed postprocess path. A human `wiki/people/*` page that a child edited keeps its identity, so fact extraction and transcript discovery still read it. (`test/cycle-synthesize-dream-ownership.test.ts`)

**#5685 follow-up: a page another writer creates while a child runs.** Verification used to treat such a page as the run's own and check the whole page, so the other writer's text could be quarantined. The ownership boundary is now the child's first write to the page. The page is diffed against the revision that write replaced, in both the unmanaged and managed paths.

**#5685 follow-up: the managed write-back reconciles automatic links.** A `managed_maintenance_page` publish now rebuilds automatic links from the published body, the same way an ordinary `put_page` does. A link that only a quarantined sentence carried no longer survives. (`test/managed-maintenance-links.test.ts`)

## Budgets and dates

**C-13: synthesize has a USD gate, and the daily cap fails closed.** Before submitting a transcript, the phase checks its whole chunk set against a per-run `BudgetMeter`. The estimate is the prompt size plus the child's output cap, multiplied by `max_turns` in agentic mode. The setting is `dream.synthesize.budget_usd`, default $5: `0` submits nothing and `unlimited` removes the cap. A denied transcript is deferred along with the rest of the run, and the cooldown isn't stamped, so the next run retries. A failed daily-cap count query now submits nothing that run instead of skipping the cap. This changes default behavior for large backfills, which are now spread across runs.

**C-16: budget meter gaps.**
- A model missing from the pricing table is now metered at a Sonnet-tier fallback rate instead of bypassing the gate. Ollama, LM Studio and llama-server count as $0, and `dream.budget.allow_unpriced=true` restores the bypass.
- A budget of `0` now means spend nothing everywhere. Before, `BudgetMeter` treated 0 as unlimited, and drift mapped `"0"` to $1. `unlimited` is the explicit no-cap value.
- Drift now estimates input tokens from the prompt it actually sends, and sizes its output cap from the model.

The OpenRouter model-id test in `propose-takes.test.ts` opts into the bypass so that it still tests only model-id preservation.

**C-15: one calendar date per cycle.** `runCycle` resolves the cycle date once and passes it to synthesize (its prompt date hint), patterns (its "Today" line) and drift (its report slug and lookback window). The verify default uses the same date. `test/cycle-date-consistency.test.ts` fails if `src/core/cycle*` derives today's date with `toISOString().slice(0, 10)`.

**C-14: atoms follow their source.** Atoms from an undated source page are dated by the page's creation date, and atoms from an undated transcript go under `undated`. Neither uses the run date, so re-extracting on a later day upserts the same slugs. After an unmanaged extraction completes, atoms from earlier extractions of the same source that the new extraction did not produce are soft-deleted. The LLM picks atom titles, and they drift between runs. Managed brains don't get the stale-atom cleanup yet (deferred). (`test/cycle/extract-atoms-reconcile.test.ts`)

## Connectors and transcripts

**#5666 follow-up: a conversation that downloads but fails to ingest.** Ingest outcomes are now attributed to each conversation (the session id is the conversation id). The rest of the batch is recorded as synced. A conversation that fails to ingest three times at the same version is quarantined, the same way repeated fetch failures are, so it no longer holds the watermark. (`test/e2e/connectors-ingest-failure-pglite.test.ts`)

**C-17: Claude connector.** Confirmed first: other open-source exporters report that `chat_conversations` returns a flat array, caps an unpaged request, and honors `limit`/`offset`. Some accounts also have an API-only org that refuses chat listing. The connector now pages with `limit`/`offset` and stops on an empty page or a page with nothing new. It lists every org whose capabilities include chat, and fetches each conversation from the org that listed it. Timestamps are normalized with the same `toIso` ChatGPT uses. None of this was probed against a live account.

**C-18: ChatGPT offset pagination.** Confirmed with a fixture: archiving or deleting a conversation mid-walk moves every later item to a lower offset, so the next page skips one. The walk now steps back when `total` shrinks, and yields each id once across the active and archived passes. A conversation updated mid-walk moves to the top, where the next run picks it up.

**C-19: a session with no timestamps.** Such a session is now reported as `skipped_no_timestamp` and counted in `sessionsSkippedNoTimestamp`. It is no longer a session error that freezes `transcripts ingest --since last`. Provenance is still never fabricated.

## #5425: speaker attribution (@clatyceo)

**Default, mechanical.** The grounding gate has a new failure reason, `decision_misattributed`. It fires on a sentence that says a named speaker decided, agreed, committed or will act, where the sentence records no proposal, refusal or negation, and where its numbers or dates were stated only by another speaker and never explicitly accepted by the named one. An acceptance is a turn that opens with "yes", "sounds good", "do that" and similar. Such a sentence is quarantined into `unverified_claims`. Bare years and numbers that no turn states are not attributed to anyone. Claims without numbers or dates can't be checked mechanically.

Measured with the in-repo repeated-consolidation harness, which gained one misattributed decision and one accepted proposal:

| After 3 cycles | before | after |
|---|---|---|
| Misattributed decisions active (of 1) | 1 | 0 |
| Source-supported claims kept (of 14, including the accepted proposal) | 14 | 14 |

To check for false positives, Sonnet 4.6 synthesized 6 assistant-proposal transcripts × 4 runs × 2 prompt arms, 81 pages in total. The final check flagged 0 of them. An earlier version of the check flagged 2 correct sentences, a declined suggestion and a file-name year, and both are now pinned as tests.

**Opt-in prompt rules.** The issue's two prompt changes ship behind `dream.synthesize.attribution_rules` and `dream.propose_takes.attribution_rules`, both off by default, because matched runs showed no benefit:

- Synthesis (6 cases × 4, Sonnet 4.6): flagged misattributions went from 0 to 1, and accepted proposals kept went from 3/4 to 1/4. In an earlier run with the same setup they were 1 to 0 and 4/4 to 4/4. That is noise, with no demonstrated gain.
- propose-takes, run on the in-repo cat15 calibration corpus (9 labeled pages × 3 runs): F1 went from 0.896 to 0.876 and recall from 0.924 to 0.882. Neither arm attributed a rejected assistant prediction to a person, so there was nothing for the rule to fix. The opt-in variant caches under its own prompt version.

Paid model spend for these measurements was about $2.70.
