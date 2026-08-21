#!/usr/bin/env tsx
/**
 * DM-2390 synthetic-bold paint-stage oracle.
 *
 * Source boundary (Chromium 7d859f271cbda744098ac69f44978d4edfa62be3,
 * Skia 62efacd37737505732dbe3d8daa62abd679626a1, HarfBuzz
 * 511df88b82e697cd2a0f1f0635787aa0b18bddbb): Blink's selected
 * FontPlatformData sets SkFont::setEmbolden. FreeType, CoreText, DirectWrite
 * and Fontations all route that flag to SkScalerContextRec::useStrokeForFakeBold
 * (SkScalerContext.cpp:1019-1041). That routine leaves the glyph path alone,
 * computes textSize*fakeBoldScale (SkTextFormatParams.h:15-29), turns a fill
 * into FrameAndFill(extra), and changes an existing frame from w to w+extra.
 * The local path effect precedes the device matrix (SkScalerContext.cpp:
 * 780-855), so transforms scale the resulting frame; they do not change its
 * local width. HarfBuzz owns the earlier shaping/glyph stream and contributes
 * no fake-bold outline or paint-width decision.
 *
 * The oracle compares production against an independently written source rule
 * over the activation/control axes required by the ticket. It records both
 * logical Skia stages and SVG lowering. Its mutation restores the retired
 * derived-outline/single-pass strategy; every opaque stroke-first synthetic
 * row must move.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveFakeBoldTextPaint, type FakeBoldSvgPaintPass, type SkiaFakeBoldPaintStage } from "../src/render/embolden-outline.js";

type Platform = "darwin" | "linux" | "win32";
type Hinting = "unhinted" | "light" | "native-full";

interface FaceCase {
  id: string;
  kind: "static" | "variable";
  naturalWeight: number;
  requestedWeight: number;
  faceLacksWeight: boolean;
}

interface TransformCase {
  id: string;
  matrix: readonly [number, number, number, number];
}

export interface SyntheticBoldPaintOracleRow {
  id: string;
  platform: Platform;
  face: FaceCase;
  hinting: Hinting;
  fontSizePx: number;
  strokeWidthPx: number;
  strokeFirst: boolean;
  fillIsTransparent: boolean;
  transform: TransformCase;
  sourceOutlineRecord: {
    owner: "selected-face-glyph";
    hinting: Hinting;
    mutation: "none";
  };
  expected: {
    outline: "source";
    extraPx: number;
    stages: SkiaFakeBoldPaintStage[];
    svgPasses: FakeBoldSvgPaintPass[];
    deviceFrameBasis: Array<readonly [number, number]>;
  };
  actual: SyntheticBoldPaintOracleRow["expected"];
  pass: boolean;
  retiredMutationMoved: boolean;
}

const PLATFORMS: readonly Platform[] = ["darwin", "linux", "win32"];
const HINTING: readonly Hinting[] = ["unhinted", "light", "native-full"];
const SIZES = [8, 9, 18, 36, 72] as const;
const STROKES = [0, 2] as const;
const BOOLEANS = [false, true] as const;

const FACES: readonly FaceCase[] = [
  { id: "static-regular", kind: "static", naturalWeight: 400, requestedWeight: 400, faceLacksWeight: false },
  { id: "static-real-bold", kind: "static", naturalWeight: 700, requestedWeight: 700, faceLacksWeight: false },
  { id: "static-missing-heavy", kind: "static", naturalWeight: 500, requestedWeight: 800, faceLacksWeight: true },
  { id: "variable-axis-satisfies", kind: "variable", naturalWeight: 700, requestedWeight: 700, faceLacksWeight: false },
  { id: "variable-declared-clamp", kind: "variable", naturalWeight: 400, requestedWeight: 700, faceLacksWeight: true },
];

const TRANSFORMS: readonly TransformCase[] = [
  { id: "identity", matrix: [1, 0, 0, 1] },
  { id: "uniform-zoom", matrix: [2, 0, 0, 2] },
  { id: "anisotropic-rotate", matrix: [0, 1.5, -0.75, 0] },
];

/** Independent transcription of SkTextFormatParams.h's interpolation table. */
function sourceExtra(fontSizePx: number): number {
  if (fontSizePx <= 9) return fontSizePx / 24;
  if (fontSizePx >= 36) return fontSizePx / 32;
  const t = (fontSizePx - 9) / (36 - 9);
  return fontSizePx * ((1 - t) / 24 + t / 32);
}

function sourceRule(opts: {
  fontSizePx: number;
  strokeWidthPx: number;
  strokeFirst: boolean;
  fillIsTransparent: boolean;
  faceLacksWeight: boolean;
}): Omit<SyntheticBoldPaintOracleRow["expected"], "deviceFrameBasis"> {
  const extraPx = opts.faceLacksWeight ? sourceExtra(opts.fontSizePx) : 0;
  const fill: SkiaFakeBoldPaintStage = {
    paint: "fill",
    frameWidthPx: extraPx > 0 ? extraPx : -1,
    frameAndFill: extraPx > 0,
    visible: !opts.fillIsTransparent,
  };
  const stroke: SkiaFakeBoldPaintStage | null = opts.strokeWidthPx > 0
    ? { paint: "stroke", frameWidthPx: opts.strokeWidthPx + extraPx, frameAndFill: false, visible: true }
    : null;
  const stages = stroke == null ? [fill] : opts.strokeFirst ? [stroke, fill] : [fill, stroke];

  let svgPasses: FakeBoldSvgPaintPass[];
  if (stroke == null) {
    svgPasses = [{
      kind: "combined", fill: "source", stroke: extraPx > 0 ? "source-fill" : "none", strokeWidthPx: extraPx,
    }];
  } else if (opts.strokeFirst && fill.visible && extraPx > 0) {
    svgPasses = [
      { kind: "author-stroke", fill: "none", stroke: "author", strokeWidthPx: stroke.frameWidthPx },
      { kind: "synthetic-fill", fill: "source", stroke: "source-fill", strokeWidthPx: extraPx },
    ];
  } else {
    svgPasses = [{
      kind: "combined",
      fill: "source",
      stroke: "author",
      strokeWidthPx: stroke.frameWidthPx,
      ...(opts.strokeFirst ? { paintOrder: "stroke fill" as const } : {}),
    }];
  }
  return { outline: "source", extraPx, stages, svgPasses };
}

