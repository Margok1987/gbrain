import type { SyncRun } from './sync-run.ts';
export async function phase(run: SyncRun): Promise<number> {
  const { failedFiles } = run; // readonly reference: allowed
  await Promise.resolve();
  if (run.checkpointDead) return failedFiles.length;
  run.bankedFiles += 1;
  return run.bankedFiles;
}
