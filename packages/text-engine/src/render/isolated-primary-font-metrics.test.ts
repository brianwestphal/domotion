import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontSourceMap, type FontInstance } from "./font-instance.js";
import {
  isolatedPrimaryFontMetrics,
  normalLineSpacing,
  overriddenLineSpacing,
  parseVdmxStrike,
} from "./isolated-primary-font-metrics.js";
import {
  registerWebfont,
  snapshotFontRegistrations,
  restoreFontRegistrations,
  pickWebfontPrimaryForCharacter,
} from "./webfont-registry.js";
import { webfontRegistry } from "./font-instance.js";
import { buildVdmxHintedFont, buildVariableHintedFont } from "./synth-test-fonts.js";
import { fontkit, isFontkitCollection } from "./fontkit-facade.js";

describe("isolated image-owned primary faces", () => {
  const data = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url));
  const request = { fontFamily: '"Owned Metric", serif', fontSize: 20, fontWeight: 400, italic: false };
  it("applies size-adjust as the used size and keeps the original face identity", () => {
    const plain = isolatedPrimaryFontMetrics({
      ...request,
      fontSize: 30,
      fontFaces: [{ family: "Owned Metric", data }],
    });
    const adjusted = isolatedPrimaryFontMetrics({
      ...request,
      fontFaces: [{ family: "Owned Metric", data, sizeAdjust: 1.5 }],
    });
    expect(plain?.zeroWidth).not.toBeNull();
    expect(adjusted).toEqual(plain);
  });
  it("derives LineSpacing from a complete override set and leaves a partial one unresolved", () => {
    const full = isolatedPrimaryFontMetrics({
      ...request,
      fontFaces: [{ family: "Owned Metric", data, ascentOverride: 0.8, descentOverride: 0.2, lineGapOverride: 0.1 }],
    });
    expect(full?.lineSpacing).toBe(22);
    const partial = isolatedPrimaryFontMetrics({
      ...request,
      fontFaces: [{ family: "Owned Metric", data, ascentOverride: 0.8 }],
    });
    expect(partial?.lineSpacing).toBeNull();
    expect(partial?.zeroWidth).toBe(full?.zeroWidth);
  });
  it("groups fractional descriptors after Blink's quarter-unit quantization", () => {
    const wider = buildVariableHintedFont({ firstCodePoint: 0x30, withOs2: true, aXMax: 650 });
    const actual = isolatedPrimaryFontMetrics({
      ...request,
      fontFaces: [
        { family: "Owned Metric", data, weight: "400.1" },
        { family: "Owned Metric", data: wider, weight: "400.2" },
      ],
    });
    expect(actual?.zeroWidth).toBe(14);
  });
  it("keeps slnt descriptor provenance unresolved instead of using the ordinary text axis rule", () => {
    const saved = snapshotFontRegistrations();
    try {
      registerWebfont("Slant Metric", 400, "normal", data);
      const variant = webfontRegistry.get("slant metric")![0];
      // fontkit memoizes real axis getters as nonconfigurable properties.
      // Give this one controlled variant its own axis descriptor instead.
      const font = Object.create(variant.font) as FontInstance;
      variant.font = font;
      Object.defineProperty(font, "variationAxes", { value: { slnt: { min: -15, default: 0, max: 0 } } });
      expect(() => pickWebfontPrimaryForCharacter("Slant Metric", 400, 20, 0, 0x30)).toThrow("slant-axis");
    } finally {
      restoreFontRegistrations(saved);
    }
  });
  it("refuses an unnormalized variable container instead of using its base advance", async () => {
    const wawoff = (await import("wawoff2" as string)) as { compress(data: Uint8Array): Promise<Uint8Array> };
    const data = Buffer.from(await wawoff.compress(buildVariableHintedFont({ firstCodePoint: 0x30, withOs2: true })));
    expect(
      isolatedPrimaryFontMetrics({
        ...request,
        fontWeight: 900,
        fontFaces: [{ family: "Owned Metric", data, weight: "100 900" }],
      }),
    ).toBeNull();
  });
  it("uses owned bytes and restores caller registrations after success and rejection", () => {
    const saved = snapshotFontRegistrations();
    try {
      registerWebfont("Caller Metric", 400, "normal", data);
      const before = snapshotFontRegistrations();
      expect(isolatedPrimaryFontMetrics({ ...request, fontFaces: [{ family: "Owned Metric", data }] })?.zeroWidth).toBe(
        12,
      );
      expect(snapshotFontRegistrations()).toEqual(before);
      expect(
        isolatedPrimaryFontMetrics({ ...request, fontFaces: [{ family: "Owned Metric", data: Buffer.from("bad") }] }),
      ).toBeNull();
      expect(snapshotFontRegistrations()).toEqual(before);
    } finally {
      restoreFontRegistrations(saved);
    }
  });
  it("chooses the descriptor group before unicode-range, then walks the CSS family list", () => {
    const fallback = isolatedPrimaryFontMetrics({ ...request, fontFamily: "serif" });
    const actual = isolatedPrimaryFontMetrics({
      ...request,
      fontFaces: [
        { family: "Owned Metric", data, weight: "400", unicodeRange: [[0x41, 0x41]] },
        { family: "Owned Metric", data, weight: "700", unicodeRange: [[0x30, 0x30]] },
      ],
    });
    expect(actual?.zeroWidth).toBe(fallback?.zeroWidth);
    expect(actual?.zeroWidth).not.toBe(12);
  });
  it("looks up the space, digit zero and water in separate range segments", () => {
    const fallback = isolatedPrimaryFontMetrics({ ...request, fontFamily: "serif" });
    const actual = isolatedPrimaryFontMetrics({
      ...request,
      fontFaces: [{ family: "Owned Metric", data, unicodeRange: [[0x30, 0x30]] }],
    });
    expect(actual?.zeroWidth).toBe(12);
    expect(actual?.xHeight).toBe(fallback?.xHeight);
    expect(actual?.ideographicAdvance).toBe(fallback?.ideographicAdvance);
  });
});

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

describe("overriddenLineSpacing", () => {
  const font = { familyName: "Owned" } as unknown as FontInstance;
  const times = { familyName: "Times" } as unknown as FontInstance;
  const all = { ascentOverride: 0.8, descentOverride: 0.2, lineGapOverride: 0.1 };
  it("rounds each overridden component like AscentDescentWithHacks", () => {
    expect(overriddenLineSpacing(font, 20, "darwin", all)).toBe(16 + 4 + 2);
    expect(overriddenLineSpacing(font, 21, "win32", all)).toBe(17 + 4 + 2);
  });
  it("adds the macOS Times/Helvetica/Courier ascent adjustment by family name", () => {
    expect(overriddenLineSpacing(times, 20, "darwin", all)).toBe(16 + 3 + 4 + 2);
    expect(overriddenLineSpacing(times, 20, "win32", all)).toBe(22);
  });
  it("leaves Linux's subpixel descent borrow and partial or invalid sets unresolved", () => {
    expect(overriddenLineSpacing(font, 20, "linux", all)).toBe(22);
    // 21 * 0.2 = 4.2 rounds down, where Linux may borrow from the ascent.
    expect(overriddenLineSpacing(font, 21, "linux", all)).toBeNull();
    expect(overriddenLineSpacing(font, 20, "darwin", { ascentOverride: 0.8, descentOverride: 0.2 })).toBeNull();
    expect(overriddenLineSpacing(font, 20, "darwin", { ...all, lineGapOverride: -1 })).toBeNull();
    expect(overriddenLineSpacing(font, 20, "aix", all)).toBeNull();
  });
});
