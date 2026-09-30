/**
 * A Git effect never turns an index lock into a target failure it cannot recover from.
 *
 * Protects: a bounded git run that is aborted or hits its deadline is SIGKILLed, which skips git's own
 * lock cleanup; the `.git/index.lock` it took used to fail every later attempt as `git_unavailable`
 * until the scan parked the target (seen as w5 "a healthy scan and contention never park" on CI).
 * Now the killed run's own lock is removed, a fresh lock held by another process is contention
 * (`git_index_locked`, retried without counting), and a lock older than the grace is reported with
 * its path. Seams: the real `commitGitTargets` over a real repository; the lock helpers directly.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitGitTargets, __gitIndexLockForTests } from '../src/core/persistence/effect-git.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-index-lock-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, 'a.md'), 'first\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  writeFileSync(join(root, 'a.md'), 'second\n');
  return root;
}

test('a fresh foreign index lock is contention; after the grace it is a stale lock named by path', async () => {
  const root = repo();
  try {
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, '');
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
    const old = (Date.now() - __gitIndexLockForTests.FOREIGN_INDEX_LOCK_GRACE_MS - 60_000) / 1000;
    utimesSync(lock, old, old);
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_unavailable', message: expect.stringContaining(lock) });
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    expect((await commitGitTargets(root, ['a.md'])).get('a.md')).toEqual({ git: 'committed' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only a lock created since the killed run started is released', () => {
  const root = repo();
  try {
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, '');
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lock, old, old);
    __gitIndexLockForTests.releaseKilledRunIndexLock(root, Date.now() - 5_000);
    expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, '');
    __gitIndexLockForTests.releaseKilledRunIndexLock(root, Date.now() - 5_000);
    expect(existsSync(lock)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an aborted git run leaves no index lock behind, and the next attempt commits', async () => {
  const root = repo();
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-slow-git-'));
  try {
    // A git whose `add` takes the index lock and then hangs, so the abort always lands mid-write.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh
root=""; prev=""
for a in "$@"; do [ "$prev" = "-C" ] && root="$a"; prev="$a"; done
for a in "$@"; do if [ "$a" = "add" ]; then : > "$root/.git/index.lock"; exec sleep 30; fi; done
exec ${realGit} "$@"
`, { mode: 0o755 });
    const lock = join(root, '.git', 'index.lock');
    const abort = new AbortController();
    const run = withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
      const pending = commitGitTargets(root, ['a.md'], abort.signal);
      setTimeout(() => abort.abort(), 500);
      return pending;
    });
    await expect(run).rejects.toMatchObject({ code: 'git_unavailable' });
    expect(existsSync(lock)).toBe(false);
    expect((await commitGitTargets(root, ['a.md'])).get('a.md')).toEqual({ git: 'committed' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
}, 60_000);
