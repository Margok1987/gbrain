/**
 * Engine-parametrized recovery-layer scenarios (fix wave 3, Lane D): remote
 * host-action lines, the remediation plan's repair steps, consent, the
 * scripted recovery run with finding classes and exit status, the cumulative
 * budget and the resume contract. test/ runs them on PGLite; test/e2e/ runs
 * the same bodies on Postgres.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { doctorReportRemote } from '../../src/commands/doctor.ts';
import { runRemediate, runRemediationPlan } from '../../src/commands/doctor/remediate.ts';
import { REMOTE_HOST_ACTION, remoteWaveHandoff } from '../../src/commands/doctor/wave-checks.ts';
import { currentExitCode, setCliExitVerdict } from '../../src/core/cli-force-exit.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { listRemediationCheckpoints, loadRemediationCheckpoint, saveRemediationCheckpoint } from '../../src/core/remediation-checkpoint.ts';
import { runRemediation } from '../../src/core/remediation/run.ts';
import { managedBrain } from './managed-brain.ts';
import { put, waveBrain } from './wave-fixture.ts';

/** Run a CLI shell function, capturing stdout/stderr lines and the exit verdict. */
export async function capture(run: () => Promise<void>): Promise<{ out: string; err: string; exit: number }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')); };
  console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ')); };
  setCliExitVerdict(0);
  try { await run(); } finally { console.log = log; console.error = error; }
  const exit = currentExitCode();
  setCliExitVerdict(0);
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

const json = async (engine: BrainEngine, args: string[], fn = runRemediate) => {
  const result = await capture(() => fn(engine, args));
  return { ...result, body: JSON.parse(result.out) };
};

export async function remoteLinesForWaveFindings(databaseUrl?: string) {
  await waveBrain(async ({ engine, root, corpus }) => {
    const report = await doctorReportRemote(engine, { remote: true });
    for (const id of ['timeline_history', 'derived_visibility', 'persistence_capacity', 'parked_effects']) {
      const line = report.checks.filter(c => c.name === id);
      expect(line).toHaveLength(1);
      expect(line[0]).toMatchObject({ status: 'warn', details: { host_action: { check_id: id, state: 'action_required', preview_command: 'gbrain doctor --remediation-plan' } } });
      expect(line[0]!.message).toContain(REMOTE_HOST_ACTION);
      const text = JSON.stringify(line[0]);
      for (const secret of [root, corpus, 'notes/history', 'atoms/unstamped', 'notes/base', 'principal:', 'SELECT', 'persistence_counters', 'persistence_effects', '1000', '850', 'git_target_unsafe']) expect(text).not.toContain(secret);
    }
  }, { databaseUrl, kinds: ['timeline', 'visibility', 'capacity', 'parked'] });

  await managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'notes/clean', 'Nothing to repair.');
    const report = await doctorReportRemote(engine, { remote: true });
    expect(report.checks.filter(c => c.message.includes('host operator action required'))).toEqual([]);
    for (const id of ['timeline_history', 'derived_visibility', 'persistence_capacity', 'parked_effects']) {
      expect(report.checks.find(c => c.name === id)).toMatchObject({ status: 'ok', details: { host_action: { state: 'ok' } } });
    }
    // A check that cannot run reports unknown, never ok.
    const broken = new Proxy(engine, { get(target, prop, receiver) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => /persistence_counters/.test(sql)
        ? Promise.reject(new Error('relation unavailable')) : target.executeRaw(sql, params as never);
      return Reflect.get(target, prop, receiver);
    } }) as BrainEngine;
    const lines = await remoteWaveHandoff(broken);
    const capacity = lines.find(c => c.name === 'persistence_capacity')!;
    expect(capacity).toMatchObject({ status: 'warn', details: { host_action: { state: 'unknown' } } });
    expect(capacity.message).toStartWith('Unknown:');
    expect(capacity.message).not.toContain('relation unavailable');
  }, { databaseUrl });
}

