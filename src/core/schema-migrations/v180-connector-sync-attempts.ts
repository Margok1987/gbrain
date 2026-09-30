import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { isConnectorSourceKind } from '../persistence/connector-identity.ts';
import { recordConnectorSyncAttempt } from '../persistence/connector-state.ts';
import { isSyncDisabledConfig } from '../sync-policy.ts';

/**
 * #5673: autopilot now dispatches a connector source only after a recorded
 * sync attempt. Record one for every connector source the pre-upgrade
 * freshness loop dispatched (a non-null local_path and not syncEnabled=false),
 * so no connector autopilot syncs today goes idle. Rerun-safe: an existing
 * stamp is kept.
 */
export async function recordPreUpgradeConnectorAttempts(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<{ id: string; config: unknown }>(
    'SELECT id, config FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id');
  for (const row of rows) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config ?? {};
    if (isConnectorSourceKind((config as { kind?: unknown }).kind) && !isSyncDisabledConfig(config)) await recordConnectorSyncAttempt(engine, row.id);
  }
}

export const v180: Migration = {
  version: 180,
  name: 'connector_sync_attempts',
  idempotent: true,
  sql: '',
  handler: recordPreUpgradeConnectorAttempts,
};
