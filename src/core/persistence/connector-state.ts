/**
 * Per-source connector state row (#5686, #5600): one `op_checkpoints` row per
 * source incarnation (`op='managed-connector-state'`, fingerprint
 * `digest({sourceId, incarnation})`), independent of the identity digest so a
 * content-config change or a checkpoint reset never loses it. It holds the
 * resolved account pin, the pending receipts a run ended with, the upgrade
 * recovery disclosure and the last run's counts. The connector session writes
 * it only while it holds the connector sync lease; the upgrade migration seeds
 * `upgrade_recovery`. The 7-day checkpoint purge never touches it.
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from './digest.ts';

export const CONNECTOR_STATE_OP = 'managed-connector-state';

export type ConnectorAccount =
  | { kind: 'google'; email: string }
  | { kind: 'github'; installationId: number | null; login: string | null };

export interface ConnectorPendingEntry {
  /** The page slug, or `__managed_connector_checkpoint__` for a checkpoint save. */
  itemRef: string;
  requestId: string;
  /** The stable request identity the retry-pointer path keys on. */
  baseRequestId: string;
  admittedAt: string;
}

export interface ConnectorRunCounts {
  page_admissions: number;
  skipped_unchanged: number;
  pending: number;
  checkpoint_admissions: number;
  stopped_on_wait_budget: boolean;
  dropped_upstream: number;
  finished_at: string;
}

export type UpgradeRecovery = 'resumed' | 'rewalking_once' | 'none';

export interface ConnectorState {
  version: 1;
  account: ConnectorAccount | null;
  pinned_at: string | null;
  /** Earlier account continuity cannot be proven (a migrated source pinned on its first post-upgrade run). */
  continuity_unverified: boolean;
  pending: ConnectorPendingEntry[];
  upgrade_recovery: UpgradeRecovery;
  resumed_from: string | null;
  last_run: ConnectorRunCounts | null;
  /**
   * Fix wave 4 (DX O1, #5673): the first recorded sync attempt, written before
   * the first provider call of an explicit or scheduled sync (managed and
   * unmanaged), including one that later fails. Autopilot dispatches only
   * connector sources that have one; checkpoint-row existence never counts.
   */
  first_attempt_at?: string | null;
}

export const emptyConnectorState = (): ConnectorState => ({ version: 1, account: null, pinned_at: null, continuity_unverified: false,
  pending: [], upgrade_recovery: 'none', resumed_from: null, last_run: null });

export function connectorStateKey(sourceId: string, incarnation: string): string {
  return digest({ sourceId, incarnation });
}

export async function readManagedConnectorState(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, incarnation: string): Promise<ConnectorState> {
  const [row] = await engine.executeRaw<{ completed_keys: ConnectorState[] }>(
    'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [CONNECTOR_STATE_OP, connectorStateKey(sourceId, incarnation)]);
  const stored = row?.completed_keys?.[0];
  return stored?.version === 1 ? { ...emptyConnectorState(), ...stored } : emptyConnectorState();
}

/**
 * Upserts the state row. With `lease`, the write happens only while that
 * connector sync lease is still held (checked in the same statement) and
 * returns false otherwise; the upgrade migration seeds rows without a lease.
 */
export async function writeManagedConnectorState(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, incarnation: string, state: ConnectorState,
  lease?: { id: string; token: string; acquiredAt: string }): Promise<boolean> {
  // FOR SHARE holds the lease row for this statement: a concurrent takeover waits, and one already made fails the match.
  const rows = await engine.executeRaw<{ op: string }>(`WITH lease AS (SELECT id FROM gbrain_cycle_locks
      WHERE id=$4 AND acquisition_token=$5::uuid AND extract(epoch from acquired_at)::text=$6 AND ttl_expires_at>now() FOR SHARE)
    INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $1,$2,$3::text::jsonb WHERE $4::text IS NULL OR EXISTS (SELECT 1 FROM lease)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now() RETURNING op`,
  [CONNECTOR_STATE_OP, connectorStateKey(sourceId, incarnation), JSON.stringify([state]), lease?.id ?? null, lease?.token ?? null, lease?.acquiredAt ?? null]);
  return rows.length > 0;
}

/**
 * Records the source's first sync attempt once (idempotent). Called before any
 * provider call, on managed brains while the connector sync lease is held.
 */
export async function recordConnectorSyncAttempt(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, at = new Date().toISOString()): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) return;
  const state = await readManagedConnectorState(engine, sourceId, source.incarnation);
  if (state.first_attempt_at) return;
  await writeManagedConnectorState(engine, sourceId, source.incarnation, { ...state, first_attempt_at: at });
}

/**
 * v181 (fix wave 4): records an attempt for every connector source the
 * pre-upgrade freshness loop dispatched (non-null local_path and not
 * `syncEnabled=false`), so the new gate idles no source autopilot synced.
 */
export async function seedConnectorDispatchAttempts(engine: Pick<BrainEngine, 'executeRaw'>): Promise<number> {
  const rows = await engine.executeRaw<{ id: string; config: unknown }>(`SELECT id,config FROM sources
    WHERE config->>'kind' IN ('google','github') AND local_path IS NOT NULL`);
  let seeded = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    // Same predicate as isSyncDisabledConfig (sync-policy.ts), inlined so the schema-migration closure stays small.
    const config = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as { syncEnabled?: unknown } | null;
    if (config?.syncEnabled === false) continue;
    await recordConnectorSyncAttempt(engine, row.id, at);
    seeded++;
  }
  return seeded;
}

/** Connector source ids (google, github) with a recorded sync attempt: the autopilot dispatch gate. */
export async function attemptedConnectorSourceIds(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ id: string; incarnation: string }>(
    "SELECT id,incarnation::text AS incarnation FROM sources WHERE config->>'kind' IN ('google','github')");
  const attempted = new Set<string>();
  for (const row of rows) if ((await readManagedConnectorState(engine, row.id, row.incarnation)).first_attempt_at) attempted.add(row.id);
  return attempted;
}

/** Account pins compare the resolved identity only; the recorded display never includes credentials. */
export function sameConnectorAccount(a: ConnectorAccount, b: ConnectorAccount): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'google') return a.email === (b as typeof a).email;
  const other = b as typeof a;
  return (a.installationId ?? null) === (other.installationId ?? null) && (a.login ?? null)?.toLowerCase() === (other.login ?? null)?.toLowerCase();
}

export function describeConnectorAccount(account: ConnectorAccount): string {
  if (account.kind === 'google') return account.email;
  return [account.installationId !== null ? `installation ${account.installationId}` : null, account.login ? `login ${account.login}` : null]
    .filter(Boolean).join(', ') || 'no installation or login';
}
