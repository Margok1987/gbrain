# P4 streaming dev pilot (development data, sets no default)

The streaming compaction harness (gbrain-evals `capy/p4-streaming-harness` at
`4c98318`, `eval/runner/p4-stream/`) runs LongMemEval-S as a live conversation
with a 32k-token window through gbrain's real Claude Code hooks. These numbers
come from development questions only; they size the sealed run and guide the
work. They never set a default.

## Builds

| Arm | gbrain commit | Config |
|---|---|---|
| A′ | `5c82936a2` (gbrain#6025 head: MCP instructions reordered under the 2,048-char cap) | defaults |
| B | `73bd681cb` (this PR merged with gbrain#6025) | `memory.core.enabled=false`, `memory.pressure.enabled=true`, `memory.pressure.context_window=32000` |
| C | `73bd681cb` | `memory.core.enabled=true`, `memory.pressure.enabled=false`; profile page marked core |

## Results: claude-sonnet-5-5, 20 questions (seed 42, first 20), judge 10x

| Arm | Accuracy | $ per question | Compactions | Notice fired | Segments with no notice before compaction | Facts saved | Evidence-saved |
|---|---|---|---|---|---|---|---|
| A′ | 25.0% | 1.67 | 9.2 | 0% | 100% | 0.1 | 0% |
| B | 21.0% | 2.10 | 10.7 | 95% | 69% | 9.2 | 11% |
| C | 20.0% | 1.72 | 9.6 | 0% | 100% | 0.2 | 6% |

Paired differences against A′ (question-level bootstrap):

- B − A′: −4.0 points, 95% CI [−20.0, +12.0], per-question SD 0.398, 20% of questions discordant.
- C − A′: −5.0 points, 95% CI [−25.0, +15.0], per-question SD 0.510, 25% discordant.

Neither difference is distinguishable from zero at n = 20. The pressure notice
fires in 95% of conversations but reaches only 31% of compaction segments: a
whole LongMemEval session (often several thousand tokens) arrives in one turn,
so fill often jumps from under 80% straight past the compaction point.

## Cost per cell (one question, one arm, arm A′)

| Model | $ per cell |
|---|---|
| claude-sonnet-5-5 | 1.67 to 2.10 (20-question mean) |
| claude-opus-5-5 | 3.15 (one cell) |
| claude-fable-5-1 | 8.61 (one cell) |
| gpt-6.1-sol | 0.85 (one cell) |

## Power

With the measured per-question SD, a +3.0-point effect at 80% power with the
95% CI excluding zero needs about 1,380 questions per model for B − A′ and
about 2,270 for C − A′ (n = ((1.96 + 0.84) × SD / 0.03)²). LongMemEval-S has
500 questions in total. At about $14.50 per question per arm across the four
newest models, the pressure gate alone (A′ and B) at n = 1,380 costs about
$40,000; on claude-sonnet-5-5 alone about $5,200. The $1,400 cap buys about
28 questions across three arms and four models, where the 95% CI half-width is
about ±15 points.

Spend for this pilot, the cost probes and the smoke runs: about $129 (plus $14.95 for the LME-S retrieval guardrail in `p4-dev-2026-10-04`).
