/**
 * `gbrain autopilot` daemon: boot, the managed worker, shutdown and the tick
 * loop. runAutopilot (src/commands/autopilot.ts) dispatches here when no
 * install/uninstall/status/pause mode flag is present.
 */
import type { BrainEngine } from '../core/engine.ts';
import { ChildWorkerSupervisor } from '../core/minions/child-worker-supervisor.ts';
import { MIGRATE_PAUSE_MARKER_PREFIX, autopilotLockPath, autopilotPaused, autopilotPausedMarkerPath, markerHolderAlive } from '../core/autopilot-paths.ts';
import { OwnerProcessingState } from '../core/minions/processing-state.ts';
import { autopilotRemediationIdempotencyKey, shouldRunAutopilotFullCycle, shouldSleepHealthyAutopilot } from './autopilot-remediation-policy.ts';
import { mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { gbrainPath as gbrainHomePath, loadConfig, loadConfigFileOnly } from '../core/config.ts';
import { isSyncDisabledConfig } from '../core/sync-policy.ts';
import { loadActivationPendingSourceIds, skipActivationPendingSync } from '../core/sync-policy.ts';
import { join } from 'path';
import { loadAllSources, sourceConfigHasRemoteUrl, sourceLocalPathSkipWarning } from '../core/sources-load.ts';
import { loadPreferences } from '../core/preferences.ts';
import { registerCleanup } from '../core/process-cleanup.ts';
import { resolveAutopilotDispatchTimeoutMs } from './autopilot-timeout.ts';
import { resolveChildCliInvocation } from '../core/minions/job-isolation.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  attemptAutopilotSelfUpgrade,
  autopilotEngineIdentity,
  chatBootWarning,
  classifyReconnectError,
  decideLockAcquisition,
  guardAutopilotEngine,
  logError,
  parseArg,
  reconcileSelfUpgradeAtBoot,
  resolveGbrainCliPath,
  shouldSpawnAutopilotWorker,
} from './autopilot.ts';

/**
 * Mutable daemon state shared by the tick loop, the shutdown path and the tick
 * steps. Each field keeps the name of the closure variable it replaced.
 */
export interface AutopilotDaemonState {
  stopping: boolean;
  /** #1872: the in-flight inline runCycle, drained by closeEngine on shutdown. */
  inflightInlineCycle: Promise<unknown> | null;
  consecutiveErrors: number;
  /**
   * Parser-probe fixture warning is once-per-process, not once-per-cycle
   * (compiled-binary installs have no source tree; don't spam the log).
   */
  parserProbeFixtureWarned: boolean;
  /**
   * #2608: once-per-process no-chat-provider warning. A keyless daemon used
   * to run every cycle "green" while all LLM phases silently no-op'd
   * (chronicle reported no_events, propose_takes skipped, …) — the operator
   * had no signal that shell-profile keys never reached launchd/systemd.
   */
  noChatProviderWarned: boolean;
  /**
   * v0.37.7.0 #1162 — counter for consecutive reconnect failures.
   * Reset on every successful health probe or reconnect. Threshold
   * controlled by GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS env (default 30).
   */
  autopilotReconnectFails: number;
  /** Consecutive --no-worker ticks with no live worker signal (see NO_WORKER_WARN_TICKS). */
  noWorkerConsecutiveIdle: number;
  /**
   * v0.36+ T8: track time since last full cycle for the 60-min floor.
   * Initialized to "long ago" (0) so the first tick on a healthy brain still
   * runs the full cycle (phase-coupling exercise) before settling into
   * targeted-submit mode.
   */
  lastFullCycleAt: number;
  /** Log the pause/resume transition once each, not every poll. */
  pausedAnnounced: boolean;
}

