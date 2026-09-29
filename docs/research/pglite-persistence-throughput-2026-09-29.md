# PGLite managed-persistence write throughput (2026-09-29)

**Decision:** ship. The PGLite soak goes from 9.0 to 33.1 committed writes/s in
matched 1,000-write runs (3.7×). The full 10,000-write gate soak drops from
1,417 s to 296 s. Postgres does not regress (11.4 → 13.9 writes/s). Every
durability and crash contract is unchanged, and the full default gate reports
`full_gate: true` on both engines.

## Method

All numbers come from one Ubicloud `standard-30` VM (30 vCPU, Ubuntu 24.04,
Bun 1.3.13, `pgvector/pgvector:pg16` with default settings), running master
`6bb88d1` and the candidate side by side, alternating runs:

```bash
bun --no-env-file scripts/persistence/validate.ts --engine=<engine> \
  --schedules=0 --no-crashes --operations=1000 --manifest=<file>
```

The owner profile adds a scratch preload to the owner process that is not
shipped: an `AsyncLocalStorage` label per consumer phase, the SQL text and
PGLite WASM time of every protocol message, Node `fs` and child-process
counters, and `bun --cpu-prof-md` for the JavaScript side.

## Owner profile, 1,000 writes, per committed write

| | master | candidate |
|---|---:|---:|
| Owner wall time per write (the owner is saturated) | 113 ms | 30 ms |
| PGLite WASM time | 60.7 ms | 13.3 ms |
| SQL statements executed | 217 | 176 |
| Relation-file `open()` / `fstat()` from PGLite NODEFS | 473 / 1,690 | 4.4 / 113 |
| Synchronous `git` spawns on the event loop | 2.0 (6.3 ms blocked) | 0 (0.87 async probe pairs) |
| Projection rebuild WASM time (55 → 38 statements) | 20.5 ms | 3.3 ms |
| Publish transaction WASM time | 9.0 ms | 1.9 ms |

Where master's time went, in order:

1. **Per-statement overhead in PGlite.** `query()` parses, plans, and describes
   every call as an unnamed statement over five protocol round trips, and its
   result parser copies `db.parsers` (412 entries, most of them composite
   row-type arrays) for every result. That copy alone was 20% of owner CPU.
   Planning each statement calls `lseek(SEEK_END)` on every relation and index
   it touches. PGLite's file-descriptor cache is pinned at about 48 files, so the
   write path reopened ~470 relation segments per write. That cache limit is
   inherent to PGLite 0.4.3: `max_files_per_process` does not change it.
2. **Synchronous git probes.** The git effect's durability check ran
   `git config --get core.hooksPath` and `git rev-parse --git-path hooks` through
   `execFileSync`, blocking the owner for about 6 ms per write. It did not sit on
   the commit's ordering path, but the owner is one event loop, so it serialized
   with everything.
3. **Work that grows with the brain.** `ANALYZE pages(...)` ran after every
   drained projection rebuild, taking 10 ms at 10,000 pages. The projection-job
   selection scanned every page to probe an almost empty queue. PGLite has no
   autovacuum, so the queue tables were never analyzed: receipt and admission
   lookups picked the `(principal_kind, principal_id, sequence)` index over the
   unique request-id index and scanned every request of that principal. Their
   cost grew linearly across the 10,000-write soak.

Durable file work (fsync of the staged file and its directory) is about 4.7 ms
per write on this VM. It is required and unchanged.

## Changes

- `src/core/pglite-statements.ts`: named server-side statements for PGLite, the
  plan cache postgres.js already gives the Postgres engine. A statement seen
  twice is prepared once; later calls send one Bind/Execute/Sync batch and parse
  rows with parsers resolved at prepare time. A changed result shape or missing
  statement drops the entry. Shape-changing SQL clears the cache. The engine also
  drops composite row-type array parsers after connect.
- Git effects start their durability probe asynchronously, once per worktree
  root per effect batch, and wait for it after the rest of the batch without
  holding a worktree lock. Effects drain in batches of 20 without waiting for
  the next consumer tick, so they keep pace with publication: at the end of
  every soak, all effects are committed and none are queued.
