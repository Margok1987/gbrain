/**
 * Database reachability: the PGLite data-dir diagnosis and scratch-store probe that run when the connect failed.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { loadConfig, gbrainPath } from '../../../core/config.ts';
import { startHeartbeat } from '../../../core/progress.ts';
import { checkPgliteScratchProbe } from './core-health.ts';
import { computePgliteDataDirCheck } from './pglite-worker.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext } from '../context.ts';

export async function runPgliteDataDir(ctx: DoctorContext): Promise<Check[]> {
  const { args, engine, fastMode, progress } = ctx;
  const checks: Check[] = [];

  // 3d. PGLite data-dir diagnosis (WAL-repair wave) + scratch-store probe
  // (#2674). The data-dir check re-derives the failure state from DISK (the
  // connect error was swallowed by the fs-only fallback); the probe adds the
  // RUNTIME dimension (a throwaway store that opens fine proves the WASM
  // runtime is healthy). Both only fire when the connect already FAILED on a
  // PGLite brain (engine === null, not --fast — under --fast connect wasn't
  // attempted, so "engine === null" proves nothing there).
  //
  // Probe cost gate (a PGLite cold start is 5–20s): auto-runs ONLY when init
  // failed AND the disk diagnosis didn't already fully explain it — a live
  // lock or a missing dir needs no runtime probe (and 'locked' was exactly
  // the reviewed false-positive: blaming the store while `gbrain serve` held
  // it). Explicit --probe-pglite always runs it. A routine healthy
  // `gbrain doctor` never pays it.
  {
    const probeRequested = args.includes('--probe-pglite');
    let cfgForProbe: ReturnType<typeof loadConfig> = null;
    try { cfgForProbe = loadConfig(); } catch { /* no config — nothing to diagnose */ }
    const pgliteInitFailed = !engine && !fastMode && cfgForProbe?.engine === 'pglite';

    let dirVerdict: import('../../../core/pglite-repair.ts').PgliteDirDiagnosis['verdict'] | undefined;
    if (pgliteInitFailed) {
      try {
        const { inspectPgliteDataDir } = await import('../../../core/pglite-repair.ts');
        const { resolve } = await import('node:path');
        // Absolutize: a RELATIVE database_path would make the sidecar/backup
        // lookups resolve against doctor's cwd instead of the engine's.
        const pgliteDataDir = resolve(cfgForProbe!.database_path || gbrainPath('brain.pglite'));
        const diagnosis = inspectPgliteDataDir(pgliteDataDir);
        dirVerdict = diagnosis.verdict;
        checks.push(computePgliteDataDirCheck(pgliteDataDir, diagnosis));
      } catch {
        // Best-effort: an unreadable config or fs failure must not stop doctor.
      }
    }

    const dirExplainsFailure = dirVerdict === 'locked' || dirVerdict === 'missing';
    if (probeRequested || (pgliteInitFailed && !dirExplainsFailure)) {
      progress.start('doctor.pglite_probe');
      const stopHb = startHeartbeat(progress, 'pglite scratch-store probe (cold start, can take 5–20s)…');
      try {
        checks.push(
          await checkPgliteScratchProbe({
            // A lock/missing dir explains the failure without the store being
            // damaged — an explicit --probe-pglite there still reports on the
            // runtime, but must not treat the store as the convicted party.
            realInitFailed: pgliteInitFailed && !dirExplainsFailure,
            storeDamageEvidence:
              dirVerdict === 'wal-corruption-likely' || dirVerdict === 'unsupported-layout',
            realStorePath: cfgForProbe?.database_path,
          }),
        );
      } finally {
        stopHb();
        progress.finish();
      }
    }
  }
  return checks;
}
