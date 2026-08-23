#!/usr/bin/env tsx
/**
 * DM-2514 vertical text-decoration LOGICAL GEOMETRY oracle.
 *
 * This gate is deliberately upstream of rasterization. It compares an
 * independent transcription of pinned Blink (`text_decoration_info.cc`,
 * `text_decoration_offset.cc`, `font_metrics.cc`, `simple_font_data.cc`, and
 * `line_relative_rect.cc`, rev 7d859f27) with the shipped resolver, metric
 * engine, line-bit flip, and physical transform. DPR is crossed coherently at
 * 1 and 4 but never enters a geometry formula; Chrome raster coverage is a
 * separately labelled browser observation, not a reason to tune constants.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as fontkit from "fontkit";
import {
  clearWebfonts, computeSkipInkGaps, getDecorationMetrics, registerWebfont,
} from "../src/render/text-to-path.js";
import { resolvedTextDecorationLine } from "../src/render/text.js";
import {
  lineRelativeToPhysicalTransform, resolveVerticalDecoration, verticalDecorationSkipInkText,
} from "../src/render/vertical-text.js";

const SERIF_PATH = "assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf";
const MONO_PATH = "assets/fonts/fixture/DomotionFixtureMono-Regular.ttf";
const FAMILIES = {
  serif: "DM2514 Fixture Serif",
  mono: "DM2514 Fixture Mono",
} as const;

type FamilyKey = keyof typeof FAMILIES;
type ScriptClass = "kana-hangul" | "other";
type WritingMode = "vertical-rl" | "vertical-lr" | "sideways-rl" | "sideways-lr";

export interface VerticalDecorationOracleCase {
  id: string;
  writingMode: WritingMode;
  textOrientation: "mixed" | "upright" | "sideways";
  lang: string;
  text: string;
  scriptClass: ScriptClass;
  family: FamilyKey;
  fontSize: number;
  logicalFontSize: number;
  ascent: number;
  descent: number;
  position: string;
  lines: string;
  thickness: string;
  offset: string;
  deviceScaleFactor: 1 | 4;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FaceFacts {
  unitsPerEm: number;
  underlineThickness: number;
  underlinePosition: number;
  typoAscender: number;
  typoDescender: number;
}

export interface VerticalDecorationOracleRow {
  id: string;
  deviceScaleFactor: number;
  expected: {
    baselineType: "alphabetic" | "central";
    underlinePosition: "auto" | "from-font" | "under";
    flip: boolean;
    effectiveLines: string;
    thickness: number;
    underlineTop: number;
    overlineTop: number;
    lineThroughTop: number;
    transform: string;
  };
  actual: VerticalDecorationOracleRow["expected"];
  errors: string[];
  pass: boolean;
}

export interface VerticalDecorationOracleReport {
  chromiumRevision: string;
  geometrySpace: "line-relative-css-px";
  deviceScaleFactors: number[];
  logicalGeometryUsesDpr: false;
  rows: VerticalDecorationOracleRow[];
  skipInk: {
    autoExcludedSlashGapCount: number;
    allIncludedSlashGapCount: number;
    uprightProjection: string;
    rotatedProjection: string;
    pass: boolean;
  };
  mutationControls: Record<string, boolean>;
  rasterPhase: {
    classification: "separate-browser-observation";
    acceptanceRole: "non-authoritative-for-logical-constants";
  };
  verdict: "source-exact-logical-geometry" | "logical-geometry-failed";
}

const base = {
  fontSize: 20,
  logicalFontSize: 20,
  ascent: 16.4,
  descent: 4.2,
  position: "auto",
  lines: "underline",
  thickness: "auto",
  offset: "auto",
  deviceScaleFactor: 1 as const,
  x: 100.25,
  y: 50.5,
  width: 21.25,
  height: 64.5,
};

function row(id: string, values: Partial<VerticalDecorationOracleCase> & Pick<VerticalDecorationOracleCase,
  "writingMode" | "textOrientation" | "lang" | "text" | "scriptClass" | "family">): VerticalDecorationOracleCase {
  return { id, ...base, ...values };
}

/** Source discriminator corpus. Same-glyph/different-locale and
 * different-glyph/same-locale pairs prevent a codepoint-derived script guess. */