export async function planListsRepairStepsIndependentOfTarget(databaseUrl?: string) {
  await waveBrain(async ({ engine }) => {
    const { body } = await json(engine, ['--remediation-plan', '--json', '--target-score', '100'], runRemediationPlan);
    expect(body.repair_steps.map((s: { kind: string }) => s.kind)).toEqual(['timeline', 'visibility', 'safe-chunks']);
    for (const step of body.repair_steps) {
      expect(step).toMatchObject({ requires_user_agreement: true, protected: true, command: `gbrain repair ${step.kind} --apply` });
      expect(step.affected).toBeGreaterThan(0);
    }
    expect(body.combined_command).toStartWith('gbrain doctor --remediate --yes --include-repairs --max-usd ');
    for (const step of body.plan) expect(step.command).toStartWith(`gbrain jobs submit ${step.job}`);
    const human = await capture(() => runRemediationPlan(engine, ['--remediation-plan']));
    expect(human.out).toContain('requires user agreement');
    expect(human.out).toContain('apply: gbrain repair timeline --apply');
    expect(human.out).toContain('gbrain doctor --remediate --yes --include-repairs --max-usd');
    expect(human.out).not.toContain('Brain is at target');
  }, { databaseUrl, kinds: ['timeline', 'visibility', 'safe_index'] });
}

export async function remediateWithoutConsentSkipsRepairs(databaseUrl?: string) {
  await waveBrain(async ({ engine }) => {
    const timelineBefore = await engine.executeRaw("SELECT timeline FROM pages WHERE slug='notes/history'");
    const { body, exit } = await json(engine, ['--remediate', '--yes', '--json']);
    expect(body.repairs_skipped.map((s: { kind: string }) => s.kind)).toEqual(['timeline', 'visibility', 'safe-chunks']);
    expect(body.repairs).toEqual([]);
    const classes = Object.fromEntries(body.findings.map((f: { check_id: string; class: string }) => [f.check_id, f.class]));
    expect(classes).toMatchObject({ timeline_history: 'consent_required', derived_visibility: 'consent_required', safe_index_pending: 'consent_required' });
    expect(exit).toBe(1);
    expect(await engine.executeRaw("SELECT timeline FROM pages WHERE slug='notes/history'")).toEqual(timelineBefore);
    const human = await capture(() => runRemediate(engine, ['--remediate', '--yes']));
    expect(human.out).toContain('3 repair steps skipped (user agreement required): re-run with --include-repairs');
    expect(human.out).toContain('gbrain repair safe-chunks --apply');
  }, { databaseUrl, kinds: ['timeline', 'visibility', 'safe_index'] });
}