export async function runAutopilotDaemon(engine: BrainEngine, args: string[]): Promise<void> {
  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  // Same NaN guard as the status path: a typo'd interval would otherwise
  // reach setTimeout(NaN) → 0ms and busy-loop the daemon against the DB.
  const rawBaseInterval = parseInt(parseArg(args, '--interval') || '300', 10);
  const baseInterval = Number.isFinite(rawBaseInterval) && rawBaseInterval > 0 ? rawBaseInterval : 300;
  const jsonMode = args.includes('--json');
  const forceInline = args.includes('--inline');
  const noWorker = !shouldSpawnAutopilotWorker(args);

  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  // Lock file to prevent concurrent instances (#14).
  // v0.37.7.0 #1226: route through gbrainPath() so the lockfile lives
  // under GBRAIN_HOME when set, not the hardcoded ~/.gbrain. Pre-fix,
  // two brains sharing GBRAIN_HOME=different-paths still wrote to the
  // same global lockfile and one would silently respawn the other
  // forever.
  const lockPath = autopilotLockPath();
  try {
    mkdirSync(gbrainHomePath(), { recursive: true });
    const decision = decideLockAcquisition(lockPath, process.pid);
    if (decision.action === 'exit') {
      // #4300: say WHY we refused, loudly, so a bricked daemon is diagnosable
      // from launchd/systemd logs without strace-ing the lock probe.
      const detail =
        decision.holderState === 'alive-autopilot'
          ? 'a live gbrain autopilot process'
          : decision.holderState === 'alive-unknown'
            ? 'a live process whose command line could not be inspected (fresh lock — will become stealable once stale)'
            : 'a live non-gbrain process holding a fresh lock (will become stealable once stale)';
      console.error(
        `[autopilot] refusing to start: lock ${lockPath} is held by pid ${decision.holderPid} — ${detail}. Exiting.`,
      );
      process.exit(0);
    }
    if (decision.action === 'takeover') {
      console.log(`Stale autopilot lock found (${decision.reason}). Taking over.`);
    }
    writeFileSync(lockPath, String(process.pid));
  } catch { /* best-effort */ }

  console.log(`Autopilot starting. Repo: ${repoPath}, interval: ${baseInterval}s`);

  // #2608: LLM phases (chronicle extract, dream synthesis, enrich) gate on
  // isAvailable('chat') and silently no-op when no chat provider resolves —
  // the classic symptom of a daemon shell that never sourced the API keys
  // (see writeWrapperScript below). One loud boot-time line makes that
  // failure mode visible in the daemon log instead of manifesting as
  // "autopilot runs green but nothing gets extracted".
  // console.log, NOT console.error: launchd/systemd route stderr to
  // autopilot.err, which install output and showStatus never reference —
  // stdout is the autopilot.log sink on all four install targets.
  // Bare isAvailable('chat') probes the GLOBAL chat model on purpose — it
  // mirrors the phases named above; facts extraction gates model-aware
  // (core/facts/extract.ts) and doctor owns that diagnosis.
  try {
    const { isAvailable } = await import('../core/ai/gateway.ts');
    const warn = chatBootWarning(isAvailable('chat'), gbrainHomePath());
    if (warn) console.log(warn);
  } catch { /* diagnostic only — never blocks the loop */ }

  // Mode resolution: Minions dispatch when the user has opted in AND the
  // worker daemon can actually run (Postgres only; PGLite's exclusive file
  // lock blocks a separate worker process).
  const mode = loadPreferences().minion_mode ?? 'pain_triggered';
  const cfg = loadConfig();
  const engineType = cfg?.engine ?? 'pglite';
  const useMinionsDispatch = mode !== 'off' && engineType === 'postgres' && !forceInline;
  const spawnManagedWorker = useMinionsDispatch && !noWorker;

  // Engine identity at boot, re-checked every tick. A cross-engine migration
  // flips config.json at the END of its copy; this long-lived process would
  // otherwise keep syncing into the ABANDONED source engine indefinitely —
  // the health probe keeps succeeding (the old engine stays alive as the
  // preserved backup) and reconnect() deliberately restores the config
  // captured at connect() (#2034), never the new file. Same silent-divergence
  // class as the dead-daemon incident, moved to after the flip.
  const engineIdentityAtBoot = autopilotEngineIdentity(loadConfigFileOnly());

  // v0.42 self-upgrade: if a prior tick swapped the binary and exited for
  // relaunch, we're now the relaunched process — reconcile the breadcrumb so a
  // crash-on-launch is recorded known-bad and a success is confirmed.
  reconcileSelfUpgradeAtBoot();

  const state: AutopilotDaemonState = {
    stopping: false,
    inflightInlineCycle: null,
    consecutiveErrors: 0,
    parserProbeFixtureWarned: false,
    noChatProviderWarned: false,
    autopilotReconnectFails: 0,
    noWorkerConsecutiveIdle: 0,
    lastFullCycleAt: 0,
    pausedAnnounced: false,
  };
  let childSupervisor: ChildWorkerSupervisor | null = null;
  const processingState = spawnManagedWorker ? new OwnerProcessingState('autopilot', 'default') : null;
  const configurationBlocked = () => processingState?.blocked ?? false;
  if (processingState) engine = guardAutopilotEngine(engine, processingState);

  // #1872: graceful engine shutdown. On PGLite the cycle steps run INLINE in
  // this process, so a hard `process.exit` mid-write (systemctl stop →
  // SIGTERM) kills WASM Postgres with the WAL dirty and can corrupt the
  // brain. Two exit paths must both close the engine:
  //   - autopilot's own shutdown() below (owns SIGINT + internal stops like
  //     max_crashes / cycle-failure-cap), and
  //   - process-cleanup's SIGTERM handler (installed inside cli.ts's
  //     import.meta.main seam before main() dispatches; it runs the cleanup
  //     registry with a 3s deadline and then exits) —
  //     which is why closeEngine is ALSO registered there.
  // closeEngine aborts the in-flight inline cycle (runCycle checks the
  // signal between phases and threads it into phase sub-work), gives it a
  // short bounded window to wind down, then disconnects. PGLite's
  // disconnect() drains the pending query and checkpoints before closing;
  // a second call is a no-op (disconnect snapshots + nulls the handle), so
  // both paths firing is safe.
  const shutdownAbort = new AbortController();
  const closeEngine = async () => {
    shutdownAbort.abort(new Error('autopilot shutdown'));
    if (state.inflightInlineCycle) {
      // ponytail: 2s cap keeps us inside process-cleanup's 3s deadline; a
      // between-phase abort resolves instantly, a mid-phase one may not.
      await Promise.race([
        state.inflightInlineCycle.catch(() => { /* cycle errors already logged by the loop */ }),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    }
    try { await engine.disconnect(); } catch { /* best-effort */ }
  };
  const deregisterEngineClose = registerCleanup('autopilot-engine-close', closeEngine);

  if (spawnManagedWorker) {
    const invocation = resolveChildCliInvocation({}, process.execPath, process.argv[1], resolveGbrainCliPath);
    if (!invocation) throw new Error('Could not resolve the worker CLI. Repair the current GBrain installation.');
    // Cgroup-aware auto-sized RSS watchdog cap (issue #1678). The old flat
    // 2048MB killed legit embed work (~10GB) on every cycle → silent
    // ~400×/24h respawn loop. resolveDefaultMaxRssMb clamps 0.5×min(cgroup,
    // RAM) to [4096,16384]. Bare `gbrain jobs work` resolves the same default;
    // we pass it explicitly so the spawn log + child agree.
    const { resolveDefaultMaxRssMb } = await import('../core/minions/rss-default.ts');
    const autopilotMaxRssMb = resolveDefaultMaxRssMb();
    childSupervisor = new ChildWorkerSupervisor({
      processingState: processingState ?? undefined,
      onConfigurationBlocked: (status) => {
        console.error(`[autopilot] processing configuration-blocked (${status?.reason_code ?? 'unknown'}); repair the worker/child installation and explicitly restart autopilot.`);
      },
      cliPath: invocation.cmd,
      args: [...invocation.argsPrefix, 'jobs', 'work', '--max-rss', String(autopilotMaxRssMb)],
      env: { ...process.env, GBRAIN_SUPERVISED: undefined } as Record<string, string | undefined>,
      maxCrashes: 5,
      isStopping: () => state.stopping,
      onMaxCrashesExceeded: (count, max) => {
        console.error(`[autopilot] ${count}/${max} consecutive worker crashes, giving up.`);
        void shutdown('max_crashes');
      },
      onEvent: (event) => {
        // Route ChildWorkerSupervisor events to autopilot's stderr log.
        // Matches the prior console output shape so operators reading
        // existing logs see the same lines.
        if (event.kind === 'worker_startup_timeout') {
          console.error(`[autopilot] worker readiness was not confirmed within ${event.timeoutMs}ms; stopping this worker and retrying with bounded backoff.`);
        } else if (event.kind === 'worker_spawned') {
          console.log(
            `[autopilot] Minions worker spawned (pid: ${event.pid}, watchdog: ${autopilotMaxRssMb}MB${event.tini ? ', tini: active' : ''})`,
          );
        } else if (event.kind === 'worker_spawn_failed') {
          console.error(
            `[autopilot] worker spawn failed (${event.phase}): ${event.error}${event.errnoCode ? ` (code=${event.errnoCode})` : ''}`,
          );
        } else if (event.kind === 'worker_exited') {
          console.error(
            `[autopilot] worker exited code=${event.code} signal=${event.signal} after ${event.runDurationMs}ms, crashCount=${event.crashCount}, cause=${event.likelyCause}`,
          );
        } else if (event.kind === 'backoff') {
          if (event.reason === 'budget_exceeded') {
            console.error(
              `[autopilot] clean-restart budget exceeded; backing off ${event.ms}ms before next spawn`,
            );
          } else if (event.reason === 'crash') {
            console.error(
              `[autopilot] crash backoff ${event.ms}ms (crashCount=${event.crashCount})`,
            );
          }
          // reason='clean_exit' with ms:0 is the steady-state watchdog drain;
          // logging every iteration would be noisy. Keep silent (the
          // worker_exited line already covers the user-visible signal).
        } else if (event.kind === 'health_warn') {
          console.error(
            `[autopilot] health_warn: ${event.reason} count=${event.count} window=${event.windowMs}ms`,
          );
        }
      },
    });
    // Fire-and-forget; runs alongside the dispatch loop. shutdown() drives
    // the child-supervisor's isStopping accessor + drain.
    void childSupervisor.run();
  } else if (!useMinionsDispatch) {
    const why = mode === 'off'
      ? 'minion_mode=off'
      : (engineType !== 'postgres' ? 'engine=pglite' : 'flag=--inline');
    console.log(`[autopilot] running steps inline (${why})`);
  } else {
    console.log('[autopilot] --no-worker set: dispatch loop only (worker managed externally)');
  }

  // Async shutdown with 35s drain window for the worker child. The worker
  // has its own SIGTERM handler (minions/worker.ts:79-85) that drains
  // in-flight jobs for up to 30s before exit. We give it 35s here to
  // account for signal-delivery latency, then SIGKILL as a last resort.
  //
  // No `process.on('exit')` handler — its callback runs synchronously and
  // cannot await the worker's drain.
  const shutdown = async (sig: string) => {
    if (configurationBlocked() && sig !== 'SIGTERM' && sig !== 'SIGINT') return;
    if (state.stopping) return;
    state.stopping = true;
    console.log(`Autopilot stopping (${sig}).`);
    if (childSupervisor) {
      childSupervisor.killChild('SIGTERM');
      await childSupervisor.awaitChildExit(35_000);
      if (childSupervisor.childAlive) {
        childSupervisor.killChild('SIGKILL');
      }
    }
    if (configurationBlocked() && sig !== 'SIGTERM' && sig !== 'SIGINT') {
      state.stopping = false;
      return;
    }
    // #1872: abort the in-flight inline cycle and close the engine BEFORE
    // process.exit — a hard exit mid-write corrupts PGLite's WASM Postgres.
    await closeEngine();
    deregisterEngineClose();
    processingState?.close();
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    process.exit(sig === 'max_crashes' || sig === 'cycle-failure-cap' ? 1 : 0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  const AUTOPILOT_MAX_RECONNECT_FAILS = Math.max(
    1,
    Number(process.env.GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS) || 30,
  );
  // Peer-worker liveness for --no-worker mode. The probe is a proxy, not
  // ground truth: SELECT count(*) of active jobs with a recent lock_until
  // refresh. A queue with only waiting jobs and a healthy idle worker
  // reads as "no worker" (false positive); a worker that died 110s ago
  // while holding a lock reads as "alive" until lock_until expires.
  // Good enough for V1 — a ground-truth minion_workers heartbeat table
  // is tracked as v0.19.1 follow-up B7. When the probe sees no signal
  // for NO_WORKER_WARN_TICKS consecutive cycles, log a loud warning so
  // the operator can spot "I set --no-worker but forgot to start one"
  // before the queue piles up.
  const NO_WORKER_WARN_TICKS = 3;

  while (!state.stopping) {
    const cycleStart = Date.now();
    let cycleOk = true;

    // Refresh the lock mtime so another cron-fired autopilot doesn't
    // declare the instance stale after 10 minutes (Codex C).
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* best-effort */ }

    if (processingState && !processingState.snapshot.processing_ready) {
      await new Promise(r => setTimeout(r, 250));
      continue;
    }

    // #2608: loud once-per-process signal when no chat provider is servable.
    // Without this a keyless daemon looks healthy forever while every LLM
    // phase quietly skips.
    if (!state.noChatProviderWarned) {
      state.noChatProviderWarned = true;
      try {
        const { isAvailable } = await import('../core/ai/gateway.ts');
        if (!isAvailable('chat')) {
          console.error(
            `[autopilot] WARN: no chat provider is available to this daemon — LLM-dependent ` +
            `phases (chronicle event extraction, propose_takes, synthesize, …) will skip. ` +
            `Shell-profile exports often do not reach launchd/systemd: put KEY=value lines in ` +
            `${join(gbrainHomePath(), 'env')} (sourced by the wrapper), then re-run ` +
            '`gbrain autopilot --install` to reload the daemon.',
          );
        }
      } catch { /* gateway unconfigured — the cycle surfaces its own errors */ }
    }

    // Post-migration convergence: if the file-plane engine identity changed
    // since boot, this process is connected to the wrong engine. Exit through
    // the clean shutdown path (engine close matters for PGLite WAL) so the
    // supervisor relaunches on the new config; the same relaunch contract the
    // self-upgrade swap relies on. Cron and one-shot targets simply pick up
    // the new config on their next run.
    // A torn or failed read (concurrent config write, transient EACCES) must
    // not restart the daemon: skip the comparison unless the file read
    // actually produced a config — a genuine migration flip never yields null.
    let identityNow: string | null = null;
    try {
      const fileCfg = loadConfigFileOnly();
      identityNow = fileCfg ? autopilotEngineIdentity(fileCfg) : null;
    } catch { /* torn read mid-write; check again next tick */ }
    if (identityNow !== null && identityNow !== engineIdentityAtBoot) {
      console.log('[autopilot] engine config changed on disk (migration?) — exiting for relaunch on the new engine.');
      await shutdown('engine-config-changed');
      return;
    }

    // Cooperative pause (see autopilotPausedMarkerPath). Checked AFTER the
    // heartbeat so a paused daemon still reads as alive, and BEFORE any DB
    // work so a cross-engine migration is not racing our writes into an
    // engine that is about to stop being the configured one.
    if (autopilotPaused()) {
      // Self-heal an orphan: a migrate-owned marker whose recorded pid is dead
      // was leaked by a killed migration (SIGKILL, power loss — anything its
      // own cleanup could not catch). Nothing else ever deletes it, and an
      // orphan parks this daemon forever. An operator's manual hold (no
      // migrate signature) is never touched, and a live migrate's marker
      // reads alive and is honored.
      let orphaned = false;
      try {
        const body = readFileSync(autopilotPausedMarkerPath(), 'utf-8');
        orphaned = body.startsWith(MIGRATE_PAUSE_MARKER_PREFIX) && markerHolderAlive(body) === 'dead';
      } catch { /* vanished or unreadable: fall through to the normal pause */ }
      if (orphaned) {
        console.log('[autopilot] clearing an orphaned pause marker (its migrate process is dead); resuming.');
        try { unlinkSync(autopilotPausedMarkerPath()); } catch { /* already gone */ }
      }
      if (autopilotPaused()) {
        if (!state.pausedAnnounced) {
          console.log('[autopilot] paused (autopilot-paused marker present) — skipping cycles until it clears.');
          state.pausedAnnounced = true;
        }
        // Poll faster than a normal tick so a migration's quiesce window is short.
        await new Promise((r) => setTimeout(r, Math.min(baseInterval, 30) * 1000));
        continue;
      }
    }
    if (state.pausedAnnounced) {
      console.log('[autopilot] resumed — pause marker cleared.');
      state.pausedAnnounced = false;
    }

    // DB health check (reconnect if needed).
    //
    // v0.37.7.0 #1162: classify reconnect failures. Pre-fix, the
    // catch logged the error and looped forever — when `database_url`
    // was unset/malformed the loop spammed `config.database_url
    // undefined` until launchd was killed manually. Now:
    //   - Recoverable transient (network blip, pool saturated, 503) →
    //     log + retry next tick. Up to GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS
    //     consecutive failures before exit (default 30 = ~5min at
    //     10s ticks).
    //   - Unrecoverable (database_url unset, malformed URL, auth
    //     failure) → exit immediately with a clear stderr line.
    //     ThrottleInterval=60 in the launchd plist (v0.37.7.0) ensures
    //     launchd's KeepAlive backoff actually backs off instead of
    //     thrashing.
    try {
      await engine.getConfig('version');
      state.autopilotReconnectFails = 0; // reset on success
    } catch (probeErr) {
      if (configurationBlocked()) continue;
      try {
        // #2034: use reconnect() — it restores the config captured at connect()
        // and avoids the null-connection window. The previous
        // `disconnect()` + bare `connect()` lost the config (throwing
        // `database_url undefined` on every retry → FATAL restart-loop on any
        // transient DB blip) AND tore down the pool postgres.js can otherwise
        // self-heal.
        await engine.reconnect({ error: probeErr });
        state.autopilotReconnectFails = 0;
      } catch (e) {
        if (configurationBlocked()) continue;
        logError('reconnect', e);
        state.autopilotReconnectFails++;
        const klass = classifyReconnectError(e);
        if (klass === 'crash') {
          // A gbrain BUG, not an operator misconfiguration. Say so plainly
          // instead of blaming the config, and keep retrying: a code defect must
          // not permanently disable the daemon. The consecutive-failure cap below
          // still bounds it.
          console.error(
            `[autopilot] BUG: internal error during reconnect (${(e as Error).message ?? 'unknown'}). ` +
            `This is a gbrain defect, not a configuration problem — please report it. ` +
            `Retrying (${state.autopilotReconnectFails}/${AUTOPILOT_MAX_RECONNECT_FAILS}).`,
          );
        } else if (klass === 'unrecoverable') {
          console.error(
            `[autopilot] FATAL: unrecoverable DB error (${(e as Error).message ?? 'unknown'}). ` +
            `Exiting so launchd ThrottleInterval can apply backoff.`,
          );
          state.stopping = true;
          setCliExitVerdict(1);
          break;
        }
        if (state.autopilotReconnectFails >= AUTOPILOT_MAX_RECONNECT_FAILS) {
          console.error(
            `[autopilot] FATAL: ${state.autopilotReconnectFails} consecutive reconnect failures. ` +
            `Last error: ${(e as Error).message ?? 'unknown'}. Exiting.`,
          );
          state.stopping = true;
          setCliExitVerdict(1);
          break;
        }
      }
    }

    // v0.42 self-upgrade silent channel (opt-in self_upgrade.mode=auto). Runs
    // each tick; cache TTL throttles the actual GitHub fetch. On apply it swaps
    // + exits for supervisor relaunch (never returns). No-op unless mode=auto.
    if (configurationBlocked()) continue;
    await attemptAutopilotSelfUpgrade(engine, engineType, lockPath, () => !configurationBlocked());
    if (configurationBlocked()) continue;

    // --no-worker peer-liveness probe (v0.19.1). Runs every cycle, cheap
    // (single SELECT). See NO_WORKER_WARN_TICKS comment above for caveats.
    if (noWorker && useMinionsDispatch) {
      try {
        const rows = await (engine as any).executeRaw?.(
          `SELECT count(*)::int AS n FROM minion_jobs
             WHERE status = 'active'
               AND lock_until IS NOT NULL
               AND lock_until > now() - interval '2 minutes'`,
        );
        const liveWorkerSignal = Number((rows as Array<{ n: number }>)?.[0]?.n ?? 0);
        if (liveWorkerSignal === 0) {
          state.noWorkerConsecutiveIdle++;
          if (state.noWorkerConsecutiveIdle === NO_WORKER_WARN_TICKS) {
            // Fire loud on the Nth consecutive idle tick; don't repeat on every
            // subsequent cycle (the operator already saw it), re-arm once a
            // live worker is seen again.
            console.error(
              `[autopilot] WARNING: --no-worker set and no worker has claimed a job in ~${NO_WORKER_WARN_TICKS * baseInterval}s. ` +
              `Jobs will pile up in 'waiting' until a worker starts. ` +
              `Probe is a proxy (lock_until refresh) and can false-positive on idle queues — see B7 for ground-truth follow-up.`,
            );
          }
        } else {
          if (state.noWorkerConsecutiveIdle >= NO_WORKER_WARN_TICKS) {
            console.log('[autopilot] --no-worker probe: live worker signal detected; warning re-armed.');
          }
          state.noWorkerConsecutiveIdle = 0;
        }
      } catch (e) {
        // Probe failures never block the main dispatch loop. Log once per
        // failure class; ignore repeated errors (common shape: DB reconnect
        // blip between ticks).
        logError('no-worker-probe', e);
      }
    }

    if (useMinionsDispatch) {
      // v0.36+ brain-health-100 wave (T8): targeted-submit loop.
      //
      // Pre-fix: every tick submitted ONE autopilot-cycle job, full phase
      // set, regardless of brain state. On a healthy brain this was pure
      // overhead. On a degraded brain it bundled fast wins (embed) with
      // slow phases (synthesize) so the user waited for the slowest.
      //
      // New logic: compute the remediation plan (cheap; no full doctor
      // walk), then route to the right level of intervention:
      //   - Full cycle every 60min regardless of score/plan (phase-
      //     coupling + freshness invariant); healthy brains sleep before it.
      //   - Small plan (<=3 steps, <5min): submit individual handlers.
      //   - Large plan or low score: full autopilot-cycle (the hammer).
      //
      // D10 cycle-lock invariant ensures targeted-submit and
      // autopilot-cycle can never run concurrently (both acquire
      // gbrain-cycle), so the "60-min floor double-processes queued
      // targeted jobs" failure mode is closed by the lock.
      //
      // v0.40 D17 layered on top: per-source freshness check fires BEFORE
      // the score gate so a healthy brain that happens to have a stale
      // federated source still picks up new commits. brain_score reflects
      // internal data quality (embed coverage, link density, orphans),
      // NOT whether GitHub has new commits on the source repo. Decoupling
      // the two closes the silent-stale-source bug class on
      // poll-only deployments.
      try {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        const { computeRecommendations, embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG, chatApiKeyConfigured } = await import('../core/brain-score-recommendations.ts');
        const queue = new MinionQueue(engine);
        const slotMs = Math.floor(Date.now() / (baseInterval * 1000)) * baseInterval * 1000;
        const slot = new Date(slotMs).toISOString();
        const timeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, false);

        // ── v0.40 D17: per-source freshness check ────────────────────
        // Runs first; independent of score gate. Submits a 'sync' job per
        // source whose last_sync_at is older than the interval. The sync
        // handler (T6/T7) auto-enqueues embed-backfill on completion if
        // pages changed.
        try {
          const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
          if (await isFederatedV2Enabled(engine)) {
            const sources = await loadAllSources(engine);
            const activationPending = await loadActivationPendingSourceIds(engine);
            const intervalMs = baseInterval * 1000;
            const now = Date.now();
            for (const src of sources) {
              if (!src.local_path) continue;
              // #4399: config.syncEnabled=false excludes a source from AUTOMATIC
              // sync (this loop, the full-cycle fan-out, `sync --all`); an
              // explicit `gbrain sync --source <id>` is unaffected.
              if (isSyncDisabledConfig(src.config)) continue;
              if (skipActivationPendingSync(activationPending, src.id, 'freshness_sync_skipped', jsonMode, (l) => process.stderr.write(l + '\n'))) continue; // #5198
              // A local_path this machine cannot use — relative (#3696: cwd is
              // launchd's, not the registering shell's) or absent on disk and
              // not a managed clone sync can re-create — would sync a phantom
              // path. Skip loudly (sourceLocalPathSkipWarning carries the
              // fix); under --json the skip is an NDJSON event like every
              // other daemon line on stderr, never bare prose in the stream.
              const skipWarn = sourceLocalPathSkipWarning(src.id, src.local_path, undefined, src.config);
              if (skipWarn) {
                process.stderr.write(
                  (jsonMode ? JSON.stringify({ event: 'freshness_source_path_skipped', source_id: src.id, reason: skipWarn }) : skipWarn) + '\n',
                );
                continue;
              }
              const lastSyncMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : 0;
              const ageMs = now - lastSyncMs;
              if (ageMs < intervalMs) continue; // fresh enough
              try {
                const job = await queue.add(
                  'sync',
                  {
                    sourceId: src.id,
                    repoPath: src.local_path,
                    pull: sourceConfigHasRemoteUrl(src.config),
                    auto_embed_backfill: true,
                    embed_reason: 'autopilot_freshness',
                  },
                  {
                    queue: 'default',
                    idempotency_key: `autopilot-sync:${src.id}:${slot}`,
                    max_attempts: 2,
                    timeout_ms: timeoutMs,
                    maxWaiting: 1,
                  },
                );
                if (jsonMode) {
                  process.stderr.write(JSON.stringify({
                    event: 'dispatched', job_id: job.id, mode: 'freshness',
                    source_id: src.id, age_ms: ageMs,
                  }) + '\n');
                } else {
                  console.log(`[dispatch] job #${job.id} sync (freshness: ${src.id}; age=${Math.floor(ageMs / 60000)}min)`);
                }
              } catch (e) {
                logError('dispatch.freshness', e);
              }
            }
          }
        } catch (e) {
          logError('dispatch.freshness-gate', e);
        }

        // ── #1685 GAP D: per-source extract_atoms auto-drain ───────────────
        // The silent-backlog incident: a pack that doesn't declare extract_atoms
        // never runs the phase in the routine cycle, so the atom backlog grows
        // invisibly. Auto-submit a bounded, PROTECTED drain per source when the
        // backlog exceeds the threshold AND the active pack doesn't declare the
        // phase. Default-ON, daily-spend-capped, time-sloted key so a new slot
        // opens each UTC day (CODEX #1/#2/#3, DECISION 3C). Postgres-only —
        // PGLite has no multi-process worker to run the job.
        if (engine.kind === 'postgres') {
          try {
            const enabled = (await engine.getConfig('autopilot.auto_drain.enabled')) !== 'false';
            if (enabled) {
              const { packDeclaresPhase } = await import('../core/cycle.ts');
              // packDeclaresPhase reads the active pack (brain-wide, not
              // per-source). If the pack declares extract_atoms the routine
              // cycle already drains it for every source — nothing to do.
              const declares = await packDeclaresPhase(engine, 'extract_atoms');
              if (!declares) {
                const parsePosInt = (v: string | null, d: number): number => {
                  if (v == null) return d;
                  const n = parseInt(v, 10);
                  return Number.isFinite(n) && n > 0 ? n : d;
                };
                const parseNonNegFloat = (v: string | null, d: number): number => {
                  if (v == null) return d;
                  const n = parseFloat(v);
                  return Number.isFinite(n) && n >= 0 ? n : d;
                };
                const threshold = parsePosInt(await engine.getConfig('autopilot.auto_drain.threshold'), 25);
                const windowSeconds = parsePosInt(await engine.getConfig('autopilot.auto_drain.window_seconds'), 120);
                const maxUsdPerDay = parseNonNegFloat(await engine.getConfig('autopilot.auto_drain.max_usd_per_day'), 2.0);
                // Each drain run is BudgetTracker-capped at ~$0.30; bound the
                // brain-wide daily count instead of a real-time spend ledger.
                const PER_RUN_USD = 0.3;
                const maxJobsToday = Math.max(0, Math.floor(maxUsdPerDay / PER_RUN_USD));
                const utcDay = new Date().toISOString().slice(0, 10);

                let submittedToday = 0;
                try {
                  const rows = await engine.executeRaw<{ cnt: number }>(
                    `SELECT count(*)::int AS cnt FROM minion_jobs WHERE name = 'extract-atoms-drain' AND created_at >= $1::timestamptz`,
                    [`${utcDay}T00:00:00Z`],
                  );
                  submittedToday = rows[0]?.cnt ?? 0;
                } catch {
                  // count is best-effort; treat as 0 (cap still bounds submits this tick).
                }

                if (submittedToday < maxJobsToday) {
                  const { countExtractAtomsBacklog } = await import('../core/cycle/extract-atoms.ts');
                  const sources = await loadAllSources(engine);
                  for (const src of sources) {
                    if (submittedToday >= maxJobsToday) break; // brain-wide daily cap (fairness)
                    if (!src.local_path) continue;
                    // Same unavailable-path skip (relative / missing on this
                    // machine) as the freshness loop above, same --json shape.
                    const skipWarn = sourceLocalPathSkipWarning(src.id, src.local_path, undefined, src.config);
                    if (skipWarn) {
                      process.stderr.write(
                        (jsonMode ? JSON.stringify({ event: 'freshness_source_path_skipped', source_id: src.id, reason: skipWarn }) : skipWarn) + '\n',
                      );
                      continue;
                    }
                    const backlog = await countExtractAtomsBacklog(engine, src.id);
                    if (backlog === null || backlog <= threshold) continue;
                    // Time-sloted key (CODEX #2): a static key would block the
                    // source FOREVER once the first job completes. A new UTC-day
                    // slot reopens it each day.
                    const idemKey = `autopilot-extract-atoms-drain:${src.id}:${utcDay}`;
                    try {
                      // CODEX (impl review #4): DO NOT use maxWaiting here — it
                      // coalesces by (name, queue), NOT by source, so source B's
                      // submit would return source A's waiting row, B would never
                      // queue, and the cap counter would over-count. The per-source
                      // idempotency key is the correct dedup. Pre-check it so we
                      // submit + count only genuinely-new sources (queue.add returns
                      // the existing row on an idempotency hit with no created flag,
                      // which would otherwise over-count the daily cap). The
                      // single-instance autopilot lock + the unique idempotency
                      // index make this pre-check race-free.
                      const dupe = await engine.executeRaw<{ one: number }>(
                        `SELECT 1 AS one FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
                        [idemKey],
                      );
                      if (dupe.length > 0) continue; // already queued/drained for this source today
                      const job = await queue.add(
                        'extract-atoms-drain',
                        { sourceId: src.id, window: windowSeconds, repoPath: src.local_path },
                        {
                          queue: 'default',
                          idempotency_key: idemKey,
                          // issue #3218: the handler now throws on an
                          // all-provider-failed batch, so give the queue's
                          // backoff a chance (was 1 — dead-lettered instantly).
                          max_attempts: 3,
                          timeout_ms: timeoutMs,
                        },
                        { allowProtectedSubmit: true },
                      );
                      submittedToday++;
                      if (jsonMode) {
                        process.stderr.write(JSON.stringify({
                          event: 'dispatched', job_id: job.id, mode: 'auto-drain',
                          source_id: src.id, backlog,
                        }) + '\n');
                      } else {
                        console.log(`[dispatch] job #${job.id} extract-atoms-drain (auto-drain: ${src.id}; backlog=${backlog})`);
                      }
                    } catch (e) {
                      logError('dispatch.auto-drain', e);
                    }
                  }
                }
              }
            }
          } catch (e) {
            logError('dispatch.auto-drain-gate', e);
          }
        }

        // Cheap path: engine.getHealth() is a single SQL count query.
        const health = await engine.getHealth();
        const score = health.brain_score;
        // v0.40.x: recipe-aware embedding-provider check shared with doctor.ts.
        // Resolve the configured model (gateway → DB fallback), then pre-await
        // the handful of hosted-key config values so the resolveKey closure
        // passed to embeddingProviderConfigured() can stay synchronous.
        let embeddingModel: string | undefined;
        try {
          const gw = await import('../core/ai/gateway.ts');
          embeddingModel = gw.getEmbeddingModel();
        } catch {
          embeddingModel = (await engine.getConfig('embedding_model')) ?? undefined;
        }
        // #2662 (codex round-3): HOSTED_EMBED_KEY_CONFIG entries are keys
        // buildGatewayConfig folds from the FILE plane only — `gbrain config
        // set <key> X` writes the DB plane, which never reaches the gateway
        // for these fields. Reading via engine.getConfig() here (DB plane)
        // would report a provider "configured" from a DB-only key that the
        // gateway can never actually use, dispatching a doomed embed job.
        // Read the same file-plane source context.ts (doctor) reads instead,
        // so autopilot and doctor agree with what the gateway can see.
        const { loadConfigFileOnly } = await import('../core/config.ts');
        const fileCfg = loadConfigFileOnly() as Record<string, unknown> | null;
        const embedKeyCfg: Record<string, unknown> = {};
        for (const field of Object.values(HOSTED_EMBED_KEY_CONFIG)) {
          embedKeyCfg[field] = fileCfg?.[field];
        }
        const ctx = {
          repoPath,
          embeddingModel,
          embeddingProviderConfigured: embeddingProviderConfigured(embeddingModel, (envVar) => {
            const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
            return !!(process.env[envVar] || (cfgField ? embedKeyCfg[cfgField] : undefined));
          }),
          // #3944: env + FILE plane via the shared helper — the same probe
          // doctor's loadRecommendationContext uses. Reading the DB plane
          // here (engine.getConfig) reported a chat key "configured" that
          // doctor's planner (file plane, per the #2662 rule above) said was
          // missing, so autopilot dispatched chat jobs doctor called blocked.
          hasChatApiKey: chatApiKeyConfigured(fileCfg),
          staleExtractionBlocked: await (await import('../core/remediation/context.ts')).staleExtractionBlocked(engine).catch(() => undefined),
        };
        // v0.41.18.0 (A5 + A19 + A22, T15): consult onboard recommendations
        // ALONGSIDE doctor's brain-score recommendations. Onboard's 4 new
        // checks (embed_staleness, link_coverage, timeline_coverage,
        // takes_count) supply extraRemediations into computeRecommendations.
        // Per A19 fail-open: any throw in the onboard path falls through
        // to legacy doctor-only plan (no crash).
        let extraRemediations: ReturnType<typeof computeRecommendations> = [];
        try {
          const { runAllOnboardChecks } = await import('../core/onboard/checks.ts');
          const onboardResults = await runAllOnboardChecks(engine);
          extraRemediations = onboardResults.flatMap((r) => r.remediations);
        } catch (err) {
          process.stderr.write(
            `[autopilot] onboard checks failed (fail-open per A19): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        const plan = computeRecommendations(health, ctx, extraRemediations).filter((r) => r.status === 'remediable');
        const estTotal = plan.reduce((s, r) => s + r.est_seconds, 0);

        // Track time since last full cycle for the 60-min floor.
        const minutesSinceLastFull = (Date.now() - state.lastFullCycleAt) / 60000;

        const shouldFullCycle = shouldRunAutopilotFullCycle({
          score,
          planLength: plan.length,
          estimatedSeconds: estTotal,
          minutesSinceLastFull,
        });

        const shouldSleep = shouldSleepHealthyAutopilot(score, plan.length, minutesSinceLastFull);

        if (shouldSleep) {
          if (jsonMode) {
            process.stderr.write(JSON.stringify({ event: 'skip_healthy', score, plan_size: 0 }) + '\n');
          }
        } else if (shouldFullCycle) {
          // v0.38: per-source fan-out replaces the single-job dispatch.
          // dispatchPerSource enumerates sources via listAllSources
          // ({ localPathOnly: true }), gates each on per-source
          // `last_full_cycle_at` from sources.config JSONB, and fans out
          // up to `fanoutMax` per tick (default 4 Postgres, 1 PGLite per
          // codex P1-3). Fresh-install brains with no sources rows fall
          // back to the legacy single autopilot-cycle so existing
          // behavior is preserved.
          const { dispatchPerSource, dispatchGlobalMaintenance, maybeDispatchConnectorSyncs, resolveEffectiveFanoutMax } = await import('./autopilot-fanout.ts');
          // #2194 fix #1: clamp fan-out to the worker's effective concurrency
          // (reserve ≥1 slot), gated on a LIVE supervisor so a stale audit row
          // can't shrink throughput (codex #9/D5). autopilot-cycle jobs run on
          // the 'default' queue, so that's the concurrency we compare against.
          const fanoutMax = await resolveEffectiveFanoutMax(engine, 'default');
          // #2781: both 'autopilot-cycle' (per-source) and 'autopilot-global-
          // maintenance' carry a 30-min handler anchor (handler-timeouts.ts)
          // because a full cycle can outlive short daemon intervals — unlike
          // the lighter interval-derived `timeoutMs` above (sync/freshness,
          // extract-atoms-drain, targeted small-plan steps), which have no
          // such anchor and are meant to stay interval-derived. Naming this
          // separately (rather than reusing the outer `timeoutMs`) avoids
          // the #2781 bug class: dispatchGlobalMaintenance previously reused
          // the outer non-full-cycle `timeoutMs` by shorthand, silently
          // dropping its own handler anchor.
          const fullCycleTimeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, true);
          const result = await dispatchPerSource(engine, queue, {
            repoPath,
            slot,
            timeoutMs: fullCycleTimeoutMs,
            fanoutMax,
            jsonMode,
          });
          // #2194 fix #3 / #2227 bug #3: dispatch the single brain-wide
          // maintenance job (embed/orphans/purge/…) once per window — the per-
          // source cycles above no longer run global phases, so this is where
          // the brain-wide work happens (single-flight, no RSS blowout). Only on
          // the per-source path (legacy single-source still runs everything).
          if (!result.legacy_fallback) {
            try {
              await dispatchGlobalMaintenance(engine, queue, { repoPath, slot, timeoutMs: fullCycleTimeoutMs, jsonMode });
            } catch (e) {
              if (jsonMode) process.stderr.write(JSON.stringify({ event: 'global_maintenance_dispatch_failed', error: e instanceof Error ? e.message : String(e) }) + '\n');
            }
          }
          // Opt-in scheduled chat-connector sync (OV#4). Credential-gated +
          // auto_sync-gated: fires for nobody who hasn't explicitly enabled it.
          try {
            await maybeDispatchConnectorSyncs(engine, queue, { slot, timeoutMs: fullCycleTimeoutMs, jsonMode });
          } catch (e) {
            if (jsonMode) process.stderr.write(JSON.stringify({ event: 'connector_sync_dispatch_failed', error: e instanceof Error ? e.message : String(e) }) + '\n');
          }
          // On restart the process-local clock starts overdue. If persisted
          // source timestamps say every source is fresh, advance the local
          // clock too; otherwise a non-empty targeted plan would be skipped
          // on every tick until the persisted 60-minute window elapsed.
          // Coalesced counts as work-in-flight: before dispatched/coalesced
          // split, a coalesced submission advanced this clock via dispatched —
          // keep that behavior, or an all-coalesced tick (single-flight
          // suppression) would retake the full-cycle branch every tick and
          // starve the targeted-plan path for the whole in-flight window.
          // (all_sources_handled subsumes all_sources_fresh: fresh + locally
          // skipped === every source.)
          if (
            result.dispatched.length > 0 ||
            result.coalesced.length > 0 ||
            result.legacy_fallback ||
            result.all_sources_handled
          ) {
            state.lastFullCycleAt = Date.now();
          }
          if (jsonMode) {
            process.stderr.write(JSON.stringify({
              event: 'fanout_summary',
              dispatched: result.dispatched,
              coalesced: result.coalesced,
              skipped_fresh: result.skipped_fresh,
              skipped_cap: result.skipped_cap,
              skipped_cooldown: result.skipped_cooldown,
              skipped_unavailable_path: result.skipped_unavailable_path,
              legacy_fallback: result.legacy_fallback,
              fanout_max: fanoutMax,
              score,
            }) + '\n');
          } else if (!result.legacy_fallback) {
            console.log(
              `[dispatch] fanout: ${result.dispatched.length} dispatched` +
              `${result.coalesced.length > 0 ? ` (${result.coalesced.length} coalesced onto in-flight)` : ''}, ` +
              `${result.skipped_fresh.length} fresh, ${result.skipped_cap.length} capped, ` +
              `${result.skipped_cooldown.length} cooldown, ` +
              `${result.skipped_unavailable_path.length} unavailable-path ` +
              `(score=${score}, max=${fanoutMax})`,
            );
          }
        } else {
          // Small targeted plan — submit individual handlers per step.
          // Recommendation keys stay stable for doctor/remediate checkpoints;
          // Autopilot adds the dispatch interval so completed rows cannot hold
          // the remediation slot forever (#4046).
          // maxWaiting:1 per submit per codex #17 bounds the cross-window
          // backlog if a targeted handler runs longer than one interval.
          for (const step of plan) {
            try {
              const isProtected = !!step.protected;
              const submitOpts = {
                queue: 'default',
                idempotency_key: autopilotRemediationIdempotencyKey(step.idempotency_key, slot),
                max_attempts: 2,
                timeout_ms: timeoutMs,
                maxWaiting: 1,
              };
              const job = await queue.add(
                step.job,
                step.params,
                submitOpts,
                isProtected ? { allowProtectedSubmit: true } : undefined,
              );
              // Honest-dispatch contract (same as the fanout paths): a
              // coalesced submission never claims a dispatch that didn't
              // insert a row.
              if (job.coalesced) {
                if (jsonMode) {
                  process.stderr.write(JSON.stringify({ event: 'dispatch_coalesced', job_id: job.id, mode: 'targeted', step: step.id, score, plan_size: plan.length }) + '\n');
                } else {
                  console.log(`[dispatch] coalesced onto job #${job.id} ${step.job} (targeted: ${step.id}; already in flight)`);
                }
              } else if (jsonMode) {
                process.stderr.write(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'targeted', step: step.id, score, plan_size: plan.length }) + '\n');
              } else {
                console.log(`[dispatch] job #${job.id} ${step.job} (targeted: ${step.id}; score=${score})`);
              }
            } catch (e) {
              logError('dispatch.step', e);
            }
          }
        }
      } catch (e) { logError('dispatch', e); cycleOk = false; }
    } else {
      // Inline fallback — delegate to runCycle so lint + backlinks +
      // orphan sweep run too (previously this path only did sync +
      // extract + embed, which didn't match the Minions-dispatch
      // path's phase set). Now both converge on the same primitive.
      try {
        const { runCycle } = await import('../core/cycle.ts');
        // #1872: track the promise so closeEngine can drain it on shutdown,
        // and pass the abort signal so the cycle winds down between phases.
        const cyclePromise = runCycle(engine, {
          brainDir: repoPath,
          // Autopilot daemon path: pulls by default (matches
          // pre-v0.17 autopilot behavior). CLI dream defaults false
          // for cron safety; that choice is scoped to dream only.
          pull: true,
          signal: shutdownAbort.signal,
          yieldBetweenPhases: async () => {
            await new Promise(r => setImmediate(r));
          },
        });
        state.inflightInlineCycle = cyclePromise;
        const report = await cyclePromise.finally(() => { state.inflightInlineCycle = null; });
        // Only 'failed' (every attempted phase failed) trips the autopilot
        // circuit breaker. 'partial' means at least one phase warned or
        // failed while others ran — that's a soft signal, not a fatal
        // condition. Treating 'partial' as failure here caused respawn
        // storms under KeepAlive=true on brains where a single phase
        // (typically `orphans`) emits a 'warn' every cycle in steady state.
        if (report.status === 'failed') {
          cycleOk = false;
        }
        if (jsonMode) {
          process.stderr.write(JSON.stringify({ event: 'cycle-inline', status: report.status, duration_ms: report.duration_ms, totals: report.totals }) + '\n');
        } else {
          const t = report.totals;
          console.log(`[cycle-inline ${report.status}] lint=${t.lint_fixes} backlinks=${t.backlinks_added} synced=${t.pages_synced} extracted=${t.pages_extracted} embedded=${t.pages_embedded} orphans=${t.orphans_found}`);
        }
      } catch (e) { logError('cycle-inline', e); cycleOk = false; }
    }

    if (configurationBlocked()) continue;
    // 4. Health check + adaptive interval (same for both paths)
    let interval = baseInterval;
    try {
      const health = await engine.getHealth();
      const score = (health as any).brain_score ?? 50;
      interval = score >= 90 ? baseInterval * 2
               : score < 70 ? Math.max(Math.floor(baseInterval / 2), 60)
               : baseInterval;

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
      const line = `[cycle] score=${score} elapsed=${elapsed}s next=${interval}s`;
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'cycle', brain_score: score, elapsed_s: Number(elapsed), next_s: interval }) + '\n');
      } else {
        console.log(line);
      }
    } catch (e) { logError('health', e); }

    if (configurationBlocked()) continue;
    if (cycleOk) {
      state.consecutiveErrors = 0;
    } else {
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= 5) {
        console.error('5 consecutive cycle failures. Stopping autopilot.');
        await shutdown('cycle-failure-cap');
        if (!state.stopping) continue;
        break;
      }
    }

    // 4.5 — Nightly quality probe (v0.41).
    // Per D10: trust the phase's internal 24h rate-limit (via shouldRunNightly
    // reading the audit JSONL). No scheduler-side precheck — one source of
    // truth for the rate-limit. Feature flag gates the probe entirely.
    // Wrapped in try/catch — a probe failure NEVER crashes the autopilot
    // loop. Probe runs even when cycleOk=false (probe may surface signal
    // explaining why the cycle is failing).
    try {
      const { resolveProbeEnabled, resolveProbeMaxUsd, runNightlyQualityProbe } =
        await import('../core/cycle/nightly-quality-probe.ts');
      const { resolveNightlyProbeSearchConfigSnapshot } =
        await import('../core/cycle/nightly-probe-search-config.ts');
      // Dual-plane read: `gbrain config set` (what the doctor enable hint
      // prints) writes the DB plane; ~/.gbrain/config.json is the fallback.
      let dbEnabled: string | null = null;
      let dbMaxUsd: string | null = null;
      try {
        dbEnabled = await engine.getConfig('autopilot.nightly_quality_probe.enabled');
        dbMaxUsd = await engine.getConfig('autopilot.nightly_quality_probe.max_usd');
      } catch { /* DB unavailable → file plane only */ }
      const probeEnabled = resolveProbeEnabled(dbEnabled, cfg?.autopilot?.nightly_quality_probe?.enabled);
      if (probeEnabled) {
        const { runLongMemEvalForProbe, runCrossModalBatchForProbe } = await import('../core/cycle/nightly-probe-adapters.ts');
        const { isAvailable } = await import('../core/ai/gateway.ts');
        const { existsSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { join } = await import('node:path');
        const maxUsd = resolveProbeMaxUsd(dbMaxUsd, cfg?.autopilot?.nightly_quality_probe?.max_usd);
        // The fixture lives in the package, not usually in the user's brain repo.
        const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
        const fixtureAtPkgRoot = existsSync(join(pkgRoot, 'test', 'fixtures', 'longmemeval-nightly.jsonl'));
        await runNightlyQualityProbe({
          isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
          hasEmbeddingProvider: () => isAvailable('embedding'),
          resolveMaxUsd: () => maxUsd,
          resolveRepoRoot: () => (fixtureAtPkgRoot ? pkgRoot : repoPath ?? gbrainHomePath('.')),
          resolveSearchConfigSnapshot: () => resolveNightlyProbeSearchConfigSnapshot(engine),
          runLongMemEval: runLongMemEvalForProbe,
          runCrossModalBatch: runCrossModalBatchForProbe,
          now: () => new Date(),
        });
      }
    } catch (e) {
      logError('autopilot.nightly_probe', e);
      // Intentional: do NOT bump consecutiveErrors. Probe failure is
      // informational; autopilot loop continues.
    }

    // 4.6 — Nightly conversation-parser probe (v0.41.16.0 phase module;
    // the scheduler wire-up was deferred at ship and is added here). Same
    // posture as 4.5: the phase owns its gates (enabled/mode-gate, LLM
    // key), the wiring owns invocation + the audit row, and a probe
    // failure NEVER crashes the autopilot loop. Per D10 the probe is
    // default-ON for search.mode=tokenmax, opt-in otherwise.
    try {
      const { runConversationParserNightlyProbe } = await import('../core/conversation-parser/nightly-probe.ts');
      const { logParserProbeEvent, parserProbeRanWithin } = await import('../core/audit-parser-probe.ts');
      const { isAvailable } = await import('../core/ai/gateway.ts');
      const { existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { join } = await import('node:path');
      // Flag reads dual-plane: the DB row (`gbrain config set …`) wins,
      // ~/.gbrain/config.json is the fallback. search.mode lives on the
      // DB plane only (mode.ts owns it).
      let parserDbEnabled: string | null = null;
      let dbSearchMode: string | null = null;
      try {
        parserDbEnabled = await engine.getConfig('autopilot.conversation_parser_probe.enabled');
        dbSearchMode = await engine.getConfig('search.mode');
      } catch { /* DB unavailable → file plane only */ }
      const parserEnabled = parserDbEnabled != null
        ? parserDbEnabled === 'true'
        : cfg?.autopilot?.conversation_parser_probe?.enabled === true;
      const searchMode = dbSearchMode ?? '';
      // Fixtures are committed in the gbrain package (test/fixtures/…),
      // NOT the brain repo — resolve from the module location. Compiled
      // binaries carry no source tree: skip quietly instead of writing
      // failure rows that would flip doctor to WARN on every binary install.
      const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
      const fixturePath = join(pkgRoot, 'test', 'fixtures', 'conversation-formats', 'all.jsonl');
      const adversarialPath = join(pkgRoot, 'test', 'fixtures', 'conversation-formats', 'adversarial.jsonl');
      const shouldInvoke = parserEnabled || searchMode === 'tokenmax';
      if (shouldInvoke && existsSync(fixturePath) && existsSync(adversarialPath)) {
        const result = await runConversationParserNightlyProbe({
          isEnabled: () => parserEnabled,
          searchMode: () => searchMode,
          hasLlmKey: () => isAvailable('chat'),
          resolveFixturePath: () => fixturePath,
          resolveAdversarialPath: () => adversarialPath,
          now: () => new Date(),
          shouldSkipForRateLimit: () => parserProbeRanWithin(24 * 60 * 60 * 1000),
        });
        // rate_limited is a non-run: the loop ticks every few minutes, so
        // logging every skip would flood the audit file with no-signal rows.
        if (result.outcome !== 'rate_limited') logParserProbeEvent(result);
      } else if (shouldInvoke && !state.parserProbeFixtureWarned) {
        state.parserProbeFixtureWarned = true;
        console.error(`[parser-probe] fixtures not found under ${pkgRoot}; skipping (probe needs a source-checkout install)`);
      }
    } catch (e) {
      logError('autopilot.parser_probe', e);
      // Informational, like 4.5: do NOT bump consecutiveErrors.
    }

    // Wait for next cycle
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}
