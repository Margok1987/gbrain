# Fix wave 3: search and the read path (`capy/fw3-search`)

Release notes for the integrator. No version stamp or CHANGELOG edit on this
branch.

## Ranking and retrieval

- **Title mentioned in a general question (#4694).** A multi-token title or
  slug tail that is the subject of a general or temporal question ("Which
  document is <title>?") now gets a bounded 1.18x boost. The subject rule
  (the title supplies at least half the query's distinct content tokens) and
  "longest nested title wins" came from measurement: boosting every mentioned
  title sent the mentioned page above the right answer. Concept-intent and
  relational questions are excluded. Thanks @jonathanlesh for the report and
  the benchmark shape.
- **Reworded relational questions fire the graph arm.** "X's investors",
  "people who funded X", "who backs X", "who is the founder of X", "which
  companies has X backed", "relationship between A and B" and "who can
  introduce me to X" now parse as relational. The arm still fires only when
  the named entity resolves to a page.
- **Deterministic rerank ties (#5428).** Rows the cross-encoder scored
  exactly equal keep the fused order instead of the provider's arbitrary
  order. Thanks @clatyceo.
- **Opt-in single-token alias hop (#5428).** `search.alias_token_hop=true`
  (or per-call `aliasTokenHop`) moves or injects the person/company page
  whose alias is one query token ("ali summary"). Off by default: no in-repo
  benchmark exercises it. Thanks @clatyceo.
- **Per-brain source boosts (audit #13).** `gbrain config set
  search.source_boosts "wiki/:1.3,daily/:1.0"` overrides the vault-shaped
  defaults per brain; a `none` entry drops them. Brains without the key keep
  today's defaults. `GBRAIN_SOURCE_BOOST` still wins.
- **Identity injections honor prefix excludes.** The alias hop and the
  exact-lookup tier no longer inject a page under `exclude_slug_prefixes` or
  the default/env hard excludes (a slug-shaped query could surface a `test/`
  page), on all three return paths.
- **Keyword-only paths apply the identity boost.** Without an embedding
  provider, "who is Alice Example" now gets the same entity exact-match and
  alias-mention boost as the hybrid path.
- **Image rows in 'both' mode rescore in the image space**, not against the
  text column where they had no vector and took a 30% penalty.
- **Token budget.** One oversized result no longer drops every lower-ranked
  result after it; CJK text is counted at about one token per character
  instead of one per four; the salvage cut never splits a surrogate pair.
  The memory verbs' frozen packer is unchanged.

## Correctness, latency, observability

- **Failed lexical arms are visible (#5324).** A rejected keyword or title
  arm stamps `keyword_arm_failed` / `title_arm_failed` in `meta.degraded`.
  Thanks @founders-sgp.
- **Bare-name entity matches are flagged (#4846, #5139).** A single-token
  name resolved to the only `<dir>/<token>-*` page is tagged
  `prefix_expansion`, and facts written through it carry an "unverified"
  note. Thanks @kweiner (the two PRs are the same change).
- **Graph walks stay bounded on dense hubs.** A 12-page clique at depth 5
  took ~22 s (`traversePaths` both) and ~3.5 s (`traverseGraph`); now about
  0.25 s and 0.06 s, both engines, with the shallow neighbourhood complete.
- **Dead semantic-cache setup removed** from `hybridSearchCached`: two fewer
  round-trips per search on hosted Postgres.
- **Trajectory lookups clear their 5 s deadline** in think and the
  LongMemEval route.

## Evaluation tooling

- **LongMemEval runs sharing one embed cache keep their writes.** A
  question's cache writes were held in a SQLite transaction across its
  network embeds, so a second run hit `SQLITE_BUSY_SNAPSHOT` (lost
  write-back) or waited on the lock. Writes are now buffered and flushed in
  one short `BEGIN IMMEDIATE`.
- **Long LongMemEval runs no longer hang (#5092).** PGLite's WASM memory is
  never returned by `TRUNCATE`; the harness now replaces its benchmark brain
  every 40 questions. Thanks @justinsharpe for the detailed report.
- **Title benchmark** in `evals/title-mention/` (72 placeholder pages, 144
  queries in four families) for `gbrain import` + `gbrain eval
  retrieval-quality`.

## Measurements

All paid runs used `openai:text-embedding-3-large@1536` through one shared
embed cache, so arms compare the same vectors. Spend was not metered; from
haystack size the LongMemEval embeddings cost roughly $3-4, and the two
relational runs about $0.07 each.

**LongMemEval** (`halfA430` split, 215 scored questions, `--retrieval-only
--top-k 5 --mode balanced --reranker off --autocut off --no-trajectory`):

| Arm | recall_all@5 | recall_any@5 | vs master |
|---|---|---|---|
| master `045a6138` | 202/215 | 211/215 | |
| this branch, default | 202/215 | 211/215 | identical top-5 on all 215 questions |
| branch + expansion, legacy budget (`null`) | 205/215 | 211/215 | +4/−1 vs no expansion |
| same variants replayed, budget 1.0 | 203/215 | 211/215 | +0/−2 vs legacy |
| same variants replayed, budget 0.25 | 202/215 | 211/215 | +1/−4 vs legacy |

Audit #14 (expansion over-weights the vector arm): the measurement does not
support defaulting the variant budget, so the bundles keep `null`. The knob
already exists (`search.expansion_variant_budget`, per call and per brain);
`docs/guides/search-modes.md` now carries these numbers. The branch run also
completed 215 embedded questions in one process (brain recycling), where the
master run stalled at question 94 twice.

**Title benchmark (#4694)** (`evals/title-mention`, 72 pages, 144 queries, one
query-embedding cache for all arms), hit@1:

| Family (n=36 each) | master | boost on every mentioned title (rejected) | shipped rule |
|---|---|---|---|
| title as the whole query | 34 | 34 | 34 |
| "Which document is <title>?" | 30 | 33 | 33 |
| long question containing the title | 33 | 34 | 33 |
| mentions one title, asks for another | 24 | 0 | 24 |

Shipped rule vs master: +3/−0 per query (one win in the first three
domains, two in the last three). The rejected variant is the naive
"title mentioned anywhere" boost. After the relational and concept
exclusions the benchmark result is unchanged.

**Relational rewordings, held out** (gbrain-evals `capy/fw3-evals`,
`eval/runner/relational-ab.ts`, 3 seeds, 435 queries per split; the frozen
paraphrase split was measured once and never inspected or tuned on):

| Split | Build | Arm fired | hit@1 arm off → on | paired hit@1 |
|---|---|---|---|---|
| template | master | 174/435 | 0.276 → 0.428 | +72/−6 |
| template | branch (final) | 174/435 | 0.276 → 0.428 | +72/−6 |
| paraphrase | master | 0/435 | 0.048 → 0.048 | +0/−0 |
| paraphrase | branch (46f61770e) | 99/435 | 0.048 → 0.166 | +51/−0 |

The paraphrase row was measured once, at 46f61770e. Two later commits change
the general title boost for relational and concept queries; they were not
re-measured on the frozen split. The first of them came from the template
split, where the 46f61770e build lost one hit@1 per seed ("Who invested in
Pulse Labs?"). The template split was re-run after the fix and matches master
exactly. By edge family on paraphrases: works_at 30 fired (hit@1 0.05 →
0.20), invested_in 45 (0.08 → 0.21), advises 24 (0.13 → 0.50), attended 0
(the attended template does not fire on master either).

False positives, measured at the parse level (the arm can only fire on a
parse): LongMemEval questions 1/500 (master: the same 1/500), Cat13 probe
templates 0/120, title benchmark 0/144, NamedThingBench non-relational 0/11.
The branch LongMemEval arm returned the same top-5 as master on every
question.

**Graph walk** (12-page clique, PGLite): `traversePaths` both at depth 5 went
from 21.9 s to 0.25 s, `traverseGraph` depth 5 from 3.4 s to 0.06 s.

**No measurement possible here:** 'both'-mode image rescoring (no multimodal
key) and the rerank tie-break (no reranker key). Both are correctness fixes
that do not change ranking outside their cases: image-arm rows, and exactly
tied rerank scores.

## Deferred / follow-ups

- Entity/event-intent title mentions (#5676 path) are still ungated. On the
  title benchmark, the 4 "mentions one title, asks for another" queries with
  entity/event intent all miss on master and on this branch. Gating them the
  same way costs an existing framed-query test ("tell me about alice
  example"), because framing words count as content tokens. The fix needs
  framing-word-aware coverage.
- `ci:ubicloud` orchestration once waited 40 minutes on a slot with no test
  running on any VM (lost completion). Cancelling it tore the VMs down; the
  next run was clean.
