/**
 * The whole orchestrator chain on a managed PGLite brain (slow tier; the
 * Postgres run is test/e2e/managed-migration-chain-postgres.test.ts).
 *
 * Protects: every registered orchestrator migration (the full `migrations`
 * array, v0.11.0 through shared-content, so a later migration is included
 * automatically) completes under the real `gbrain apply-migrations` runner
 * on a brain that was claimed and activated before any of them ran, with
 * legacy content each data phase has to move, and a rerun changes nothing.
 * Fails when: a migration writes canonical tables outside the coordinator
 * (writer_coordinator_required, a `partial` then `wedged` ledger entry), a
 * data phase silently does nothing, or adoption duplicates or loses rows.
 */
import { expect, test } from 'bun:test';
import { runManagedMigrationChain } from './helpers/managed-migration-chain-contract.ts';

test('pglite: the managed migration chain completes from v0.11.0 and a rerun is idempotent', async () => {
  await runManagedMigrationChain(undefined, expect);
}, 900_000);