export function verticalDecorationCases(): VerticalDecorationOracleCase[] {
  const cases: VerticalDecorationOracleCase[] = [
    row("vrl-en-A-auto-under", { writingMode: "vertical-rl", textOrientation: "mixed", lang: "en", text: "A", scriptClass: "other", family: "serif" }),
    row("vrl-ja-A-auto-over", { writingMode: "vertical-rl", textOrientation: "mixed", lang: "ja", text: "A", scriptClass: "kana-hangul", family: "serif", offset: "3px" }),
    // Rounded LayoutUnit em: round(15.001 * 64) = 960. The captured central
    // FloatAscent is chosen at the integer-boundary discriminator where
    // dividing the unrounded float before LU rounding produces the wrong +1.
    row("vrl-en-kana-auto-under", { writingMode: "vertical-rl", textOrientation: "mixed", lang: "en", text: "日", scriptClass: "other", family: "serif", fontSize: 15.001, logicalFontSize: 15.001, ascent: 13.5, descent: 3.484132 }),
    row("vlr-ja-kana-left-under", { writingMode: "vertical-lr", textOrientation: "upright", lang: "ja-JP", text: "日", scriptClass: "kana-hangul", family: "mono", position: "under left", lines: "underline overline" }),
    row("vlr-ko-right-over", { writingMode: "vertical-lr", textOrientation: "mixed", lang: "ko", text: "한", scriptClass: "kana-hangul", family: "mono", position: "under right", lines: "overline" }),
    row("vrl-zh-right-over", { writingMode: "vertical-rl", textOrientation: "mixed", lang: "zh-Hans", text: "中", scriptClass: "other", family: "serif", position: "from-font right", thickness: "from-font", offset: "10%" }),
    row("vrl-en-from-font-central-under", { writingMode: "vertical-rl", textOrientation: "mixed", lang: "en", text: "A", scriptClass: "other", family: "mono", position: "from-font", thickness: "from-font" }),
    row("vrl-sideways-from-font", { writingMode: "vertical-rl", textOrientation: "sideways", lang: "ja", text: "A", scriptClass: "kana-hangul", family: "serif", position: "from-font right", thickness: "from-font", offset: "2px", fontSize: 40, logicalFontSize: 40, ascent: 32.8, descent: 8.4 }),
    row("srl-ja-right-alphabetic-auto", { writingMode: "sideways-rl", textOrientation: "mixed", lang: "ja", text: "日", scriptClass: "kana-hangul", family: "serif", position: "right", thickness: "10%", lines: "underline line-through" }),
    row("slr-en-under", { writingMode: "sideways-lr", textOrientation: "mixed", lang: "en", text: "g", scriptClass: "other", family: "mono", position: "under left", thickness: "0.2em", offset: "-2px" }),
    row("slr-ja-from-font", { writingMode: "sideways-lr", textOrientation: "mixed", lang: "ja", text: "A", scriptClass: "kana-hangul", family: "mono", position: "from-font", thickness: "from-font", lines: "underline overline line-through" }),
    row("vrl-zoom-125-fixed", { writingMode: "vertical-rl", textOrientation: "upright", lang: "en", text: "A", scriptClass: "other", family: "serif", fontSize: 25, logicalFontSize: 20, ascent: 20.5, descent: 5.25, thickness: "3px", offset: "2px" }),
    row("vrl-zoom-080-percent", { writingMode: "vertical-rl", textOrientation: "upright", lang: "ja", text: "A", scriptClass: "kana-hangul", family: "mono", fontSize: 16, logicalFontSize: 20, ascent: 13.1, descent: 3.4, thickness: "12.5%", offset: "0.15em", lines: "underline overline" }),
  ];
  // DPR is a coherent state qualifier, never a geometry multiplier.
  return cases.flatMap((c) => [c, { ...c, id: `${c.id}.dpr4`, deviceScaleFactor: 4 }]);
}

const LU = (v: number): number => Math.round(v * 64) / 64;
const roundf = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));

