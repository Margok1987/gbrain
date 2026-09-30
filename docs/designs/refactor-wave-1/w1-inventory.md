# Refactor wave 1: W1-core per-method inventory

Every PostgresEngine / PGLiteEngine method of the five W1-core domains, classified before its conversion
(plan W1, "Engineering contracts: Dialect capabilities"). Classes:

- **identical**: same SQL text on both engines on master.
- **identical-after-normalization**: same statement modulo placeholder numbering, whitespace, bind-vs-inline of
  equivalent values, redundant casts, or clause order with identical semantics.
- **identical SQL, different driver post-processing**: the statements agree but the engines decoded rows
  differently (int8 as string vs number, timestamps as `Date` vs string, vector text parsing). The unified code keeps
  Postgres's mapping and declares the difference once (`engine-sql/normalize.ts` kinds or an explicit conversion).
- **dialect-specific**: the engines' SQL differs in behavior on master; the method keeps per-engine code and is
  listed in `scripts/engine-sql-baseline.tsv`.

The unified statement text is always PostgresEngine's master text (pinned byte for byte by
`test/fixtures/goldens/sql-text/<domain>.json`); PGLite now runs that text. Engine differences that remain are
expressed as executor capabilities (`src/core/engine-sql/executor.ts` `DialectCapabilities`), not
`if (engine === ...)` branches.

RLS scoping is unchanged per method (`test/fixtures/goldens/rls-scope-inventory.json`): every salience, facts,
takes and code-edges read was unscoped on master and takes `LegacyUnscopedRead`; the CJK keyword read was scoped and
takes `ScopedRead`.

## Capabilities

| Capability | PGLite | Postgres | Consumer | Tests |
|---|---|---|---|---|
| `maxBindParamsPerStatement` | 30,000 (the WASM parameter bridge corrupts the session past 32,767 binds) | `Infinity` (master never batched) | `code-edges.addCodeEdges` | boundary 5,000 / 5,001 unresolved rows (1 vs 2 statements on PGLite, 1 on Postgres) and three overlapping concurrent writers, `test/engine-sql-capabilities.test.ts` + `test/e2e/engine-sql-capabilities-parity.test.ts` |
| `transactionAdvisoryLocks` | false (single connection; the plain insert never opened a transaction) | true (`pg_advisory_xact_lock(hashtextextended(source_id \|\| ':' \|\| entity_slug, 0))` inside the insert transaction) | `facts.insertFact` | eight concurrent same-entity inserts, an entity-less insert, three concurrent supersedes of one fact |
| `probesEmbeddingCast` | false (master always cast `::vector`; the bundled pgvector assignment-casts to the `halfvec` column) | true (`PostgresEngine#resolveFactsEmbeddingCast` probes `format_type` once per process) | `facts.insertFact`, `facts.insertFacts` | three concurrent vector writes at the live column dimension round-trip exactly |

## salience (`engine-sql/salience.ts`, C10)

| Method | Class | Notes |
|---|---|---|
| `batchLoadEmotionalInputs` | identical-after-normalization | PGLite appended ` WHERE p.slug = ANY($1::text[])` to a shared base string. |
| `setEmotionalWeightBatch` | identical-after-normalization | Placeholder numbering only; returns `RETURNING 1` row count on both. |
| `getRecentSalience` | identical-after-normalization | PGLite built clauses into a params array (`$N` reuse); same predicates, order, recency builder. |
| `listEnrichCandidates` | identical-after-normalization | PGLite joined a WHERE array; same predicates and whitelisted ORDER BY. |
| `findAnomalies` | identical-after-normalization | PGLite reused `$1/$2/$3` across CTEs; Postgres binds each occurrence. |

## facts (`engine-sql/facts.ts`, C11)

