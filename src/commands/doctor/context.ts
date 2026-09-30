/**
 * Explicit context for the doctor check entries (refactor wave 1, W4 doctor).
 *
 * `buildChecks` parses the argument vector once and resolves the skills dir
 * once; every entry reads those values from here instead of from closure
 * locals. Fields an entry writes for later entries are named explicitly.
 */

import type { BrainEngine } from '../../core/engine.ts';
import type { DbUrlSource } from '../../core/config.ts';
import type { createProgress } from '../../core/progress.ts';
import type { resolveSkillsDir } from '../check-resolvable.ts';

export interface DoctorContext {
  engine: BrainEngine | null;
  args: string[];
  dbSource?: DbUrlSource;
  connectError?: unknown;
  jsonOutput: boolean;
  fastMode: boolean;
  doFix: boolean;
  dryRun: boolean;
  scope: 'all' | 'brain';
  orphanRatioSourceId: string | undefined;
  progress: ReturnType<typeof createProgress>;
  /** `--skills-dir` / env / walk-up resolution; `source: 'none'` under `--scope=brain`. */
  skillsDirResolution: ReturnType<typeof resolveSkillsDir> | { dir: null; source: 'none' };
  skillsDir: string | null;
}

/**
 * The engine for entries that run after the DB-checks early stop, which ends
 * the run when there is no engine or `--fast` is set.
 */
export function connectedEngine(ctx: DoctorContext): BrainEngine {
  if (!ctx.engine) throw new Error('doctor: a DB check ran without an engine; it must be ordered after the DB-checks early stop');
  return ctx.engine;
}
