import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cdpBounded, cdpObject } from "./real-world-cdp.js";
import {
  maySignalOriginalProcess,
  observeLinuxProcess,
  originalProcessExited,
  type LinuxProcessObservation,
} from "./real-world-process-lifetime.js";

const require = createRequire(import.meta.url);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("owned real-world browser host lifetime (DM-34WC46)", () => {
  it.each(["SIGTERM", "SIGKILL"] as const)("cleans the browser when its own Node host receives %s", async (signal) => {
    const dir = await mkdtemp(join(tmpdir(), "dm34-signal-"));
    const script = join(dir, "host.mjs");
    const module = pathToFileURL(join(process.cwd(), "tests/real-world-browser.ts")).href;
    await writeFile(
      script,
      `import {openRealWorldBrowser} from ${JSON.stringify(module)};const owner=await openRealWorldBrowser(()=>{});process.send?.({browserPid:owner.processId});await new Promise(()=>{});`,
    );
    const host = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, script], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    let browserPid: number | undefined;
    let expectedStartTime: string | undefined;
    let passed = false;
    let cleanupSignalSent = false;
    const startedAt = Date.now();
    const samples: Array<LinuxProcessObservation & { elapsedMs: number }> = [];
    const sample = async (): Promise<LinuxProcessObservation> => {
      const observation = await observeLinuxProcess(browserPid!, expectedStartTime);
      const previous = samples.at(-1);
      const { elapsedMs: _elapsedMs, ...last } = previous ?? { elapsedMs: 0 };
      if (JSON.stringify(last) !== JSON.stringify(observation)) {
        // Retain the initial identity and at most fifteen latest transitions.
        if (samples.length === 16) samples.splice(1, 1);
        samples.push({ ...observation, elapsedMs: Date.now() - startedAt });
      }
      return observation;
    };
    try {
      browserPid = await cdpBounded(
        new Promise<number>((resolve, reject) => {
          host.once("error", reject);
          host.once("exit", (code) => reject(new Error(`Owned browser host exited before readiness (${code})`)));
          host.on("message", (message) => {
            const value = cdpObject(message)?.browserPid;
            if (typeof value === "number") resolve(value);
          });
        }),
        30_000,
        "Owned browser signal fixture ready",
      );
      expect(alive(browserPid)).toBe(true);
      if (process.platform === "linux") {
        const initial = await sample();
        expect(initial.status).toBe("live");
        if (initial.startTime == null) throw new Error("Owned browser initial Linux identity unavailable");
        expectedStartTime = initial.startTime;
      }
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      host.kill(signal);
      await cdpBounded(exited, 15_000, "Owned browser host exit");
      if (process.platform === "linux")
        await expect.poll(async () => originalProcessExited(await sample()), { timeout: 10_000 }).toBe(true);
      else await expect.poll(() => alive(browserPid!), { timeout: 10_000 }).toBe(false);
      passed = true;
    } finally {
      if (host.exitCode == null && host.signalCode == null) host.kill("SIGKILL");
      if (browserPid != null) {
        if (process.platform === "linux") {
          // A proven original exit needs no further PID lookup or cleanup.
          if (!passed) {
            const observation = await sample();
            // No signal to terminal, reused or unreadable PID identities.
            if (maySignalOriginalProcess(observation, expectedStartTime)) {
              try {
                process.kill(browserPid, "SIGKILL");
                cleanupSignalSent = true;
              } catch (error) {
                if (!(error != null && typeof error === "object" && "code" in error && error.code === "ESRCH"))
                  throw error;
              }
            }
          }
        } else if (alive(browserPid)) process.kill(browserPid, "SIGKILL");
      }
      const evidence = process.env["DOMOTION_WORKER_BOOTSTRAP_EVIDENCE"];
      if (process.platform === "linux" && evidence != null) {
        const output = dirname(evidence);
        await mkdir(output, { recursive: true });
        await writeFile(
          join(output, `process-lifetime-${signal}.json`),
          JSON.stringify(
            {
              schemaVersion: 1,
              profile: "worker-bootstrap-only",
              platform: process.platform,
              arch: process.arch,
              sourceCommit: process.env["GITHUB_SHA"],
              signal,
              pid: browserPid,
              expectedStartTime,
              passed,
              cleanupSignalSent,
              samples,
            },
            null,
            2,
          ),
        );
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
