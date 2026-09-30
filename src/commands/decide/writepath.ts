/**
 * Write-path slot lanes (S7 triage, S8 grounding, S9 conflict): registers
 * their `gbrain decide` subcommands, what-if reducers and dataset adapters.
 * Loaded by `loadDecideLanes()` before any decide subcommand or help runs.
 */
import { registerDecideSubcommand } from '../decide.ts';
import { registerConflictDatasets } from '../../core/ai/decide/datasets-conflict.ts';

// --- S9 conflict: sweep + proposals (lazy: help stays cheap), dataset adapter + facts-fixtures builder ---
registerConflictDatasets();
registerDecideSubcommand('sweep', async (engine, args) => (await import('./proposals.ts')).runSweepCommand(engine, args),
  'sweep --slot conflict [--since <fact id>] [--source <id>] [--json]   Run the contradiction sweep now (proposals only)');
registerDecideSubcommand('proposals', async (engine, args) => (await import('./proposals.ts')).runProposalsCommand(engine, args),
  'proposals list [--status pending|accepted|rejected|stale|undone|all] [--json] | accept <id>|--all-from <sweep id> | reject <id>|--all-from <sweep id> | undo <id>   Review contradiction proposals');
// --- end S9 ---
