# Refactor wave 1 — W1 per-method inventory

## Forward-reference bootstrap (E1)

Sources compared: `PGLiteEngine#applyForwardReferenceBootstrap` (`src/core/pglite-engine.ts`, 604 lines) and
`applyPostgresForwardReferenceBootstrap(conn)` (`src/core/postgres-engine/forward-reference-bootstrap.ts`, 655 lines),
both at the E1 base. Destination: `src/core/engine-sql/bootstrap.ts`. Classes: **identical**; **identical after
normalization** (whitespace, comment wording, variable typing); **identical SQL, different driver post-processing**;
**dialect-specific** (kept as an explicit hook).

### Probe statement (one round-trip)

| Item | Class | Notes |
|---|---|---|
| 55 `EXISTS` probes on `information_schema.tables` / `.columns` (`pages`, `links`, `content_chunks`, `mcp_request_log`, `subagent_messages`, `ingest_log`, `files`, `oauth_clients`, `sources`, `timeline_entries`, `minion_jobs`, `facts` targets) | identical after normalization | Same aliases and table/column pairs on both engines. Column order in the SELECT list differed (`effective_date_exists` position); results are read by alias, so order has no effect. Now rendered once from `FORWARD_REFERENCE_PROBES`. |
| `oauth_client_grants_exist` (`COUNT(*) = 6` over the six grant columns) | identical after normalization | Rendered once. |
| `table_schema` predicate | dialect-specific | Postgres `current_schema()`, PGLite `'public'`. Hook `probeSchema`; kept per engine because the two differ when `search_path` is not `public`. |
| `dream_verdicts_exists`, `dream_verdicts_expires_at_exists` | dialect-specific | Postgres only (its blob carries `dream_verdicts` + `dream_verdicts_expires_idx`; PGLite creates the table by migration v30). Hook `dreamVerdictsForwardReference` gates the probes, the gap and the ALTER. |
| Driver call | identical SQL, different driver post-processing | Postgres ran a zero-parameter tagged template (named prepared statement on direct Postgres, unprepared through PgBouncer, extended protocol); now `conn.unsafe(sql, [], { prepare: true, simple: false })`, which postgres.js treats identically (per-call `prepare` ANDed with the connection option; `simple: false`). PGLite keeps `db.query(sql)`. Both return one row of booleans. |

### Gap predicates

All 26 shared `needs*` predicates are identical after normalization: Postgres read some probes through widened
`probe as {...}` casts and compared `=== true`; PGLite read them directly. Both drivers return JS booleans for
`EXISTS`/`=` columns, so truthiness and `=== true` agree. `needsDreamVerdictsExpiresAt` is dialect-specific (above).
The early-return conjunction lists the same flags on both engines (plus the dream_verdicts flag on Postgres).

### DDL blocks (in execution order)

| Block | Class | Notes |
|---|---|---|
| stderr `Schema forward-reference gap detected, applying bootstrap` | identical | |
| facts `embedding_model`, `embedded_text_hash` | identical after normalization | |
| `sources` CREATE TABLE + default seed + `pages.source_id` | identical after normalization | |
| links `link_source`, `origin_page_id` | identical after normalization | |
| content_chunks v26/v27 columns | identical after normalization | |
| pages `deleted_at` | identical after normalization | |
| content_chunks v39 `modality`, `embedding_image` | dialect-specific (position only) | Same statements. PGLite ran it right after `deleted_at`; Postgres after `subagent_messages.provider_id`. Hook `chunksEmbeddingImageStep` keeps each engine's order; the SQL text is one constant. |
| mcp_request_log `agent_name`, `params`, `error_message` | identical after normalization | |
| subagent_messages `provider_id` | identical after normalization | |
| pages v40/v41 recency columns | identical after normalization | |
| ingest_log `source_id` | identical after normalization | |
| files `source_id`, `page_id` | identical after normalization | |
| oauth_clients `source_id`, `federated_read` | identical after normalization | |
| `GRANT_COLUMNS_SQL` | identical | Same imported constant. |
| oauth_clients `surface`, `surface_set_by` | identical after normalization | |
| sources archive columns | identical after normalization | |
| pages `last_retrieved_at`; provenance; contextual-retrieval (+ sources); `generation`; `embedding_signature`; `links_extracted_at` | identical after normalization | |
| timeline_entries `event_page_id` | identical after normalization | |
| minion_jobs `timeout_at`; `idempotency_key` | identical after normalization | |
| dream_verdicts `expires_at` + `SET DEFAULT` (two statements) | dialect-specific | Postgres only, between `idempotency_key` and the private-queue block, as on master; wrapped in `dialect-only:postgres` markers so the PGLite half of `test/schema-bootstrap-coverage.test.ts` does not count it. |
| minion_jobs private-queue columns; `submission_authority`, `claim_generation` | identical after normalization | |

DDL driver calls are unchanged: PGLite `db.exec(sql)`, Postgres `conn.unsafe(sql)` (simple protocol, multi-statement).

### Equivalence evidence

A trace harness ran master's and E1's bootstrap on the same states (empty database, current schema, every probed
column dropped at once, then each probed column dropped singly: 48 scenarios per engine) and recorded probe rows, every
DDL batch (whitespace-normalized) and the stderr line. PGLite traces are byte-identical. Postgres traces are identical
except the recorded probe call form (tagged template vs `unsafe` with tagged-template options); on a single direct
connection both leave the probe as a named prepared statement.
