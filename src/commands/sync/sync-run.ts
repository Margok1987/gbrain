/**
 * `SyncRun`: the mutable state of one incremental sync run (refactor wave 1,
 * W4 sync, A17). It replaces the closure `let`s that `performSyncInner`'s
 * nested closures (checkpoint flush, import workers, stall watchdog, partial
 * exit) shared across awaits.
 *
 * Rule: a mutable field is read and written only as `run.<field>`. Copying one
 * into a local (destructuring or `const x = run.field`) snapshots a value that
 * another closure may change across the next await — the stale-state bug class
 * this object exists to remove. `scripts/check-sync-run-state.ts` enforces it
 * over `src/commands/sync/`.
 */
export interface SyncRun {
  /** Files flushed since the last checkpoint write (count cadence). */
  sinceFlush: number;
  /** Wall-clock ms of the last checkpoint flush (time cadence). */
  lastFlushAt: number;
  /** Consecutive failed checkpoint flushes; reaching the cap kills the checkpoint. */
  consecutiveFlushFailures: number;
  /** Paths durably banked to the checkpoint (resumed + this run). */
  bankedFiles: number;
  /** Single-flight guard for the checkpoint flush. */
  flushing: boolean;
  /** Checkpoint persistence gave up; the run must stop and report `checkpoint_unavailable`. */
  checkpointDead: boolean;
  /** Deregisters the SIGTERM checkpoint flush; a no-op until registered. */
  deregisterCheckpointCleanup: () => void;
  /** Imported files since the last event-loop yield. */
  sinceYield: number;
  /** Add/modify files persisted this run (partial `filesImported`). */
  filesImported: number;
  /** Chunks written this run. */
  chunksCreated: number;
  /** Pages the un-syncable-modified sweep soft-deleted this run. */
  swept: number;
  /** The stall watchdog fired (partial reason `stall_timeout`). */
  stallAborted: boolean;
}

/** A fresh run. Each field is assigned at its original declaration point before first use. */
export function createSyncRun(): SyncRun {
  return {
    sinceFlush: 0,
    lastFlushAt: 0,
    consecutiveFlushFailures: 0,
    bankedFiles: 0,
    flushing: false,
    checkpointDead: false,
    deregisterCheckpointCleanup: () => {},
    sinceYield: 0,
    filesImported: 0,
    chunksCreated: 0,
    swept: 0,
    stallAborted: false,
  };
}