function lengthPx(value: string, fontSize: number, scale: number): number | null {
  const match = /^(-?[\d.]+)(px|em|%)?$/.exec(value.trim());
  if (match == null) return null;
  const n = Number.parseFloat(match[1]);
  if (match[2] === "%") return n * fontSize / 100;
  if (match[2] === "em") return n * fontSize;
  return n * scale;
}

function sourceResolution(c: VerticalDecorationOracleCase) {
  const tokens = c.position.toLowerCase().split(/\s+/);
  const central = (c.writingMode === "vertical-rl" || c.writingMode === "vertical-lr")
    && c.textOrientation !== "sideways";
  if (!central) {
    return {
      baselineType: "alphabetic" as const,
      underlinePosition: (tokens.includes("under") ? "under"
        : tokens.includes("from-font") ? "from-font" : "auto") as "under" | "from-font" | "auto",
      flip: false,
    };
  }
  const flip = c.scriptClass === "kana-hangul" ? !tokens.includes("left") : tokens.includes("right");
  return { baselineType: "central" as const, underlinePosition: "under" as const, flip };
}

function normalizedTypoDescent(fontSize: number, face: FaceFacts, asc: number, desc: number): number {
  const normalize = (a: number, d: number): number | null => {
    const height = a + d;
    if (height <= 0 || a < 0 || a > height) return null;
    return LU(fontSize) - LU(a * fontSize / height);
  };
  return face.typoAscender > 0
    ? (normalize(face.typoAscender, -face.typoDescender) ?? 0)
    : (normalize(asc, desc) ?? 0);
}

function sourceMetrics(c: VerticalDecorationOracleCase, face: FaceFacts, resolution = sourceResolution(c)) {
  const scale = c.fontSize / c.logicalFontSize;
  let thickness: number;
  if (c.thickness === "auto" || c.thickness === "") thickness = c.fontSize / 10;
  else if (c.thickness === "from-font") thickness = face.underlineThickness * c.fontSize / face.unitsPerEm;
  else thickness = roundf(lengthPx(c.thickness, c.fontSize, scale) ?? c.fontSize / 10);
  thickness = Math.max(1, thickness);
  const offsetAuto = c.offset === "auto" || c.offset === "";
  const extra = offsetAuto ? 0 : (lengthPx(c.offset, c.fontSize, scale) ?? 0);
  let underlineTop: number;
  if (resolution.baselineType === "central") {
    const centralAscent = (c.ascent + c.descent) / 2;
    const normalizedHeightRaw = Math.round(c.fontSize * 64);
    const normalizedDescent = Math.trunc(normalizedHeightRaw / 2) / 64;
    underlineTop = Math.floor(LU(centralAscent + normalizedDescent)
      + LU(resolution.flip ? 0 : extra)) + 1;
  } else if (resolution.underlinePosition === "under") {
    underlineTop = Math.floor(LU(c.ascent + normalizedTypoDescent(c.fontSize, face, c.ascent, c.descent)) + LU(extra)) + 1;
  } else if (resolution.underlinePosition === "from-font") {
    const belowBaseline = -face.underlinePosition * c.fontSize / face.unitsPerEm;
    underlineTop = roundf(c.ascent + belowBaseline + extra);
  } else {
    const gap = offsetAuto ? Math.max(1, Math.ceil(thickness / 2)) : 0;
    underlineTop = Math.trunc(Math.round(c.ascent) + gap + roundf(extra));
  }
  let overlineTop: number;
  if (resolution.baselineType === "central") {
    const centralAscent = (c.ascent + c.descent) / 2;
    if (resolution.flip) {
      const normalizedHeightRaw = Math.round(c.fontSize * 64);
      const normalizedHeight = normalizedHeightRaw / 64;
      const normalizedDescent = Math.trunc(normalizedHeightRaw / 2) / 64;
      const normalizedAscent = normalizedHeight - normalizedDescent;
      overlineTop = Math.floor(LU(centralAscent - normalizedAscent) - LU(extra))
        - 1 - Math.floor(thickness);
    } else {
      const integerHeight = Math.round(c.ascent) + Math.round(c.descent);
      const centralIntAscent = integerHeight - Math.trunc(integerHeight / 2);
      overlineTop = Math.floor(LU(centralAscent - centralIntAscent)) - Math.floor(thickness);
    }
  } else {
    overlineTop = Math.floor(LU(c.ascent - Math.round(c.ascent))) - Math.floor(thickness);
  }
  return { thickness, underlineTop, overlineTop, lineThroughTop: 2 * c.ascent / 3 - thickness / 2 };
}