/** CEO Lane D test (5) + DX recovery measurement: every finding class, exit status, commands and wall time. */
export async function scriptedRecoveryRun(databaseUrl?: string): Promise<{ wall_ms: number; operator_commands: number }> {
  let measured = { wall_ms: 0, operator_commands: 0 };
  await waveBrain(async ({ engine }) => {
    const started = Date.now();
    const commands: string[] = [];
    const plan = await json(engine, ['--remediation-plan', '--json'], runRemediationPlan);
    commands.push('gbrain doctor --remediation-plan');
    expect(plan.body.repair_steps.length).toBe(3);
    const run = await json(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json']);
    commands.push('gbrain doctor --remediate --yes --include-repairs --no-embed --max-usd 0');
    const byId = Object.fromEntries(run.body.findings.map((f: { check_id: string }) => [f.check_id, f]));
    for (const id of ['timeline_history', 'derived_visibility', 'safe_index_pending']) expect(byId[id]).toMatchObject({ class: 'cleared' });
    expect(byId.persistence_capacity).toMatchObject({ class: 'operator_required' });
    expect(byId.parked_effects).toMatchObject({ class: 'operator_required' });
    expect(byId.self_capture).toMatchObject({ class: 'operator_required' });
    expect(byId.self_capture.instruction).toContain('Quarantine');
    expect(byId.stale_embedding_effects).toMatchObject({ class: 'unsupported' });
    expect(byId.stale_embedding_effects.message).toContain('inspection cannot clear it');
    expect(run.body.repairs_completed).toBe(3);
    expect(run.body.healthy).toBe(false);
    expect(run.body.exit_status).toBe(0);
    expect(run.exit).toBe(0);
    const verify = await json(engine, ['--remediation-plan', '--json'], runRemediationPlan);
    commands.push('gbrain doctor --remediation-plan');
    expect(verify.body.repair_steps).toEqual([]);
    measured = { wall_ms: Date.now() - started, operator_commands: commands.length };
    expect(measured.operator_commands).toBeLessThanOrEqual(3);
    expect(measured.wall_ms).toBeLessThan(5 * 60_000);
  }, { databaseUrl });
  return measured;
}

/**
 * A zero cap refuses the paid step before it starts, still applies the free
 * steps, saves a checkpoint with brain, cap, consent and manifest, and a
 * copied resume command (or a bare --resume) keeps them; another brain's
 * checkpoint is refused.
 */
export async function budgetAndResumeContract(databaseUrl?: string) {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
  try {
    await waveBrain(async ({ engine }) => {
      const first = await json(engine, ['--remediate', '--yes', '--include-repairs', '--max-usd', '0', '--json']);
      const byKind = Object.fromEntries(first.body.repairs.map((r: { kind: string }) => [r.kind, r]));
      expect(byKind.timeline).toMatchObject({ status: 'completed', applied: 1 });
      expect(byKind.visibility).toMatchObject({ status: 'completed', applied: 1 });
      expect(byKind['safe-chunks']).toMatchObject({ status: 'budget_refused' });
      expect(first.body.budget_exhausted).toMatchObject({ cap: 0, reason: 'max_usd' });
      expect(first.exit).toBe(1);
      expect(first.err).toContain(`gbrain doctor --remediate --yes --include-repairs --max-usd 0 --resume ${first.body.budget_exhausted.plan_hash}`);
      const unsealed = await engine.executeRaw<{ chunker_version: number }>("SELECT chunker_version FROM pages WHERE slug='notes/unsealed'");
      expect(unsealed[0]!.chunker_version).toBe(3);

      const cp = loadRemediationCheckpoint(first.body.budget_exhausted.plan_hash)!;
      expect(cp).toMatchObject({ max_usd: 0, include_repairs: true, manifest: { repair_kinds: ['timeline', 'visibility', 'safe-chunks'] } });
      expect(cp.completed.map(c => c.id).sort()).toEqual(['repair:timeline', 'repair:visibility']);

      // Resume without --max-usd reuses the recorded cap and consent (no --include-repairs given).
      const again = await json(engine, ['--remediate', '--yes', '--resume', '--json']);
      expect(again.err).toContain('cumulative cap $0.00');
      expect(again.body.budget).toMatchObject({ max_usd: 0, include_repairs: true });
      expect(again.body.repairs).toEqual([expect.objectContaining({ kind: 'safe-chunks', status: 'budget_refused' })]);

      // The copied resume command with a raised cap finishes the paid step.
      const raised = await json(engine, ['--remediate', '--yes', '--include-repairs', '--max-usd', '5', '--resume', first.body.budget_exhausted.plan_hash, '--json']);
      expect(raised.body.repairs).toEqual([expect.objectContaining({ kind: 'safe-chunks', status: 'completed' })]);
      expect(raised.body.budget_exhausted).toBeUndefined();
      const resealed = await engine.executeRaw<{ chunker_version: number }>("SELECT chunker_version FROM pages WHERE slug='notes/unsealed'");
      expect(resealed[0]!.chunker_version).toBeGreaterThanOrEqual(4);
      expect(listRemediationCheckpoints().map(e => e.plan_hash)).not.toContain(first.body.budget_exhausted.plan_hash);

      // A checkpoint recorded for another brain is refused, never silently resumed.
      saveRemediationCheckpoint({ ...cp, plan_hash: 'otherbrain000001', brain_id: '00000000-0000-4000-8000-000000000000' });
      const foreign = await json(engine, ['--remediate', '--yes', '--resume', 'otherbrain000001', '--json']);
      expect(foreign.body.resume_refused).toMatchObject({ reason: 'brain_mismatch', plan_hash: 'otherbrain000001' });
      expect(foreign.exit).toBe(2);
      expect(foreign.err).toContain('belongs to brain 00000000-0000-4000-8000-000000000000');
    }, { databaseUrl, kinds: ['timeline', 'visibility', 'safe_index'] });
  } finally { resetGateway(); }
}

export async function remoteCallerCannotRunRepairs(databaseUrl?: string) {
  await waveBrain(async ({ engine }) => {
    await expect(runRemediation(engine, { repairs: { include: true, remote: true } })).rejects.toMatchObject({ code: 'permission_denied' });
    const { runRepairSteps, planRepairSteps } = await import('../../src/core/remediation/repairs.ts');
    const steps = await planRepairSteps(engine);
    await expect(runRepairSteps(engine, steps, { remote: true, remainingUsd: () => undefined })).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await engine.executeRaw<{ timeline: string }>("SELECT timeline FROM pages WHERE slug='notes/history'"))[0]!.timeline).not.toContain('gbrain:materialized');
  }, { databaseUrl, kinds: ['timeline'] });
}
