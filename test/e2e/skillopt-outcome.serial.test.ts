/**
 * #5584 — orchestrator wiring for the truthful outcome, reflect cap, early
 * stop, must-abort classification and resume correctness, driven through the
 * real runSkillOpt with a stub chat transport (no real LLM, no network).
 *
 * Serial lane: installs gateway module state (`__setChatTransportForTests`)
 * and walks multi-step shared disk state (checkpoints, audit JSONL).
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import { checkpointPath, loadCheckpoint } from '../../src/core/skillopt/checkpoint.ts';
import { skillPath } from '../../src/core/skillopt/version-store.ts';
import { _resetAuditWriterForTests, currentAuditFilename } from '../../src/core/skillopt/audit.ts';
import type { SkillOptOpts } from '../../src/core/skillopt/types.ts';

const SKILL = 'outcome-skill';
const THINKING = 'anthropic:claude-fable-5-1';
const PLAIN = 'anthropic:claude-opus-4-7';
const TARGET = 'anthropic:claude-sonnet-4-6';

const SKILL_TEXT = `---
name: outcome-skill
version: 0.1.0
description: Test skill for the skillopt outcome contract.
triggers:
  - "do the outcome task"
brain_first: exempt
---

# Outcome Skill

When asked, produce a structured output.

## People
List people mentioned.
`;

const task = (id: string, arg: string) => ({ task_id: id, task: `Process ${id}`, judge: { kind: 'rule', checks: [{ op: 'contains', arg }] } });
/** Every task fails at baseline -> one (failure-mode) optimizer call per step. */
const ALL_FAIL = Array.from({ length: 50 }, (_, i) => task(`cit-${String(i + 1).padStart(3, '0')}`, 'Citations'));
/** Alternating People / Citations -> baseline 0.5, the Citations edit reaches 1.0. */
const MIXED = Array.from({ length: 50 }, (_, i) => task(`mix-${String(i + 1).padStart(3, '0')}`, i % 2 === 0 ? 'People' : 'Citations'));

const ADD_CITATIONS = { op: 'add', anchor: 'People', content: '## Citations\nCite the source.', reason: 'add citations' };
const TRUNCATED_JSON = '{"edits":[{"op":"add",';

let engine: PGLiteEngine;
let skillsDir: string;
let benchmarkPath: string;

interface OptimizerCall { mode: 'failure' | 'success' | 'one-shot'; maxTokens?: number }
let optimizerCalls: OptimizerCall[] = [];

function result(text: string, stopReason: ChatResult['stopReason'] = 'end', outputTokens = 20): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason,
    usage: { input_tokens: 100, output_tokens: outputTokens, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'stub', providerId: 'anthropic',
  };
}

function installOptimizer(fn: (call: OptimizerCall, n: number) => ChatResult): void {
  __setChatTransportForTests(async (opts: ChatOpts) => {
    const sys = opts.system ?? '';
    if (sys.startsWith("You are SkillOpt's optimizer")) {
      const mode = sys.includes('ONE-SHOT REWRITE') ? 'one-shot' : sys.includes('FAILURE TRAJECTORIES') ? 'failure' : 'success';
      const call: OptimizerCall = { mode, maxTokens: opts.maxTokens };
      optimizerCalls.push(call);
      return fn(call, optimizerCalls.length);
    }
    const parts: string[] = [];
    if (sys.includes('## People')) parts.push('## People\nAlice.');
    if (sys.includes('## Citations')) parts.push('## Citations\nSource: example.com');
    return result(parts.join('\n\n') || 'nothing');
  });
}

function writeFixture(bench: ReadonlyArray<unknown>): void {
  fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, SKILL, 'SKILL.md'), SKILL_TEXT);
  fs.writeFileSync(benchmarkPath, bench.map((t) => JSON.stringify(t)).join('\n') + '\n');
}

async function run(over: Partial<SkillOptOpts> = {}) {
  return withEnv({ GBRAIN_AUDIT_DIR: skillsDir }, () => runSkillOpt({
    engine,
    skillName: SKILL,
    skillsDir,
    benchmarkPath,
    epochs: 1,
    batchSize: 2,
    lr: 4,
    lrSchedule: 'constant',
    split: [4, 1, 5],
    optimizerModel: PLAIN,
    targetModel: TARGET,
    judgeModel: TARGET,
    mode: 'patch',
    dryRun: false,
    noMutate: false,
    allowMutateBundled: true,
    bootstrapReviewed: false,
    json: true,
    maxCostUsd: 100,
    maxRuntimeMin: 2,
    force: true,
    ...over,
  }));
}

