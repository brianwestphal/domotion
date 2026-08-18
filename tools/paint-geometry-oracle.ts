#!/usr/bin/env tsx
/**
 * Source-level geometry oracle for gradients, masks, and basic clip paths.
 *
 * Chromium source is the rule leg; the parsed SVG definition emitted by the
 * production builders is the Domotion leg. Pixel integration remains a later
 * stage because Skia and SVG rasterization cannot establish logical geometry.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildLinearGradientDef } from "../src/render/gradient-defs.js";
import { translateClipPath } from "../src/render/clip-path.js";
import { buildMaskDef } from "../src/render/mask.js";

export interface Point { x: number; y: number }
export interface LineRecord { p0: Point; p1: Point }
export interface OracleRow {
  id: string;
  stage: "gradient" | "clip" | "mask";
  source: string;
  expected: unknown;
  actual: unknown;
  maxAbsDelta: number;
  pass: boolean;
}

const TOLERANCE = 0.00011;

function numberAttr(markup: string, name: string): number {
  const match = new RegExp(`\\b${name}="(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))"`).exec(markup);
  if (match == null) throw new Error(`missing ${name} in ${markup}`);
  return Number(match[1]);
}

function lineFromMarkup(markup: string): LineRecord {
  return { p0: { x: numberAttr(markup, "x1"), y: numberAttr(markup, "y1") }, p1: { x: numberAttr(markup, "x2"), y: numberAttr(markup, "y2") } };
}

function maxDelta(expected: unknown, actual: unknown): number {
  const a: number[] = [], b: number[] = [];
  const visit = (value: unknown, out: number[]) => {
    if (typeof value === "number") out.push(value);
    else if (value != null && typeof value === "object") for (const child of Object.values(value)) visit(child, out);
  };
  visit(expected, a); visit(actual, b);
  if (a.length !== b.length) return Infinity;
  return Math.max(0, ...a.map((value, i) => Math.abs(value - b[i])));
}

/** Blink css_gradient_value.cc:1282-1337 and 1410-1430, rev 7d859f27. */
export function blinkCornerLine(direction: "top-right" | "bottom-right" | "bottom-left" | "top-left", x: number, y: number, width: number, height: number): LineRecord {
  const acute = 90 - Math.atan2(width, height) * 180 / Math.PI;
  const angle = direction === "top-right" ? acute : direction === "bottom-right" ? 180 - acute : direction === "bottom-left" ? 180 + acute : 360 - acute;
  const radians = angle * Math.PI / 180;
  const dx = Math.sin(radians), dy = -Math.cos(radians);
  const half = (Math.abs(width * dx) + Math.abs(height * Math.cos(radians))) / 2;
  const cx = x + width / 2, cy = y + height / 2;
  return { p0: { x: cx - half * dx, y: cy - half * dy }, p1: { x: cx + half * dx, y: cy + half * dy } };
}

function gradientRows(): OracleRow[] {
  const boxes = [{ width: 300, height: 100 }, { width: 100, height: 300 }, { width: 173, height: 91 }];
  const dirs = ["top-right", "bottom-right", "bottom-left", "top-left"] as const;
  return boxes.flatMap(({ width, height }, boxIndex) => dirs.map((direction) => {
    const css = direction.replace("-", " ");
    const markup = buildLinearGradientDef("g", `to ${css}, red, blue`, false, width, height, 13, 17);
    const expected = blinkCornerLine(direction, 13, 17, width, height);
    const actual = lineFromMarkup(markup);
    const delta = maxDelta(expected, actual);
    return { id: `linear.magic-corner.${boxIndex}.${direction}`, stage: "gradient" as const, source: "css_gradient_value.cc:1282-1337,1410-1430", expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE };
  }));
}

