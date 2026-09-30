# W0 goldens (refactor wave 1)

Outputs captured on master (`f8d1e3936`, v0.60.11.0) that the wave-1 refactor must
reproduce byte for byte. Each file is written by `test/helpers/golden.ts` as
`{ "normalizer": <name>, "golden": <normalized value> }` with sorted object keys.

- Compare: run the owning test normally (`bun test <file>`).
- Regenerate (deliberate, reviewer-visible): `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <file>`.
  A regenerated golden needs a reason in the PR body; a refactor commit never
  regenerates one.
- Every golden names its normalizer. Each normalizer was proven by capturing the
  golden twice and diffing to empty (`expectNormalizerStable`, or the manual
  double-capture receipt recorded in the owning test's header).
