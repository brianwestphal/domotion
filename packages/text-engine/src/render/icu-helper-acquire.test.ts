import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: childProcess.spawnSync };
});
import {
  ICU_COMPANION_VERSION,
  __resetIcuAcquireStateForTest,
  acquireIcuCompanion,
  acquireIcuCompanionSync,
  downloadIcuCompanion,
  icuAcquireWorkerArgs,
  icuAssetStem,
  icuCacheDir,
  parseIcuCompanionTarget,
  resolveIcuCompanionTarget,
} from "./icu-helper-acquire.js";

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    warnings.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  childProcess.spawnSync.mockReset();
  __resetIcuAcquireStateForTest();
});

describe("ICU companion acquisition (DM-2254)", () => {
  it("selects an independently versioned native asset for every supported target", () => {
    expect(icuAssetStem("darwin", "x64")).toBe("domotion-icu-darwin-x64");
    expect(icuAssetStem("darwin", "arm64")).toBe("domotion-icu-darwin-arm64");
    expect(icuAssetStem("linux", "x64")).toBe("domotion-icu-linux-x64");
    expect(icuAssetStem("linux", "arm64")).toBe("domotion-icu-linux-arm64");
    expect(icuAssetStem("win32", "x64")).toBe("domotion-icu-win32-x64");
    expect(icuAssetStem("win32", "arm64")).toBe("domotion-icu-win32-arm64");
    expect(icuAssetStem("freebsd", "x64")).toBeNull();
  });

  it("keeps ICU releases independent from the npm package version", () => {
    expect(ICU_COMPANION_VERSION).toBe("78.2-domotion.2");
    expect(icuCacheDir("linux", { XDG_DATA_HOME: "/cache" }, "/home/me")).toBe(
      path.join("/cache", "domotion", "icu", ICU_COMPANION_VERSION),
    );
  });

  it("installs a stable executable name beside the matching data file", () => {
    const target = resolveIcuCompanionTarget({ platform: "win32", arch: "arm64", cacheDir: "C:\\cache" });
    expect(target?.releaseVersion).toBe(ICU_COMPANION_VERSION);
    expect(target?.executableAsset).toBe("domotion-icu-win32-arm64.exe");
    expect(target?.dataAsset).toBe("domotion-icu-win32-arm64.icudtl.dat");
    expect(target?.runtimeAssets.map((item) => item.asset)).toEqual([
      "domotion-icu-win32-arm64.icuuc78.dll",
      "domotion-icu-win32-arm64.icudt78.dll",
    ]);
    expect(path.win32.basename(target!.executablePath)).toBe("domotion-icu.exe");
    expect(path.win32.basename(target!.dataPath)).toBe("icudtl.dat");
  });

  it("keeps the tsx loader when a source checkout launches the download worker", () => {
    const target = resolveIcuCompanionTarget({ platform: "linux", arch: "x64", cacheDir: "/cache" })!;
    expect(icuAcquireWorkerArgs("/repo/src/render/icu-helper-acquire.ts", target).slice(0, 3)).toEqual([
      "--import",
      "tsx",
      "/repo/src/render/icu-helper-acquire.ts",
    ]);
    expect(icuAcquireWorkerArgs("/pkg/dist/render/icu-helper-acquire.js", target)[0]).toBe(
      "/pkg/dist/render/icu-helper-acquire.js",
    );
  });

  it("round-trips the worker argv target and refuses a malformed one", () => {
    const target = resolveIcuCompanionTarget({ platform: "linux", arch: "x64", cacheDir: "/cache" })!;
    const argv = icuAcquireWorkerArgs("/pkg/dist/render/icu-helper-acquire.js", target);
    expect(parseIcuCompanionTarget(argv[argv.length - 1])).toEqual(target);
    for (const raw of [
      undefined,
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...target, dataPath: 3 }),
      JSON.stringify({ ...target, releaseVersion: "bad" }),
      JSON.stringify({ ...target, directory: "" }),
      JSON.stringify({ ...target, runtimeAssets: "x" }),
      JSON.stringify({ ...target, runtimeAssets: [{ asset: "a" }] }),
    ]) {
      expect(parseIcuCompanionTarget(raw)).toBeNull();
    }
  });

  it("retains the previous release as a fallback while new assets are published", () => {
    const target = resolveIcuCompanionTarget({ platform: "darwin", arch: "arm64" }, "78.2-domotion.1")!;
    expect(target.releaseVersion).toBe("78.2-domotion.1");
    expect(target.directory).toContain(path.join("icu", "78.2-domotion.1"));
  });

  it.each([503, 429, "network", "timeout"] as const)(
    "recovers from one transient %s failure before installing verified assets",
    async (failure) => {
      vi.useFakeTimers();
      const dir = mkdtempSync(path.join(tmpdir(), "dm-icu-retry-"));
      const target = resolveIcuCompanionTarget({ platform: "darwin", arch: "arm64", cacheDir: dir })!;
      const body = "verified ICU asset";
      const sha = createHash("sha256").update(body).digest("hex");
      let attempts = 0;
      const request = vi.fn(async (input: string, init: RequestInit) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const url = String(input);
        if (url.endsWith(`/${target.executableAsset}`) && ++attempts === 1) {
          if (failure === "network") throw new TypeError("fetch failed");
          if (failure === "timeout") throw new DOMException("request exceeded deadline", "TimeoutError");
          return new Response("transient failure", { status: failure });
        }
        return new Response(url.endsWith(".sha256") ? sha : body);
      });
      vi.stubGlobal("fetch", request);
      try {
        const download = downloadIcuCompanion(target);
        await vi.runAllTimersAsync();
        expect(await download).toBe(true);
        expect(attempts).toBe(2);
        expect(readFileSync(target.executablePath, "utf8")).toBe(body);
        expect(readFileSync(target.dataPath, "utf8")).toBe(body);
        expect(warnings).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing-checksum", "mismatched-checksum"])(
    "reports %s and leaves the cache uninstalled",
    async (failure) => {
      const dir = mkdtempSync(path.join(tmpdir(), "dm-icu-integrity-"));
      const target = resolveIcuCompanionTarget({ platform: "darwin", arch: "arm64", cacheDir: dir })!;
      const request = vi.fn(async (input: string) => {
        if (!String(input).endsWith(".sha256")) return new Response("asset bytes");
        return failure === "missing-checksum"
          ? new Response("not found", { status: 404 })
          : new Response("0".repeat(64));
      });
      vi.stubGlobal("fetch", request);
      try {
        expect(await downloadIcuCompanion(target)).toBe(false);
        expect(existsSync(target.executablePath)).toBe(false);
        expect(existsSync(target.dataPath)).toBe(false);
        expect(request).toHaveBeenCalledTimes(4);
        expect(warnings.join("\n")).toContain(target.executableAsset);
        expect(warnings.join("\n")).toContain(
          failure === "missing-checksum" ? "checksum HTTP 404" : "SHA-256 mismatch",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("bounds repeated network errors and records the transport cause", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "dm-icu-network-"));
    const target = resolveIcuCompanionTarget({ platform: "darwin", arch: "arm64", cacheDir: dir })!;
    const request = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    vi.stubGlobal("fetch", request);
    try {
      const download = downloadIcuCompanion(target);
      await vi.runAllTimersAsync();
      expect(await download).toBe(false);
      expect(request).toHaveBeenCalledTimes(12);
      expect(warnings.join("\n")).toContain("failed after 3 attempt(s)");
      expect(warnings.join("\n")).toContain("ECONNRESET");
      expect(existsSync(target.executablePath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shares the acquisition deadline across request retries and retains the last timeout", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "dm-icu-deadline-"));
    const target = resolveIcuCompanionTarget({ platform: "darwin", arch: "arm64", cacheDir: dir })!;
    const deadlines: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("request deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const request = vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", request);
    try {
      const started = Date.now();
      const download = downloadIcuCompanion(target);
      await vi.runAllTimersAsync();
      expect(await download).toBe(false);
      expect(Date.now() - started).toBe(55_000);
      expect(deadlines).toEqual([30_000, 30_000, 24_750, 24_750]);
      expect(request).toHaveBeenCalledTimes(8);
      expect(warnings.join("\n")).toContain("55000ms budget after 2 attempt(s)");
      expect(warnings.join("\n")).toContain("TimeoutError: request deadline");
      expect(existsSync(target.executablePath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports worker timeout and child HTTP evidence while retaining warn-once degraded mode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dm-icu-worker-"));
    vi.stubEnv("DOMOTION_ICU_HELPER_PATH", undefined);
    vi.stubEnv("DOMOTION_DISABLE_ICU_HELPER", undefined);
    childProcess.spawnSync.mockReturnValue({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
      stderr: "domotion: ICU download failed: asset HTTP 503",
    });
    try {
      expect(acquireIcuCompanionSync({ platform: "darwin", arch: "arm64", cacheDir: dir })).toBeUndefined();
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(2);
      expect(warnings.join("\n")).toContain("timed out after 60000ms");
      expect(warnings.join("\n")).toContain("asset HTTP 503");
      expect(warnings.join("\n")).toContain("best-effort JavaScript Unicode classification");
      const count = warnings.length;
      expect(acquireIcuCompanionSync({ platform: "darwin", arch: "arm64", cacheDir: dir })).toBeUndefined();
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(count);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tries the new release before downloading the still-published legacy companion", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dm-icu-release-fallback-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    const body = "companion asset";
    const sha = createHash("sha256").update(body).digest("hex");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("icu-v78.2-domotion.2/")) return new Response("missing", { status: 404 });
      return new Response(url.endsWith(".sha256") ? sha : body);
    });
    try {
      const executable = await acquireIcuCompanion({ platform: "linux", arch: "x64" });
      expect(executable).toContain(path.join("icu", "78.2-domotion.1"));
      expect(readFileSync(executable!, "utf8")).toBe(body);
      expect(urls.some((url) => url.includes("icu-v78.2-domotion.2/"))).toBe(true);
      expect(urls.some((url) => url.includes("icu-v78.2-domotion.1/"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      __resetIcuAcquireStateForTest();
      if (previousDataHome == null) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
