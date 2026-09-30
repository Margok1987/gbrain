/** Incremental (git-diff) sync: `performSyncInner`. */
import { existsSync, realpathSync } from 'fs';
import {
  currentCompanyBrainSync,
  importCompanyBrainFile,
  softDeleteSyncPages,
} from '../../core/company-brain/profile.ts';
import { join, resolve as pathResolve } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../../core/engine-constants.ts';
import { importFile, importImageFile, isImageFilePath as isImageImportPath } from '../../core/import-file.ts';
import { shouldLogIngest } from '../import.ts';
import {
  isSyncable,
  isPoisonedPath,
  sanitizePathForDisplay,
  unsyncableReason,
  matchesAnyGlob,
  resolveSlugForPath,
  loadSyncFailures,
  formatCodeBreakdown,
  formatFailedFileList,
  applySyncFailureGate,
  isSkippablePath,
  resolveAutoSkipThreshold,
  summarizeFailuresByCode,
  isEmbeddingInfraCode,
  DEFAULT_SOURCE_ID,
  RENAME_SENTINEL_PREFIX,
  renameSentinelPath,
  renameReconcileErrorMessage,
} from '../../core/sync.ts';
import { computeSyncDelta, buildDetachedWorkingTreeManifest } from '../../core/sync-delta.ts';
import { CHUNKER_VERSION } from '../../core/chunkers/code.ts';
import type { SyncManifest } from '../../core/sync.ts';
import { createProgress } from '../../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../../core/cli-options.ts';
import { loadConfig } from '../../core/config.ts';
import { DB_ACCESS_MARKER_PREFIX, shouldEmitDbAccessMarker } from '../../core/pg-access-classify.ts';
import {
  autoConcurrency,
  shouldRunParallel,
  resolveMaxConnections,
  clampWorkersForConnectionBudget,
} from '../../core/sync-concurrency.ts';
import { slog, serr } from '../../core/console-prefix.ts';
import { commitTimeMs } from '../../core/source-health.ts';
import { sortNewestFirst } from '../../core/sort-newest-first.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  appendCompleted,
  appendCompletedOnce,
  clearOpCheckpoint,
  resumeFilter,
} from '../../core/op-checkpoint.ts';
import { registerCleanup } from '../../core/process-cleanup.ts';
import { type DbPacer, createDbPacer, createNoopPacer, observed } from '../../core/db-pacer.ts';
import { resolvePaceMode, loadPaceModeConfig, readPaceEnv } from '../../core/pace-mode.ts';
import { AbortError } from '../../core/abort-check.ts';
import {
  git,
  isPathSafe,
  hasOriginRemote,
  isDetachedHead,
  unique,
  resolveSlugsForRemovedPaths,
  resolveRemovedPathSlug,
  refusedRemovedPathMessage,
  createSyncBaselineCommit,
  isWithinRoot,
  discoverGitRoot,
  gitRelativePath,
} from '../../core/sync-git.ts';
import {
  readSyncAnchor,
  isAnchorOwnedSyncPath,
  writeSyncAnchor,
  readChunkerVersion,
  writeChunkerVersion,
  resolveSlugRootMode,
  type SlugRootMode,
} from '../../core/sync-anchor.ts';
import { buildPartialResult } from '../../core/sync-lock.ts';
import {
  MASS_RECONCILE_RATIO,
  massReconcileAllowed,
  resolveStallAbortSeconds,
  composeAbortSignals,
} from '../../core/sync-reconcile.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';
import {
  resolveSyncCheckpointEvery,
  resolveSyncCheckpointSeconds,
  resolveSyncMaxCheckpointFailures,
  resolveSyncYieldEvery,
  syncCheckpointKeys,
} from './checkpoint.ts';
import { runConnectorSync } from './connector.ts';
import { performFullSync } from './full.ts';
import {
  activeSlugsBySourcePath,
  sweepOrphanedRenameSentinels,
  trackedSlugIndex,
} from './rename-reconcile.ts';
import type { TrackedSlugIndex } from './rename-reconcile.ts';
import { createSyncRun } from './sync-run.ts';

