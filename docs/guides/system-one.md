# System One (decide) operator guide

Operator reference for `gbrain decide`. The capability contract is
[`docs/architecture/decide.md`](../architecture/decide.md). Every slot is
off by default; each slot is `off` or `on`.

## Contradictions (S9 `conflict`): sweep and proposals

The fact write path stays zero-LLM and unchanged. With the slot on, a sweep
compares each fact written since the last sweep with its five nearest
neighbours about the same entity (same source and visibility, active,
cosine at least 0.80) and asks the provider, per pair, whether the new fact
is a duplicate of, supersedes, or is independent of the older one. v1 never
supersedes anything automatically: a supersede answer at or above
`decide.slots.conflict.proposal_floor` (default 0.50) becomes a pending
proposal you review. Duplicates and independents are receipts only.

```bash
gbrain decide enable conflict            # facts are private by default: needs decide.egress.private=allow
                                         # (or an llm: route); enable prints the share of private facts
gbrain decide sweep --slot conflict      # run now; also runs as the tail of the extract_facts cycle phase
gbrain decide sweep --slot conflict --since 0   # the first run only records the watermark; --since sweeps earlier facts
gbrain decide proposals list             # both facts' text, locally; --status accepted|rejected|stale|undone|all; --json
gbrain decide proposals accept <id>      # or --all-from <sweep id>
gbrain decide proposals reject <id>      # or --all-from <sweep id>
gbrain decide proposals undo <id>        # reverse an accepted proposal
```

- **Accept** rechecks that both facts are still active and share source,
  entity and visibility (otherwise the proposal becomes `stale` and nothing
  changes), then supersedes the old fact with the new one: `expired_at`,
  `valid_until` and `superseded_by` on the old fact and the struck row in the
  page's `## Facts` fence change together. If any part fails, nothing changes
  and the proposal stays `pending`; run accept again.
- **Undo** (`gbrain decide proposals undo <id>`) is the reverse path: it
  restores the three fields and the fence row, and refuses when either fact
  or the fence row changed since the accept.
- The sweep only advances its watermark past facts older than 60 seconds;
  facts without an embedding, and facts whose request failed (timeout, 429,
  5xx, exhausted budget), are retried on later sweeps up to 5 times. Facts
  without an entity are skipped. Receipts carry hashes only, never fact text.
- Kill switch: `gbrain decide disable conflict`, `gbrain decide disable --all`
  or `decide.provider none` stop the sweep; with the slot off the
  `extract_facts` phase output is unchanged.
- Calibrate the duplicate threshold with labelled fact pairs:
  `gbrain decide dataset --slot conflict --from facts-fixtures <pairs.jsonl>`,
  one JSON object per line:

  ```json
  {"id":"p1","family":"alice-role","fact":"Alice Example is CTO of Acme Example","candidate":"Alice Example is VP Engineering at Acme Example","label":"supersede"}
  ```

  `label` is `duplicate`, `supersede` or `independent`; pairs sharing a new
  fact share a `family`.
