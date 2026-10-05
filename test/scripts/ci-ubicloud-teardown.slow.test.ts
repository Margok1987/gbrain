// ci-ubicloud-teardown.slow.test.ts — SIGTERM or SIGHUP (a dropped terminal,
// a cancelled background operation) to scripts/ci-ubicloud.ts while
// its VMs are still provisioning (one created, two creates in flight) against
// a mock Ubicloud API. Every name is recorded before its create, and teardown
// returns only after each VM that came to exist is destroyed and gone. Slow
// because the orchestrator packs the whole checkout before provisioning.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockUbicloud, waitForEvent, type MockUbicloud } from "../helpers/mock-ubicloud-api.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
let dir = "";
let runDir = "";
let mock: MockUbicloud | null = null;

afterEach(() => {
  mock?.stop();
  rmSync(dir, { recursive: true, force: true });
  if (runDir) rmSync(runDir, { recursive: true, force: true });
});

describe("ci:ubicloud teardown", () => {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) it(`${signal} mid-provision destroys every VM it asked for, including creates still in flight`, async () => {
    dir = mkdtempSync(join(tmpdir(), "ci-ubicloud-teardown-"));
    const api = (mock = startMockUbicloud({ createDelayMs: (name) => (/-ci01/.test(name) ? 0 : 4000) }));
    const proc = Bun.spawn(["bun", "run", "scripts/ci-ubicloud.ts", "--vms", "3", "--lanes", "gitleaks"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        UBICLOUD_API_KEY: "test-token",
        UBICLOUD_API_URL: api.url,
        UBI_RUNNER_STATE: join(dir, "state"),
        UBI_OWNER: "probe",
        UBI_POLL_SECONDS: "0.2",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    await waitForEvent(api, /^created \S+-ci01/, 120_000);
    await waitForEvent(api, /^create-start \S+-ci03/, 10_000);
    expect(api.events.some((e) => /^created \S+-ci0[23]/.test(e))).toBe(false);
    proc.kill(signal);
    expect(await proc.exited).toBe(130);
    const out = await stdout;
    runDir = /logs in (\S+)/.exec(out)?.[1] ?? "";

    const requested = readFileSync(join(runDir, "vms.txt"), "utf8").trim().split("\n").map((l) => l.split(" ")[0]!);
    expect(requested).toHaveLength(3);
    for (const name of requested) {
      expect(name).toMatch(/^ubirun-probe-\d{10}-ci0[123][0-9a-f]{4}$/);
      expect(api.events).toContain(`created ${name}`);
      expect(api.events).toContain(`removed ${name}`);
    }
    expect(api.vms.size).toBe(0);
    expect(out).toContain("teardown confirmed 3 VM(s) gone");
    expect(await stderr).not.toContain("WARNING");
  }, 180_000);
});