function auditSteps(runId: string): Array<{ step: number; reason?: string }> {
  const file = path.join(skillsDir, currentAuditFilename());
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { kind: string; run_id: string; step: number; reason?: string })
    .filter((e) => e.kind === 'step' && e.run_id === runId);
}

let realWrite: typeof process.stderr.write;
let stderr: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-outcome-'));
  benchmarkPath = path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl');
  optimizerCalls = [];
  stderr = [];
  _resetAuditWriterForTests();
  realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = realWrite;
  __setChatTransportForTests(null);
  _resetAuditWriterForTests();
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

describe('unusable optimizer output', () => {
  test('thinking optimizer truncated every call -> errored after 2 steps, resume command doubles the cap', async () => {
    writeFixture(ALL_FAIL);
    installOptimizer(() => result(TRUNCATED_JSON, 'length', 32000));
    const res = await run({ optimizerModel: THINKING });

    expect(res.outcome).toBe('errored');
    expect(res.receipt.abort_reason).toBe('error');
    expect(res.receipt.abort_detail).toBe('optimizer_output_unusable: reflect_failure_truncated: 32000 output tokens, max_tokens=32000');
    expect(res.receipt.stop_reason).toBe('early_stop_unusable_output');
    expect(optimizerCalls).toHaveLength(2);
    expect(optimizerCalls.every((c) => c.maxTokens === 32000)).toBe(true);
    expect(res.receipt.reflect_max_tokens).toBe(32000);
    expect(res.receipt.reflect_max_tokens_source).toBe('default');
    expect(res.receipt.reflect_errors).toEqual(['reflect_failure_truncated: 32000 output tokens, max_tokens=32000']);
    expect(res.receipt.remediation!.map((r) => r.code)).toEqual(['reflect_truncated']);
    expect(res.receipt.resume_command).toContain(`--resume ${res.receipt.run_id}`);
    expect(res.receipt.resume_command).toContain('--reflect-max-tokens 64000');
    expect(res.receipt.test_score).toBeUndefined();
    expect(fs.existsSync(checkpointPath(skillsDir, SKILL, res.receipt.run_id))).toBe(true);
    expect(fs.readFileSync(skillPath(skillsDir, SKILL), 'utf8')).toBe(SKILL_TEXT);
    expect(stderr.join('')).toContain('stopped after 2 steps of reflect_truncated; remaining budget not spent');
  });

  test('accepted step, then unusable steps -> accepted (SKILL.md mutated), stop_reason early stop', async () => {
    writeFixture(MIXED);
    let proposed = false;
    installOptimizer((call) => {
      if (call.mode === 'failure' && !proposed) { proposed = true; return result(JSON.stringify({ edits: [ADD_CITATIONS] })); }
      return result(TRUNCATED_JSON, 'length', 4096);
    });
    const res = await run();

    expect(res.outcome).toBe('accepted');
    expect(res.mutatedSkillFile).toBe(true);
    expect(res.receipt.stop_reason).toBe('early_stop_unusable_output');
    expect(res.receipt.abort_detail).toBeUndefined();
    expect(fs.readFileSync(skillPath(skillsDir, SKILL), 'utf8')).toContain('## Citations');
    expect(fs.existsSync(checkpointPath(skillsDir, SKILL, res.receipt.run_id))).toBe(false);
  });

  test('one-shot rewrite cut off at max_tokens -> not promoted, errored, error in reflect_errors', async () => {
    writeFixture(ALL_FAIL);
    installOptimizer(() => result('# Outcome Skill\n\n## People\nList peo', 'length', 4096));
    const res = await run({ optimizerMode: 'one-shot-rewrite' });

    expect(optimizerCalls.map((c) => c.mode)).toEqual(['one-shot']);
    expect(res.outcome).toBe('errored');
    expect(res.receipt.reflect_errors).toEqual(['one_shot_rewrite_truncated: 4096 output tokens, max_tokens=4096']);
    expect(res.receipt.abort_detail).toBe('optimizer_output_unusable: one_shot_rewrite_truncated: 4096 output tokens, max_tokens=4096');
    expect(res.mutatedSkillFile).toBe(false);
    expect(fs.readFileSync(skillPath(skillsDir, SKILL), 'utf8')).toBe(SKILL_TEXT);
  });
});

