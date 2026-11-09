import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ICU_COMPANION_VERSION,
  __resetIcuAcquireStateForTest,
  acquireIcuCompanion,
  icuAcquireWorkerArgs,
  icuAssetStem,
  icuCacheDir,
  parseIcuCompanionTarget,
  resolveIcuCompanionTarget,
} from "./icu-helper-acquire.js";

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
