/**
 * Per-source connector state row (#5686, #5600): one `op_checkpoints` row per
 * source incarnation (`op='managed-connector-state'`, fingerprint
 * `digest({sourceId, incarnation})`), independent of the identity digest so a
 * content-config change or a checkpoint reset never loses it. It holds the
 * resolved account pin, the pending receipts a run ended with, the upgrade
 * recovery disclosure and the last run's counts. The connector session writes
 * it only while it holds the connector sync lease; the upgrade migration seeds
 * `upgrade_recovery`. The 7-day checkpoint purge never touches it.
 *
 * `first_attempt_at` (#5673) is the autopilot dispatch gate: it is stamped
 * once, before the first provider call of an explicit or scheduled sync of a
 * managed or unmanaged connector source, even when that run later fails.
 * `idle_notice_at` records that autopilot printed the enable command for a
 * connector that was never attempted.
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from './digest.ts';
import { isConnectorSourceKind } from './connector-identity.ts';

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
  first_attempt_at: string | null;
  idle_notice_at: string | null;
}

export const emptyConnectorState = (): ConnectorState => ({ version: 1, account: null, pinned_at: null, continuity_unverified: false,
  pending: [], upgrade_recovery: 'none', resumed_from: null, last_run: null, first_attempt_at: null, idle_notice_at: null });

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
 * Stamp a one-time field on the source's current-incarnation state row; an
 * already stamped field is kept. Returns false when the source does not exist.
 */
async function stampConnectorState(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, field: 'first_attempt_at' | 'idle_notice_at'): Promise<boolean> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) return false;
  const now = new Date().toISOString();
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_set(op_checkpoints.completed_keys, ARRAY['0',$4::text], to_jsonb($5::text), true), updated_at=now()
    WHERE op_checkpoints.completed_keys->0->>$4::text IS NULL`,
  [CONNECTOR_STATE_OP, connectorStateKey(sourceId, source.incarnation), JSON.stringify([{ ...emptyConnectorState(), [field]: now }]), field, now]);
  return true;
}

/** #5673: record that a connector sync is about to call its provider. Call before the managed session loads its state. */
export function recordConnectorSyncAttempt(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  return stampConnectorState(engine, sourceId, 'first_attempt_at');
}

export function recordConnectorIdleNotice(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  return stampConnectorState(engine, sourceId, 'idle_notice_at');
}

export interface ConnectorDispatchState { attempted: boolean; noticed: boolean }

/** The dispatch gate for every connector source (google, github), keyed by source id. */
export async function readConnectorDispatchStates(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Map<string, ConnectorDispatchState>> {
  const sources = (await engine.executeRaw<{ id: string; incarnation: string; kind: string | null }>(
    "SELECT id, incarnation, config->>'kind' AS kind FROM sources")).filter(source => isConnectorSourceKind(source.kind));
  const keys = new Map(sources.map(source => [connectorStateKey(source.id, source.incarnation), source.id]));
  const rows = keys.size ? await engine.executeRaw<{ fingerprint: string; attempted: string | null; noticed: string | null }>(
    `SELECT fingerprint, completed_keys->0->>'first_attempt_at' AS attempted, completed_keys->0->>'idle_notice_at' AS noticed
       FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])`, [CONNECTOR_STATE_OP, [...keys.keys()]]) : [];
  const states = new Map(sources.map(source => [source.id, { attempted: false, noticed: false }]));
  for (const row of rows) states.set(keys.get(row.fingerprint)!, { attempted: row.attempted !== null, noticed: row.noticed !== null });
  return states;
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
