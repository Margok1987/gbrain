/**
 * Ports for tests that spawn a server process.
 *
 * A random port from a fixed range can already be taken on a busy runner; the
 * server then exits with "port in use" and the test waits out its health
 * deadline. `freePort` asks the OS for a port that is free right now, and
 * `startOnFreePort` retries on a fresh port when the server still exits
 * before it is healthy (another process took the port between the probe and
 * the bind).
 */
import { createServer, type AddressInfo } from 'node:net';

/** A port the OS reports free on `host` (use '0.0.0.0' when the server may bind every interface). */
export async function freePort(host = '127.0.0.1'): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, resolve); });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/** A start attempt whose server exited before it was healthy; `startOnFreePort` retries it on a fresh port. */
export class ExitedEarly {
  constructor(readonly reason: string) {}
}

/**
 * Run `start` on a free port; when it returns `ExitedEarly`, try again on a
 * fresh port, at most `attempts` times, then throw the last reason. `start`
 * throws on its own for anything else (a timeout is not retried).
 */
export async function startOnFreePort<T>(start: (port: number) => Promise<T | ExitedEarly>, opts: { attempts?: number; host?: string } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let reason = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await start(await freePort(opts.host));
    if (!(outcome instanceof ExitedEarly)) return outcome;
    reason = outcome.reason;
  }
  throw new Error(`server exited before it was healthy on ${attempts} fresh ports; last: ${reason}`);
}

/**
 * Poll `url` until it answers 2xx, the process exits, or `timeoutMs` passes.
 * `exited` reports whether the server process has exited.
 */
export async function waitForHealthy(url: string, exited: () => boolean, timeoutMs: number): Promise<'healthy' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) return 'exited';
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return 'healthy';
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return exited() ? 'exited' : 'timeout';
}
