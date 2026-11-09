import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cdpBounded, cdpObject } from "./real-world-cdp.js";

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
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      host.kill(signal);
      await cdpBounded(exited, 15_000, "Owned browser host exit");
      await expect.poll(() => alive(browserPid!), { timeout: 10_000 }).toBe(false);
    } finally {
      if (host.exitCode == null && host.signalCode == null) host.kill("SIGKILL");
      if (browserPid != null && alive(browserPid)) process.kill(browserPid, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