function sourceTransform(c: VerticalDecorationOracleCase): string {
  const r = (v: number) => Number.isInteger(v) ? String(v) : v.toFixed(2);
  return c.writingMode === "sideways-lr"
    ? `matrix(0 -1 1 0 ${r(c.x - c.y)} ${r(c.x + c.y + c.height)})`
    : `matrix(0 1 -1 0 ${r(c.x + c.y + c.width)} ${r(c.y - c.x)})`;
}

function sourceLines(lines: string, flip: boolean): string {
  return flip ? lines.split(/\s+/).map((line) => line === "underline" ? "overline"
    : line === "overline" ? "underline" : line).join(" ") : lines;
}

function faceFacts(path: string): FaceFacts {
  const font = fontkit.create(readFileSync(path)) as any;
  return {
    unitsPerEm: font.unitsPerEm,
    underlineThickness: font.underlineThickness,
    underlinePosition: font.underlinePosition,
    typoAscender: font["OS/2"]?.typoAscender ?? 0,
    typoDescender: font["OS/2"]?.typoDescender ?? 0,
  };
}

function compareNumber(errors: string[], label: string, expected: number, actual: number): void {
  if (Math.abs(expected - actual) > 1e-9) errors.push(`${label}: expected ${expected}, got ${actual}`);
}