function deviceFrameBasis(
  stages: SkiaFakeBoldPaintStage[],
  matrix: TransformCase["matrix"],
): Array<readonly [number, number]> {
  const [a, b, c, d] = matrix;
  const xScale = Math.hypot(a, b);
  const yScale = Math.hypot(c, d);
  return stages.map((stage) => [stage.frameWidthPx * xScale, stage.frameWidthPx * yScale] as const);
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-12;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => same(value, b[index]));
  }
  if (a != null && b != null && typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord).sort();
    const bKeys = Object.keys(bRecord).sort();
    return same(aKeys, bKeys) && aKeys.every((key) => same(aRecord[key], bRecord[key]));
  }
  return a === b;
}

export function runSyntheticBoldPaintOracle(): {
  rows: SyntheticBoldPaintOracleRow[];
  failures: number;
  retiredMutationRows: number;
  retiredMutationMoved: number;
  retiredProductionSymbolsGone: boolean;
} {
  const rows: SyntheticBoldPaintOracleRow[] = [];
  for (const platform of PLATFORMS) {
    for (const face of FACES) {
      for (const hinting of HINTING) {
        for (const fontSizePx of SIZES) {
          for (const strokeWidthPx of STROKES) {
            for (const strokeFirst of BOOLEANS) {
              for (const fillIsTransparent of BOOLEANS) {
                for (const transform of TRANSFORMS) {
                  const input = {
                    fontSizePx, strokeWidthPx, strokeFirst, fillIsTransparent,
                    faceLacksWeight: face.faceLacksWeight,
                  };
                  const source = sourceRule(input);
                  const production = resolveFakeBoldTextPaint({ ...input, platform });
                  const expected = {
                    ...source,
                    deviceFrameBasis: deviceFrameBasis(source.stages, transform.matrix),
                  };
                  const actual = {
                    outline: production.outline,
                    extraPx: production.extraPx,
                    stages: production.stages,
                    svgPasses: production.svgPasses,
                    deviceFrameBasis: deviceFrameBasis(production.stages, transform.matrix),
                  };
                  const mutationTarget = face.faceLacksWeight && strokeWidthPx > 0
                    && strokeFirst && !fillIsTransparent;
                  const retiredMutation = mutationTarget
                    ? { ...actual, outline: "derived-outline", svgPasses: [actual.svgPasses[0]] }
                    : actual;
                  rows.push({
                    id: [platform, face.id, hinting, fontSizePx, `sw${strokeWidthPx}`,
                      strokeFirst ? "stroke-first" : "fill-first",
                      fillIsTransparent ? "transparent" : "opaque", transform.id].join("/"),
                    platform, face, hinting, fontSizePx, strokeWidthPx,
                    strokeFirst, fillIsTransparent, transform,
                    sourceOutlineRecord: { owner: "selected-face-glyph", hinting, mutation: "none" },
                    expected, actual,
                    pass: same(expected, actual),
                    retiredMutationMoved: mutationTarget ? !same(expected, retiredMutation) : false,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const sourceFiles = [
    fileURLToPath(new URL("../src/render/embolden-outline.ts", import.meta.url)),
    fileURLToPath(new URL("../src/render/embedded-font-builder.ts", import.meta.url)),
    fileURLToPath(new URL("../src/render/text-to-path.ts", import.meta.url)),
  ];
  const retiredSymbol = /(?:0\.73|emboldenStrengthForFont|emboldenPathCommands|emboldenStrengthFU)/;
  const retiredProductionSymbolsGone = sourceFiles.every((file) => !retiredSymbol.test(readFileSync(file, "utf8")));
  const mutationRows = rows.filter((row) => row.face.faceLacksWeight && row.strokeWidthPx > 0
    && row.strokeFirst && !row.fillIsTransparent);
  return {
    rows,
    failures: rows.filter((row) => !row.pass).length,
    retiredMutationRows: mutationRows.length,
    retiredMutationMoved: mutationRows.filter((row) => row.retiredMutationMoved).length,
    retiredProductionSymbolsGone,
  };
}

function main(): void {
  const report = runSyntheticBoldPaintOracle();
  console.log(`synthetic-bold paint oracle: ${report.rows.length - report.failures}/${report.rows.length}`);
  console.log(`retired outline mutation: ${report.retiredMutationMoved}/${report.retiredMutationRows} moved`);
  console.log(`retired production symbols: ${report.retiredProductionSymbolsGone ? "gone" : "PRESENT"}`);
  if (report.failures > 0
    || report.retiredMutationMoved !== report.retiredMutationRows
    || !report.retiredProductionSymbolsGone) process.exitCode = 1;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
