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

## Postgres SQL goldens (EO8 / EO4 / EO9)

- `sql-text/<domain>.json` (`test/engine-sql-sql-text.test.ts`): per PostgresEngine
  method and option variant in the 12 W1 domains, the ordered trace captured by the
  recording fake (`test/helpers/fake-postgres-sql.ts`, which renders with postgres.js's
  vendored `stringify`, so text is wire-exact). A W1 conversion must reproduce each
  entry byte for byte after `sql-text-v1` (`test/helpers/sql-text-normalizer.ts`):
  `textSha256` = exact text with `$N` renumbered by occurrence, `sql` = the same
  text whitespace-collapsed (readable diff), `params` = shape per placeholder
  occurrence, `lane` and `event` = pool / tx / savepoint / reserved and begin/commit.
- `sql-text/_driver.json`: tagged vs `unsafe`, param count and `unsafe()` options per
  statement. This is the only SQL golden an EO2 conversion (tagged -> `runUnsafe`)
  may regenerate, and only for the converted statements.
- `sql-text/_classification.json`: every PostgresEngine prototype member -> domain or
  out-of-scope bucket.
- `rls-scope-inventory.json` (`test/postgres-rls-scope-inventory.test.ts`): AST
  `withScopedReadTransaction` call sites (22 in 21 methods) plus runtime scoping per
  case with `GBRAIN_RLS_SCOPE_BINDING` on and off.
- `postgres-engine-gauge/*.json` (`test/postgres-engine-gauge-golden.test.ts`):
  checkoutGauge snapshots over a fixed in-flight op sequence, and gauge acquires per
  W1 domain case.
