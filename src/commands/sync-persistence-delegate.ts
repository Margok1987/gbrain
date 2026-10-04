import { resolve } from 'node:path';
import type { GBrainConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { resolveSourceIdEngineFree } from '../core/source-resolver.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError } from '../core/ops/contract.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { SYNC_BOOLEAN_FLAGS, SYNC_VALUE_FLAGS, validateSyncWireParams } from '../core/persistence/sync-wire.ts';
import { deriveDelegatedTimeoutSeconds } from './sync-delegate.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import type { SyncResult } from './sync.ts';
import { buildSingleSyncJsonEnvelope } from '../core/sync-embed-backfill.ts';
import { printManagedSyncDiagnostic } from './sync-diagnostics.ts';
import { parseDurationSeconds } from '../core/sync-concurrency.ts';
import { runDrain, drainJsonFields, formatDrainSummary, syncOutcome } from '../core/persistence/sync-drain.ts';
import { syncResumeCommand } from '../core/sync-reconcile.ts';

export async function parsePersistenceSyncArgs(args:string[],cwd=process.cwd()) {
  const options:Record<string,unknown>={};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    const boolean=SYNC_BOOLEAN_FLAGS[arg as keyof typeof SYNC_BOOLEAN_FLAGS];
    if(boolean){options[boolean]=true;continue;}
    if(['--json','--yes','--no-hard-deadline'].includes(arg))continue;
    if(['--timeout','--hard-deadline'].includes(arg)){if(!args[++i]||args[i].startsWith('--'))throw new OperationError('invalid_params',`${arg} requires a value.`);continue;}
    const key=SYNC_VALUE_FLAGS[arg as keyof typeof SYNC_VALUE_FLAGS];
    if(!key)throw new OperationError('invalid_params',`Unsupported owner-delegated sync option: ${arg}.`);
    const value=args[++i];if(!value||value.startsWith('--'))throw new OperationError('invalid_params',`${arg} requires a value.`);
    if(key==='exclude'||key==='includeHidden')options[key]=[...(options[key] as string[]??[]),value];
    else options[key]=key==='repoPath'?resolve(cwd,value):value;
  }
  const source=resolveSourceIdEngineFree(typeof options.sourceId==='string'?options.sourceId:null,cwd);
  if(source==='__all__')throw new OperationError('invalid_params','Owner-delegated sync requires one explicit source.');
  if(source)options.sourceId=source;
  const softTimeout=parseDurationSeconds(args.find((_,i)=>args[i-1]==='--timeout'),'--timeout');
  const hardTimeout=await deriveDelegatedTimeoutSeconds(args);
  const timeoutSeconds=softTimeout && softTimeout>0 ? hardTimeout>0 ? Math.min(softTimeout,hardTimeout) : softTimeout : hardTimeout;
  return validateSyncWireParams({options,cwd,timeoutSeconds});
}
/** Any resident native owner may proxy; its durable registration, not a process label, authorizes work. */
export async function maybeDelegateSyncToPersistence(hostConfig:GBrainConfig|null,args:string[]):Promise<boolean> {
  if(args.includes('--no-delegate')||process.env.GBRAIN_SYNC_NO_DELEGATE==='1')return false;
  const brainId=resolveBrainId(getCliOptions().brain,process.cwd());
  const config=persistenceConfigForBrain(hostConfig,brainId,brainId==='host'?[]:loadMounts());
  if(config?.engine!=='pglite'||!config.database_path||config.database_url||!inspectLockHolder(config.database_path).held)return false;
  try {
    const params=await parsePersistenceSyncArgs(args);
    const deadline=params.timeoutSeconds>0?performance.now()+params.timeoutSeconds*1000:Infinity;
    const stop=new AbortController();
    const timer=Number.isFinite(deadline)?setTimeout(()=>stop.abort(),deadline-performance.now()):undefined;
    console.error('[sync] Delegating to the registered PGLite owner.');
    // #5984: the owner returns one bounded slice per call; the shared drain owns re-entry and the stop rules.
    let result:SyncResult&{source_id?:string};
    try {
      result=await runDrain({signal:stop.signal,announce:true,pass:async()=>{
        const delegated=await maybeDelegateLocalAdministration('writer_sync',{...params,timeoutSeconds:Number.isFinite(deadline)?Math.max(1,Math.ceil((deadline-performance.now())/1000)):params.timeoutSeconds} as unknown as Record<string,unknown>,config,
          {timeoutMs:Math.min(86_400_000,Math.max(30_000,deadline-performance.now()+30_000))});
        if(!delegated.handled)throw new OperationError('owner_unavailable','The observed PGLite owner stopped before sync admission.','Retry the same sync options to resume its durable cursor.');
        return delegated.result as SyncResult;
      }});
    } finally { if(timer)clearTimeout(timer); }
    const sourceId=result.source_id??params.options.sourceId??'default';
    const resume=syncResumeCommand(args,getCliOptions().brain);
    if(args.includes('--json')) {
      await writeStdoutFinal(JSON.stringify({ ...buildSingleSyncJsonEnvelope(sourceId,result),
        ...(result.managedWrite ? { managed_write: result.managedWrite } : {}), ...drainJsonFields(result,resume,sourceId) })+'\n');
      printManagedSyncDiagnostic(result, process.stderr);
      for(const line of formatDrainSummary(result,resume,sourceId))process.stderr.write(line+'\n');
    }
    else {
      (await import('./sync.ts')).printSyncResult(result);
      for(const line of formatDrainSummary(result,resume,sourceId))process.stdout.write(line+'\n');
      if(!params.options.dryRun&&!params.options.noEmbed&&result.added+result.modified>0) {
        console.error('[sync] embeds deferred — the owner drains them using its configured provider and keys.');
      }
    }
    if(syncOutcome(result)==='blocked')setCliExitVerdict(1);
    return true;
  }catch(error){
    if(error instanceof PersistenceIpcTransportError&&error.sent)error=new OperationError('write_pending','The sync acknowledgment was lost; accepted page requests retain their IDs.','Repeat the same sync options to resume the durable cursor.');
    if(await reportPersistenceCliError(error,args.includes('--json')))return true;
    throw error;
  }
}