- The projection-job queue is read job-first. Planner statistics refresh on an
  autovacuum-style threshold (50 + 10% of pages) instead of after every drained
  rebuild.
- The resident owner runs `VACUUM (ANALYZE)` on the queue tables every minute
  or after 50 + 20% of the request table's rows in publications. PGLite only.
- Statement trims: reentrant page guards within one PGLite transaction and its
  open savepoints; one-statement counter updates; the publication's final
  snapshot reused when queuing effects; the projection's guarded snapshot reused
  when sealing; exact-slug snapshot reads keep alias resolution in the SQL text,
  so a cached plan uses the slug index; completion wake-ups skip the root
  refresh and recovery/expiry/topology scans when they ran less than one poll
  interval ago; the managed-root registry skips its directory fsync when no
  record changed.

## Matched throughput, `standard-30`, 3 × 1,000 writes

| Engine | master (median, range) | candidate (median, range) | Caller p50 |
|---|---|---|---|
| PGLite | 8.97 (8.96–9.01) | 33.14 (33.04–34.17) | 1,713 → 421 ms |
| Postgres | 11.35 (11.33–11.60) | 13.86 (13.66–14.63) | 1,303 → 1,078 ms |

## Full default gate (1,000 schedules, 8 SIGKILL boundaries, 10,000-write soak)

| Engine | master soak | candidate soak | `full_gate` |
|---|---|---|---|
| PGLite | 7.06 writes/s, 1,417 s | 33.77 writes/s, 296 s | true / true |
| Postgres | 11.28 writes/s, 886 s | 17.22 writes/s, 581 s | true / true |

## Read latency (`scripts/persistence/performance.ts`, median of 3 runs)

The statement cache is engine-wide, so read paths were checked against master
on the same VM: 500 pages, 200 search queries, alone and under 4 concurrent
writers.

| Engine | master idle p50 / p95 | candidate idle p50 / p95 | master loaded p50 / p95 | candidate loaded p50 / p95 |
|---|---|---|---|---|
| PGLite | 11.6 / 19.3 ms | 8.2 / 16.6 ms | 12.5 / 17.3 ms | 8.9 / 16.0 ms |
| Postgres | 21.1 / 30.2 ms | 23.0 / 32.1 ms | 18.1 / 30.1 ms | 18.4 / 32.0 ms |

Both engines pass the workload's loaded-versus-idle gate. The Postgres
differences are within run-to-run noise; the Postgres engine's reads are not
changed by this work.

## Tried and rejected

- `plan_cache_mode = force_custom_plan`: this keeps parse savings but replans
  every call. PGLite fell from 30.6 to 20.1 writes/s. Generic plans are safe
  once PGLite's statistics exist; the one generic-plan trap on the hot path, the
  snapshot read's `$2::boolean` alias toggle, is now statement text.
- Collapsing `lockCounters` into two array statements, and merging
  `indexingContext`'s two page reads: tests inject faults on those exact SQL
  strings, and the gain was small, so both are unchanged.
- A consumer concurrency above 1 on PGLite: `tryAcquirePublicationCapacity`
  admits one embedded publication at a time by design, and the owner is
  CPU-bound on one event loop, so extra claims would only be released as
  `writer_pool_capacity`.
- PGLite start parameters: `-F` (fsync off inside WASM Postgres) is PGLite's
  default and unchanged. Neither `max_files_per_process` nor any other GUC
  raises the ~48-file descriptor cache.

## Follow-up: restore the 10,000-write soak on pull requests

[#5667](https://github.com/garrytan/gbrain/pull/5667) cut pull-request soaks to
2,500 writes while the PGLite soak ran about 11 writes/s. At 33.8 writes/s the
full 10,000-write PGLite soak takes 296 s on `standard-30`, and the whole
default gate takes 356 s. Postgres now takes 581 s for its soak. Proposal: run
the full default gate (10,000 writes) on pull requests again for both engines,
keeping #5667's timeout headroom, and drop the 2,500-write PR variant.