export async function performSyncInner(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  const company = currentCompanyBrainSync(opts.sourceId);
  // v0.41.8.0 (D9 / #1342): phase breadcrumbs. The #1342 reporter saw
  // ZERO stderr output before their sync hang, which made the bug
  // impossible to triage. Mirror the existing `[gbrain phase] sync.git_pull`
  // pattern at the major phase boundaries so the next #1342-shaped
  // report names WHICH phase spun. Doesn't fix #1342 but converts
  // "hung with no output" into actionable diagnostic data.
  serr(`[gbrain phase] sync.resolve_repo`);
  opts.onProgress?.({ phase: 'resolve_repo' });
  // Resolve repo path
  const rawRepoPath = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!rawRepoPath) {
    const hint = opts.sourceId
      ? `Source "${opts.sourceId}" has no local_path. Run: gbrain sources add ${opts.sourceId} --path <path>`
      : `No repo path specified. Use --repo or run gbrain init with --repo first.`;
    throw new Error(hint);
  }
  // #3696: resolve to ABSOLUTE at entry. A relative path (legacy relative
  // sources.local_path row, or a caller-passed `--repo .`) breaks the moment
  // any consumer runs from a different cwd (launchd daemon at cwd=/). Since
  // writeSyncAnchor('repo_path', anchorPath) re-persists this value below,
  // one successful sync from the right cwd self-heals a legacy relative row
  // to absolute.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- rawRepoPath is the local operator's --repo CLI arg or the operator-written sync anchor (sync.repo_path / sources.local_path); the sync_brain op is localOnly:true so no remote caller reaches this path, and absolutizing it here IS the #3696 fix
  const repoPath = pathResolve(rawRepoPath);

  serr(`[gbrain phase] sync.load_active_pack`);
  // v0.39 T1.5: load active pack ONCE at sync entry; pass to every per-file
  // importFile call below. Codex perf finding #7: per-file loadActivePack adds
  // disk/YAML/hash overhead × thousands of files. Best-effort: pack load
  // failure falls through to legacy inferType (parity preserved).
  let syncActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> } | undefined;
  try {
    // v0.41.37.0 #1569: --no-schema-pack escape hatch. Skip pack load entirely so
    // no user-supplied pack regex (markdown.ts subtype path_pattern) runs during
    // sync; pages fall back to legacy prefix typing.
    if (opts.noSchemaPack) {
      serr('[sync] --no-schema-pack: skipping schema pack; pages use legacy prefix typing');
      throw new Error('schema-pack-skipped');
    }
    const { loadActivePackForEngine } = await import('../../core/schema-pack/engine-resolution.ts');
    const resolved = await loadActivePackForEngine(engine, {
      remote: false, // sync is always a trusted CLI / autopilot caller
      sourceId: opts.sourceId,
    });
    syncActivePack = { page_types: resolved.manifest.page_types };
  } catch {
    syncActivePack = undefined;
  }

  const connector = await runConnectorSync(engine, opts, false);
  if (connector) return connector;

  // v0.28: source-aware re-clone branch. When the source has a remote_url
  // recorded (i.e. it was registered via `sources add --url`), the on-disk
  // clone is auto-managed. validateRepoState classifies the on-disk state;
  // we recover from missing/no-git/not-a-dir by re-cloning, refuse on
  // url-drift or corruption with structured hints.
  if (opts.sourceId) {
    serr(`[gbrain phase] sync.validate_repo_state`);
    const { validateRepoState } = await import('../../core/git-remote.ts');
    const { recloneIfMissing, isOwnedClone, unownedHint } = await import(
      '../../core/sources-ops.ts'
    );
    const cfgRows = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
      `SELECT local_path, config FROM sources WHERE id = $1`,
      [opts.sourceId],
    );
    const cfg =
      typeof cfgRows[0]?.config === 'string'
        ? (JSON.parse(cfgRows[0].config as string) as Record<string, unknown>)
        : ((cfgRows[0]?.config ?? {}) as Record<string, unknown>);
    // #4899: EVERY caller that is not the `--all` fan-out passes no strategy —
    // the autopilot freshness lane (commands/autopilot.ts -> jobs.ts), the dream
    // cycle (core/cycle.ts), the MCP `sync` op (core/operations.ts) and the
    // single-source CLI path below. `isSyncable` then falls back to 'markdown'
    // (core/sync.ts), which drops every code file in the range. Two consequences:
    // the run imports nothing yet still advances the anchor (`Update sync state
    // even with no syncable changes`), freezing the index at HEAD forever; and
    // every MODIFIED code file reaches the un-syncable delete loop, whose only
    // exemptions are 'metafile' (#1433) and 'pruned-dir' (#2404), so its page is
    // soft-deleted.
    //
    // Resolve the source's own strategy when the caller states none. An explicit
    // --strategy still wins, so the `--all` fan-out and the CLI flag are unchanged.
    if (opts.strategy === undefined && typeof cfg.strategy === 'string') {
      const persisted = cfg.strategy;
      if (persisted === 'markdown' || persisted === 'code' || persisted === 'auto') {
        // Assign the PROPERTY, never `opts = {...opts}`: this block runs inside
        // `if (opts.sourceId)`, and replacing the object discards that narrowing,
        // so three downstream call sites stop compiling.
        opts.strategy = persisted;
      }
    }
    const remoteUrl = typeof cfg.remote_url === 'string' ? cfg.remote_url : null;
    if (remoteUrl) {
      const ownSrc = {
        id: opts.sourceId,
        local_path: cfgRows[0]?.local_path ?? repoPath,
        config: cfg,
      };
      const state = validateRepoState(repoPath, remoteUrl);
      switch (state) {
        case 'healthy':
          // No per-sync warning for an unowned-but-healthy source — it would
          // spam every sync. The misconfig is surfaced by the doctor check
          // (TODO1) instead. Healthy unowned paths sync read-only and are safe.
          break;
        case 'missing':
        case 'no-git':
        case 'not-a-dir':
          // #1881: only re-clone a clone gbrain owns. An unowned local_path
          // (the user's working tree) is refused loudly, never deleted.
          if (!isOwnedClone(ownSrc)) {
            throw new Error(unownedHint(ownSrc, state));
          }
          serr(
            `[gbrain] auto-recovery: re-cloning "${opts.sourceId}" (clone state: ${state}).`,
          );
          await recloneIfMissing(engine, opts.sourceId);
          break;
        case 'corrupted':
          throw new Error(
            `Source "${opts.sourceId}" clone at ${repoPath} is corrupted ` +
              `(\`git remote get-url origin\` failed). Run: ` +
              `gbrain sources remove ${opts.sourceId} --confirm-destructive && ` +
              `gbrain sources add ${opts.sourceId} --url ${remoteUrl}`,
          );
        case 'url-drift':
          throw new Error(
            `Source "${opts.sourceId}" clone at ${repoPath} has a remote ` +
              `that differs from config.remote_url=${remoteUrl}. ` +
              `Re-clone with: gbrain sources rebase-clone ${opts.sourceId} ` +
              `(if available, else: sources remove + sources add).`,
          );
      }
    }
  }

  // #753/#774: discover the git root instead of requiring `.git` at repoPath
  // directly. Supports subdir-of-git-repo sources (monorepo pattern): either
  // an explicit `--src-subpath` under a git-root repoPath, or a repoPath that
  // IS a subdirectory (auto-discovery). Two axes fall out:
  //   - gitContextRoot: ALL git operations (pull, rev-parse, diff, cat-file)
  //   - syncScopeRoot:  file walking, imports, deletes, renames
  // In the common case (repoPath == git root, no subpath) they are identical.
  serr(`[gbrain phase] sync.discover_git_root`);
  // #2964: a legacy `sync.repo_path`-anchored default brain can reach here
  // having never been `git init`-ed — e.g. a brain-pages dir that predates
  // git-backed sync, or one rsync'd from another machine without its
  // `.git`. gbrain owns that directory outright, so self-heal by
  // initializing it in place instead of failing the sync phase every
  // single run. Mirrors the recloneIfMissing self-recovery above for
  // owned remote clones. Ownership is proven by VALUE (resolved repoPath
  // equals gbrain's persisted anchor) via `isAnchorOwnedSyncPath`, not by
  // the mere absence of `opts.sourceId`/`opts.repoPath` — see that
  // function's docstring. `!opts.dryRun`: a preview must never write.
  let gitContextRoot: string;
  try {
    gitContextRoot = realpathSync(discoverGitRoot(repoPath));
  } catch (err) {
    if (company) throw err;
    if (
      opts.dryRun ||
      opts.signal?.aborted ||
      !existsSync(repoPath) ||
      !(await isAnchorOwnedSyncPath(engine, opts, repoPath))
    ) {
      throw err;
    }
    // 2026-08-10 incident guard. `discoverGitRoot` is a 30s-bounded
    // `git rev-parse --show-toplevel` that walks UP; it can throw for reasons
    // OTHER than "no git repo" — a transient timeout on a large brain, or a
    // concurrent `gbrain-sync` holding a git lock — on a directory that IS a
    // git repo, whether the repo root is `repoPath` itself OR an ANCESTOR
    // (subdir-anchored brain, the #753/#774 monorepo pattern). Trusting a
    // single throw and running `git init` (a no-op reinit at repoPath, or a
    // NEW nested repo shadowing the ancestor) + baseline-commit stacks a
    // spurious auto-init commit and re-cases the tree on a case-insensitive
    // filesystem. So do NOT self-heal on one throw — re-probe once:
    //   - re-probe SUCCEEDS => the first throw was transient and the repo
    //     (own or ancestor) is real; use it, never init/commit.
    //   - re-probe THROWS but `.git` is present at repoPath => a real but
    //     unreadable repo (corrupt, broken gitlink, or a persistent transient)
    //     — NEVER init/commit over it; surface the original error.
    //   - re-probe THROWS and no `.git` at repoPath => genuinely not a git
    //     repo anywhere up the tree; self-heal.
    // The createSyncBaselineCommit chokepoint is the fail-closed backstop if
    // this ever reaches a baseline on a repo that turns out to have commits.
    let reprobedRoot: string | null = null;
    try {
      reprobedRoot = discoverGitRoot(repoPath);
    } catch {
      reprobedRoot = null;
    }
    if (reprobedRoot !== null) {
      gitContextRoot = realpathSync(reprobedRoot);
    } else if (existsSync(join(repoPath, '.git'))) {
      throw err;
    } else {
      serr(`[gbrain] auto-recovery: git-initializing brain dir ${repoPath} (no git repo found).`);
      git(repoPath, ['init', '--quiet']);
      createSyncBaselineCommit(repoPath);
      gitContextRoot = realpathSync(discoverGitRoot(repoPath));
    }
  }
  const rawScopeRoot = opts.srcSubpath ? join(repoPath, opts.srcSubpath) : repoPath;
  if (!existsSync(rawScopeRoot)) {
    throw new Error(`Sync scope does not exist: ${rawScopeRoot}`);
  }
  const syncScopeRoot = realpathSync(rawScopeRoot);
  // NAV-1/NAV-2 scope-entry guard: the realpath-resolved scope must live
  // inside the realpath-resolved git root. Catches `--src-subpath ../escape`
  // AND a symlinked subdir pointing outside the repo, before any git op runs.
  if (!isWithinRoot(syncScopeRoot, gitContextRoot)) {
    throw new Error(
      `Sync scope ${syncScopeRoot} resolves outside git repo ${gitContextRoot}. ` +
      `Refusing to sync: possible path traversal via --src-subpath.`,
    );
  }
  const syncScopeRelPath = gitRelativePath(gitContextRoot, syncScopeRoot);
  const scoped = syncScopeRelPath !== '';
  // Anchor written back to sync state (sources.local_path / sync.repo_path):
  // the SCOPE path, so a follow-up bare `gbrain sync` auto-discovers the same
  // scope. Unchanged (the caller's repoPath spelling) when no --src-subpath.
  const anchorPath = opts.srcSubpath ? rawScopeRoot : repoPath;
  // #4342 — explicit + STICKY slug namespace for scoped syncs. Pre-fix the
  // namespace was implicit: a local_path that happened to sit inside a bigger
  // git repo silently produced git-root-PREFIXED slugs (`notes/foo` instead
  // of `foo`), diverging from what `gbrain import <dir>` of the same tree
  // creates. The mode is decided once (resolveSlugRootMode: stored pin >
  // explicit --src-subpath > auto-pin when existing pages already carry the
  // prefix > local_path-relative) and persisted, so a live install never
  // re-slugs and every later sync agrees.
  let slugRootMode: SlugRootMode = 'git-root';
  if (scoped) {
    // Probe prefix in SLUG spelling (resolveSlugForPath), not raw path
    // spelling — the auto-pin LIKE must match how slugs were actually minted.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- syncScopeRelPath is relative() of the realpath'd scope already proven inside the realpath'd git root by the isWithinRoot guard above (so it carries no ..); the join output only mints an in-memory slug probe string, no fs operation
    const probeSlug = resolveSlugForPath(join(syncScopeRelPath, 'x.md'));
    const slugPrefix = probeSlug.slice(0, probeSlug.length - '/x'.length);
    slugRootMode = await resolveSlugRootMode(engine, {
      sourceId: opts.sourceId,
      explicitGitRoot: opts.srcSubpath !== undefined,
      slugPrefix,
      // #4342 review fix: a --dry-run must not persist the sticky pin —
      // resolve in-memory only; the first real sync writes it.
      dryRun: opts.dryRun === true,
    });
  }
  const fullSyncRoots = { gitContextRoot, syncScopeRoot, anchorPath, slugRootMode };

  serr(`[gbrain phase] sync.detect_head`);
  // Detect detached HEAD up front so the working-tree fallback fires for both
  // the default sync and `--no-pull` callers. Only the actual git pull is
  // gated on opts.noPull or opts.dryRun.
  const detachedHead = !company && isDetachedHead(gitContextRoot);
  if (detachedHead && !opts.noPull) {
    // Print the caller's repoPath spelling (not the realpathed git root) —
    // it's what the operator recognizes, and tests pin it.
    serr(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // Git pull (unless --no-pull or --dry-run). v0.28.1 codex finding (HIGH): the legacy
  // git() helper at sync.ts:192 spawns git without GIT_SSRF_FLAGS, so
  // every steady-state pull was bypassing the redirect/submodule/protocol
  // hardening that cloneRepo applies. Route through pullRepo from
  // git-remote.ts so the flag set is consistent across initial clone and
  // ongoing pulls — single source of truth for the defensive flags.
  const originRemotePresent = !opts.noPull && !detachedHead ? hasOriginRemote(gitContextRoot) : false;
  if (!opts.noPull && !detachedHead && !originRemotePresent) {
    serr(`No origin remote on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // v0.41.13.0 (T2 + T3): read the bookmark BEFORE pull so the pull-phase
  // abort/partial path has a real `fromCommit` value to report. lastCommit
  // is a pure DB read — pull doesn't change the bookmark — so the read
  // order doesn't matter for correctness. Ancestry validation below still
  // happens AFTER pull (so a `git pull` that brings in missing commits
  // can restore a valid ancestor chain).
  const lastCommit = opts.full ? null : await readSyncAnchor(engine, opts.sourceId, 'last_commit');

  // v0.41.13.0 (T2): pre-pull abort check. If --timeout already fired
  // (e.g. cron invoked sync after the previous run took the full budget),
  // return partial without invoking the pull subprocess. fromCommit and
  // toCommit both report the prior bookmark since we never advanced past it.
  if (opts.signal?.aborted) {
    return buildPartialResult({
      fromCommit: lastCommit,
      toCommit: lastCommit ?? '',
      filesImported: 0,
      pagesAffected: [],
      chunksCreated: 0,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      reason: 'timeout',
    });
  }

  // #3068: remember a warn-and-continue pull failure. The fall-through-to-
  // working-tree design stays (local commits still import when the remote is
  // unreachable), but a ZERO-import sync after a failed pull must not report
  // `up_to_date` / bump the freshness heartbeat — that is what made a
  // permanently-failing pull (e.g. a local-path origin rejected by
  // protocol.file.allow=never, #1315) invisible forever: every nightly run
  // exited 0 with "Already up to date" and doctor's sync_freshness never
  // fired because last_sync_at kept advancing.
  let pullFailed = false;
  if (!opts.dryRun && !opts.noPull && !detachedHead && originRemotePresent) {
    const _t0 = Date.now();
    serr(`[gbrain phase] sync.git_pull start`);
    opts.onProgress?.({ phase: 'git_pull' });
    try {
      const { pullRepo } = await import('../../core/git-remote.ts');
      // v0.41.13.0 (T3 / D-V4-mech-7): if the operator set --timeout,
      // bound the pull subprocess to a fraction of the remaining budget.
      // We pass a safe default (the operator's full --timeout if set, else
      // pullRepo's own 300s default). The catch below distinguishes
      // timeout (ETIMEDOUT / SIGTERM on err.cause) from ordinary pull
      // failure. Pull applies to the whole git repo (gitContextRoot), not
      // just the sync scope — git has no per-subdir pull.
      pullRepo(gitContextRoot);
      serr(`[gbrain phase] sync.git_pull done ${Date.now() - _t0}ms`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      serr(`[gbrain phase] sync.git_pull error ${Date.now() - _t0}ms (${msg.slice(0, 200)})`);
      // v0.41.13.0 (T3 / D-V4-mech-7): pullRepo wraps execFileSync errors
      // in GitOperationError, so `error.code === 'ETIMEDOUT'` and
      // `error.signal === 'SIGTERM'` live on `.cause`, NOT on the top-
      // level error. Inspect `.cause` to distinguish a real timeout
      // (return partial reason='pull_timeout') from ordinary failure
      // (keep the existing warn-and-continue R2 invariant).
      const cause: unknown = e instanceof Error && 'cause' in e ? (e as { cause?: unknown }).cause : undefined;
      const causeCode = (cause && typeof cause === 'object' && 'code' in cause)
        ? (cause as { code?: unknown }).code
        : undefined;
      const causeSignal = (cause && typeof cause === 'object' && 'signal' in cause)
        ? (cause as { signal?: unknown }).signal
        : undefined;
      const isTimeout = causeCode === 'ETIMEDOUT' || causeSignal === 'SIGTERM';
      if (isTimeout) {
        return buildPartialResult({
          fromCommit: lastCommit,
          toCommit: lastCommit ?? '',
          filesImported: 0,
          pagesAffected: [],
          chunksCreated: 0,
          added: 0, modified: 0, deleted: 0, renamed: 0,
          reason: 'pull_timeout',
        });
      }
      pullFailed = true;
      if (msg.includes('non-fast-forward') || msg.includes('diverged')) {
        serr(`Warning: git pull failed (remote diverged). Syncing from local state.`);
      } else {
        serr(`Warning: git pull failed: ${msg.slice(0, 200)}`); // #1315 stderr-first
      }
    }
  }

  // Get current HEAD
  let headCommit: string;
  try {
    headCommit = company?.plan.revision?.commit ?? git(gitContextRoot, ['rev-parse', 'HEAD']);
  } catch {
    // #2964: unborn-HEAD recovery. `.git` exists (discoverGitRoot succeeded
    // above) but there are zero commits — e.g. a prior self-heal `git init`
    // ran but the process died before the baseline commit landed, leaving
    // this brain permanently wedged on "No commits in repo" every night
    // thereafter. Finish the same baseline-commit self-heal the
    // discoverGitRoot catch above would have done, gated the same way
    // (ownership proven by value, never on a dry-run preview) PLUS a scope
    // check: `discoverGitRoot` walks UP from `repoPath`, so it can resolve
    // to an ANCESTOR repo, not `repoPath` itself (most plausible for a
    // `--src-subpath` sync, but `isAnchorOwnedSyncPath` already refuses
    // that case — kept here too as defense in depth against any other path
    // where gitContextRoot could diverge from repoPath). Committing at an
    // ancestor (`git add -A` at gitContextRoot) would capture sibling
    // files well outside the sync scope — refuse instead of guessing.
    if (
      opts.dryRun ||
      opts.signal?.aborted ||
      gitContextRoot !== realpathSync(repoPath) ||
      !(await isAnchorOwnedSyncPath(engine, opts, repoPath))
    ) {
      throw new Error(`No commits in repo ${repoPath}. Make at least one commit before syncing.`);
    }
    serr(`[gbrain] auto-recovery: repo has no commits yet, creating baseline commit ${gitContextRoot}.`);
    createSyncBaselineCommit(gitContextRoot);
    headCommit = git(gitContextRoot, ['rev-parse', 'HEAD']);
  }

  // #2964: self-heal deliberately does NOT special-case db_only/.gitignore
  // interaction beyond the COMMIT itself (createSyncBaselineCommit's
  // pathspec exclusion, which stands on its own regardless of what
  // .gitignore says). db_only content is documented as DB-sourced ("bulk
  // machine-generated content... written to disk as a local cache", see
  // docs/storage-tiering.md) — it reaches the database via ingest-specific
  // paths, never via gbrain sync's git-diff-based file collection, and
  // `.gitignore` management there is entirely about keeping db_only out of
  // git history, not about what sync imports. An earlier version of this
  // fix (Codex review rounds 6-7) tried to also guarantee db_only markdown
  // gets imported on this first sync and that .gitignore gets written
  // post-success even when called outside runSync — solving a problem
  // that, per the docs above, isn't actually in scope for what sync is
  // for. Reverted in round 8 review discussion in favor of this simpler
  // design: after self-heal, the import + any subsequent .gitignore
  // management behave EXACTLY the same as for any other brain, self-healed
  // or not (runSync's existing post-success manageGitignoreAtGitRoot call
  // covers the CLI path identically either way; the dream cycle not
  // calling it is a separate, pre-existing characteristic of the dream
  // cycle in general, not something this fix introduces or worsens).

  // Same reasoning as the `sync.include_working_tree` config fallback further
  // down, applied to the indexing scope: `--exclude` is a per-invocation flag,
  // so only callers that go through the CLI can narrow what gets indexed.
  // autopilot, minion sync jobs and the dream cycle call sync internally with
  // no place to put exclusions — a repo whose indexing scope is narrower than
  // its git tree is honored on one path and silently ignored on the others.
  //
  // Silently is the operative word: not excluding something is not an error
  // for an indexer, so the gap surfaces as content quietly reappearing in the
  // index, never as a failure. Resolving the config HERE gives every caller
  // the same scope. The read is best-effort, exactly like that one.
  //
  // UNION rather than flag-wins, which is where this departs from that
  // boolean: a persisted scope is a property of the repo ("this is not
  // indexable material"), and an ad-hoc `--exclude tmp/` must not silently
  // re-open it — that would reintroduce the very failure this closes. A
  // boolean has no union; a pattern list does. Narrowing further always
  // works; widening is deliberate, by editing the config.
  //
  // Directory prefixes are normalized to subtree globs (`raw/` → `raw/**`):
  // without the `**` the pattern matches the directory entry and none of the
  // files inside it, which is the same gap wearing a different shape.
  //
  // POSITION IS LOAD-BEARING: this union must run ABOVE the three
  // performFullSync early returns below (gc'd anchor, first sync,
  // --include-gitignored). The first sync is exactly where exclusion
  // pollution is permanent — a full walk that ignores the persisted scope
  // imports every excluded derivative file, and no later incremental sync
  // ever revisits them.
  try {
    const stored = await engine.getConfig('sync.exclude');
    const storedPatterns = (stored ?? '')
      .split(/[\n,]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.endsWith('/') ? `${p}**` : p));
    if (storedPatterns.length > 0) {
      opts = { ...opts, exclude: [...new Set([...(opts.exclude ?? []), ...storedPatterns])] };
    }
  } catch { /* config unreadable — never break a sync over the scope read */ }

  // #4901: the WAIVER's persisted twin, read exactly like `sync.exclude` above
  // (same dialect, trailing-slash normalization, union, best-effort, position).
  // `--include-hidden` is refused under `--all` and unavailable to autopilot /
  // the dream cycle, so this key is the only way the unattended paths get it.
  // An unset key admits nothing — the dot-directory default does not move.
  try {
    const storedHidden = await engine.getConfig('sync.include_hidden');
    const hiddenPatterns = (storedHidden ?? '')
      .split(/[\n,]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.endsWith('/') ? `${p}**` : p));
    if (hiddenPatterns.length > 0) {
      opts = { ...opts, includeHidden: [...new Set([...(opts.includeHidden ?? []), ...hiddenPatterns])] };
    }
  } catch { /* config unreadable — never break a sync over the scope read */ }

  // #1970: bookmark reachability. The ONLY thing that should force a full
  // reconcile is a truly-absent object; a present-but-non-ancestor bookmark
  // (history rewrite: force-push, master→main consolidation, squash) is still
  // diffable. `git diff A..B` is an endpoint-tree comparison and does NOT
  // require A to be an ancestor of B (unlike rev-walk commands or `A...B`,
  // which use merge-base). So we diff DIRECTLY against the orphaned-but-on-disk
  // bookmark for the exact delta instead of a blind full re-walk that never
  // finishes cross-region (#1958) and never advances the bookmark.
  //
  //   lastCommit (orphan)        HEAD
  //        o ─────── x ─────── x   (old line, dropped by the rewrite)
  //         \
  //          o ─────── o ─────── ●  HEAD (new line)
  //   git diff orphan..HEAD == net tree delta — ancestry irrelevant.
  if (lastCommit) {
    let objectPresent = true;
    try {
      git(gitContextRoot, ['cat-file', '-t', lastCommit]);
    } catch {
      objectPresent = false;
    }
    if (!objectPresent) {
      // Object gc'd after a history rewrite — nothing to diff against, so fall
      // back to the authoritative full reconcile (which now also purges stale
      // pages for deleted files; see performFullSync's delete-reconcile pass).
      serr(`Sync anchor ${lastCommit.slice(0, 8)} object missing (gc'd after history rewrite). Running full reimport.`);
      return performFullSync(engine, fullSyncRoots, headCommit, opts);
    }

    // Observability only — NOT control flow. A non-ancestor bookmark is still
    // diffed directly below; we just announce the rewrite so the silent-staleness
    // failure mode (#1970) is visible in the logs.
    let isAncestor = true;
    try {
      git(gitContextRoot, ['merge-base', '--is-ancestor', lastCommit, headCommit]);
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) {
      slog(
        `[sync] last_commit ${lastCommit.slice(0, 8)} not an ancestor of HEAD ` +
        `(history rewritten) — diffing tree-to-tree against the orphaned bookmark; ` +
        `advancing to HEAD on completion.`,
      );
    }
  }

  // First sync
  if (!lastCommit) {
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }

  if (opts.includeGitignored) {
    slog(
      `[sync] --include-gitignored: running full filesystem reconcile because ` +
      `git diff cannot report untracked ignored files.`,
    );
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }

  // v0.42.x (#1794): resumable incremental sync — resolve the PINNED target.
  // last_commit advances only at FULL import completion, so a killed run keeps
  // lastCommit fixed and the checkpoint key stable across every resume even as
  // the enrich process races HEAD forward underneath us. We drain
  // `lastCommit..pin`; commits past the pin are a clean next-sync diff (this is
  // what kills the staleness window — see plan).
  //   - valid in-flight checkpoint (pin still reachable from HEAD) → resume it.
  //   - rewrite / force-push (pin no longer an ancestor) → discard, re-pin to HEAD.
  //   - no checkpoint → pin = HEAD (the normal single-shot case).
  const ckpt = syncCheckpointKeys(opts.sourceId, company ? company.receiptId : lastCommit);
  if (company && !opts.dryRun) await company.protect([{ ...ckpt.paths, kind: 'content' }, { ...ckpt.target, kind: 'manifest' }]);
  const checkpointEvery = resolveSyncCheckpointEvery();
  let pin = headCommit;
  let completedPaths: string[] = [];
  {
    const storedTargetArr = await loadOpCheckpoint(engine, ckpt.target);
    const storedTarget = storedTargetArr[0] ?? null;
    if (storedTarget) {
      let pinReachable = false;
      try {
        if (company && storedTarget !== company.plan.revision!.commit) throw new Error('Approved revision mismatch');
        if (!company) git(gitContextRoot, ['merge-base', '--is-ancestor', storedTarget, headCommit]);
        pinReachable = true;
      } catch {
        pinReachable = false;
      }
      if (pinReachable) {
        pin = storedTarget;
        completedPaths = await loadOpCheckpoint(engine, ckpt.paths);
        slog(
          `[sync] resuming checkpoint: ${completedPaths.length} file(s) already done; ` +
          `draining ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} (pinned target).`,
        );
      } else {
        slog(
          `[sync] checkpoint target ${storedTarget.slice(0, 8)} no longer reachable ` +
          `(history rewritten); restarting against HEAD.`,
        );
        // #3583 review: NOT under --dry-run — this hygiene clear is a
        // persistent write, and the real run re-detects the unreachable
        // pin and clears it itself; a preview only reports.
        if (!opts.dryRun) {
          await clearOpCheckpoint(engine, ckpt.paths);
          await clearOpCheckpoint(engine, ckpt.target);
        }
      }
    }
  }

  // v0.20.0 Cathedral II Layer 12 (codex SP-1 fix): before returning
  // 'up_to_date' on git-HEAD equality, check the chunker version gate.
  // If sources.chunker_version mismatches CURRENT_CHUNKER_VERSION, force
  // a full re-walk so existing chunks get re-chunked under the new
  // pipeline (qualified symbol names, parent scope, doc-comment column
  // population, etc.). Without this, upgraded brains silently stay on
  // the old chunks — the whole reason we bumped the version.
  const storedVersion = await readChunkerVersion(engine, opts.sourceId);
  const currentVersion = String(CHUNKER_VERSION);
  const versionMismatch = storedVersion !== null && storedVersion !== currentVersion;
  const versionNeverSet = storedVersion === null && opts.sourceId !== undefined;
  // Untracked-gap fix: the working-tree manifest is now built for attached
  // HEADs too, not just detached ones. Detached HEAD (pre-existing semantics)
  // or a resolved workingTree opt-in → the manifest merges into the delta
  // below and uncommitted state IMPORTS. Attached without the opt-in → NOT
  // imported, but counted through the same scope/exclude/isSyncable filters
  // imports use and reported as `uncommitted` drift + a stderr warning.
  // Before this, "Already up to date." printed while untracked files sat
  // invisible — sync reported convergence it had not achieved.
  //
  // The config fallback resolves HERE (not the CLI layer) so EVERY caller —
  // dream cycle, minion sync jobs, sync_brain — honors the persisted
  // `sync.include_working_tree` the warnings recommend. Per-call flag wins;
  // the config read is best-effort (a config error never breaks a sync).
  let workingTreeResolved = opts.workingTree;
  if (workingTreeResolved === undefined) {
    try {
      workingTreeResolved = (await engine.getConfig('sync.include_working_tree')) === 'true';
    } catch { workingTreeResolved = false; }
  }
  const importWorkingTree = !company && (detachedHead || workingTreeResolved === true);
  // Fail-open guard: the manifest builder shells out under a 30s/100MiB git
  // budget and THROWS on breach; a monster untracked dir must not convert
  // every previously-working up-to-date sync into a hard error. Drift
  // counting degrades to empty with a stderr note; an EXPLICIT working-tree
  // import request fails closed with the reason (importing without the
  // manifest would silently skip the very files the caller asked for).
  let workingTreeManifest: SyncManifest;
  try {
    workingTreeManifest = company ? { added: [], modified: [], deleted: [], renamed: [] } : buildDetachedWorkingTreeManifest(gitContextRoot);
  } catch (e) {
    if (importWorkingTree) {
      throw new Error(
        `working-tree manifest unavailable (${e instanceof Error ? e.message.slice(0, 160) : String(e)}) — ` +
        `cannot import uncommitted state; re-run without --working-tree or fix the repo state`,
      );
    }
    serr('[sync] working-tree drift probe failed — drift counting skipped this run.');
    workingTreeManifest = { added: [], modified: [], deleted: [], renamed: [] };
  }

  // #753/#774 scope filter (hoisted above the up_to_date gate so the drift
  // counter here and the delta filter below apply IDENTICAL predicates):
  // git-diff paths are git-root-relative; when a subpath scope is active, only
  // paths under it participate. Back-compat: syncScopeRelPath is '' when
  // scope == root, so inScope is always true and the filters reduce to the
  // pre-#774 behavior exactly.
  const inScope = (p: string): boolean =>
    !scoped || p === syncScopeRelPath || p.startsWith(syncScopeRelPath + '/');
  // --exclude patterns match the SCOPE-relative path (what the user of a
  // scoped source thinks in), same form runImport matches on full sync.
  const scopeRel = (p: string): string =>
    scoped && p.startsWith(syncScopeRelPath + '/') ? p.slice(syncScopeRelPath.length + 1) : p;
  const includedPaths = company ? new Set(company.plan.manifest.filter(entry => entry.disposition === 'included').map(entry => entry.path)) : null;
  const storedPaths = company ? new Set((await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND source_path IS NOT NULL', [opts.sourceId!])).map(page => page.source_path)) : null;
  const isSelectedForRun = (path: string, options?: Parameters<typeof isSyncable>[1]): boolean => company
    ? includedPaths!.has(scopeRel(path)) || storedPaths!.has(scopeRel(path))
    : isSyncable(path, options);
  const excluded = (p: string): boolean => company ? !includedPaths!.has(scopeRel(p)) :
    opts.exclude !== undefined && opts.exclude.length > 0 && matchesAnyGlob(scopeRel(p), opts.exclude);
  // #4027: includeHidden must ride along wherever isSyncable() consults these
  // opts — dropping it here silently disables --include-hidden on the whole
  // delta path (and the #3974 drift counter) while the flag still parses.
  const syncOpts = { strategy: opts.strategy, includeHidden: opts.includeHidden };

  // Filtered working-tree counts. Renames decompose as add(to) + delete(from)
  // — the same decomposition the import path applies — so a rename-only dirty
  // tree still reports drift instead of reproducing the silent gap this
  // counter exists to close (a staged `git mv` populates only `renamed`).
  const wtCounts = {
    added: workingTreeManifest.added.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)).length +
      workingTreeManifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSelectedForRun(r.to, syncOpts)).length,
    modified: workingTreeManifest.modified.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)).length,
    deleted: workingTreeManifest.deleted.filter(p => inScope(p) && isSelectedForRun(p, syncOpts)).length +
      workingTreeManifest.renamed.filter(r => inScope(r.from) && isSelectedForRun(r.from, syncOpts)).length,
  };
  const wtSyncableTotal = wtCounts.added + wtCounts.modified + wtCounts.deleted;
  // Fast-path gate: detached HEADs keep the pre-existing RAW-manifest gate;
  // attached repos gate on SYNCABLE changes so a stray unsyncable scratch
  // file can't defeat the up_to_date fast path on every scheduled run.
  const hasWorkingTreeChanges = detachedHead
    ? (workingTreeManifest.added.length > 0 ||
        workingTreeManifest.modified.length > 0 ||
        workingTreeManifest.deleted.length > 0 ||
        workingTreeManifest.renamed.length > 0)
    : wtSyncableTotal > 0;

  let uncommittedDrift: { added: number; modified: number; deleted: number } | undefined;
  if (!importWorkingTree && wtSyncableTotal > 0) {
    uncommittedDrift = wtCounts;
    serr(
      `[sync] ${wtSyncableTotal} uncommitted file(s) are invisible to ` +
      `commit-driven sync (${wtCounts.added} untracked/added, ${wtCounts.modified} modified, ${wtCounts.deleted} deleted). ` +
      `Commit them, or run 'gbrain sync --working-tree' to import uncommitted state.`,
    );
  }

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet && !(importWorkingTree && hasWorkingTreeChanges)) {
    // #3068: the pull failed and nothing local advanced — this run imported
    // NOTHING and the remote may hold commits we could not fetch. Reporting
    // `up_to_date` here (and bumping the heartbeat below) is exactly the
    // silent-wedge from the issue: every scheduled sync exits 0 forever while
    // the source is stale. Return `partial` instead (not a clean status, and
    // last_sync_at stays frozen so doctor/sources-status staleness fires).
    // The anchor is untouched; the next sync retries the pull from the same
    // bookmark.
    if (pullFailed) {
      serr(
        `[sync] git pull failed and no local changes imported — reporting partial ` +
        `(not up_to_date); sync anchor unchanged at ${lastCommit.slice(0, 8)}.`,
      );
      return buildPartialResult({
        fromCommit: lastCommit,
        toCommit: lastCommit,
        filesImported: 0,
        pagesAffected: [],
        chunksCreated: 0,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        reason: 'pull_failed',
      });
    }
    // v0.42.52.0 (PR #22xx): bump last_sync_at as a heartbeat on every successful
    // 0-changes sync. D4 invariant ("never advance last_commit on partial") is
    // preserved: last_sync_at is a monitoring signal (doctor sync_freshness
    // reads it), separate from the import-converged bookmark. Without this,
    // a cron-driven `*/15 sync` over a quiet vault leaves last_sync_at pinned
    // to the last real commit, so doctor falsely flags the source as stale.
    // #3583 review: NOT under --dry-run — a preview that bumps the freshness
    // heartbeat masks real staleness from doctor.
    if (opts.sourceId && !opts.dryRun) {
      await engine.executeRaw(
        `UPDATE sources SET last_sync_at = now() WHERE id = $1`,
        [opts.sourceId],
      );
    }
    // #3479 blocker 2: quiet runs bypass the failure gate below, and an
    // orphaned `<rename:…>` sentinel would otherwise sit open forever.
    // #3583 review: NOT under --dry-run — the sweep rewrites the failure
    // ledger, and this early return sits ABOVE the dry-run gate, so an
    // unguarded sweep here made a preview clear the operator's only wedge
    // signal. (The sibling site below already sits after the dry-run
    // return, and performFullSync's dry-run return precedes both of its
    // sweep sites.)
    if (!opts.dryRun) {
      await sweepOrphanedRenameSentinels(engine, opts.sourceId ?? DEFAULT_SOURCE_ID);
    }
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
      ...(uncommittedDrift ? { uncommitted: uncommittedDrift } : {}),
    };
  }

  if ((versionMismatch || versionNeverSet) && lastCommit === headCommit) {
    slog(
      `[sync] chunker_version gate: stored=${storedVersion ?? 'unset'}, current=${currentVersion}. ` +
      `Forcing full re-chunk pass (git HEAD unchanged but pipeline version advanced).`,
    );
    // #3583 gate13: NO unconditional version write here. performFullSync's
    // own gated advance writes the version exactly when the re-chunk
    // actually completed — writing it here acknowledged the version on a
    // BLOCKED run (losing the retry signal: the next run said up_to_date
    // and the failed re-walk never re-ran) and on a --dry-run PREVIEW
    // (persistent brain-state write from a preview).
    return await performFullSync(engine, fullSyncRoots, headCommit, opts);
  }

  // Diff using git diff (net result, not per-commit). v0.42.x (#1794): diff
  // against the PINNED target, not live HEAD. With a fixed (lastCommit, pin)
  // both endpoints are stable across every resume, so the manifest is
  // deterministic and resumeFilter maps cleanly onto completed paths.
  //
  // v0.42.42.0 (#2139): the diff + detached-working-tree merge now route
  // through `computeSyncDelta` (src/core/sync-delta.ts) — the SAME helper the
  // inline cost estimator uses, so the gate's dollar figure can't drift from
  // what this sync actually imports. `detachedWorkingTreeManifest` (computed
  // above for the `up_to_date` gate) is passed through to avoid recomputing it.
  //
  // #1970 (F-B): a non-ancestor diff against a wildly divergent tree (e.g. a
  // force-push to unrelated history) can exceed git()'s 30s timeout / 100 MiB
  // buffer, and a gc'd anchor object can't be diffed at all. On either
  // `unavailable`, fall back to the authoritative full reconcile instead of
  // throwing — a slow correct reconcile beats a hard error or a silent walk.
  const delta = computeSyncDelta(gitContextRoot, lastCommit, pin, {
    detachedManifest: importWorkingTree ? workingTreeManifest : null,
  });
  if (delta.status === 'unavailable') {
    serr(
      `[sync] delta ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} unavailable ` +
      `(${delta.reason}) — falling back to full reconcile.`,
    );
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }
  const manifest = delta.manifest;
  if (company) {
    manifest.added.push(...manifest.renamed.map(rename => rename.to));
    manifest.deleted.push(...manifest.renamed.map(rename => rename.from));
    manifest.renamed = [];
  }

  // Scope/exclude/isSyncable filter lambdas (`inScope`/`scopeRel`/`excluded`/
  // `syncOpts`) are hoisted above the up_to_date gate — the untracked-gap
  // drift counter shares them so both apply identical predicates.
  // #1970 (F-C): a rename whose DESTINATION is unsyncable drops out of BOTH
  // `renamed` (only `r.to` is kept below) AND `deleted` (git emits it as `R`,
  // not `D`), leaving the OLD page stale. Fold the source side into the delete
  // set. isSelectedForRun(r.from) excludes metafiles automatically, so a rename of a
  // metafile is left untouched (matching the #1433 metafile-skip invariant).
  // #774: a rename whose destination LEFT the scope is the same class — the
  // old page's backing file is gone from this source's slice of the repo.
  const renamedToUnsyncable = manifest.renamed
    .filter(r => inScope(r.from) && isSelectedForRun(r.from, syncOpts) &&
      !(inScope(r.to) && isSelectedForRun(r.to, syncOpts)) &&
      // A rename onto a NON-poison malformed destination (`foo.md` →
      // `notes [draft].md`) keeps the old row: the content still exists on
      // disk under the new name, it just can't re-import until renamed —
      // deleting the row here would be the rename-lane variant of the
      // reconcile data-loss class (codex re-review P1). Poisoned
      // destinations (`](`/control chars) still sweep.
      !(unsyncableReason(r.to, syncOpts) === 'malformed-path' && !isPoisonedPath(r.to)))
    .map(r => r.from);
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)),
    modified: manifest.modified.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)),
    deleted: unique([
      // 'malformed-path' deletions MUST still process: the classifier makes
      // junk filenames unsyncable, but their previously-ingested DB rows are
      // exactly what a delete event is supposed to remove — filtering them
      // out here would orphan those rows (searchable forever). Mirror of the
      // metafile carve-out, in the opposite direction.
      ...manifest.deleted.filter(p => inScope(p) &&
        (isSelectedForRun(p, syncOpts) || unsyncableReason(p, syncOpts) === 'malformed-path')),
      ...renamedToUnsyncable,
    ]),
    renamed: manifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSelectedForRun(r.to, syncOpts)),
  };

  // Surface malformed-filename skips: they were silently dropped from the
  // `filtered` manifest above, and a skip nobody can see reads as "synced".
  // Rename DESTINATIONS count too (the rename lane keeps the old row for
  // non-poison destinations, but the new name still can't import).
  const malformedSkipped = unique([
    ...[...manifest.added, ...manifest.modified]
      .filter(p => inScope(p) && unsyncableReason(p, syncOpts) === 'malformed-path'),
    ...manifest.renamed
      .filter(r => inScope(r.to) && unsyncableReason(r.to, syncOpts) === 'malformed-path')
      .map(r => r.to),
  ]);

  // #4342 'source-root' mode: translate the (git-root-relative) manifest to
  // SOURCE-relative paths so every downstream consumer — slugs, source_path,
  // deletes, renames, checkpoints — names pages the way `gbrain import
  // <local_path>` would. Under 'git-root' (or an unscoped sync) this is a
  // no-op and the pre-#4342 behavior is byte-for-byte. The file-join base
  // below (`syncImportRoot`) moves with it so `join(base, path)` still lands
  // on the same file.
  const sourceRootMode = scoped && slugRootMode === 'source-root';
  const syncImportRoot = sourceRootMode ? syncScopeRoot : gitContextRoot;
  /** Manifest path → the mode's canonical page path (slug/source_path base). */
  const modePath = (p: string): string => (sourceRootMode ? scopeRel(p) : p);
  if (sourceRootMode) {
    filtered.added = filtered.added.map(scopeRel);
    filtered.modified = filtered.modified.map(scopeRel);
    filtered.deleted = filtered.deleted.map(scopeRel);
    filtered.renamed = filtered.renamed.map(r => ({ from: scopeRel(r.from), to: scopeRel(r.to) }));
  }

  // Working-tree mass-delete valve: merged working-tree deletes bypass the
  // full-reconcile valve (#2828), but the hazard is the same — a transient
  // uncommitted tree state (mid-rebase checkout, accidental rm -rf) hit by a
  // scheduled --working-tree/config sync must not sweep the source. Same
  // ratio + same env escape hatch. Deletes are skipped loudly; adds and
  // modifies still import, and committing the deletions (or
  // GBRAIN_ALLOW_MASS_RECONCILE=1) re-enables them.
  if (importWorkingTree && !detachedHead && filtered.deleted.length >= 10 && !massReconcileAllowed()) {
    try {
      const rows = await engine.executeRaw<{ count: number }>(
        opts.sourceId
          ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
          : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
        opts.sourceId ? [opts.sourceId] : [],
      );
      const pageCount = Number(rows[0]?.count ?? 0);
      if (pageCount > 0 && filtered.deleted.length > pageCount * MASS_RECONCILE_RATIO) {
        serr(
          `\n  WARNING: refusing to delete ${filtered.deleted.length} page(s) from a working-tree ` +
          `sync (> ${Math.round(MASS_RECONCILE_RATIO * 100)}% of ${pageCount} page(s)). An uncommitted ` +
          `tree deleting this much is almost always transient (mid-rebase, accidental rm) — commit the ` +
          `deletions to apply them, or re-run with GBRAIN_ALLOW_MASS_RECONCILE=1. Adds/modifies still import.\n`,
        );
        filtered.deleted = [];
      }
    } catch { /* valve is best-effort — a count failure must not block the sync */ }
  }

  // NAV-4: warn when --exclude filtered out every candidate change — almost
  // always a mistyped pattern, and otherwise indistinguishable from
  // "up to date" in the output.
  if (opts.exclude && opts.exclude.length > 0) {
    const excludeCandidates = [...manifest.added, ...manifest.modified]
      .filter(p => inScope(p) && isSelectedForRun(p, syncOpts));
    if (excludeCandidates.length > 0 && excludeCandidates.every(excluded)) {
      console.warn(
        `[gbrain sync] No files matched after applying ${opts.exclude.length} --exclude pattern(s). ` +
        `Check your --exclude flags. Patterns: ${JSON.stringify(opts.exclude)}`,
      );
    }
  }

  const totalChanges = filtered.added.length + filtered.modified.length +
    filtered.deleted.length + filtered.renamed.length;

  // Dry run
  if (opts.dryRun) {
    slog(`Sync dry run: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
    if (filtered.added.length) slog(`  Added: ${filtered.added.join(', ')}`);
    if (filtered.modified.length) slog(`  Modified: ${filtered.modified.join(', ')}`);
    if (filtered.deleted.length) slog(`  Deleted: ${filtered.deleted.join(', ')}`);
    if (filtered.renamed.length) slog(`  Renamed: ${filtered.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}`);
    if (malformedSkipped.length) {
      slog(`  Skipped (malformed filename — brackets/control chars; rename to import): ${malformedSkipped.map(sanitizePathForDisplay).join(', ')}`);
    }
    if (totalChanges === 0) slog(`  No syncable changes.`);
    return {
      status: 'dry_run',
      malformedSkipped: malformedSkipped.length,
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  // Delete pages that became un-syncable (modified but filtered out).
  // v0.20.0 Cathedral II SP-5: resolveSlugForPath picks the right slug shape
  // (markdown vs code) based on the chunker's classifier, so a Rust file that
  // became un-syncable (e.g., moved under `.gitignore` or filtered by
  // strategy=markdown) deletes the actual code-slug page, not a ghost
  // markdown-slug that never existed.
  //
  // v0.41.13 (#1433): the original cleanup loop deleted EVERY pre-existing
  // page for unsyncable-modified paths, including `log.md`, `schema.md`,
  // `index.md`, `README.md` — files that fail `isSyncable` precisely
  // because they're metafiles by convention, not because the user
  // "removed" them from the strategy. infiniteGameExp's domain `log.md`
  // pages had been indexed by an older gbrain version (or via direct
  // put_page) and were silently dropped on every subsequent sync. The
  // fix uses `unsyncableReason` (factored from `isSyncable` so they
  // cannot drift) to skip the delete when the reason is `'metafile'`.
  //
  // Honest scope: this guard only fixes the `manifest.modified` case.
  // `manifest.deleted` is filtered upstream at sync.ts:757 via the same
  // `isSyncable` call, so `rm log.md` followed by sync also doesn't
  // delete the page. That's the same pre-fix behavior — removing the
  // page requires `gbrain pages purge-deleted` or a direct MCP delete.
  // Filed as v0.42+ follow-up for a `gbrain pages remove <slug>` surface.
  const unsyncableModified = manifest.modified.filter(p => inScope(p) && !isSelectedForRun(p, syncOpts));
  // v0.18.0+ multi-source: scope getPage + deletePage to opts.sourceId so
  // unsyncable cleanup in source A doesn't accidentally sweep same-slug
  // pages in sources B/C/D.
  const pageOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  // #4786: pages this loop retires count as `deleted` in the result (only rows
  // that actually transitioned), so a sweep-only run never reports up_to_date.
  const run = createSyncRun();
  run.swept = 0;
  for (const path of unsyncableModified) {
    // v0.41.13 #1433: never delete on metafile classification.
    // #2404 hardening: same for 'pruned-dir' — a page under a pruned
    // directory can only exist via a deliberate put_page (sync never
    // imports those paths), so "the file was modified" is not evidence
    // the page is stale. Deleting here silently destroyed put-created
    // pages every time their materialized file landed in a commit.
    const reason = unsyncableReason(path, syncOpts);
    if (reason === 'metafile' || reason === 'pruned-dir') continue;
    // Bare-bracket markdown (pre-gate imports like `notes [draft].md`) keeps
    // its row — only the poison signature (`](`/control chars) is sweepable.
    // Deleting a legit page's row while its file sits on disk is data loss.
    if (reason === 'malformed-path' && !isPoisonedPath(path)) continue;
    // #3942: guarded resolver — never delete a page whose recorded origin is
    // a DIFFERENT file just because this path re-slugifies onto its slug.
    // #4342: resolve in the mode's namespace (source-relative under
    // 'source-root'; git-root-relative otherwise).
    const slug = await resolveRemovedPathSlug(engine, modePath(path), opts.sourceId, serr);
    if (slug === undefined) continue;
    try {
      const existing = await engine.getPage(slug, pageOpts);
      if (existing) {
        // #3583 review: this loop sits ABOVE the dry-run return below, so
        // an unguarded delete made a preview under a narrower strategy
        // hard-delete previously-imported pages. A preview only reports.
        if (opts.dryRun) {
          slog(`  [dry-run] would delete un-syncable page: ${slug}`);
        } else {
          // #4587: soft-delete (72h recovery window) instead of hard delete.
          // Scope falls back to DEFAULT_SOURCE_ID to preserve deletePage's
          // old 'default' fallback; softDeletePages requires an explicit
          // sourceId. The purge phase owns the eventual hard delete.
          run.swept += (await softDeleteSyncPages(engine, [slug], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID })).length;
          slog(`  Soft-deleted un-syncable page (recoverable 72h): ${slug}`);
        }
      }
    } catch { /* ignore */ }
  }

  if (totalChanges === 0) {
    // #3068: same guard as the git-HEAD-equality gate above — a failed pull
    // plus zero imports must not produce a clean `up_to_date` (and must not
    // advance the anchor past commits this run never looked at remotely).
    // Reached when local-only commits landed with no syncable content while
    // the pull kept failing. Nothing is imported (the #4786 sweep above may
    // have soft-deleted pages — report it); the next sync re-diffs the same
    // trivial range and retries the pull.
    if (pullFailed) {
      serr(
        `[sync] git pull failed and no syncable changes imported — reporting partial ` +
        `(not up_to_date); sync anchor unchanged at ${lastCommit.slice(0, 8)}.`,
      );
      return buildPartialResult({
        fromCommit: lastCommit,
        toCommit: lastCommit,
        filesImported: 0,
        pagesAffected: [],
        chunksCreated: 0,
        added: 0, modified: 0, deleted: run.swept, renamed: 0,
        reason: 'pull_failed',
      });
    }
    // Update sync state even with no syncable changes (git advanced). v0.42.x
    // (#1794): advance to the PINNED target, and clear any checkpoint (a resume
    // whose remaining range turned out to have no syncable changes still
    // completes cleanly here).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(gitContextRoot, pin), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    if (!company) { await clearOpCheckpoint(engine, ckpt.paths); await clearOpCheckpoint(engine, ckpt.target); }
    // A commit whose ONLY changes are malformed filenames lands here with
    // totalChanges === 0 — the anchor advances past those files forever, so
    // this early return must surface the skips too (structured-review P2).
    if (malformedSkipped.length > 0) {
      serr(
        `  ${malformedSkipped.length} file(s) skipped: malformed filename ` +
        `(brackets/control chars; rename to import): ` +
        malformedSkipped.map(sanitizePathForDisplay).join(', '),
      );
    }
    // #3479 blocker 2: this early return also bypasses the failure gate —
    // sweep orphaned `<rename:…>` sentinels here too.
    await sweepOrphanedRenameSentinels(engine, opts.sourceId ?? DEFAULT_SOURCE_ID);
    return {
      status: run.swept > 0 ? 'synced' : 'up_to_date',
      fromCommit: lastCommit,
      toCommit: pin,
      added: 0, modified: 0, deleted: run.swept, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
      ...(malformedSkipped.length > 0 ? { malformedSkipped: malformedSkipped.length } : {}),
    };
  }

  const noEmbed = opts.noEmbed || totalChanges > 100;
  if (totalChanges > 100) {
    slog(`Large sync (${totalChanges} files). Importing text, deferring embeddings.`);
  }

  // v0.42.x (#1794): we have real work — persist the PIN now so a crash before
  // the first path-flush still resumes to THIS target (not re-pin to a newer
  // HEAD). recordCompleted is durable (executeRawDirect + retry); a false return
  // means the pool is genuinely dead. Nothing is imported yet, so we abort
  // cleanly (zero loss) rather than draining work we could never anchor — see
  // the !pinPersisted gate just after the partial() closure below.
  const pinPersisted = await recordCompleted(engine, ckpt.target, [pin]);

  // v0.42.x (#1794): durable, race-safe, bankable checkpoint state.
  //  - `completed`: the cross-run skip set (seeded from the resume load).
  //  - `pendingCheckpointPaths`: the not-yet-flushed delta (V4). Workers add to
  //    BOTH. The flush single-flight-swaps pending into an in-flight batch and
  //    re-merges it on failure, so no path is "banked" before a durable write.
  //  - cadence (D): flush after the FIRST file, then every `checkpointEvery`
  //    files OR every `checkpointSeconds` seconds — bounds worst-case loss
  //    regardless of import throughput.
  //  - fail-loud (C): `maxFlushFailures` consecutive failed flushes (each
  //    already retried ~12s by withRetry) set `checkpointDead`; the loops' abort
  //    checks then exit and partial() reports `checkpoint_unavailable`. A FLAG,
  //    not a throw — importOnePath's per-file catch would swallow a throw.
  const completed = new Set<string>(completedPaths);
  const pendingCheckpointPaths = new Set<string>();
  const checkpointSeconds = resolveSyncCheckpointSeconds();
  const maxFlushFailures = resolveSyncMaxCheckpointFailures();
  run.sinceFlush = 0;
  run.lastFlushAt = Date.now();
  run.consecutiveFlushFailures = 0;
  run.bankedFiles = completedPaths.length;
  run.flushing = false;
  run.checkpointDead = false;
  // Assigned at registration (after the pinPersisted gate); called on every
  // normal return so a later operation's SIGTERM doesn't fire this stale flush.
  run.deregisterCheckpointCleanup = () => {};
  const flushCheckpoint = async (): Promise<void> => {
    if (pendingCheckpointPaths.size === 0 || run.flushing) return;
    run.flushing = true;
    // Synchronous swap (atomic under single-threaded JS): take the current
    // pending set as this flush's batch; workers accumulate into a fresh set.
    const batch = [...pendingCheckpointPaths];
    pendingCheckpointPaths.clear();
    try {
      const ok = await appendCompleted(engine, ckpt.paths, batch);
      if (ok) {
        run.consecutiveFlushFailures = 0;
        run.bankedFiles += batch.length;
        opts.onProgress?.({ phase: 'import', bankedFiles: run.bankedFiles });
      } else {
        // Not durably banked — re-merge so the next flush retries this batch.
        for (const p of batch) pendingCheckpointPaths.add(p);
        if (++run.consecutiveFlushFailures >= maxFlushFailures) run.checkpointDead = true;
      }
    } finally {
      run.flushing = false;
    }
  };
  // v0.42.x (#1794): yield the event loop every N files so the refreshing-lock
  // heartbeat timer can fire mid-import (otherwise the CPU loop starves it and
  // the live lock gets stolen — the thrash this fixes).
  const yieldEvery = resolveSyncYieldEvery();
  run.sinceYield = 0;
  const maybeYield = async (): Promise<void> => {
    if (++run.sinceYield >= yieldEvery) {
      run.sinceYield = 0;
      // setTimeout(0), NOT setImmediate: the lock-refresh heartbeat is a
      // setInterval (timers phase). In Bun a tight setImmediate loop starves
      // the timers phase, so the heartbeat would never fire. setTimeout(0)
      // enters the timers phase where setInterval callbacks also run.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  };
  const markCompleted = async (path: string): Promise<void> => {
    completed.add(path);
    pendingCheckpointPaths.add(path);
    const dueByCount = ++run.sinceFlush >= checkpointEvery;
    const dueByTime = Date.now() - run.lastFlushAt >= checkpointSeconds * 1000;
    const firstFile = completed.size === 1; // bank early on a fresh run
    if (dueByCount || dueByTime || firstFile) {
      run.sinceFlush = 0;
      run.lastFlushAt = Date.now();
      await flushCheckpoint();
    }
  };

  const pagesAffected: string[] = [];
  // #1284: slugs deleted this run (delete loop, or renamed-away old slugs are
  // NOT pushed — only confirmed deletes land here). pagesAffected stays the
  // full manifest for extract/report paths, but the auto-embed at the end
  // must NOT be handed deleted slugs: embedPage throws 'Page not found' for
  // each one and serr-logs noise. A slug re-imported later in the same run
  // (delete + re-add) is removed from this set at its push site.
  const deletedSlugs = new Set<string>();
  // issue #1939: file paths that imported cleanly this run. The failure-ledger
  // gate clears these so a previously-failing file's `attempts` streak resets
  // on success (consecutive-failure semantics for the auto-skip valve).
  const succeededPaths: string[] = [];
  run.chunksCreated = 0;
  // v0.41.13.0 (T2): tracks add+modify files actually persisted so far.
  // Only bumped from inside importOnePath's success path. partial() reports
  // this as `filesImported` so cron operators can see how much work the
  // aborted run completed before --timeout fired.
  run.filesImported = 0;
  const start = Date.now();

  // v0.41.13.0 (T2 + D-V3-1): closure for the partial-return path.
  // v0.42.x (#1794): now ASYNC — it banks the unflushed delta before returning
  // so a clean --timeout/SIGINT abort doesn't drop the last sub-cadence batch
  // (best-effort; skipped when checkpointDead — the pool is gone). `reason` is
  // overridden to 'checkpoint_unavailable' when the checkpoint died, and
  // `bankedFiles` is surfaced so a killed run shows banked progress instead of
  // looking like total loss. toCommit reports the PINNED target; last_commit is
  // never advanced on a partial (the next run resumes from the checkpoint).
  const partial = async (reason: 'timeout' | 'pull_timeout' | 'stall_timeout'): Promise<SyncResult> => {
    run.deregisterCheckpointCleanup();
    if (!run.checkpointDead) {
      try { await flushCheckpoint(); } catch { /* best effort — we're aborting */ }
    }
    serr(
      `[sync] banked ${run.bankedFiles} file(s) this run; next 'gbrain sync' resumes from ` +
      `the checkpoint (last_commit unchanged at ${(lastCommit ?? '').slice(0, 8)}).`,
    );
    // db-availability loop (4b): a dead checkpoint IS a DB-access failure by
    // construction — the checkpoint writer only gives up after exhausting the
    // retry-matcher's connection-class retries (#1794), so `conn_dropped` is
    // asserted structurally, not parsed from an error. The marker lets the
    // bundled skills/db-repair skill pick this up from an agent-run sync.
    if (run.checkpointDead && shouldEmitDbAccessMarker()) {
      serr(`${DB_ACCESS_MARKER_PREFIX} conn_dropped`);
      serr('The sync checkpoint pool died mid-run. Run: gbrain db-repair');
    }
    return buildPartialResult({
      fromCommit: lastCommit,
      toCommit: pin,
      filesImported: run.filesImported,
      pagesAffected: [...pagesAffected],
      chunksCreated: run.chunksCreated,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length + run.swept,
      renamed: filtered.renamed.length,
      reason: run.checkpointDead ? 'checkpoint_unavailable' : reason,
      bankedFiles: run.bankedFiles,
    });
  };

  // v0.42.x (#1794): the pin write IS the mint of this run's checkpoint. If it
  // can't persist, the pool is dead and nothing has drained — abort with zero
  // loss; the next run retries the whole range (content_hash short-circuits).
  if (!pinPersisted) {
    serr('[sync] checkpoint target write failed (pool unavailable) — aborting before import; nothing drained, next run retries.');
    run.checkpointDead = true;
    return await partial('timeout'); // reason → checkpoint_unavailable
  }

  // v0.42.x (#1794): an external SIGTERM (watchdog/launcher timeout — the exact
  // incident shape) exits through process-cleanup, NOT this function's control
  // flow, so it would skip every flush and bank zero. Register a best-effort,
  // NO-RETRY one-shot flush of the unflushed delta (the registry's 3s deadline
  // is shorter than withRetry's ~12s budget, so a retrying flush would be cut
  // off). Flushes paths ONLY — never clears the checkpoint or advances
  // last_commit, so the D4 invariant holds. Deregistered on every normal return.
  run.deregisterCheckpointCleanup = registerCleanup('sync-checkpoint', async () => {
    await appendCompletedOnce(engine, ckpt.paths, [...pendingCheckpointPaths]);
  });

  // Per-file progress on stderr so agents see each step of a big sync.
  // Phases: sync.deletes, sync.renames, sync.imports.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // v0.41.19.0: hoisted out of the import block so the delete decompose
  // path (per-batch try-catch fallback) can append unrecoverable delete
  // failures here too. Same canonical surface that gates `sync.last_commit`
  // advancement at the bottom of this function.
  const failedFiles: Array<{ path: string; error: string; line?: number }> = [];

  // Alias-footgun visibility (schema.type_warnings, default on): aggregate
  // per-file type_warning results ONCE per distinct type per run — an
  // N-thousand-file sync must warn in O(distinct types) lines, not O(files).
  const typeWarningCounts = new Map<string, import('../../core/schema-pack/type-usage.ts').TypeWarningCount>();
  const noteTypeWarning = (w: { kind: 'alias_of' | 'undeclared'; type: string; canonical?: string; directory?: string } | undefined): void => {
    if (!w) return;
    const key = `${w.kind}\t${w.type}`;
    const cur = typeWarningCounts.get(key);
    if (cur) cur.count++;
    else typeWarningCounts.set(key, { ...w, count: 1 });
  };
  let typeWarningsEnabled = true;
  try {
    const v = await engine.getConfig('schema.type_warnings');
    typeWarningsEnabled = !(v === 'false' || v === '0' || v === 'off');
  } catch { /* config unavailable → default on */ }

  // v0.41.19.0 (T2/D6/D7/D16/D18 via /plan-eng-review + codex outside-voice):
  // batched delete loop. Replaces the per-file N+1 that PR #1538 originally
  // batched on Postgres only. See plan file:
  //   ~/.claude/plans/system-instruction-you-are-working-ethereal-narwhal.md
  // #4587: the lanes below SOFT-delete (deleted_at = now(), 72h recovery
  // window) via softDeletePages; the autopilot purge phase owns the eventual
  // hard delete and a re-import within the window revives via upsert.
  //
  // SHAPE (interleaved per-batch resolve + delete; caller owns chunking):
  //
  //   filtered.deleted (e.g. 73K paths)
  //       │
  //       ▼
  //   slice into batches of DELETE_BATCH_SIZE (500)
  //       │
  //       ▼  for each batch:
  //   abort-check ──► partial('timeout')
  //       │
  //       ▼
  //   resolveSlugsForRemovedPaths(batch)             ◀── exact source_path,
  //       │                                              then VERIFIED fallback;
  //       ▼                                              foreign-origin refusals
  //   slugs = deletable.map(...)                         (#3942) warned + skipped
  //       │
  //       ▼
  //   try {
  //     deleted = engine.softDeletePages(slugs, opts) ◀── 1 SQL round-trip
  //     pagesAffected.push(...deleted)                ◀── D6: only confirmed
  //   } catch {                                           transitions, not phantoms
  //     // D7 decompose: one-element softDeletePages per slug,
  //     // unrecoverable failures → failedFiles, run continues
  //   }
  //
  // ROUND-TRIP COUNTS (73K deletes):
  //   pre-fix:   73,000 SELECTs + 73,000 DELETEs = 146,000 (~5 hours)
  //   post-fix:     146 SELECTs +     146 UPDATEs =     292 (~2 minutes)
  //
  // ATOMICITY (D3): each batch is one transaction. A mid-batch abort or
  // transient connection failure rolls back up to DELETE_BATCH_SIZE - 1
  // successful deletes. Sync is idempotent — the next run picks them up
  // via git diff regenerating the deletion list.
  //
  // NO-SOURCEID FALLBACK: when opts.sourceId is undefined (legacy unscoped
  // callers, rare post-v0.34.1 source-resolution wiring), fall back to the
  // OLD per-path loop. The batch engine surface requires sourceId per D5
  // (multi-source-bug-class defense at the type level). Production callers
  // that thread sourceId via resolveSourceWithTier get the new fast path.
  // v0.42.x (#1794): resume-filter the delete set so a resumed run skips paths
  // already drained in a prior run (deletes are idempotent, but skipping avoids
  // re-resolving + re-deleting tens of thousands of already-gone pages).
  const deletesToDo = resumeFilter(filtered.deleted, [...completed]);
  if (deletesToDo.length > 0) {
    progress.start('sync.deletes', deletesToDo.length);
    if (opts.sourceId) {
      const sid = opts.sourceId;
      const deleteScopedOpts = { sourceId: sid };
      for (let i = 0; i < deletesToDo.length; i += DELETE_BATCH_SIZE) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial('timeout');
        }
        const batch = deletesToDo.slice(i, i + DELETE_BATCH_SIZE);

        // Phase A: guarded batch slug resolution (#3942 — a re-slugified
        // fallback can name a DIFFERENT page; refusals are logged + skipped).
        const resolution = await resolveSlugsForRemovedPaths(engine, batch, sid);
        for (const r of resolution.refused) {
          serr(refusedRemovedPathMessage(r));
          // Deliberately handled — checkpoint so a resume doesn't re-refuse.
          await markCompleted(r.path);
        }
        const deletable = batch.filter(p => resolution.slugs.has(p));
        const slugs = deletable.map(p => resolution.slugs.get(p) as string);

        // Phase B: batch soft-delete (1 round-trip per batch). #4587: the
        // removed-file drain honors the 72h recovery window — deleted_at is
        // set, the purge phase hard-deletes later, and a re-import within
        // the window revives via putPage's upsert.
        try {
          const deleted = await softDeleteSyncPages(engine, slugs, deleteScopedOpts);
          // D6: only push slugs that actually transitioned. Filters phantom
          // slugs (paths in filtered.deleted but with no DB row — or rows
          // already soft-deleted) so downstream extract/embed don't waste
          // lookups.
          pagesAffected.push(...deleted);
          for (const s of deleted) deletedSlugs.add(s);
          // v0.42.x (#1794): the whole batch is handled (soft-deleted,
          // already gone, or refused above); checkpoint every path so a
          // resume skips it.
          for (const p of deletable) await markCompleted(p);
        } catch (err) {
          // D7 decompose: a transient blip on this batch shouldn't lose all
          // 500 deletes. Fall back to one-element softDeletePages batches
          // for THIS batch only (per-slug isolation, same primitive);
          // unrecoverable per-slug failures land in failedFiles and the run
          // CONTINUES (--skip-failed semantics), matching the existing
          // import-loop pattern.
          for (let j = 0; j < slugs.length; j++) {
            try {
              await softDeleteSyncPages(engine, [slugs[j]], deleteScopedOpts);
              pagesAffected.push(slugs[j]);
              deletedSlugs.add(slugs[j]);
              await markCompleted(deletable[j]);
            } catch (perSlugErr) {
              failedFiles.push({
                path: deletable[j],
                error: `delete failed: ${perSlugErr instanceof Error ? perSlugErr.message : String(perSlugErr)} (batch error: ${err instanceof Error ? err.message : String(err)})`,
              });
            }
          }
        }
        progress.tick(batch.length, `deletes ${Math.min(i + DELETE_BATCH_SIZE, deletesToDo.length)}/${deletesToDo.length}`);
        await maybeYield();
      }
    } else {
      // Legacy no-sourceId path. The engine batch methods require sourceId
      // per D5 (kills the multi-source-bug-class on the new surface); when
      // sourceId is unset, fall back to the original per-path loop. Slow
      // but correct; production callers all thread sourceId so this branch
      // is functionally dead post-v0.34.1.
      for (const path of deletesToDo) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial('timeout');
        }
        // #3942: same guarded resolver as the batched lane (single-path call).
        const slug = await resolveRemovedPathSlug(engine, path, undefined, serr);
        if (slug === undefined) {
          await markCompleted(path);
          progress.tick(1, path);
          continue;
        }
        try {
          // #4587: soft-delete with the same 'default' fallback the old
          // optional-opts deletePage call applied on this legacy lane
          // (opts.sourceId is undefined here by construction).
          await softDeleteSyncPages(engine, [slug], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
          pagesAffected.push(slug);
          deletedSlugs.add(slug);
          await markCompleted(path);
        } catch (err) {
          failedFiles.push({
            path,
            error: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        progress.tick(1, slug);
      }
    }
    progress.finish();
  }

  // Process renames (updateSlug preserves page_id, chunks, embeddings).
  // SP-5: both old and new slugs use resolveSlugForPath so a .ts → .ts
  // rename (code→code), .md → .md (markdown→markdown), or cross-kind rename
  // all resolve to the right slug shape for each side.
  //
  // v0.41.19.0 (T4): pre-batched slug resolution per Phase 3 of the plan.
  // Renames' per-file cost is dominated by importFile() (file IO + chunking
  // + embedding), so the per-iteration updateSlug + importFile loop stays;
  // only the upfront slug-resolve N+1 gets batched. The try/catch around
  // updateSlug for slug-doesn't-exist preserves verbatim.
  // v0.42.x (#1794): resume-filter renames on the destination path.
  const renamesToDo = filtered.renamed.filter(r => !completed.has(r.to));
  if (renamesToDo.length > 0) {
    progress.start('sync.renames', renamesToDo.length);
    // v0.18.0+ multi-source: scope updateSlug so the rename only touches the
    // source-A row, not every same-slug row across sources (which would
    // either sweep them all OR violate (source_id, slug) UNIQUE).
    const renameOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;

    // #3583 review: lazily-built (at most once per run) tracked-file slug
    // index for the live-row filter in the reconcile below. A throw from the
    // index build surfaces inside the reconcile's own try/catch, where it
    // records the `<rename:…>` sentinel — fail-closed, never a guessed delete.
    // Liveness = tracked in the git index, deliberately NOT "present on
    // disk": sync's ground truth is git, and in a sparse/partial checkout a
    // tracked file is intentionally absent from the working tree — an
    // on-disk check would misclassify its live page as stale and delete it,
    // the same failure shape this filter exists to prevent.
    // Three-way verdict, not boolean: when the index is incomplete (an
    // unreadable fallback-regime file — see trackedSlugIndex), an index miss
    // proves nothing, so the row is spared as 'unknown' rather than deleted.
    let treeSlugIndex: TrackedSlugIndex | undefined;
    const slugLiveness = (s: string, from: string): 'live' | 'stale' | 'unknown' => {
      // lastCommit = the commit the brain reflects; its blob is one of the
      // consulted content states (see fallbackSlugsForFile). Anchor paths
      // are keyed through modePath so they compare against `from` under
      // #4342 source-root mode too.
      treeSlugIndex ??= trackedSlugIndex(gitContextRoot, lastCommit, modePath);
      if (treeSlugIndex.slugs.has(s)) {
        // #4597: when the ONLY liveness proof is the anchor blob at THIS
        // rename's own from-path, that proof is the pre-rename state of the
        // file just re-imported at `to` (the reconcile only runs once the
        // destination materialized) — the exact duplicate it exists to
        // remove. Sparing it checkpointed the rename as converged, so the
        // duplicate never re-entered an incremental diff. Any current-tree
        // hit, or anchor proof from a DIFFERENT path (the #3583 data-loss
        // shapes), still spares the row.
        const onlyAt = treeSlugIndex.anchorOnlyPaths.get(s);
        if (!onlyAt || ![...onlyAt].every(p => p === from)) return 'live';
      }
      return treeSlugIndex.complete ? 'stale' : 'unknown';
    };

    // #3583 review (GATE6): the old slug of EVERY rename in this diff. A
    // row can be CARRIED by a different rename in the same diff whose
    // destination derives no slug (ordinary path → exotic path, frontmatter
    // absent): no current path, blob, or anchor state names its slug, but
    // the rename pair itself proves the content is still tracked. The
    // reconcile of rename R therefore spares candidates that are ANOTHER
    // rename's old slug; R's OWN old slug stays deletable — that is
    // exactly the duplicate the reconcile exists to remove once the
    // destination materializes. Built over the RAW manifest — not the
    // scope/exclude/resume-filtered list — so a carried row is protected
    // even when its own rename was filtered out of processing (an
    // --exclude'd or out-of-scope destination still proves the content is
    // tracked; registration is purely spare-side).
    // Each from-path maps to a SET of slugs, never one: source_path is
    // non-unique, so a DB resolve can return an UNRELATED row's slug
    // (stale bookkeeping naming the same path) and silently displace the
    // path-derived slug the carried-spare depends on — the carried row
    // then lost its protection and the GATE6 delete came back. The set
    // always holds the path-derived slug (when the path derives one)
    // PLUS every active row's slug under that source_path; registration
    // is purely spare-side, so over-inclusion only delays a cleanup.
    // Spare-side only: a resolve failure merely shrinks the DB half of the
    // set, and the path-derived entries still protect the carried row.
    let dbSlugsByFrom = new Map<string, string[]>();
    try {
      dbSlugsByFrom = await activeSlugsBySourcePath(
        engine, manifest.renamed.map(r => r.from), opts.sourceId ?? DEFAULT_SOURCE_ID,
        opts.signal,
      );
    } catch { /* see above — both consumers degrade safely */ }
    const renameOldSlugs = new Map<string, Set<string>>();
    for (const r of manifest.renamed) {
      const shapes = new Set<string>();
      const derived = resolveSlugForPath(r.from);
      if (derived !== '') shapes.add(derived);
      for (const s of dbSlugsByFrom.get(r.from) ?? []) shapes.add(s);
      renameOldSlugs.set(r.from, shapes);
    }

    // T4: pre-resolve ALL `from` slugs in batches before iterating. Falls
    // back to the guarded per-path resolver when sourceId is unset. For
    // large rename commits (rare but possible: prefix sweep, reorganization),
    // this drops the slug-resolve round-trips from O(renames) to O(renames/500).
    //
    // #3942: routed through resolveSlugsForRemovedPaths (same guarded
    // resolver the delete lane uses) instead of a raw resolveSlugsByPaths +
    // unguarded resolveSlugForPath fallback — a re-slugified fallback can
    // name a page whose recorded origin is a DIFFERENT file (e.g. a
    // trailing-hyphen collision). A refused from-path gets no entry in
    // fromSlugByPath, so the rename below skips the cheap updateSlug and
    // falls through to add + reconcile instead of repointing that page.
    const fromSlugByPath = new Map<string, string>();
    if (opts.sourceId) {
      const sid = opts.sourceId;
      const fromPaths = renamesToDo.map(r => r.from);
      for (let i = 0; i < fromPaths.length; i += DELETE_BATCH_SIZE) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial('timeout');
        }
        const batch = fromPaths.slice(i, i + DELETE_BATCH_SIZE);
        const resolution = await resolveSlugsForRemovedPaths(engine, batch, sid);
        for (const r of resolution.refused) serr(refusedRemovedPathMessage(r));
        for (const [p, s] of resolution.slugs) fromSlugByPath.set(p, s);
      }
    }

    // Is a `<rename:…>` sentinel for this destination already open from an
    // earlier run? Read once per run: the ledger is only rewritten at the
    // gate, after this loop.
    const openRenameSentinels = new Set(
      loadSyncFailures()
        .filter(f => f.source_id === (opts.sourceId ?? DEFAULT_SOURCE_ID) && f.state === 'open')
        .map(f => f.path),
    );
    const renameSentinelAlreadyOpen = (to: string): boolean =>
      openRenameSentinels.has(renameSentinelPath(to));

    for (const { from, to } of renamesToDo) {
      // v0.41.13.0 (T2 / D-V4-2): per-iteration abort check. Renames call
      // importFile() at line 1173-style sites which can be slow on big files;
      // refactor commits with 200+ renames must respect --timeout.
      if (opts.signal?.aborted) {
        progress.finish();
        return await partial('timeout');
      }
      // T4: the batch-resolved slug for `from` (see fromSlugByPath above). A
      // refused/unresolved from-path has no entry, so this is undefined
      // rather than falling back to an unverified derived slug.
      //
      // #3942: the no-sourceId lane is scoped to DEFAULT_SOURCE_ID (not
      // left unscoped) — updateSlug below only ever touches the
      // default-scoped row (renameOpts is undefined here, and updateSlug
      // defaults its own sourceId to 'default'), so the read that decides
      // what to rename must agree with that scope. An unscoped resolve
      // could otherwise return a DIFFERENT source's row sharing this
      // source_path, licensing the wrong (or a foreign) slug for a
      // default-scoped rename.
      const oldSlug = opts.sourceId
        ? fromSlugByPath.get(from)
        : await resolveRemovedPathSlug(engine, from, DEFAULT_SOURCE_ID, serr);
      // The new path doesn't yet have a row, so resolve from path only.
      const newSlug = resolveSlugForPath(to);
      // #3056: the cheap rename is OBSERVED, not assumed. A zero-row UPDATE
      // doesn't throw, and a thrown collision used to be swallowed by an
      // empty catch — both fell through to importFile, which created/updated
      // the row at the new path while the old row stayed behind live. Both
      // shapes now fall through to the reconcile below.
      let renameApplied = false;
      if (oldSlug !== undefined) {
        try {
          renameApplied = (await engine.updateSlug(oldSlug, newSlug, renameOpts)) > 0;
        } catch {
          // Destination slug occupied or invalid — treat as add; the
          // reconcile below removes the stale old row once the destination
          // materialized.
        }
      }
      if (renameApplied) {
        // #3583 gate13: the cheap rename moves the ROW but updateSlug never
        // rewrites source_path — and the unchanged-content reimport below is
        // a no-write skip, so the stale bookkeeping survived indefinitely
        // and the full-sync purge later read it as "source file removed"
        // and hard-deleted the LIVE renamed page. Repair the bookkeeping at
        // the moment the rename lands. Best-effort, and nothing downstream
        // covers a miss: rows renamed BEFORE this repair — and rows whose
        // repair query fails — keep the stale path and stay exposed to the
        // full-sync purge exactly as they are on master. That exposure is
        // pre-existing (verified against the merge base) and out of scope
        // here; this repair stops the shape being manufactured going
        // forward.
        try {
          // Scope EXACTLY the way updateSlug scoped the move it repairs:
          // no sourceId means the DEFAULT source, never every source — an
          // unqualified UPDATE rewrote a matching (slug, source_path) row
          // in ANOTHER source, and that source's later fallback reconcile
          // probed the rewritten path, found nothing, and advanced without
          // its rename sentinel (gate 14).
          await engine.executeRaw(
            `UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3 AND source_path = $4`,
            [to, opts.sourceId ?? DEFAULT_SOURCE_ID, newSlug, from],
          );
        } catch { /* bookkeeping only — never fail the rename over it */ }
      }
      // Reimport at new path (picks up content changes). Wrapped to match the
      // deletes/adds loops: a malformed renamed file is recorded to failedFiles
      // and skipped, NOT thrown uncaught. importFile still throws on content
      // sanity-block, duplicate-slug, and missing-link endpoints; an uncaught
      // throw here crashes the whole sync mid-run and freezes the checkpoint,
      // defeating --skip-failed. A `skipped` result carrying an error is also
      // captured so the failure is recorded rather than silently dropped.
      // Paths from git diff are relative to gitContextRoot — except under
      // #4342's 'source-root' mode, where the filtered manifest (this loop's
      // source) was remapped scope-relative; the join base moves with it.
      // NAV-1 TOCTOU: refuse a destination that realpath-resolves outside the
      // repo (committed symlink pointing out).
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `to` is a git-diff rename path from the synced repo (repo content can be hostile), but the joined path is used ONLY inside the isPathSafe(filePath, gitContextRoot) realpath containment check on the next line — a path escaping the repo root (dot-dot or committed symlink) is refused before any read
      const filePath = join(syncImportRoot, to);
      let importResult: Awaited<ReturnType<typeof importFile>> | undefined;
      // #2683 residual: a failed destination import (status 'error' OR a
      // throw) must not checkpoint `to` — the resume filter would skip the
      // rename forever, leaving the target permanently unimported.
      let importErrored = false;
      if (existsSync(filePath) && isPathSafe(filePath, gitContextRoot)) {
        try {
          // #2683: dispatch renamed images to importImageFile (binary bytes
          // through importFile threw UTF-8 errors). Same gate as import.ts.
          const result = isImageImportPath(to) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
            ? await importImageFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId })
            : await importFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack });
          importResult = result;
          noteTypeWarning(result.type_warning);
          if (result.status === 'imported') run.chunksCreated += result.chunks;
          else if (result.status === 'skipped' && result.skip_reason === 'malformed_path') {
            // Informational skip — a bracket/control-char filename can never
            // import; counting it as a failure would gate the bookmark forever.
            serr(`  Skipped (malformed filename): ${sanitizePathForDisplay(to)}`);
          } else if (result.status === 'skipped' && (result as { error?: string }).error) {
            // An errored skip (frontmatter slug-authority rejection, invalid
            // YAML, symlink refusal, oversize file, ...) means the
            // destination never materialized — same as status 'error' below,
            // this must gate the success sentinel + markCompleted(to), or a
            // resumed sync would treat the rename as permanently done.
            importErrored = true;
            failedFiles.push({ path: to, error: String((result as { error?: string }).error) });
          } else if (result.status === 'error') {
            // importImageFile (and importFile's frontmatter gate) report
            // failures as status 'error', which no branch above recorded —
            // the rename silently succeeded with a dead target.
            importErrored = true;
            failedFiles.push({ path: to, error: String((result as { error?: string }).error ?? 'import error') });
          }
        } catch (e: unknown) {
          importErrored = true;
          failedFiles.push({ path: to, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // #3056 reconcile: the rename fell back to add semantics, so the row
      // that still represents the OLD path is the stale half of the rename
      // (git reported the old path gone; a plain delete of that path would
      // remove this row). Two safety rails, both from the #3252 review:
      //
      //   1. Delete only after the destination demonstrably materialized —
      //      `imported`, or an errorless `skipped` AT the new slug. Identity
      //      dedup can skip against the OLD row (result.slug === oldSlug),
      //      in which case nothing landed at newSlug and deleting the old
      //      row would destroy the only copy.
      //   2. Locate the stale row POSITIVELY by `source_path = from`, never
      //      by the oldSlug guess — after a collision, a path-derived
      //      fallback slug could name an unrelated (e.g. manually curated)
      //      row. No source_path match → nothing is deleted (code pages
      //      imported before `importCodeFile` wrote `source_path` (#4900)
      //      still carry NULL until their next import and fall back safely
      //      to leaving the old row rather than guessing).
      //
      // A failed delete records a `<rename:…>` SENTINEL (not an ordinary
      // path failure): the gate hard-blocks the bookmark, and — unlike a
      // plain path row — the auto-skip valve can never chronic-skip it after
      // N attempts, which would advance the bookmark and make a transient
      // delete outage a permanent duplicate. The sentinel clears through the
      // ordinary success path once the rename converges on a later run.
      let reconcileFailed = false;
      if (!renameApplied && importResult !== undefined) {
        const destMaterialized = importResult.status === 'imported' ||
          (importResult.status === 'skipped' && !importResult.error && importResult.slug === newSlug);
        if (destMaterialized) {
          // Hoisted above the try so the failure record can name the exact
          // row `gbrain delete` should remove when the DELETE itself failed
          // (still unknown — recorded as `?` — when the probe threw first).
          //
          // ACTIVE rows only, considering EVERY row with the old path:
          // source_path is non-unique, and a one-row resolve could hand back
          // a soft-deleted row while a live duplicate sharing the path hides
          // behind it (#3479 review). Skipping already-soft-deleted rows is
          // also what makes `gbrain delete` (a soft delete) the documented
          // operator exit from a permanent delete-failure wedge (blocker 1):
          // retrying the hard delete against a row the operator already
          // removed would just re-fail and keep the sync blocked.
          // Rows whose CURRENT slug a working-tree file still derives to are
          // LIVE, not stale, and are filtered out before any delete (#3583
          // review) — so `staleSlug` below (and the sentinel/remedy text it
          // feeds) can only ever name a genuinely-stale row.
          let staleSlug: string | undefined;
          try {
            const active = await activeSlugsBySourcePath(
              engine, [from], opts.sourceId ?? DEFAULT_SOURCE_ID,
            );
            // #3583 review (data-loss blocker): `source_path = from` also
            // matches LIVE pages — after an ordinary cheap rename the
            // surviving row keeps the OLD path (updateSlug never rewrites
            // source_path; an unchanged-content re-import writes nothing).
            // Delete only rows whose CURRENT slug no tracked file derives
            // to; spare the rest — 'live' when a tracked file still derives
            // to the slug, 'unknown' when staleness could not be proven.
            const candidates = (active.get(from) ?? []).filter(s => s !== newSlug);
            const staleSlugs: string[] = [];
            const unprovable: string[] = [];
            for (const s of candidates) {
              // Carried by ANOTHER rename in this diff (see renameOldSlugs):
              // its content is still tracked even when no slug state names
              // it anymore — never a reconcile target of THIS rename.
              let carriedByOtherRename = false;
              for (const [rFrom, rOldSlugs] of renameOldSlugs) {
                if (rFrom !== from && rOldSlugs.has(s)) { carriedByOtherRename = true; break; }
              }
              if (carriedByOtherRename) {
                serr(
                  `  [sync] rename reconcile: skipping row ${s} — another rename in ` +
                  `this diff still carries it (source_path ${from} is stale bookkeeping).`,
                );
                continue;
              }
              const verdict = slugLiveness(s, from);
              if (verdict === 'live') {
                serr(
                  `  [sync] rename reconcile: skipping live row ${s} — a tracked ` +
                  `file still derives to it (source_path ${from} is stale bookkeeping).`,
                );
              } else if (verdict === 'unknown') {
                // An unreadable tracked file could own this slug, so the row
                // is NOT deleted. What happens to the RENAME depends on
                // whether it was already unresolved (see the check after this
                // loop): a first unprovable run is accepted and banks
                // normally — the usual cause is a live row whose slug merely
                // could not be read (content filter, shallow clone, sparse
                // checkout, over-size file), where nothing is pending — but a
                // rename that already carries an open sentinel is not
                // retired on this evidence.
                unprovable.push(s);
                serr(
                  `  [sync] rename reconcile: cannot prove row ${s} stale — an ` +
                  `unreadable tracked file could still own this slug, so it is ` +
                  `spared rather than deleted.`,
                );
              } else {
                // Established bookkeeping cleanup (#3056 → gate 6): a stale
                // claimant is exactly the duplicate the reconcile exists to
                // remove once the destination materialized.
                staleSlugs.push(s);
              }
            }
            if (staleSlugs.length > 0) {
              // Delete every genuinely-stale active row still carrying the
              // old path — with a non-unique source_path there can be more
              // than one, and the rename is checkpointed after this loop, so
              // a survivor would never be retried (#3479 review, the ORDER BY
              // finding).
              //
              // Post-review note: the `slugLiveness(s)` verdict above and this
              // `deletePage` are not one atomic operation — `deletePage` takes
              // only `slug`, not a row id or updated_at, so it can't express
              // "delete iff still the row I just proved stale". Under
              // `performSync`'s per-source writer lock this window is closed
              // for every normal caller (no other sync/import for this source
              // can run concurrently); it only opens for a write that bypasses
              // the lock entirely (e.g. a direct `put_page` racing this run).
              // Closing it for real needs a conditional DELETE (id/source_path/
              // updated_at) added to `BrainEngine.deletePage` on both engines —
              // out of scope for this fix; tracked as a known gap rather than
              // silently assumed safe.
              for (const s of staleSlugs) {
                staleSlug = s;
                // #4587: soft-delete the stale claimant (72h recovery) —
                // candidates come from activeSlugsBySourcePath, so every s
                // is an ACTIVE row and the flip always applies. Same scope
                // fallback updateSlug/renameOpts use ('default' when the
                // caller threads no sourceId).
                await softDeleteSyncPages(engine, [s], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
                deletedSlugs.add(s); // never hand a deleted slug to auto-embed
                serr(`  [sync] rename reconciled: soft-deleted stale row ${s} (recoverable 72h; ${from} -> ${to} fell back to add).`);
              }
            } else if (candidates.length > 0) {
              serr(`  [sync] rename fallback: every active row with source_path ${from} was spared (live or unprovable); nothing stale to reconcile.`);
            } else {
              serr(`  [sync] rename fallback: no active row has source_path ${from}; nothing left to reconcile.`);
            }
            if (unprovable.length > 0 && renameSentinelAlreadyOpen(to)) {
              // Provably-stale rows above were still removed; these were not
              // provable either way. On its own that is an accepted cost (see
              // the verdict comment). But an EARLIER run already recorded a
              // `<rename:…>` sentinel for this rename, so convergence has been
              // denied before — and falling through would hand that sentinel
              // to the success path, which the gate clears before it decides.
              // Clearing a non-convergence marker requires proof of
              // convergence, and 'unprovable' is not proof.
              // Deliberately NOT named: `staleSlug` feeds the sentinel's
              // "stale row X" slot and the blocked-run remedy tells the
              // operator to `gbrain delete X`. An unprovable row may well be
              // LIVE — that is the whole reason it was spared — so naming one
              // here would tell the operator to delete a page this very code
              // just refused to delete. Clearing it also drops whatever
              // actionable slug an earlier failure had recorded. `undefined`
              // renders as `?`, which is the truth: not known.
              staleSlug = undefined;
              throw new Error(
                `staleness unprovable for ${unprovable.length} row(s) ` +
                `(${unprovable.join(', ')}): the tracked-file slug index is ` +
                `incomplete, so no index miss proves a row stale, and this ` +
                `rename was already unresolved. Fix or remove the unreadable ` +
                `tracked file and re-run.`,
              );
            }
          } catch (e: unknown) {
            reconcileFailed = true;
            failedFiles.push({
              path: renameSentinelPath(to),
              error: renameReconcileErrorMessage(
                from, staleSlug, e instanceof Error ? e.message : String(e),
              ),
            });
          }
        } else {
          serr(
            `  [sync] rename fallback: ${from} -> ${to} did not materialize at ${newSlug} ` +
            `(import ${importResult.status}); old row left in place.`,
          );
        }
      }
      // Converged (cheap rename, clean reconcile, or nothing to reconcile):
      // clear any `<rename:…>` sentinel a previous failing run recorded.
      // A run that spared an UNPROVABLE row reaches here too — that is the
      // accepted cost of never deleting without proof — EXCEPT when this
      // rename already had a sentinel open, which the reconcile turns into
      // a failure above precisely so this line cannot retire it. #2683
      // residual (#4496): a failed destination import likewise cannot retire
      // the sentinel — the rename did not converge.
      if (!reconcileFailed && !importErrored) succeededPaths.push(renameSentinelPath(to));
      pagesAffected.push(newSlug);
      deletedSlugs.delete(newSlug); // #1284: rename landed on a previously-deleted slug → embeddable again
      // A failed reconcile OR a failed destination import must NOT checkpoint:
      // banking `to` would make the resume filter skip this rename on the
      // retry run — a permanent duplicate (reconcile) or a permanently
      // unimported target (import error) — the exact bug class being fixed.
      if (!reconcileFailed && !importErrored) await markCompleted(to);
      progress.tick(1, newSlug);
    }
    progress.finish();
  }

  // Process adds and modifies.
  //
  // NOTE: do NOT wrap this loop in engine.transaction(). importFromContent
  // already opens its own inner transaction per file, and PGLite transactions
  // are not reentrant — they acquire the same _runExclusiveTransaction mutex,
  // so a nested call from inside a user callback queues forever on the mutex
  // the outer transaction is still holding. Result: incremental sync hangs in
  // ep_poll whenever the diff crosses the old > 10 threshold that used to
  // trigger the outer wrap. Per-file atomicity is also the right granularity:
  // one file's failure should not roll back the others' successful imports.
  //
  // v0.15.2: per-file progress on stderr via the shared reporter.
  // Bug 9: per-file failures captured in `failedFiles` so the caller can
  // gate `sync.last_commit` advancement and record recoverable errors.
  // v0.41.19.0: `failedFiles` is now hoisted above the delete loop (the
  // delete decompose path appends here too); kept as a comment-pin so
  // future maintainers know to thread additional failure surfaces through
  // the same array.
  const addsAndMods = [...filtered.added, ...filtered.modified];

  // Sort newest-first so date-prefixed brain paths get embedded before older
  // ones. See src/core/sort-newest-first.ts for the policy.
  sortNewestFirst(addsAndMods);

  // v0.42.x (#1794): resume-filter the import set so a resumed run only
  // processes files it hasn't already drained. This is the convergence win —
  // a killed run banks `completed`, the next run skips it (no per-file disk
  // read or content_hash DB lookup for done files).
  const importsToDo = resumeFilter(addsAndMods, [...completed]);

  // v0.22.13 (PR #490 Q5): one source of truth for the concurrency decision.
  // engine.kind === 'pglite' → forced 1; explicit opts.concurrency wins;
  // auto path returns DEFAULT_PARALLEL_WORKERS only when fileCount > 100.
  const explicitConcurrency = opts.concurrency !== undefined;
  let effectiveConcurrency = autoConcurrency(engine, importsToDo.length, opts.concurrency);
  // v0.42.x (#1794, 4A): clamp the worker fan-out under GBRAIN_MAX_CONNECTIONS
  // (opt-in; no-op when unset). The parent engine holds ~resolvePoolSize()
  // connections; each parallel worker opens its own pool of
  // min(2, resolvePoolSize(2)). When the budget can't fit even one extra
  // worker, the clamp returns 1 and we fall through to the serial path
  // (parent pool only). The doctor `pool_budget` nudge covers the case where
  // the parent pool alone already exceeds the budget.
  const maxConnections = resolveMaxConnections();
  if (maxConnections !== undefined && engine.kind !== 'pglite') {
    const { resolvePoolSize } = await import('../../core/db.ts');
    const parentPool = resolvePoolSize();
    const perWorkerPool = Math.min(2, resolvePoolSize(2));
    const clampResult = clampWorkersForConnectionBudget(effectiveConcurrency, {
      maxConnections,
      parentPool,
      perWorkerPool,
    });
    if (clampResult.clamped) {
      serr(
        `  [sync] GBRAIN_MAX_CONNECTIONS=${maxConnections}: clamped workers ` +
        `${effectiveConcurrency} -> ${clampResult.workers} ` +
        `(parent ${parentPool} + ${clampResult.workers}x${perWorkerPool} per-worker).`,
      );
    }
    effectiveConcurrency = clampResult.workers;
  }
  const runParallel = shouldRunParallel(effectiveConcurrency, importsToDo.length, explicitConcurrency);

  if (importsToDo.length > 0) {
    progress.start('sync.imports', importsToDo.length);

    // Core import logic shared by serial and parallel paths.
    // Paths from git diff are relative to gitContextRoot; under #4342's
    // 'source-root' mode the filtered manifest was remapped scope-relative,
    // so the join base moves to syncScopeRoot with it.
    const syncRepoPath = syncImportRoot;
    // paced-backfill (T3 / C9 / CX4): ONE shared pacer across all worker
    // engines. This is the multi-pool permit case — each parallel worker owns a
    // separate PostgresEngine, so a single worker count can't bound TOTAL
    // concurrent writes; the shared acquire() permit caps them. No-op when
    // pacing is off. Resolved env > config > bundle (env = incident escape
    // hatch); fail-open so pacing never breaks a sync.
    let pacer: DbPacer = createNoopPacer();
    try {
      const pcfg = await loadPaceModeConfig(engine);
      const { envMode, envOverrides } = readPaceEnv();
      const knobs = resolvePaceMode({
        mode: pcfg.mode,
        configOverrides: pcfg.configOverrides,
        envMode,
        envOverrides,
      });
      if (knobs.enabled) pacer = createDbPacer({ bundle: knobs });
    } catch {
      pacer = createNoopPacer();
    }

    // #1950: progress-aware stall watchdog for the import drain. The incident
    // was a sync wedged ~29min while ALIVE — so the lock heartbeat kept
    // refreshing (it fires on its own timer) and the wall-clock deadline hadn't
    // hit yet, leaving only a manual `pkill`. This keys off FORWARD IMPORT
    // PROGRESS (progress.tick below bumps `progressAt`), not the heartbeat: if no
    // file completes for `resolveStallAbortSeconds()`, abort. The abort signal is
    // composed into `opts.signal`, so the existing per-iteration abort checks,
    // pacer.acquire/pace, and parallel-worker break-loops all observe it; the
    // drain returns partial() (last_commit unchanged, next run resumes from the
    // checkpoint) and withRefreshingLock's finally releases the lock. Limits
    // (TODOS: #1950 follow-up — thread a cancellation signal through importFile):
    // the abort is observed BETWEEN files (the per-iteration checks + the next
    // importOnePath's pre-acquire check), so a hang INSIDE a single importFile
    // call is not interrupted until that call returns — the watchdog fires and
    // logs, but the in-flight file finishes (or the wall-clock hard deadline is
    // the eventual backstop). This catches the documented #1950 incident shape
    // (a slow-but-progressing drain, many files) and a stalled between-file
    // drain; a single wedged file or a fully starved event loop is out of scope
    // here. stallAborted distinguishes this from a user --timeout/SIGINT so the
    // partial result reports `stall_timeout`, not `timeout`.
    const stallSeconds = resolveStallAbortSeconds();
    const progressAt = { last: Date.now() };
    run.stallAborted = false;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    if (stallSeconds > 0) {
      const stallMs = stallSeconds * 1000;
      const stallController = new AbortController();
      stallTimer = setInterval(() => {
        if (Date.now() - progressAt.last >= stallMs) {
          serr(
            `[sync] no import progress for ${stallSeconds}s — aborting (stall watchdog). ` +
            `The per-source lock will release; the next 'gbrain sync' resumes from the checkpoint.`,
          );
          run.stallAborted = true;
          stallController.abort();
        }
      }, Math.min(5000, stallMs));
      // Don't keep the process alive on the watchdog alone.
      (stallTimer as unknown as { unref?: () => void }).unref?.();
      opts = { ...opts, signal: composeAbortSignals(opts.signal, stallController.signal) };
    }

    async function importOnePath(eng: BrainEngine, path: string): Promise<void> {
      const filePath = join(syncRepoPath, path);
      if (!company && !existsSync(filePath)) {
        // v0.42.x (#1794, Codex #3): the diff is against the PINNED target, but
        // importFile reads the live working tree. A file added in lastCommit..pin
        // that's gone from disk was deleted by a commit AFTER the pin (normal
        // forward progress from the enrich process). It genuinely doesn't exist
        // at live HEAD, so there's nothing to import — SKIP and mark it
        // completed rather than failing the run. The post-loop pin-reachability
        // gate catches a real history REWRITE (the dangerous drift); a benign
        // forward delete is handled by the next sync's pin..HEAD diff (which
        // will show this path deleted). The pre-v0.42 "record as failure" was
        // correct only when the gate compared HEAD == captured; under pinning a
        // forward delete must not block.
        await markCompleted(path);
        // issue #1939 adversarial finding #1: a file that previously failed to
        // parse (open ledger row) and is now gone from disk is resolved — clear
        // its row so it can't age doctor to a permanent FAIL. (This covers the
        // net-zero add-then-delete range where the path isn't in filtered.deleted.)
        succeededPaths.push(path);
        progressAt.last = Date.now(); // #1950: forward progress → reset stall watchdog
        progress.tick(1, `skip:${path}`);
        return;
      }
      // #774 NAV-1 TOCTOU: re-validate the file's realpath at import time so a
      // committed symlink pointing outside the repo (or one swapped in after
      // the scope-entry check) is never read. Recorded as a failure —
      // fail-closed: the bookmark won't advance past a symlink escape.
      if (!company && !isPathSafe(filePath, gitContextRoot)) {
        failedFiles.push({ path, error: 'path resolves outside git repo (symlink escape)' });
        progressAt.last = Date.now();
        progress.tick(1, `skip:${path}`);
        return;
      }
      // v0.41.37.0 #1569: per-file BEGIN heartbeat, emitted BEFORE importFile so a
      // hang names the stalling file (the progress.tick below only fires AFTER
      // importFile returns — useless when one file wedges). Off by default
      // (GBRAIN_SYNC_TRACE=1) to avoid a line per file on huge brains. serr is
      // source-prefix-aware, so under --workers>1 / --all the stuck file is the
      // begin-line with no matching completion in the in-flight set.
      if (process.env.GBRAIN_SYNC_TRACE) serr(`[sync] begin import: ${path}`);
      // paced-backfill: acquire a DB-write permit (caps total concurrent writes
      // across all worker engines). Throws AbortError on cancel while waiting —
      // treat as a clean skip; the worker loop sees signal.aborted next tick.
      let permit;
      try {
        permit = await pacer.acquire(opts.signal);
      } catch (e) {
        if (e instanceof AbortError) return;
        throw e;
      }
      try {
        // v0.18.0+ multi-source: thread `opts.sourceId` so per-page tx writes
        // (putPage / getTags / addTag / removeTag / deleteChunks / upsertChunks
        // / addLink) target (sourceId, slug). Pre-fix the schema DEFAULT
        // 'default' was applied even for non-default sources, fabricating
        // duplicate rows that crashed bare-slug subqueries with Postgres 21000.
        // #2683: incremental adds/modifies dispatch images to importImageFile
        // when multimodal is on (same gate as import.ts's full-sync walker).
        // Pre-fix, a committed .png went through importFile's UTF-8 text read
        // and failed — images only ever landed via `sync --full`.
        const result = await observed(pacer, () =>
          isImageImportPath(path) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
            ? importImageFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId })
            : company ? importCompanyBrainFile(eng, filePath, opts.sourceId!) : importFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack }));
        noteTypeWarning(result.type_warning);
        if (result.status === 'imported') {
          run.chunksCreated += result.chunks;
          pagesAffected.push(result.slug);
          deletedSlugs.delete(result.slug); // #1284: deleted-then-re-added in the same run → embeddable again
          // issue #1939: record the file path (not slug) so the gate clears any
          // prior failure-ledger row — success resets the auto-skip attempt streak.
          succeededPaths.push(path);
          // v0.41.13.0 (T2): bump filesImported on every successful
          // persist. partial() reports this so cron operators see how
          // much actually landed before --timeout fired.
          run.filesImported++;
          // v0.42.x (#1794): checkpoint this path so a kill banks it.
          await markCompleted(path);
        } else if (result.status === 'skipped' && result.skip_reason === 'malformed_path') {
          // Informational skip (bracket/control-char filename): never a
          // failure, and stable across runs — checkpoint it as done so a
          // resumed sync doesn't re-attempt it forever.
          serr(`  Skipped (malformed filename — rename to import): ${sanitizePathForDisplay(path)}`);
          await markCompleted(path);
        } else if (result.status === 'skipped' && (result as any).error) {
          failedFiles.push({ path, error: String((result as any).error) });
        } else if (result.status === 'error') {
          // status 'error' (frontmatter validation, importImageFile OCR/read
          // failures) must feed the failure ledger like a thrown error — the
          // fall-through below would checkpoint the path as DONE and the file
          // would never be re-attempted.
          failedFiles.push({ path, error: String((result as any).error ?? 'import error') });
        } else {
          // status 'skipped' with no error == content_hash short-circuit
          // (already imported, unchanged). It IS done for checkpoint purposes,
          // so mark it completed (matches import-checkpoint's posture).
          await markCompleted(path);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        serr(`  Warning: skipped ${path}: ${msg}`);
        failedFiles.push({ path, error: msg });
      } finally {
        permit.release();
      }
      progressAt.last = Date.now(); // #1950: forward progress → reset stall watchdog
      progress.tick(1, path);
      // v0.42.x (#1794): keep the lock-refresh heartbeat alive on big imports.
      await maybeYield();
      // paced-backfill: cooperative DB-contention pace between files (no-op when
      // unpaced). pace() throws AbortError on cancel; the loops break on
      // signal.aborted, so swallow it here.
      try {
        await pacer.pace(opts.signal);
      } catch (e) {
        if (!(e instanceof AbortError)) throw e;
      }
    }

    try {
    if (runParallel) {
      // A1 (v0.22.13): use engine.kind discriminator instead of config?.engine
      // string compare or constructor.name sniff. Q3: belt-and-suspenders fall
      // back to serial when database_url is unset, so we never crash on a null
      // assertion if config is missing.
      const config = loadConfig();
      if (engine.kind === 'pglite' || !config?.database_url) {
        for (const path of importsToDo) {
          // v0.41.13.0 (T2 / D-V3-2): per-iteration abort check. PGLite
          // serial fallback inside the parallel branch (database_url unset).
          if (opts.signal?.aborted) {
            progress.finish();
            return await partial(run.stallAborted ? 'stall_timeout' : 'timeout');
          }
          await importOnePath(engine, path);
        }
      } else {
        const { PostgresEngine } = await import('../../core/postgres-engine.ts');
        const { resolvePoolSize } = await import('../../core/db.ts');
        const workerPoolSize = Math.min(2, resolvePoolSize(2));
        const workerCount = Math.min(effectiveConcurrency, importsToDo.length);
        const databaseUrl = config.database_url;

        // Q4 (v0.22.13): banner on stderr so stdout stays clean for --json.
        serr(`  Parallel sync: ${workerCount} workers for ${importsToDo.length} files`);

        const workerEngines: InstanceType<typeof PostgresEngine>[] = [];
        try {
          // Connect workers one-by-one rather than Promise.all so a partial
          // failure leaves us with the connected ones in workerEngines for
          // the finally-block cleanup. The original code lost track of
          // already-connected engines on any one failure.
          for (let i = 0; i < workerCount; i++) {
            const eng = new PostgresEngine();
            await eng.connect({ database_url: databaseUrl, poolSize: workerPoolSize });
            workerEngines.push(eng);
          }

          // Atomic queue index — JS is single-threaded; the read-then-increment
          // happens between awaits, so no lock is needed.
          let queueIndex = 0;
          await Promise.all(
            workerEngines.map(async (eng) => {
              while (true) {
                // v0.41.13.0 (T2 / D-V3-2): per-iteration abort check.
                // Each worker exits its while loop cleanly when --timeout
                // fires. In-flight importOnePath() calls complete
                // naturally (no mid-transaction kill).
                if (opts.signal?.aborted || run.checkpointDead) break;
                const idx = queueIndex++;
                if (idx >= importsToDo.length) break;
                await importOnePath(eng, importsToDo[idx]);
              }
            }),
          );
        } finally {
          // A2 (v0.22.13): try/finally guarantees connection cleanup even when
          // the worker loop throws (partial connect failure, OOM, mid-import
          // signal). Each disconnect is best-effort — one worker failing to
          // disconnect must not strand the others.
          await Promise.all(
            workerEngines.map((e) =>
              e.disconnect().catch((err: unknown) =>
                serr(`  worker disconnect failed: ${err instanceof Error ? err.message : String(err)}`),
              ),
            ),
          );
        }
      }
    } else {
      // Serial path (small auto diffs or explicit --workers 1).
      for (const path of importsToDo) {
        // v0.41.13.0 (T2 / D-V3-2): per-iteration abort check at the
        // primary serial site.
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial(run.stallAborted ? 'stall_timeout' : 'timeout');
        }
        await importOnePath(engine, path);
      }
    }
    } finally {
      // paced-backfill: release any blocked acquirers + clear pacer state on
      // every exit path (including the early partial('timeout') returns above).
      pacer.dispose();
      // #1950: tear down the stall watchdog on every import-phase exit (normal,
      // partial('timeout'), or throw). The try wrapping the import loop guarantees
      // this runs before any post-import bookmark/anchor work.
      if (stallTimer) clearInterval(stallTimer);
    }

    progress.finish();

    // v0.41.13.0 (T2): post-parallel-loop abort check. The parallel
    // workers exit via `break` inside their while loop when signal
    // aborts; Promise.all then resolves, and we land here. Without
    // this check, an aborted parallel sync would silently advance to
    // the bookmark write below. By returning partial here, we preserve
    // the D-V3-1 invariant that abort means "never advance last_commit."
    if (opts.signal?.aborted) {
      return await partial(run.stallAborted ? 'stall_timeout' : 'timeout');
    }
  }

  // v0.42.x (#1794): if checkpoint persistence died mid-run (pool dead through
  // the whole retry budget), do NOT advance last_commit — return a
  // checkpoint_unavailable partial so the next run re-drains (content_hash
  // short-circuits the re-import). partial() overrides the reason when
  // checkpointDead is set.
  if (run.checkpointDead) {
    return await partial('timeout');
  }

  // v0.42.x (#1794): bank the final completed set before the gate so a block /
  // rewrite still persists everything drained this run (the next run resumes).
  await flushCheckpoint();
  // Past the final flush we're on a terminal path (blocked or success); both
  // either leave the checkpoint in place (blocked) or clear it (success), so the
  // SIGTERM one-shot flush has nothing left to add. Deregister so a SIGTERM
  // during the success-path git/anchor writes doesn't fire a stale flush.
  run.deregisterCheckpointCleanup();

  // v0.42.x (#1794, T3): pin-reachability gate, replacing the pre-v0.42 strict
  // "HEAD == captured" head-drift gate. CODEX-3 originally blocked on ANY HEAD
  // movement to catch external `git checkout`/`reset` that would make the
  // imported chunks reflect a different tree. But the #1794 repro has an enrich
  // process committing to the SAME repo every ~2 min, so the strict gate
  // blocked every run — a co-equal cause of non-convergence. Under pinning we
  // drain a FIXED lastCommit..pin range, so:
  //   - HEAD == pin           → nothing moved; advance.
  //   - HEAD is descendant of pin (forward progress) → SAFE. The new commits
  //     are outside this run's range and get picked up by the next sync's
  //     pin..HEAD diff. Advance to pin.
  //   - pin NOT an ancestor of HEAD (history REWRITE / reset / force-push) →
  //     the tree we imported against is gone. Block; do not advance.
  let headVerificationSucceeded = false;
  try {
    const currentHead = company ? company.plan.revision!.commit : git(gitContextRoot, ['rev-parse', 'HEAD']);
    if (currentHead !== pin) {
      let pinStillReachable = false;
      try {
        git(gitContextRoot, ['merge-base', '--is-ancestor', pin, currentHead]);
        pinStillReachable = true;
      } catch {
        pinStillReachable = false;
      }
      if (!pinStillReachable) {
        failedFiles.push({
          path: '<head>',
          error: `git history rewritten during sync: pinned target ${pin.slice(0, 8)} is no longer an ancestor of HEAD ${currentHead.slice(0, 8)}`,
        });
      } else {
        headVerificationSucceeded = true;
      }
      // else: forward progress (enrich committed on top) — safe, advance to pin.
    } else {
      headVerificationSucceeded = true;
    }
  } catch (e) {
    // rev-parse failure is itself a drift signal (worktree disappeared).
    failedFiles.push({
      path: '<head>',
      error: `git HEAD verification failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const elapsed = Date.now() - start;

  // issue #1939 — gate the bookmark through the shared failure ledger.
  //   • Fresh failures still BLOCK (fail-closed): the next sync re-walks the
  //     diff and re-attempts. Escape hatch: --skip-failed.
  //   • A file that fails >= threshold consecutive syncs AUTO-SKIPS so a poison
  //     file can't wedge all indexing forever (recorded, surfaced by doctor).
  //   • A `<head>` SENTINEL (history rewrite) HARD-BLOCKS even with
  //     --skip-failed — advancing would record a commit that no longer matches
  //     the indexed tree.
  // `advance` is the bookmark write; the gate runs it ONLY when advancing, and
  // ALWAYS before marking anything auto-skipped/acknowledged (crash-atomic).
  const advance = async (): Promise<void> => {
    // v0.42.x (#1794): advance to the PINNED target (not live HEAD) — commits
    // past the pin are the next sync's pin..HEAD diff. `commitTimeMs(pin)` stamps
    // newest_content_at against the commit we drained to. `last_sync_at` is bumped
    // HERE and ONLY here so the autopilot scheduler never sees a stuck source as
    // "fresh". The checkpoint rows clear here — CONVERGENCE CONTRACT: sync
    // convergence == IMPORT convergence; downstream extract/facts/embed is
    // decoupled (its own resumable stale sweeps).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(gitContextRoot, pin), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    if (!company) { await clearOpCheckpoint(engine, ckpt.paths); await clearOpCheckpoint(engine, ckpt.target); }
  };

  // issue #1939 adversarial finding #1: a file that failed to parse (open ledger
  // row) and is then deleted/renamed-away never re-enters failedFiles and never
  // imports, so its row would never clear and would age doctor to a permanent
  // FAIL. Treat removed paths as resolved so the ledger self-heals.
  const resolvedPaths = [
    ...succeededPaths,
    ...filtered.deleted,
    ...filtered.renamed.map(r => r.from),
    // A prior transient rev-parse timeout records a hard-blocking sentinel that
    // operators cannot acknowledge manually. Once pin ancestry is verified on
    // a later run, clear that stale sentinel through the ordinary success path.
    ...(headVerificationSucceeded ? ['<head>'] : []),
  ];

  const gate = await applySyncFailureGate({
    sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID,
    failedFiles,
    succeededPaths: resolvedPaths,
    commit: pin,
    skipFailed: !company && opts.skipFailed === true,
    ...(company ? { threshold: 0 } : {}),
    advance,
  });
  // #3479 blocker 2 — self-heal for orphaned `<rename:…>` sentinels: a
  // force-push that invalidates the pinned target means the rename never
  // re-enters the diff, so the ordinary convergence path above can never
  // clear the row and doctor ages it to a permanent FAIL no CLI can fix.
  // Deliberately AFTER the gate and OUTSIDE it (#3583): the gate used to
  // clear these via succeededPaths, which cleared BEFORE advance() — a
  // throwing advance then lost the sentinel with the verify never reached.
  // Out here, a gate that throws never clears anything (fail-closed), and
  // the sweep carries the full clear-then-verify-restore semantics.
  await sweepOrphanedRenameSentinels(
    engine, opts.sourceId ?? DEFAULT_SOURCE_ID, new Set(failedFiles.map(f => f.path)),
  );

  if (!gate.advanced) {
    const codeBreakdown = formatCodeBreakdown(failedFiles);
    // Two sentinel classes block here: `<head>` (pin ancestry broken) and
    // `<rename:…>` (#3056 — a rename-reconcile delete failed and advancing
    // would permanently bank the duplicate). Pick the message by which fired —
    // and when BOTH fired, the rename detail is appended to the head message
    // rather than silently losing to it (#3479 review).
    const renameRows = failedFiles.filter(f => f.path.startsWith(RENAME_SENTINEL_PREFIX));
    // The failing rows verbatim (path + error): the error names the stale
    // slug and the old path, which the operator remedy below points at —
    // a code-count breakdown alone can't tell them which row to delete.
    const renameDetail = renameRows.map(f => `  ${f.path}: ${f.error}`).join('\n');
    // #3479 blocker 1 — the sentinel hard-blocks even --skip-failed by
    // design, so an environment where the DELETE can never succeed (RLS
    // denying DELETE, an FK RESTRICT) needs a documented exit or a cosmetic
    // duplicate becomes a total sync outage. The remedy is deliberately NOT
    // pitched at a fully read-only database: 'gbrain delete' soft-deletes
    // via UPDATE, so it unwedges exactly the environments where writes work
    // but this DELETE does not.
    const renameRemedy =
      `The next 'gbrain sync' retries the reconcile from the same diff. If the delete ` +
      `keeps failing in your environment (RLS denying DELETE, an FK RESTRICT — anywhere ` +
      `UPDATE still works), remove the stale row yourself: 'gbrain delete <stale-slug>' ` +
      `with the stale slug named above (the reconcile only names rows whose backing file ` +
      `is gone from the working tree — never a live page). A sentinel reading 'stale row ?' ` +
      `names nothing on purpose: that run could not prove ANY row stale, usually because a ` +
      `tracked file could not be read — fix or remove that file instead of deleting a page. ` +
      `The reconcile then finds nothing left to delete and the sentinel clears on the next run.`;
    if (gate.sentinelBlocked && failedFiles.some(f => f.path === '<head>')) {
      serr(
        `\nSync blocked: repository history changed during sync (force-push / reset).\n` +
        `${codeBreakdown}\n\n` +
        `The pinned target is no longer an ancestor of HEAD; advancing would record ` +
        `a commit that doesn't match the indexed tree. Re-run sync to re-pin against ` +
        `current HEAD.` +
        (renameRows.length > 0
          ? `\n\nA rename also left a stale duplicate that could not be removed:\n` +
            `${renameDetail}\n\n${renameRemedy}`
          : ''),
      );
    } else if (gate.sentinelBlocked) {
      serr(
        `\nSync blocked: a rename left a stale duplicate that could not be removed:\n` +
        `${renameDetail || codeBreakdown}\n\n` +
        renameRemedy,
      );
    } else {
      const fileFailCount = failedFiles.filter(f => isSkippablePath(f.path)).length;
      // #3875: code-aware copy. Provider-infra failures (embed timeout /
      // rate limit / quota) are NOT bad files — suggesting --skip-failed for
      // them acknowledges away perfectly good content. Point at provider
      // health + a plain re-run (or --full to rebuild) instead.
      const infraCodes = summarizeFailuresByCode(failedFiles).filter(c => isEmbeddingInfraCode(c.code));
      if (infraCodes.length > 0) {
        serr(
          `\nSync blocked: ${fileFailCount} file(s) failed — embedding provider errors:\n` +
          `${codeBreakdown}\n\n` +
          `These are provider-health failures (timeout / rate limit / quota), not bad ` +
          `files — do NOT use --skip-failed for them. Check the embedding provider ` +
          `(is it running? out of quota?), then re-run 'gbrain sync' (only the failed ` +
          `files are re-attempted), or 'gbrain sync --full' to rebuild.`,
        );
      } else {
        serr(
          `\nSync blocked: ${fileFailCount} file(s) failed to parse:\n` +
          `${codeBreakdown}\n${formatFailedFileList(failedFiles)}\n\n` +
          `Pinpoint a file with 'gbrain frontmatter validate <path>' (--fix auto-repairs), ` +
          `fix the frontmatter and re-run, or use 'gbrain sync --skip-failed' to ` +
          `acknowledge and move on. A file that keeps failing auto-skips after ` +
          `${resolveAutoSkipThreshold()} consecutive syncs.`,
        );
      }
    }
    // Update last_run + repo_path (progress on infra) but NOT last_commit. The
    // checkpoint is INTENTIONALLY left in place — the banked completed set lets
    // the next run skip the drained files and re-attempt only the failures.
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    // v0.42.x (#1794): surface banked progress so a blocked run doesn't read as
    // total loss (last_commit is unchanged by design; the checkpoint is banked).
    serr(
      `[sync] banked ${run.bankedFiles} file(s) this run; next 'gbrain sync' resumes ` +
      `from the checkpoint (last_commit unchanged at ${(lastCommit ?? '').slice(0, 8)}).`,
    );
    return {
      status: 'blocked_by_failures',
      fromCommit: lastCommit,
      toCommit: pin,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length + run.swept,
      renamed: filtered.renamed.length,
      chunksCreated: run.chunksCreated,
      embedded: 0,
      pagesAffected,
      failedFiles: failedFiles.length,
      failureCodes: summarizeFailuresByCode(failedFiles),
      bankedFiles: run.bankedFiles,
    };
  }

  // Advanced. Surface what the gate did past the failures.
  if (gate.acknowledged > 0) {
    serr(`  Acknowledged ${gate.acknowledged} failure(s) and advanced past them.`);
  }
  if (gate.autoSkipped.length > 0) {
    serr(
      `\n  Auto-skipped ${gate.autoSkipped.length} file(s) that failed >= ` +
      `${resolveAutoSkipThreshold()} consecutive syncs:\n` +
      gate.autoSkipped.map(p => `    ${p}`).join('\n') + '\n' +
      `  Bookmark advanced; these pages are NOT indexed and remain in ` +
      `sync-failures.jsonl. 'gbrain doctor' will warn until they're fixed.`,
    );
  }

  // Log ingest. #3969: mirror runImport's shouldLogIngest gate — a run that
  // landed nothing (no pages written, no chunks, no failures acknowledged or
  // auto-skipped) is a poll, not an ingest event; skip the row unless
  // opts.logNoop opts back in.
  if (shouldLogIngest(
    {
      imported: pagesAffected.length,
      errors: gate.acknowledged + gate.autoSkipped.length,
      chunksCreated: run.chunksCreated,
    },
    opts.logNoop === true,
  )) {
    await engine.logIngest({
      // #3242 (attribution sub-bug): credit the sync to the source it wrote
      // to, not the shared 'default' bucket.
      ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
      source_type: 'git_sync',
      source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
      pages_updated: pagesAffected,
      summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${run.chunksCreated} chunks, ${elapsed}ms`,
    });
  }

  // Auto-extract links + timeline (cheap CPU, but skip-inline for LARGE syncs).
  // Thread opts.sourceId so the extract phase reconciles edges + timeline
  // entries against the right source — pre-fix (Data R1 HIGH 1) this phase
  // bypassed sourceId entirely and the bare-slug subquery in addTimelineEntry
  // (Data R1 HIGH 2) crashed with 21000 in multi-source brains.
  //
  // v0.42.x (#1794, T4): size-gate inline extract on `totalChanges <= 100`
  // (same threshold as noEmbed). A large sync (the #1794 case) would otherwise
  // run links+timeline extraction over tens of thousands of pages inline,
  // re-coupling a slow pass into the just-decoupled convergence path. Instead we
  // leave `links_extracted_at` UNSTAMPED so the resumable `extract --stale`
  // watermark sweep (run by the autopilot cycle / on demand) picks the pages
  // up. For resumed large syncs, pagesAffected holds only THIS run's slugs, but
  // the stale sweep scans the whole source, so banked-across-runs pages are
  // covered regardless.
  const extractOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  if (!opts.noExtract && totalChanges > 100 && pagesAffected.length > 0) {
    // #2849: above the size gate the deferred extraction must be DURABLY
    // QUEUED, not just hinted. The autopilot cycle's extract phase is
    // slug-scoped (an up_to_date follow-up sync hands it an empty
    // pagesAffected), so a webhook-driven large sync left
    // `links_extracted_at` unstamped FOREVER unless an operator ran
    // `gbrain extract --stale` by hand. Submit a source-scoped stale-sweep
    // job bound to the consumed commit (idempotency key) so repeated
    // webhook deliveries / sync retries of the same commit coalesce onto
    // one job. The sweep itself is the watermark scan — it picks up the
    // pages this run imported AND any banked across resumed runs.
    // Best-effort: queue submission failure falls back to the hint-only
    // behavior (the pages stay stale + visible to doctor, never mis-stamped).
    let queuedJobId: number | string | null = null;
    try {
      const { MinionQueue } = await import('../../core/minions/queue.ts');
      const { STALE_TIME_BUDGET_MS } = await import('../extract.ts');
      const queue = new MinionQueue(engine);
      const payload = {
        stale: true,
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        reason: 'sync_size_gate',
        // Bound to the PIN this run drained to (== headCommit unless resuming
        // a stored target), not live HEAD — the sweep covers what we imported.
        deferred_commit: pin,
      };
      // The stale sweep has its own internal wall-clock budget
      // (GBRAIN_EXTRACT_TIME_BUDGET_MS-derived); without an explicit
      // timeout_ms the job would inherit the tight null-default and get
      // wall-clock-killed mid-sweep (#1737 class). 5-min headroom.
      const timeoutMs = STALE_TIME_BUDGET_MS + 5 * 60 * 1000;
      // NO maxWaiting here: with an unscoped (NULL-sourceId) payload the
      // queue's coalesce filter matches ANY waiting 'extract' job (e.g. a
      // remediation-submitted {mode:'links'} row) and returns THAT job —
      // silently dropping the sweep while we log "queued". The idempotency
      // key alone is the dedup for repeat submissions toward the same pin.
      const key = `extract-stale:${opts.sourceId ?? 'default'}:${pin}`;
      const isLiveSweep = (j: { status: string; data: Record<string, unknown> }): boolean =>
        j.data?.stale === true && ['waiting', 'delayed', 'active'].includes(j.status);
      let job = await queue.add('extract', payload, { idempotency_key: key, timeout_ms: timeoutMs });
      if (!isLiveSweep(job)) {
        // The key slot holds a FINISHED row: a prior sweep toward this pin
        // that completed BEFORE this run's pages landed (checkpoint-resume /
        // blocked-advance re-sync of the same target). Those pages went
        // stale after that sweep's watermark pass, so coalescing onto the
        // finished row would strand them — queue a fresh sweep under a
        // run-unique key. (An 'active' sweep is safe to coalesce onto: its
        // end-of-run staleRemaining re-count chains a continuation.)
        job = await queue.add('extract', payload, {
          idempotency_key: `${key}:${Date.now()}`,
          timeout_ms: timeoutMs,
        });
      }
      // Only claim "queued" once we verified the returned row IS a live
      // stale sweep — never trust queue.add's row blind.
      if (isLiveSweep(job)) queuedJobId = job.id;
    } catch { /* best-effort — hint below still tells the operator */ }
    slog(
      `  Large sync: deferring link/timeline extraction` +
      (queuedJobId != null
        ? ` — queued stale-sweep job #${queuedJobId} (source: ${opts.sourceId ?? 'default'}); a running jobs worker will consume it.`
        : `.`) +
      ` Run 'gbrain extract --stale${opts.sourceId ? ` --source-id ${opts.sourceId}` : ''}' to extract now.`,
    );
  }
  let extractError: string | undefined;
  if (!opts.noExtract && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted, slugsSafeToStamp } = await import('../extract.ts');
      // #774: pages' source_path is git-root-relative, so extract resolves
      // files from gitContextRoot (== repoPath realpath when unscoped).
      const linksResult = await extractLinksForSlugs(engine, gitContextRoot, pagesAffected, extractOpts);
      const timelineResult = await extractTimelineForSlugs(engine, gitContextRoot, pagesAffected, extractOpts);
      if (linksResult.created > 0 || timelineResult.created > 0) {
        slog(`  Extracted: ${linksResult.created} links, ${timelineResult.created} timeline entries`);
      }
      // v0.42.7 (#1696, CDX-6): stamp the links_extracted_at watermark for the
      // pages we just extracted, AFTER the import set their updated_at, so
      // links_extracted_at >= updated_at (page is now fresh, not flagged stale).
      // Source-correct via opts.sourceId. Stamp at the CALL SITE (not inside
      // extractLinksForSlugs) so we use the per-source sourceId the sync owns.
      // Best-effort: a stamp miss just means extract --stale re-sweeps later.
      // Only the slugs both hooks actually read — a page the extractor
      // skipped must stay stale so the sweep still owes it.
      await stampExtracted(
        engine,
        slugsSafeToStamp(linksResult, timelineResult)
          .map((slug) => ({ slug, source_id: opts.sourceId ?? 'default' })),
      );
      const failed = [...(linksResult.errors ?? []), ...(timelineResult.errors ?? [])];
      if (failed.length > 0) extractError = `${failed.length} page(s) not extracted, e.g. ${failed[0]!.slug}: ${failed[0]!.error}`;
    } catch (e) {
      extractError = e instanceof Error ? e.message : String(e);
    }
    // A15: best-effort (the import stands and failed pages stay stale for
    // `extract --stale`), but never silent.
    if (extractError) serr(`  Link/timeline extraction failed: ${extractError}. Run 'gbrain extract --stale${opts.sourceId ? ` --source-id ${opts.sourceId}` : ''}' after fixing it.`);
  }

  // v0.31.2: facts extraction now routes through the shared
  // src/core/facts/backstop.ts helper (PR1 commit 6). Sync uses
  // queue mode (fire-and-forget) + 'high-only' filter so a 50-page
  // sync doesn't block on N sequential Sonnet calls. The pre-fix
  // inline loop is gone — it carried (a) a dead-code type filter
  // ('conversation'/'transcript'/'therapy'/'call' aren't real
  // PageTypes), (b) a divergent eligibility shape from put_page,
  // and (c) raw extract→insert without dedup/supersede.
  if (!opts.noExtract && pagesAffected.length > 0 && pagesAffected.length <= 50) {
    const { runFactsBackstop } = await import('../../core/facts/backstop.ts');
    const factsSourceId = opts.sourceId ?? 'default';
    for (const slug of pagesAffected) {
      try {
        // v0.40 D21: source-scoped getPage. Pre-v0.40 this called
        // engine.getPage(slug) WITHOUT sourceId, then wrote facts under
        // factsSourceId. On a federated brain with the same slug in two
        // sources (e.g. people/garry-tan in default + zion-brain), this
        // would attribute facts to the wrong source. Codex outside-voice
        // catch on the v0.40 plan review.
        const page = await engine.getPage(slug, { sourceId: factsSourceId });
        if (!page) continue;
        await runFactsBackstop(
          {
            slug,
            type: page.type,
            compiled_truth: page.compiled_truth ?? '',
            frontmatter: page.frontmatter ?? {},
          },
          {
            engine,
            sourceId: factsSourceId,
            sessionId: `sync:${slug}`,
            source: 'sync:import',
            mode: 'queue',
            notabilityFilter: 'high-only',
          },
        );
      } catch { /* per-page enqueue is best-effort */ }
    }
  }

  // Auto-embed (skip for large syncs — embedding calls OpenAI).
  // Thread sourceId so incremental source syncs embed the page row they just
  // imported instead of falling back to the default source.
  //
  // v0.37 fix wave (Lane D.3 + CDX2-8): switched from `runEmbed` (which
  // does its own process.exit) to `runEmbedCore` so sync can detect the
  // dim-mismatch class and surface a stderr hint without killing the
  // sync. Non-mismatch errors stay best-effort (rate limits, transient
  // network) — those shouldn't break sync.
  let embedded = 0;
  // #1284: never hand deleted slugs to the embedder — embedPage throws
  // 'Page not found' per deleted slug and logs one error line each. Filter
  // against this run's confirmed-deleted set (slugs re-imported later in the
  // run were removed from it at their push sites).
  const embedSlugs = pagesAffected.filter((s) => !deletedSlugs.has(s));
  if (!noEmbed && embedSlugs.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbedCore } = await import('../embed.ts');
      const embedOpts = opts.sourceId
        ? { slugs: embedSlugs, sourceId: opts.sourceId }
        : { slugs: embedSlugs };
      await runEmbedCore(engine, embedOpts);
      embedded = embedSlugs.length;
    } catch (e: unknown) {
      const { EmbeddingDimMismatchError } = await import('../embed.ts');
      if (e instanceof EmbeddingDimMismatchError) {
        serr('\n' + e.recipeMessage + '\n');
        serr(`Tip: pass --no-embed to sync without embedding, then`);
        serr(`run 'gbrain embed --stale' after fixing the schema.\n`);
      }
      // Other errors stay best-effort — rate limits, transient network.
    }
  } else if (noEmbed || totalChanges > 100) {
    slog(`Text imported. Run 'gbrain embed --stale' to generate embeddings.`);
  }

  if (malformedSkipped.length > 0) {
    serr(
      `\n  ${malformedSkipped.length} file(s) skipped: malformed filename ` +
      `(brackets/control chars) — rename to import. Not counted as failures.`,
    );
  }

  const typeWarnings = [...typeWarningCounts.values()];
  if (typeWarningsEnabled && typeWarnings.length > 0) {
    const { renderTypeWarningSummary } = await import('../../core/schema-pack/type-usage.ts');
    for (const line of renderTypeWarningSummary(typeWarnings)) serr(`  ${line}`);
    serr(`  (silence with: gbrain config set schema.type_warnings false)`);
  }

  return {
    status: 'synced',
    fromCommit: lastCommit,
    toCommit: pin,
    added: filtered.added.length,
    modified: filtered.modified.length,
    deleted: filtered.deleted.length + run.swept,
    renamed: filtered.renamed.length,
    chunksCreated: run.chunksCreated,
    embedded,
    pagesAffected,
    ...(totalChanges > 100 && embedSlugs.length > 0 ? { embedDeferralReason: 'large_sync' as const } : {}),
    malformedSkipped: malformedSkipped.length,
    ...(typeWarningsEnabled && typeWarnings.length > 0 ? { type_warnings: typeWarnings } : {}),
    ...(uncommittedDrift ? { uncommitted: uncommittedDrift } : {}),
    ...(extractError ? { extract_error: extractError } : {}),
  };
}