function clipRows(): OracleRow[] {
  // Basic clip coordinates pass through `r()`, the renderer's documented
  // one-decimal SVG representation boundary. Apply that serialization to the
  // independent rule leg before requiring exact equality.
  const svgNumber = (value: number) => Number(value.toFixed(1));
  const cases = [
    { id: "inset", value: "inset(10% 20% 30% 40%)", expected: { x: 90, y: 32, width: 80, height: 72 } },
    { id: "circle", value: "circle(25% at 20% 75%)", expected: { cx: 50, cy: 110, r: svgNumber(Math.sqrt((200 ** 2 + 120 ** 2) / 2) * 0.25) } },
    { id: "ellipse", value: "ellipse(30% 40% at 25% 60%)", expected: { cx: 60, cy: 92, rx: 60, ry: 48 } },
    { id: "polygon", value: "polygon(0% 0%, 100% 25%, 75% 100%)", expected: { points: [10, 20, 210, 50, 160, 140] } },
  ];
  return cases.map(({ id, value, expected }) => {
    const markup = translateClipPath(value, 10, 20, 200, 120);
    let actual: unknown;
    if (id === "inset") actual = { x: numberAttr(markup, "x"), y: numberAttr(markup, "y"), width: numberAttr(markup, "width"), height: numberAttr(markup, "height") };
    else if (id === "circle") actual = { cx: numberAttr(markup, "cx"), cy: numberAttr(markup, "cy"), r: numberAttr(markup, "r") };
    else if (id === "ellipse") actual = { cx: numberAttr(markup, "cx"), cy: numberAttr(markup, "cy"), rx: numberAttr(markup, "rx"), ry: numberAttr(markup, "ry") };
    else actual = { points: [...markup.matchAll(/(?:points="| )(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]) };
    const delta = maxDelta(expected, actual);
    return { id: `clip.${id}`, stage: "clip" as const, source: "basic_shape_functions.cc and clip_path_clipper.cc reference-box path", expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE };
  });
}

function maskRows(): OracleRow[] {
  const expected = blinkCornerLine("top-right", 10, 20, 300, 100);
  const built = buildMaskDef("m", "linear-gradient(to top right, transparent, black)", 10, 20, 300, 100, "alpha", "auto", "0% 0%", "no-repeat", "add");
  const actual = { line: lineFromMarkup(built.def), maskType: /mask-type="([^"]+)"/.exec(built.def)?.[1] ?? "" };
  const wanted = { line: expected, maskType: "alpha" };
  const delta = maxDelta(expected, actual.line);
  return [{ id: "mask.linear.magic-corner.alpha", stage: "mask", source: "CSSMaskPainter FillLayer geometry plus css_gradient_value.cc", expected: wanted, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE && actual.maskType === "alpha" }];
}

export function runPaintGeometryOracle(): { rows: OracleRow[]; movementProven: boolean; verdict: string } {
  const rows = [...gradientRows(), ...clipRows(), ...maskRows()];
  // Corpus activation control: the retired direct-to-corner formula must be
  // distinguishable from Blink's magic-corner line on every non-square box.
  const correct = blinkCornerLine("top-right", 0, 0, 300, 100);
  const wrongAngle = Math.atan2(300, 100);
  const wrong = { p0: { x: 0, y: 100 }, p1: { x: 300, y: 0 }, angle: wrongAngle };
  const movementProven = maxDelta(correct, { p0: wrong.p0, p1: wrong.p1 }) > 1;
  const verdict = rows.every((row) => row.pass) && movementProven ? "exact-logical-agreement" : "logical-mismatch";
  return { rows, movementProven, verdict };
}

function main(): number {
  const result = runPaintGeometryOracle();
  const failures = result.rows.filter((row) => !row.pass);
  const report = { schemaVersion: 1, stage: "gradient-mask-clip-geometry", sourceRevision: "chromium:7d859f271cbda744098ac69f44978d4edfa62be3", tolerance: TOLERANCE, ...result };
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(`paint geometry oracle: ${result.rows.length - failures.length}/${result.rows.length} exact; activation control ${result.movementProven ? "moved" : "DID NOT MOVE"}`);
  if (failures.length) for (const failure of failures) console.log(`FAIL ${failure.id}: delta=${failure.maxAbsDelta}`);
  return failures.length || !result.movementProven ? 1 : 0;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
