/**
 * #5984 lanes: one process's shared hold on a worktree's native lock.
 *
 * The native lock (`native-lock.ts`) is exclusive per open handle, so two
 * group publications of one worktree in the same process cannot both hold
 * it. Parallel sync lanes share one native lock through a counted lease:
 * the first lane takes the lock, later lanes join, and the last one to
 * leave releases it. Cross-process exclusion is unchanged.
 *
 * Every other worktree writer (file publications, effects, recovery,
 * refresh, transfer) keeps taking the lock exclusively through
 * `acquireWorktree`. When such a writer finds a live lease in this process,
 * it marks the lease draining and wounded: no lane joins it any more, lanes
 * waiting to commit roll back and release their claims, and the native lock
 * is released as soon as the running lanes finish, so the exclusive writer
 * gets it on its next attempt. A lease also drains (without wounding) after
 * `LEASE_TURN_MS` of continuous holding: lanes already claimed still join it,
 * but no new lane is claimed until it ends, so writers in other processes,
 * which cannot mark it, still get a turn.
 */
import type { NativeLockHandle } from './native-lock.ts';

/** A lease stops admitting lanes after this long, so other processes get the native lock between turns. */
export const LEASE_TURN_MS = 30_000;

interface Lease { lock: NativeLockHandle; holders: number; since: number; draining: boolean; wounded: boolean; ended: Promise<void>; end: () => void }
const leases = new Map<string, Lease>();

/** Whether lanes of this worktree should stop: an exclusive writer waits, or the lease used up its turn. */
export function leaseDraining(path: string): boolean {
  const lease = leases.get(path);
  if (!lease) return false;
  if (!lease.draining && Date.now() - lease.since >= LEASE_TURN_MS) lease.draining = true;
  return lease.draining;
}

/** Whether an exclusive writer in this process waits for the lease: lanes still waiting to commit roll back. */
export function leaseWounded(path: string): boolean {
  return leases.get(path)?.wounded === true;
}

/**
 * Joins this process's lease on `path`, or takes the native lock through
 * `acquire` when there is none. Null when the lock is busy elsewhere or an
 * exclusive writer waits for the lease; the caller releases its claim and retries later.
 */
export async function acquireShared(path: string, acquire: () => Promise<NativeLockHandle | null>): Promise<NativeLockHandle | null> {
  const live = leases.get(path);
  if (live) {
    // A used-up turn only stops new lane claims (sync-lanes.ts laneRoots); a wounded lease also refuses joins.
    if (live.lock.released || live.wounded) return null;
    live.holders++;
    return share(path, live);
  }
  const lock = await acquire();
  if (!lock) return null;
  // Another lane may have created the lease while this one waited for the lock.
  const raced = leases.get(path);
  if (raced) { await lock.release(); return acquireShared(path, acquire); }
  let end!: () => void;
  const ended = new Promise<void>(resolve => { end = resolve; });
  const lease: Lease = { lock, holders: 1, since: Date.now(), draining: false, wounded: false, ended, end };
  leases.set(path, lease);
  return share(path, lease);
}

function share(path: string, lease: Lease): NativeLockHandle {
  let released = false;
  return {
    get released() { return released || lease.lock.released; },
    async release() {
      if (released) return;
      released = true;
      if (--lease.holders > 0) return;
      leases.delete(path);
      try { await lease.lock.release(); } finally { lease.end(); }
    },
  };
}

/**
 * Called by an exclusive writer before it takes the native lock. Without a
 * lease in this process it returns at once. With one, it marks the lease
 * draining and waits up to `waitMs` for the lanes to finish; false means the
 * lease is still held and the writer should treat the worktree as busy.
 */
export async function yieldLease(path: string, waitMs: number, signal?: AbortSignal): Promise<boolean> {
  const lease = leases.get(path);
  if (!lease) return true;
  lease.draining = true;
  lease.wounded = true;
  if (waitMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), waitMs); });
  const aborted = new Promise<false>(resolve => signal?.addEventListener('abort', () => resolve(false), { once: true }));
  try { return await Promise.race([lease.ended.then(() => true as const), timeout, aborted]); }
  finally { clearTimeout(timer); }
}
