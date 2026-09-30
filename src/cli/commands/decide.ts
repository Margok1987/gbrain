/**
 * `gbrain decide`: pre-connect dispatch (opens its own engine), so `--help`
 * and every subcommand's help answer without a configured brain, and a plain
 * `decide probe` works with only a TypeSafe key. The record lives in
 * src/cli/command-table.ts (thinClient: 'refuse').
 */
import { finishCliTeardown, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const decide = await import('../../commands/decide.ts');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(decide.decideHelpText());
    return;
  }
  if (args[0] === 'probe' && !args.includes('--query')) {
    let eng: BrainEngine | null = null;
    const { loadConfig } = await import('../../core/config.ts');
    if (loadConfig()) {
      try { eng = await ctx.connectEngine(); } catch { /* key-only probe: no brain needed */ }
    }
    try {
      setCliExitVerdict(await decide.cmdProbe(eng, args.slice(1)));
    } finally {
      if (eng) await finishCliTeardown({ engine: eng });
    }
    return;
  }
  const eng = await ctx.connectEngine();
  try {
    setCliExitVerdict(await decide.runDecideCommand(eng, args));
  } finally {
    await finishCliTeardown({ engine: eng });
  }
}