export function runVerticalDecorationLogicalOracle(): VerticalDecorationOracleReport {
  clearWebfonts();
  const serif = readFileSync(SERIF_PATH);
  const mono = readFileSync(MONO_PATH);
  registerWebfont(FAMILIES.serif, 400, "normal", serif);
  registerWebfont(FAMILIES.mono, 400, "normal", mono);
  const faces: Record<FamilyKey, FaceFacts> = { serif: faceFacts(SERIF_PATH), mono: faceFacts(MONO_PATH) };
  const cases = verticalDecorationCases();
  const caseById = new Map(cases.map((entry) => [entry.id, entry]));
  const rows: VerticalDecorationOracleRow[] = [];
  for (const c of cases) {
    const expectedResolution = sourceResolution(c);
    const expectedMetrics = sourceMetrics(c, faces[c.family], expectedResolution);
    const actualResolution = resolveVerticalDecoration(c.writingMode, c.textOrientation, c.position, c.lang);
    const actualMetrics = getDecorationMetrics(
      { fontFamily: FAMILIES[c.family], fontSize: c.fontSize, fontWeight: "400" },
      {
        thicknessOverride: c.thickness,
        underlineOffsetCss: c.offset,
        underlinePositionCss: actualResolution.underlinePosition,
        lengthScale: c.fontSize / c.logicalFontSize,
        fontAscent: c.ascent,
        fontDescent: c.descent,
        baselineType: actualResolution.baselineType,
        flipUnderlineAndOverline: actualResolution.flipUnderlineAndOverline,
      },
    );
    const expected = {
      ...expectedResolution,
      effectiveLines: sourceLines(c.lines, expectedResolution.flip),
      ...expectedMetrics,
      transform: sourceTransform(c),
    };
    const actual = {
      baselineType: actualResolution.baselineType,
      underlinePosition: actualResolution.underlinePosition,
      flip: actualResolution.flipUnderlineAndOverline,
      effectiveLines: resolvedTextDecorationLine(c.lines, actualResolution.flipUnderlineAndOverline),
      ...actualMetrics,
      transform: lineRelativeToPhysicalTransform(c.x, c.y, c.width, c.height, c.writingMode),
    };
    const errors: string[] = [];
    for (const key of ["baselineType", "underlinePosition", "flip", "effectiveLines", "transform"] as const) {
      if (expected[key] !== actual[key]) errors.push(`${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
    for (const key of ["thickness", "underlineTop", "overlineTop", "lineThroughTop"] as const) {
      compareNumber(errors, key, expected[key], actual[key]);
    }
    rows.push({ id: c.id, deviceScaleFactor: c.deviceScaleFactor, expected, actual, errors, pass: errors.length === 0 });
  }

  const byId = new Map(rows.map((entry) => [entry.id, entry]));
  const ja = byId.get("vrl-ja-A-auto-over")!;
  const central = byId.get("vrl-en-A-auto-under")!;
  const zoom = byId.get("vrl-zoom-125-fixed")!;
  const slr = byId.get("slr-en-under")!;
  const fromFont = byId.get("vrl-sideways-from-font")!;
  const skipInkFont = { fontFamily: FAMILIES.serif, fontSize: 20, fontWeight: "400" };
  const autoExcludedSlash = computeSkipInkGaps("/", skipInkFont, {
    decorationCenterYRel: 0, decorationThickness: 4, skipInkMode: "auto",
  });
  const allIncludedSlash = computeSkipInkGaps("/", skipInkFont, {
    decorationCenterYRel: 0, decorationThickness: 4, skipInkMode: "all",
  });
  const uprightProjection = verticalDecorationSkipInkText({
    text: "/", verticalOrientations: ["upright"],
  } as Parameters<typeof verticalDecorationSkipInkText>[0]) ?? "";
  const rotatedProjection = verticalDecorationSkipInkText({
    text: "/", verticalOrientations: ["rotated"],
  } as Parameters<typeof verticalDecorationSkipInkText>[0]) ?? "";
  const skipInk = {
    autoExcludedSlashGapCount: autoExcludedSlash.length,
    allIncludedSlashGapCount: allIncludedSlash.length,
    uprightProjection,
    rotatedProjection,
    pass: autoExcludedSlash.length === 0 && allIncludedSlash.length > 0
      && uprightProjection === "\u200B" && rotatedProjection === "/",
  };
  const mutationControls = {
    "force-central-under": ja.expected.flip !== false,
    "use-alphabetic-central-offset": central.expected.underlineTop !== Math.trunc(Math.round(base.ascent) + 1),
    "drop-flipped-author-offset": ja.expected.overlineTop !== sourceMetrics(
      { ...caseById.get("vrl-ja-A-auto-over")!, offset: "auto" }, faces.serif,
    ).overlineTop,
    "skip-effective-zoom": zoom.expected.thickness !== roundf(3),
    "multiply-logical-geometry-by-dpr": byId.get("vrl-en-A-auto-under.dpr4")!.expected.thickness * 4
      !== byId.get("vrl-en-A-auto-under.dpr4")!.actual.thickness,
    "reuse-clockwise-for-sideways-lr": slr.expected.transform
      !== sourceTransform({ ...caseById.get("slr-en-under")!, writingMode: "sideways-rl" }),
    "derive-script-from-glyph": ja.expected.flip
      !== sourceResolution({ ...caseById.get("vrl-ja-A-auto-over")!, scriptClass: "other" }).flip,
    "substitute-wrong-from-font-face": fromFont.expected.thickness
      !== Math.max(1, faces.mono.underlineThickness * caseById.get("vrl-sideways-from-font")!.fontSize / faces.mono.unitsPerEm),
    "treat-skip-ink-all-as-auto": autoExcludedSlash.length === 0 && allIncludedSlash.length > 0,
    "open-upright-vertical-intercepts": uprightProjection !== rotatedProjection,
  };
  const pass = rows.every((entry) => entry.pass) && skipInk.pass
    && Object.values(mutationControls).every(Boolean);
  return {
    chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
    geometrySpace: "line-relative-css-px",
    deviceScaleFactors: [1, 4],
    logicalGeometryUsesDpr: false,
    rows,
    skipInk,
    mutationControls,
    rasterPhase: {
      classification: "separate-browser-observation",
      acceptanceRole: "non-authoritative-for-logical-constants",
    },
    verdict: pass ? "source-exact-logical-geometry" : "logical-geometry-failed",
  };
}

async function main(): Promise<void> {
  const report = runVerticalDecorationLogicalOracle();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "source-exact-logical-geometry") process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
