import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ICU_BINARY,
  __resetIcuHelperForTest,
  isIcuHelperAvailable,
  parseIcuResponse,
  queryIcuCodepoints,
} from "./icu-helper.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = path.join(
  ROOT,
  "tools",
  "icu-helper",
  process.platform === "win32" ? "domotion-icu.exe" : "domotion-icu",
);
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

describe("parseIcuResponse", () => {
  const row = (cp: number, overrides: Record<string, unknown> = {}) => ({
    cp,
    found: true,
    generalCategory: 1,
    generalCategoryName: "Lu",
    combiningClass: 0,
    script: 25,
    scriptName: "Latn",
    scriptLongName: "Latin",
    block: 1,
    blockName: "Basic Latin",
    bidiClass: 0,
    bidiPairedBracketType: 0,
    eastAsianWidth: 0,
    indicPositionalCategory: 0,
    indicSyllabicCategory: 0,
    lineBreak: 0,
    verticalOrientation: 0,
    binaryProperties: 0,
    scriptExtensions: [],
    scriptExtensionNames: [],
    ...overrides,
  });
  const envelope = (properties: unknown, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ protocolVersion: "1", icuVersion: "78.2", unicodeVersion: "17.0", properties, ...overrides });

  it("accepts a well-formed response", () => {
    const parsed = parseIcuResponse(envelope([row(0x41), row(0x42)]));
    expect(parsed?.properties.map((r) => r.cp)).toEqual([0x41, 0x42]);
  });

  it("rejects non-JSON, non-objects, wrong versions, and a missing or non-array properties field", () => {
    expect(parseIcuResponse("not json")).toBeNull();
    expect(parseIcuResponse("null")).toBeNull();
    expect(parseIcuResponse("[]")).toBeNull();
    expect(parseIcuResponse(envelope([], { protocolVersion: "2" }))).toBeNull();
    expect(parseIcuResponse(envelope([], { icuVersion: "77.1" }))).toBeNull();
    expect(parseIcuResponse(envelope([], { unicodeVersion: 17 }))).toBeNull();
    expect(parseIcuResponse(envelope({ 0: row(0x41) }))).toBeNull();
    expect(
      parseIcuResponse(JSON.stringify({ protocolVersion: "1", icuVersion: "78.2", unicodeVersion: "17.0" })),
    ).toBeNull();
  });

  it("drops only the malformed rows, so a bad row is never memoized as an answer", () => {
    const parsed = parseIcuResponse(
      envelope([
        row(0x41),
        row(0x42, { script: "Latn" }), // wrong type
        row(0x43, { found: 1 }),
        row(0x44, { scriptExtensions: ["x"] }),
        row(0x45, { scriptExtensionNames: [1] }),
        row(0x46, { blockName: undefined }),
        row(0x47, { generalCategory: null }),
        row(0x1_10000_0), // out of range
        row(1.5),
        null,
        "row",
        row(0x48),
      ]),
    );
    expect(parsed?.properties.map((r) => r.cp)).toEqual([0x41, 0x48]);
  });
});
