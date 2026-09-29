import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { isDurabilityHardenedAsync } from '../brain-repo-durability.ts';
import { OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import { nativeFileTarget } from './native-file-target.ts';

function git(root: string, hooks: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-C', root, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0', GIT_ICASE_PATHSPECS: '0' },
    }, (error, stdout) => {
      if (error && (error.killed || typeof error.code !== 'number')) reject(new OperationError('git_unavailable', 'Git execution did not finish within its bounded attempt.'));
      else resolve({ stdout, code: error?.code as number ?? 0 });
    });
  });
}

type GitOutcome = { git: string; reason?: string; push?: string };

/**
 * Stage one single-file target. Returns 'changed' when the index now differs
 * for the path, 'unchanged', or a skip outcome for an absent target.
 */
async function stageTarget(root: string, hooks: string, relativePath: string, signal?: AbortSignal): Promise<{ path: string; state: 'changed' | 'unchanged' } | { path: string; skip: GitOutcome }> {
  const path = nativeFileTarget(root, resolvePath(root, relativePath), 'git_target_unsafe');
  relativePath = relative(root, path).split(sep).join('/');
  const tracked = await git(root, hooks, ['ls-files', '-z', '--error-unmatch', '--', relativePath], signal);
  if (tracked.code !== 0 && tracked.code !== 1) throw new OperationError('git_unavailable', 'Cannot inspect the canonical Git target.');
  const changed = await git(root, hooks, ['status', '--porcelain', '--untracked-files=all', '--', relativePath], signal);
  if (changed.code !== 0) throw new OperationError('git_unavailable', 'Cannot inspect the canonical Git target.');
  if (changed.stdout.trim()) {
    if (tracked.code === 0 || existsSync(path)) {
      const add = await git(root, hooks, ['add', '-A', '--', relativePath], signal);
      if (add.code !== 0) throw new OperationError('git_unavailable', 'Cannot stage the canonical Git target.');
    }
    const diff = await git(root, hooks, ['diff', '--cached', '--quiet', '--', relativePath], signal);
    if (diff.code === 1) return { path: relativePath, state: 'changed' };
    if (diff.code !== 0) throw new OperationError('git_unavailable', 'Cannot compare the canonical Git target.');
    return { path: relativePath, state: 'unchanged' };
  }
  if (tracked.code === 0) return { path: relativePath, state: 'unchanged' };
  if (existsSync(path)) throw new OperationError('git_target_unsafe', 'Git cannot identify the existing canonical file by its native spelling.',
    'Reconcile the index and worktree spelling before retrying publication.');
  let parent = dirname(path);
  while (!existsSync(parent)) {
    if (parent === resolvePath(root)) throw new OperationError('git_target_unsafe', 'The canonical Git root disappeared.');
    parent = dirname(parent);
  }
  const scope = relative(root, parent).split(sep).join('/') || '.';
  const deleted = await git(root, hooks, ['diff', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope], signal);
  const staged = await git(root, hooks, ['diff', '--cached', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope], signal);
  if (deleted.code !== 0 || staged.code !== 0) throw new OperationError('git_unavailable', 'Cannot inspect canonical Git deletions.');
  for (const entry of new Set(`${deleted.stdout}${staged.stdout}`.split('\0').filter(Boolean))) {
    if (existsSync(join(root, entry))) continue;
    let missingParent = dirname(nativeFileTarget(root, join(root, entry), 'git_target_unsafe'));
    while (!existsSync(missingParent)) {
      if (missingParent === resolvePath(root)) throw new OperationError('git_target_unsafe', 'The canonical Git root disappeared.');
      missingParent = dirname(missingParent);
    }
    if (missingParent === parent) throw new OperationError('git_target_unsafe', 'The absent target cannot be distinguished from an indexed deletion.',
      'Reconcile the recorded deletion path with the Git index before retrying publication.');
  }
  return { path: relativePath, skip: { git: 'skipped', reason: 'target_absent', push: 'skipped' } };
}

function withHooks<T>(run: (hooks: string) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'effect-'));
  return run(hooks).finally(() => rmSync(hooks, { recursive: true, force: true }));
}

/**
 * #5530: commit a group of single-file targets with one `commit --only`. The
 * caller owns the native worktree lock and has probed durability. Each
 * target's outcome (or its own error) is keyed by its requested relative
 * path; a failing target never enters the commit. Nothing is pushed.
 */
export async function commitGitTargets(root: string, relativePaths: string[], signal?: AbortSignal): Promise<Map<string, GitOutcome | OperationError>> {
  const results = new Map<string, GitOutcome | OperationError>();
  await withHooks(async hooks => {
    const changed: { requested: string; path: string }[] = [];
    for (const requested of new Set(relativePaths)) {
      try {
        const staged = await stageTarget(root, hooks, requested, signal);
        if ('skip' in staged) results.set(requested, staged.skip);
        else if (staged.state === 'changed') changed.push({ requested, path: staged.path });
        else results.set(requested, { git: 'unchanged' });
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        results.set(requested, error);
      }
    }
    if (!changed.length) return;
    // --only keeps unrelated staged paths out of this commit. After a lost
    // database acknowledgment the same HEAD/file state is an exact no-op.
    const message = changed.length === 1 ? 'gbrain: persist canonical memory update' : `gbrain: persist ${changed.length} canonical memory updates`;
    const result = await git(root, hooks, ['commit', '--only', '-m', message, '--', ...changed.map(c => c.path)], signal);
    const outcome = result.code === 0 ? { git: 'committed' } : new OperationError('git_unavailable', 'Cannot commit the canonical Git target.');
    for (const c of changed) results.set(c.requested, outcome);
  });
  return results;
}

/** Push the current branch to its tracking remote once. A plain push is idempotent and cannot import remote canonical content. */
export async function pushGitRoot(root: string, signal?: AbortSignal): Promise<{ push: 'committed' } | { push: 'skipped'; reason: 'no_tracking_remote' }> {
  return withHooks(async hooks => {
    const branch = await git(root, hooks, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
    if (branch.code !== 0) return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const remote = await git(root, hooks, ['config', '--get', `branch.${branch.stdout.trim()}.remote`], signal);
    const merge = await git(root, hooks, ['config', '--get', `branch.${branch.stdout.trim()}.merge`], signal);
    if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const push = await git(root, hooks, ['push', '--', remote.stdout.trim(), `HEAD:${merge.stdout.trim()}`], signal);
    if (push.code !== 0) throw new OperationError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.');
    return { push: 'committed' } as const;
  });
}

/**
 * Caller owns the native worktree lock. Never run pull, rebase, or legacy hooks.
 * `hardened` is the caller's durability probe of `root`, taken before it locked
 * the worktree.
 */
export async function publishGitEffect(root: string, relativePath: string, signal?: AbortSignal,
  hardened?: boolean): Promise<Record<string, unknown>> {
  if (!(hardened ?? await isDurabilityHardenedAsync(root))) return { git: 'skipped', reason: 'durability_not_enabled', push: 'skipped' };
  const outcome = (await commitGitTargets(root, [relativePath], signal)).get(relativePath)!;
  if (outcome instanceof OperationError) throw outcome;
  if (outcome.reason === 'target_absent') return outcome;
  const pushed = await pushGitRoot(root, signal);
  return { git: outcome.git, ...pushed };
}
