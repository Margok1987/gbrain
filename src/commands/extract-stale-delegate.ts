import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError } from '../core/ops/contract.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';
import { formatManagedStaleExtraction, runManagedStaleExtraction, type ManagedLinkExtraction } from '../core/persistence/links-maintenance.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import type { BrainEngine } from '../core/engine.ts';

const render = (result: ManagedLinkExtraction, dryRun: boolean, json: boolean) =>
  json ? JSON.stringify({ action: dryRun ? 'extract_stale_dry_run' : 'extract_stale', ...result }) : formatManagedStaleExtraction(result, dryRun);

/** Managed brains guard canonical rows; `extract --stale` derives links and watermarks on the coordinator-safe path. */
export async function runManagedExtractStale(engine: BrainEngine, args: string[], sourceId: string | undefined): Promise<boolean> {
  if (!await managedPersistenceEnabled(engine)) return false;
  const dryRun = args.includes('--dry-run');
  console.log(render(await runManagedStaleExtraction(engine, { sourceId, dryRun }), dryRun, args.includes('--json')));
  return true;
}

/** A live PGLite owner holds the database; `extract --stale` runs inside it instead of failing on the lock. */
export async function maybeDelegateExtractStale(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  const json = args.includes('--json');
  try {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--dry-run') params.dry_run = true;
      else if (arg === '--source-id') {
        const value = args[++i];
        if (!value || value.startsWith('-')) throw new OperationError('invalid_params', '--source-id requires a value.');
        params.source_id = value;
      } else if (arg === '--source') {
        if (args[++i] !== 'db') throw new OperationError('invalid_params', "extract --stale is DB-source only; drop '--source fs'.");
      } else if (!['--stale', '--json', '--include-frontmatter', '--catch-up', 'all'].includes(arg)) {
        throw new OperationError('invalid_params', `Unsupported owner-delegated extract --stale option: ${arg}.`);
      }
    }
    const delegated = await maybeDelegateLocalAdministration('writer_extract_stale', params, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) throw new OperationError('owner_unavailable', 'The registered owner stopped before extraction. Retry the same command.');
    const result = delegated.result as ManagedLinkExtraction;
    const dryRun = params.dry_run === true;
    await writeStdoutFinal(render(result, dryRun, json) + '\n');
    return true;
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return true;
    throw error;
  }
}
