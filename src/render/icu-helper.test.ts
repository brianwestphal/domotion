import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICU_BINARY, __resetIcuHelperForTest, isIcuHelperAvailable, queryIcuCodepoints } from "./icu-helper.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = path.join(ROOT, "tools", "icu-helper", process.platform === "win32" ? "domotion-icu.exe" : "domotion-icu");
const DATA = path.join(ROOT, "tools", "icu-helper", "icudtl.dat");
const haveLocalCompanion = existsSync(HELPER) && existsSync(DATA);

describe.runIf(haveLocalCompanion)("Chromium-pinned ICU companion (DM-2254)", () => {
  it("reports availability without requiring a property query", () => {
    __resetIcuHelperForTest();
    expect(isIcuHelperAvailable()).toBe(true);
  });

  it("does not treat a configured but unusable companion as available", () => {
    const previous = process.env.DOMOTION_ICU_HELPER_PATH;
    process.env.DOMOTION_ICU_HELPER_PATH = path.join(ROOT, "tools", "icu-helper", "missing-companion");
    try {
      __resetIcuHelperForTest();
      expect(isIcuHelperAvailable()).toBe(false);
    } finally {
      if (previous == null) delete process.env.DOMOTION_ICU_HELPER_PATH;
      else process.env.DOMOTION_ICU_HELPER_PATH = previous;
      __resetIcuHelperForTest();
    }
  });

  it("returns exact ICU properties in one batched call", () => {
    __resetIcuHelperForTest();
    const rows = queryIcuCodepoints([0x41, 0x200d, 0x4e00, 0x1f9d1, 0x1f3fb, 0x1f1fa]);
    expect(rows.get(0x41)?.scriptLongName).toBe("Latin");
    expect(rows.get(0x200d)?.generalCategoryName).toBe("Format");
    expect(rows.get(0x4e00)!.binaryProperties & ICU_BINARY.IDEOGRAPHIC).not.toBe(0);
    expect(rows.get(0x1f9d1)!.binaryProperties & ICU_BINARY.EMOJI).not.toBe(0);
    expect(rows.get(0x1f9d1)!.binaryProperties & ICU_BINARY.V2).not.toBe(0);
    expect(rows.get(0x1f3fb)!.binaryProperties & ICU_BINARY.EMOJI_MODIFIER).not.toBe(0);
    expect(rows.get(0x1f1fa)!.binaryProperties & ICU_BINARY.REGIONAL_INDICATOR).not.toBe(0);
  });

  it("rejects invalid scalar values before crossing the native boundary", () => {
    const rows = queryIcuCodepoints([-1, 0x110000, Number.NaN]);
    expect(rows.size).toBe(0);
  });
});