describe('reflect cap precedence through the orchestrator', () => {
  test('config value (below the default) is sent verbatim; an explicit value beats it', async () => {
    writeFixture(ALL_FAIL);
    installOptimizer(() => result('{"edits": []}'));
    await engine.setConfig('skillopt.reflect_max_tokens', '1500');
    const fromConfig = await run({ optimizerModel: THINKING });
    expect(fromConfig.outcome).toBe('no_improvement');
    expect(new Set(optimizerCalls.map((c) => c.maxTokens))).toEqual(new Set([1500]));
    expect(fromConfig.receipt.reflect_max_tokens_source).toBe('config');

    optimizerCalls = [];
    const fromFlag = await run({ optimizerModel: THINKING, reflectMaxTokens: 2222 });
    expect(new Set(optimizerCalls.map((c) => c.maxTokens))).toEqual(new Set([2222]));
    expect(fromFlag.receipt.reflect_max_tokens_source).toBe('flag');
  });
});

describe('--rewrite mode', () => {
  test('mode rewrite still routes through reflect + the validation gate, never the one-shot ablation', async () => {
    writeFixture(MIXED);
    installOptimizer((call) => result(JSON.stringify({ edits: call.mode === 'failure' ? [ADD_CITATIONS] : [] })));
    const res = await run({ mode: 'rewrite' });
    expect(optimizerCalls.length).toBeGreaterThan(0);
    expect(optimizerCalls.some((c) => c.mode === 'one-shot')).toBe(false);
    expect(res.outcome).toBe('accepted');
    expect(res.receipt.optimizer_mode).toBeUndefined();
  });
});

describe('must-abort classification', () => {
  test('raised reflect cap trips reserve() -> aborted budget_exhausted naming both knobs, zero optimizer calls', async () => {
    writeFixture(ALL_FAIL);
    installOptimizer(() => result('{"edits": []}'));
    // Preflight (~$8 heuristic) admits the run; one 200k-token fable
    // reservation (~$10) cannot fit the $9 cap.
    const res = await run({ optimizerModel: THINKING, reflectMaxTokens: 200_000, maxCostUsd: 9 });

    expect(optimizerCalls).toHaveLength(0);
    expect(res.outcome).toBe('aborted');
    expect(res.receipt.abort_reason).toBe('budget_exhausted');
    expect(res.receipt.abort_detail).toContain('--max-cost-usd');
    expect(res.receipt.abort_detail).toContain('skillopt.reflect_max_tokens');
    expect(res.receipt.remediation!.map((r) => r.code)).toEqual(['budget_exhausted']);
  });
});

describe('resume correctness', () => {
  async function abortAtThirdStep(over: Partial<SkillOptOpts> = {}) {
    installOptimizer((_c, n) => {
      if (n === 3) throw new BudgetExhausted('skillopt:x: projected cost $2 exceeds --max-cost $1.00', { reason: 'cost', spent: 0.5, cap: 1 });
      return result('{"edits": []}');
    });
    return run(over);
  }

  test('exhaustion after usable replies -> aborted budget_exhausted (not unusable output); resume continues at the interrupted step', async () => {
    writeFixture(ALL_FAIL);
    const first = await abortAtThirdStep();
    const runId = first.receipt.run_id;
    expect(first.outcome).toBe('aborted');
    expect(first.receipt.abort_reason).toBe('budget_exhausted');
    expect(first.receipt.stop_reason).toBe('aborted');
    expect(first.receipt.abort_detail).not.toContain('optimizer_output_unusable');
    expect(auditSteps(runId).map((s) => s.step)).toEqual([1, 2]);
    const cp = loadCheckpoint(skillsDir, SKILL, runId)!;
    expect({ epoch: cp.next_epoch, step: cp.next_step }).toEqual({ epoch: 1, step: 3 });
    expect(cp.tally!.usable_replies).toBe(2);
    expect(first.receipt.resume_command).toContain(`--resume ${runId}`);

    optimizerCalls = [];
    installOptimizer(() => result('{"edits": []}'));
    const second = await run({ resumeRunId: runId });
    expect(second.outcome).toBe('no_improvement');
    expect(auditSteps(runId).map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(optimizerCalls).toHaveLength(8);
  });

  test('changed benchmark refuses the resume, naming the field', async () => {
    writeFixture(ALL_FAIL);
    const first = await abortAtThirdStep();
    writeFixture([...ALL_FAIL.slice(0, 49), task('cit-new', 'Citations')]);
    await expect(run({ resumeRunId: first.receipt.run_id })).rejects.toThrow(/benchmark_sha8 changed/);
  });

  test('--no-mutate is preserved: resuming with mutation enabled is refused', async () => {
    writeFixture(ALL_FAIL);
    const first = await abortAtThirdStep({ noMutate: true });
    expect(first.receipt.resume_command).toContain('--no-mutate');
    await expect(run({ resumeRunId: first.receipt.run_id, noMutate: false })).rejects.toThrow(/mutate policy changed/);
  });
});
