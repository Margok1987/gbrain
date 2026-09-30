export interface SyncRun {
  readonly failedFiles: string[];
  bankedFiles: number;
  checkpointDead: boolean;
}
export function createSyncRun(): SyncRun {
  return { failedFiles: [], bankedFiles: 0, checkpointDead: false };
}
