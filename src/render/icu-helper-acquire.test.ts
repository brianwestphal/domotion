import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  ICU_COMPANION_VERSION,
  icuAcquireWorkerArgs,
  icuAssetStem,
  icuCacheDir,
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
    expect(ICU_COMPANION_VERSION).toBe("78.2-domotion.1");
    expect(icuCacheDir("linux", { XDG_DATA_HOME: "/cache" }, "/home/me"))
      .toBe(path.join("/cache", "domotion", "icu", ICU_COMPANION_VERSION));
  });

  it("installs a stable executable name beside the matching data file", () => {
    const target = resolveIcuCompanionTarget({ platform: "win32", arch: "arm64", cacheDir: "C:\\cache" });
    expect(target?.executableAsset).toBe("domotion-icu-win32-arm64.exe");
    expect(target?.dataAsset).toBe("domotion-icu-win32-arm64.icudtl.dat");
    expect(target?.runtimeAssets.map(item => item.asset)).toEqual([
      "domotion-icu-win32-arm64.icuuc78.dll",
      "domotion-icu-win32-arm64.icudt78.dll",
    ]);
    expect(path.win32.basename(target!.executablePath)).toBe("domotion-icu.exe");
    expect(path.win32.basename(target!.dataPath)).toBe("icudtl.dat");
  });

  it("keeps the tsx loader when a source checkout launches the download worker", () => {
    const target = resolveIcuCompanionTarget({ platform: "linux", arch: "x64", cacheDir: "/cache" })!;
    expect(icuAcquireWorkerArgs("/repo/src/render/icu-helper-acquire.ts", target).slice(0, 3)).toEqual([
      "--import", "tsx", "/repo/src/render/icu-helper-acquire.ts",
    ]);
    expect(icuAcquireWorkerArgs("/pkg/dist/render/icu-helper-acquire.js", target)[0])
      .toBe("/pkg/dist/render/icu-helper-acquire.js");
  });
});
