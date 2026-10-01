/**
 * v0.60.27 migration — security fix wave. Google pages, cursor state and
 * created directories are now written 0600/0700; this orchestrator prints the
 * one-time notice for Google sources outside `~/.gbrain`, whose older files
 * keep their old permissions until `gbrain repair google-file-modes` (opt-in)
 * or a rewrite tightens them. No data or permission changes.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult } from './types.ts';
import { googleFileModesNoticePhase } from './v0_60_27-google-file-modes.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  let engine: BrainEngine | null = testEngineOverride;
  let owned = false;
  if (!engine && !opts.dryRun) {
    try {
      const cfg = loadConfig();
      if (cfg) {
        const engineConfig = toEngineConfig(cfg);
        engine = await createEngine(engineConfig);
        await engine.connect(engineConfig);
        owned = true;
      }
    } catch {
      engine = null;
    }
  }
  try {
    const phase = await googleFileModesNoticePhase(engine, { dryRun: opts.dryRun });
    return { version: '0.60.27', status: phase.status === 'failed' ? 'partial' : 'complete', phases: [phase] };
  } catch (error) {
    return { version: '0.60.27', status: 'partial',
      phases: [{ name: 'google_file_modes_notice', status: 'failed', detail: error instanceof Error ? error.message : String(error) }] };
  } finally {
    if (owned) await engine?.disconnect();
  }
}

export const v0_60_27: Migration = {
  version: '0.60.27',
  featurePitch: {
    headline: 'Google connector files are now written private (0600 files, 0700 directories).',
    description: 'Files written before this version under a Google source directory outside ~/.gbrain keep their old permissions. '
      + 'gbrain doctor lists them; preview the opt-in fix with gbrain repair google-file-modes and apply it with --apply.',
  },
  orchestrator,
};
