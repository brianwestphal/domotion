import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontSourceMap, type FontInstance } from "./font-instance.js";
import { normalLineSpacing, parseVdmxStrike } from "./isolated-primary-font-metrics.js";
import { buildVdmxHintedFont } from "./synth-test-fonts.js";
import { fontkit, isFontkitCollection } from "./fontkit-facade.js";

describe("Linux normal line spacing", () => {
  it("selects the discriminating VDMX strike only with observed bytecode hinting", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-vdmx-"));
    try {
      const path = join(dir, "control.ttf");
      writeFileSync(path, buildVdmxHintedFont());
      const font = fontkit.openSync(path);
      if (isFontkitCollection(font)) throw new Error("expected single control face");
      fontSourceMap.set(font, { path, faceIndex: 0, nameMatched: true });
      expect(normalLineSpacing(font, 16, "linux")).toBeNull();
      expect(normalLineSpacing(font, 16, "linux", "full")).toBeNull();
      expect(normalLineSpacing(font, 16, "linux", "full", true)).toBe(16);
      expect(normalLineSpacing(font, 16, "linux", "none")).toBe(16);
      expect(normalLineSpacing(font, 16, "linux", "slight")).toBe(16);
      expect(normalLineSpacing(font, 16, "linux", "medium", false)).toBe(23);
      expect(normalLineSpacing(font, 16, "linux", "full", false)).toBe(23);
      expect(normalLineSpacing(font, 20, "linux", "full", false)).toBe(20);
      // A no-VDMX mode must not depend on reading an unused table at all.
      fontSourceMap.delete(font);
      expect(normalLineSpacing(font, 16, "linux", "none")).toBe(16);
      expect(normalLineSpacing(font, 16, "linux", "full", false)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses OS/2 typo metrics only when USE_TYPO_METRICS is selected", () => {
    const face = {
      unitsPerEm: 1000,
      ascent: 900,
      descent: -200,
      lineGap: 100,
      "OS/2": {
        version: 4,
        fsSelection: { useTypoMetrics: true },
        typoAscender: 700,
        typoDescender: -300,
        typoLineGap: 100,
      },
    } as unknown as FontInstance;
    expect(normalLineSpacing(face, 20, "linux")).toBe(22);
    expect(normalLineSpacing(face, 20, "darwin")).toBe(24);
  });

  it("reads the first matching 1:1 VDMX strike and ignores other sizes", () => {
    // Header, one ratio, one group offset, then a group with two strikes.
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 1);
    bytes.set([0, 1, 0, 1], 6);
    view.setUint16(10, 12);
    view.setUint16(12, 2);
    view.setUint16(14, 16);
    view.setUint16(16, 13);
    view.setInt16(18, 12);
    view.setInt16(20, -4);
    view.setUint16(22, 16);
    view.setInt16(24, 15);
    expect(parseVdmxStrike(bytes, 13)).toEqual([12, 4]);
    expect(parseVdmxStrike(bytes, 12)).toBeNull();
  });
});

describe("Windows normal line spacing", () => {
  const face = {
    unitsPerEm: 2048,
    ascent: 1854,
    descent: -434,
    lineGap: 67,
    directory: { tables: { hhea: {} } },
  } as unknown as FontInstance;

  it("matches DirectWrite natural metrics for a file-backed face", () => {
    expect(normalLineSpacing(face, 16, "win32")).toBe(18);
  });

  it("leaves bitmap and divergent OS/2 typo metrics unresolved", () => {
    const bitmap = { ...face, directory: { tables: { EBLC: {} } } } as FontInstance;
    expect(normalLineSpacing(bitmap, 16, "win32")).toBeNull();
    const typo = {
      ...face,
      "OS/2": {
        version: 4,
        fsSelection: { useTypoMetrics: true },
        typoAscender: 1600,
        typoDescender: -400,
        typoLineGap: 100,
      },
    } as FontInstance;
    expect(normalLineSpacing(typo, 16, "win32")).toBeNull();
  });
});
