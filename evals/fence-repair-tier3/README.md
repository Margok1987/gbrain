# Tier 3 fence-repair eval (#6188 T4)

Measures how well a chat model repairs the facts and takes fences that the free repair rules (Tier 1) leave malformed, through the production Tier 3 path, and whether that is accurate enough to stay on by default. The preregistration, raw per-item results and verdict live in gbrain-evals (`docs/benchmarks/2026-10-06-fence-repair-tier3*`).

## What's here

| File | Role |
|---|---|
| `cases.ts` | 78 hand-written cases. Each is one page whose fence Tier 1 leaves with a residual reason a model may clear (`short_row`, `no_header`, `row_before_header`, `extra_cells`, `header_unmapped`), with the whole repaired section written by hand. Sets: 66 `repairable` (a correct repair exists and passes every gate), 9 `adversarial` (the only correct outcome is to stay held: 6 `ambiguous` with two readings the gates cannot tell apart, 3 `unrecoverable` missing a required value) and 3 `gate_limited` (a person would repair them, but the gates forbid the correct table; diagnostic). Placeholder names only. |
| `generate-fixtures.ts` | Deterministic builder: `cases.ts` → `fixtures.jsonl` (committed). Regenerate after editing a case; the keyless test fails on drift. |
| `run-case.ts` | One fixture through the production path: the page becomes a stored-page target, `analyzeFences` runs the free tiers, and `runTier3` makes the model call with the brain's real daily ledger and attempt store (prompt v1, one call per fence, at most one corrective re-ask, gates (a)-(g), Tier 1 fixed point). Nothing re-implements a tier or a gate. |
| `oracle.ts` | The $0 label check: a scripted model answers with each ground truth (or adversarial probe) and the real gates must agree with the label. |
| `score.ts` | Pure scoring: the cell-level match rule, per-model rates, Wilson intervals and the preregistered decision rule. |
| `harness.ts` | Runner: `--oracle`, live (`--model`, `--run`, `--out`) and `--score`. |

The keyless test is `test/eval-fence-repair-tier3.test.ts` (fixture freshness and coverage floors, the oracle, scorer arithmetic). It guards the instrument, not the score.

## Running

```bash
# Prove every label against the production gates ($0, no key):
bun evals/fence-repair-tier3/harness.ts --oracle

# One live run of one model on a fresh throwaway brain (needs the provider key):
bun evals/fence-repair-tier3/harness.ts --model anthropic:claude-sonnet-5-5 --run 1 --out results/sonnet-5-5-run1.jsonl --max-usd 10
bun evals/fence-repair-tier3/harness.ts --model default --run 1 --out results/default-run1.jsonl   # gbrain's own models.fence_repair resolution

# Score saved runs ($0):
bun evals/fence-repair-tier3/harness.ts --score results/*.jsonl --json summary.json
```

A live run sets `models.fence_repair` on its brain (unset for `default`), registers list prices gbrain's table lacks in `pricing.overrides` (as `gbrain pricing set` would), and sets `fences.repair.max_usd_per_day` to `--max-usd`, which the daily ledger enforces as a hard ceiling. The per-page cap stays at the production default ($0.05), so a corrective re-ask the cap cannot cover is refused exactly as in production. A provider error is retried twice after a pause, as the next maintenance run would retry it. Each result row records the outcome (repaired, or held with its gate or failure class), the match against the ground truth, per-call tokens, ledger-priced USD, latency and the model's answer text.

Exit codes: 0 done, 1 oracle violation, 2 infrastructure (no key, cap reached, a fixture that no longer reaches Tier 3).

## Metrics

- **Gate-pass rate**: repairable fences whose Tier 3 repair passed every gate, over repairable fences run.
- **False-accept rate**: repairable fences repaired but not matching the ground truth, over repairable fences run. A match means the same non-empty cell text in the same columns (spacing ignored) and identical text outside the fences.
- **Held correctly**: adversarial fences that stayed held.
- **USD per repair**: ledger-priced spend on repairable fences over repairs. **Latency**: wall time of the Tier 3 step per fence that made a call (p50, p95).