| Method | Class | Notes |
|---|---|---|
| `insertFact` | dialect-specific via capabilities | Advisory lock + insert transaction on Postgres only (`transactionAdvisoryLocks`); cast suffix probed on Postgres only (`probesEmbeddingCast`). The vector literal stays inlined text on both (master's planner behavior). `md5(fact)` vs `CASE WHEN model THEN md5($3)` compute the same hash. |
| `expireFact` | identical-after-normalization | `affectedRows` replaces `.count` / `.affectedRows`. |
| `insertFacts` | identical-after-normalization | Same transaction, delete-first, per-row insert and supersede second pass; PGLite bound `$14::vector`, Postgres inlines the literal. |
| `deleteFactsForPage` | identical-after-normalization | PGLite cast `LIKE ANY($3::text[])`; Postgres binds the array uncast (PGLite infers `text[]` from context, verified). |
| `listFactsByEntity`, `listFactsSince`, `listFactsBySession` | identical SQL, different driver post-processing | PGLite's `_listFacts` built `NOT (source = ANY(...))` and inlined LIMIT/OFFSET; same predicates. PGLite returned some timestamps as strings: `rowToFact` declares six `date` columns. |
| `listSupersessions` | identical SQL, different driver post-processing | As above. |
| `countUnconsolidatedFacts` | identical-after-normalization | `source != ALL` vs `NOT (source = ANY)`: identical for the NOT NULL `source`. |
| `findCandidateDuplicates` | identical-after-normalization | PGLite bound the query vector; Postgres inlines it. |
| `consolidateFact` | identical-after-normalization | |
| `findTrajectory` | identical SQL, different driver post-processing | PGLite selected `embedding` and parsed inline; Postgres selects `embedding::text` and uses `tryParseEmbedding` (same result for valid vectors). `valid_from` string on PGLite is converted to `Date`. |
| `getFactsHealth` | identical SQL, different driver post-processing | Postgres returns `COUNT(*)` as int8 text; PGLite cast `::int`. Both map through `Number()`. |
| Stays in the engines (listed in the baseline): `resolveFactsEmbeddingCast` (Postgres probe), `migrateFactsToCanonical`, `mergeOntologyFact`, `getOntology`, `discoverOntologyDimensions`, `findOntologyConflicts` (never in the per-engine facts modules). | | |

## takes (`engine-sql/takes.ts`, C12)

| Method | Class | Notes |
|---|---|---|
| `addTakesBatch`, `updateTakeEmbeddings` | identical | Already shared text through `executeRawJsonb`; keep master's executeRaw path (raw gauge) and re-resolve the executor per `batchRetry` attempt. |
| `listActiveTakesForPages`, `listTakes`, `searchTakes`, `searchTakesVector`, `countStaleTakes`, `listStaleTakes` | identical-after-normalization | Clause builders vs tagged fragments; row mappers already shared (`takeRowToTake`, `takeHitRowToHit`, `staleTakeRowToRow`). |
| `writeContradictionsRun`, `putContradictionCacheEntry` | identical-after-normalization | `sql.json` becomes `jsonbParam` (still `sql.json` on Postgres; PGLite binds the serialized value to the jsonb column, as its raw object bind did). |
| `loadContradictionsTrend`, `getContradictionCacheEntry`, `sweepContradictionCache` | identical-after-normalization | |
| `getTakeEmbeddings` | identical SQL, different driver post-processing | PGLite parsed the vector text inline; unified on `tryParseEmbedding`. |
| `updateTake`, `supersedeTake`, `resolveTake` | identical-after-normalization | `supersedeTake` runs through `exec.transaction`. |
| `getScorecard`, `getCalibrationCurve`, `addSynthesisEvidence` | identical-after-normalization | |

## code-edges (`engine-sql/code-edges.ts`, C13)

| Method | Class | Notes |
|---|---|---|
| `addCodeEdges` | dialect-specific via capabilities | PGLite batched below 30,000 binds (`maxBindParamsPerStatement`); casts `::int` / `::text::jsonb` now on both. Keeps master's direct `unsafe` path. |
| `deleteCodeEdgesForChunks` | identical-after-normalization | |
| `getCallersOf`, `getCalleesOf` | identical-after-normalization | PGLite inlined an escaped `source_id` literal; Postgres binds it. `NULL` vs `NULL::int` in the UNION. |
| `getEdgesByChunk` | **dialect-specific (kept per engine)** | PGLite's master SQL is one UNION ALL under a single shared LIMIT, and for direction `both` its edge-type filter binds only to the `to_chunk_id` arm (operator precedence); Postgres runs two statements, each with its own LIMIT, filter parenthesized. Unifying would change PGLite results, so PGLite keeps `src/core/pglite-engine/code-edges.ts` (baseline row) and Postgres uses the engine-sql version. Aligning PGLite is a behavior change: TODO. |

## cjk-search (`engine-sql/cjk-search.ts`, C14)

| Method | Class | Notes |
|---|---|---|
| `searchKeyword` / `searchKeywordChunks` CJK branch (`_searchKeywordCJK`) | identical | SQL already built once in `search/cjk-keyword-sql.ts`. Postgres's statement timeout (`SET LOCAL statement_timeout = '8s'`) and RLS scope transaction stay in the engine hook (dialect-specific; `PostgresEngine._searchKeywordCJK` keeps its baseline row). |
