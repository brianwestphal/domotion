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
import { buildLinearGradientDef, buildRadialGradientDef, parseGradientStops } from "../src/render/gradient-defs.js";
import { clipPathShapeForElement, clipReferenceBox, translateClipPath, type HtmlClipGeometryBox } from "../src/render/clip-path.js";
import { buildMaskDef, positionFragmentClipPathDef, positionFragmentMaskDef } from "../src/render/mask.js";

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

function radialAndStopRows(): OracleRow[] {
  const radialCases = [
    { id: "circle.closest-side", args: "circle closest-side at 25% 75%, red, blue", expected: { cx: 60, cy: 110, r: 30, scale: 1 } },
    { id: "circle.farthest-corner", args: "circle farthest-corner at 25% 75%, red, blue", expected: { cx: 60, cy: 110, r: Math.hypot(150, 90), scale: 1 } },
    { id: "ellipse.closest-side", args: "ellipse closest-side at 25% 75%, red, blue", expected: { cx: 60, cy: 110, r: 50, scale: 0.6 } },
    { id: "ellipse.farthest-corner", args: "ellipse farthest-corner at 25% 75%, red, blue", expected: { cx: 60, cy: 110, r: 150 * Math.SQRT2, scale: 0.6 } },
  ];
  const rows: OracleRow[] = radialCases.map(({ id, args, expected }) => {
    const markup = buildRadialGradientDef("g", args, false, 10, 20, 200, 120);
    const transform = /scale\(1 (-?\d+(?:\.\d+)?)\)/.exec(markup);
    const actual = { cx: numberAttr(markup, "cx"), cy: numberAttr(markup, "cy"), r: numberAttr(markup, "r"), scale: transform == null ? 1 : Number(transform[1]) };
    const delta = maxDelta(expected, actual);
    return { id: `radial.${id}`, stage: "gradient", source: "css_gradient_value.cc:1846-2008", expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE };
  });

  const repeating = buildRadialGradientDef("g", "circle 100px at center, red 10px, blue 30px", true, 0, 0, 200, 100);
  const repeatExpected = { fr: 10, r: 30, spread: "repeat", offsets: [0, 1] };
  const repeatActual = { fr: numberAttr(repeating, "fr"), r: numberAttr(repeating, "r"), spread: /spreadMethod="([^"]+)"/.exec(repeating)?.[1] ?? "", offsets: [...repeating.matchAll(/<stop offset="([^"]+)"/g)].map((m) => Number(m[1])) };
  rows.push({ id: "radial.repeating-positive-domain", stage: "gradient", source: "css_gradient_value.cc:506-653,809-824", expected: repeatExpected, actual: repeatActual, maxAbsDelta: maxDelta({ fr: 10, r: 30, offsets: [0, 1] }, { fr: repeatActual.fr, r: repeatActual.r, offsets: repeatActual.offsets }), pass: repeatActual.spread === "repeat" && maxDelta(repeatExpected.offsets, repeatActual.offsets) <= TOLERANCE && repeatActual.fr === 10 && repeatActual.r === 30 });

  const stopCases = [
    { id: "monotonic-clamp", tokens: ["red 70%", "green 20%", "blue"], expected: [0.7, 0.7, 1] },
    { id: "unspecified-distribution", tokens: ["red", "green", "yellow", "blue"], expected: [0, 1 / 3, 2 / 3, 1] },
    { id: "double-position", tokens: ["red 10% 30%", "blue"], expected: [0.1, 0.3, 1] },
  ];
  for (const test of stopCases) {
    const actual = parseGradientStops(test.tokens, 100).map((stop) => stop.pos);
    const delta = maxDelta(test.expected, actual);
    rows.push({ id: `stops.${test.id}`, stage: "gradient", source: "css_gradient_value.cc:656-790", expected: test.expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE });
  }

  const hintStops = parseGradientStops(["red", "20%", "blue"], 100);
  const expectedHintPositions = [0, 0.2 / 3, 0.2 * 2 / 3, ...Array.from({ length: 7 }, (_, y) => 0.2 + 0.8 * (y / 13)), 1];
  const hintActual = hintStops.map((stop) => stop.pos);
  const hintDelta = maxDelta(expectedHintPositions, hintActual);
  rows.push({ id: "stops.chromium-nine-stop-hint", stage: "gradient", source: "css_gradient_value.cc:266-399", expected: expectedHintPositions, actual: hintActual, maxAbsDelta: hintDelta, pass: hintDelta <= TOLERANCE });
  return rows;
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
  const rows = cases.map(({ id, value, expected }) => {
    const markup = translateClipPath(value, 10, 20, 200, 120);
    let actual: unknown;
    if (id === "inset") actual = { x: numberAttr(markup, "x"), y: numberAttr(markup, "y"), width: numberAttr(markup, "width"), height: numberAttr(markup, "height") };
    else if (id === "circle") actual = { cx: numberAttr(markup, "cx"), cy: numberAttr(markup, "cy"), r: numberAttr(markup, "r") };
    else if (id === "ellipse") actual = { cx: numberAttr(markup, "cx"), cy: numberAttr(markup, "cy"), rx: numberAttr(markup, "rx"), ry: numberAttr(markup, "ry") };
    else actual = { points: [...markup.matchAll(/(?:points="| )(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]) };
    const delta = maxDelta(expected, actual);
    return { id: `clip.${id}`, stage: "clip" as const, source: "basic_shape_functions.cc and clip_path_clipper.cc reference-box path", expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE };
  });
  const element = {
    x: 10, y: 20, width: 200, height: 120,
    styles: {
      borderTopWidth: "4px", borderRightWidth: "6px", borderBottomWidth: "8px", borderLeftWidth: "10px",
      paddingTop: "12px", paddingRight: "14px", paddingBottom: "16px", paddingLeft: "18px",
      marginTop: "20px", marginRight: "22px", marginBottom: "24px", marginLeft: "26px",
      borderRadius: "30px",
    },
  };
  const referenceCases: Array<{ box: HtmlClipGeometryBox; expected: { x: number; y: number; width: number; height: number } }> = [
    { box: "border-box", expected: { x: 10, y: 20, width: 200, height: 120 } },
    { box: "padding-box", expected: { x: 20, y: 24, width: 184, height: 108 } },
    { box: "content-box", expected: { x: 38, y: 36, width: 152, height: 80 } },
    { box: "fill-box", expected: { x: 38, y: 36, width: 152, height: 80 } },
    { box: "margin-box", expected: { x: -16, y: 0, width: 248, height: 164 } },
    { box: "half-border-box", expected: { x: 15, y: 22, width: 192, height: 114 } },
  ];
  for (const test of referenceCases) {
    const actual = clipReferenceBox(element, test.box);
    const delta = maxDelta(test.expected, actual);
    rows.push({ id: `clip.reference-box.${test.box}`, stage: "clip", source: "geometry_box_utils.cc:13-49", expected: test.expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE });
  }
  const roundedElement = { ...element, styles: { ...element.styles, borderTopWidth: "5px", borderRightWidth: "5px", borderBottomWidth: "5px", borderLeftWidth: "5px", paddingTop: "10px", paddingRight: "10px", paddingBottom: "10px", paddingLeft: "10px" } };
  for (const test of [{ box: "padding-box" as const, expected: { x: 15, y: 25, width: 190, height: 110, rx: 25 } }, { box: "content-box" as const, expected: { x: 25, y: 35, width: 170, height: 90, rx: 15 } }]) {
    const markup = clipPathShapeForElement(roundedElement, test.box);
    const actual = { x: numberAttr(markup, "x"), y: numberAttr(markup, "y"), width: numberAttr(markup, "width"), height: numberAttr(markup, "height"), rx: numberAttr(markup, "rx") };
    const delta = maxDelta(test.expected, actual);
    rows.push({ id: `clip.rounded-reference-box.${test.box}`, stage: "clip", source: "clip_path_clipper.cc:242-261", expected: test.expected, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE });
  }
  const marginRounded = clipPathShapeForElement({ ...roundedElement, styles: { ...roundedElement.styles, borderRadius: "10px", marginTop: "20px", marginRight: "20px", marginBottom: "20px", marginLeft: "20px" } }, "margin-box");
  const marginExpected = { x: -10, y: 0, width: 240, height: 160, rx: 27.5 };
  const marginActual = { x: numberAttr(marginRounded, "x"), y: numberAttr(marginRounded, "y"), width: numberAttr(marginRounded, "width"), height: numberAttr(marginRounded, "height"), rx: numberAttr(marginRounded, "rx") };
  const marginDelta = maxDelta(marginExpected, marginActual);
  rows.push({ id: "clip.rounded-reference-box.margin-correction", stage: "clip", source: "float_rounded_rect.cc OutsetWithCornerCorrection", expected: marginExpected, actual: marginActual, maxAbsDelta: marginDelta, pass: marginDelta <= TOLERANCE });
  return rows;
}

function maskRows(): OracleRow[] {
  const expected = blinkCornerLine("top-right", 10, 20, 300, 100);
  const built = buildMaskDef("m", "linear-gradient(to top right, transparent, black)", 10, 20, 300, 100, "alpha", "auto", "0% 0%", "no-repeat", "add");
  const actual = { line: lineFromMarkup(built.def), maskType: /mask-type="([^"]+)"/.exec(built.def)?.[1] ?? "" };
  const wanted = { line: expected, maskType: "alpha" };
  const delta = maxDelta(expected, actual.line);
  const rows: OracleRow[] = [{ id: "mask.linear.magic-corner.alpha", stage: "mask", source: "CSSMaskPainter FillLayer geometry plus css_gradient_value.cc", expected: wanted, actual, maxAbsDelta: delta, pass: delta <= TOLERANCE && actual.maskType === "alpha" }];
  const positioned = buildMaskDef("mp", "linear-gradient(red, black)", 10, 20, 200, 100, "alpha", "80px 40px", "25% 75%", "no-repeat", "add").def;
  const positionedRect = /<rect x="40" y="65" width="80" height="40"/.test(positioned);
  rows.push({ id: "mask.size-position.no-repeat", stage: "mask", source: "CSSMaskPainter FillLayer image geometry", expected: true, actual: positionedRect, maxAbsDelta: positionedRect ? 0 : Infinity, pass: positionedRect });
  const repeated = buildMaskDef("mr", "linear-gradient(red, black)", 10, 20, 200, 100, "alpha", "80px 40px", "25% 75%", "repeat", "add").def;
  const repeatOrigins = [...repeated.matchAll(/<rect x="(-?\d+(?:\.\d+)?)" y="(-?\d+(?:\.\d+)?)" width="80" height="40"/g)].map((match) => [Number(match[1]), Number(match[2])]);
  const expectedRepeatOrigins = [[-40, -15], [40, -15], [120, -15], [200, -15], [-40, 25], [40, 25], [120, 25], [200, 25], [-40, 65], [40, 65], [120, 65], [200, 65], [-40, 105], [40, 105], [120, 105], [200, 105]];
  const repeatDelta = maxDelta(expectedRepeatOrigins, repeatOrigins);
  rows.push({ id: "mask.size-position.repeat", stage: "mask", source: "CSSMaskPainter FillLayer tiling geometry", expected: expectedRepeatOrigins, actual: repeatOrigins, maxAbsDelta: repeatDelta, pass: repeatDelta <= TOLERANCE });
  const twoLayers = "linear-gradient(red, black),linear-gradient(white, transparent)";
  for (const test of [
    { op: "add", marker: (def: string) => !def.includes("<feColorMatrix") && (def.match(/<mask /g)?.length ?? 0) === 1 },
    { op: "intersect", marker: (def: string) => def.includes('id="mci1"') && def.includes('mask="url(#mci1)"') },
    { op: "subtract", marker: (def: string) => def.includes('id="mcs1"') && def.includes('id="mcinv"') },
    { op: "exclude", marker: (def: string) => def.includes('id="mcx0"') && def.includes('id="mcx1"') && def.includes('id="mcinv"') },
  ]) {
    const composite = buildMaskDef("mc", twoLayers, 0, 0, 100, 80, "alpha", "auto", "0% 0%", "no-repeat", test.op).def;
    const matched = test.marker(composite);
    rows.push({ id: `mask.composite.${test.op}`, stage: "mask", source: "CSS mask-composite Porter-Duff mapping", expected: true, actual: matched, maxAbsDelta: matched ? 0 : Infinity, pass: matched });
  }
  const fragmentMask = positionFragmentMaskDef('<mask id="fm" x="0" y="0" width="1" height="1"><rect width="10" height="8"/></mask>', 13, 17, 90, 70);
  const fragmentMaskExpected = '<mask id="fm" maskUnits="userSpaceOnUse" x="13" y="17" width="90" height="70"><g transform="translate(13, 17)"><rect width="10" height="8"/></g></mask>';
  rows.push({ id: "mask.fragment.user-space", stage: "mask", source: "SVGResourceClipper/Masker HTML reference coordinate mapping", expected: fragmentMaskExpected, actual: fragmentMask, maxAbsDelta: fragmentMask === fragmentMaskExpected ? 0 : Infinity, pass: fragmentMask === fragmentMaskExpected });
  const fragmentClip = positionFragmentClipPathDef('<clipPath id="fc" clipPathUnits="userSpaceOnUse"><rect width="10" height="8"/></clipPath>', 13, 17);
  const fragmentClipExpected = '<clipPath id="fc" clipPathUnits="userSpaceOnUse" transform="translate(13, 17)"><rect width="10" height="8"/></clipPath>';
  rows.push({ id: "clip.fragment.user-space", stage: "clip", source: "ClipPathClipper local reference coordinate mapping", expected: fragmentClipExpected, actual: fragmentClip, maxAbsDelta: fragmentClip === fragmentClipExpected ? 0 : Infinity, pass: fragmentClip === fragmentClipExpected });
  return rows;
}

export function runPaintGeometryOracle(): { rows: OracleRow[]; movementProven: boolean; verdict: string } {
  const rows = [...gradientRows(), ...radialAndStopRows(), ...clipRows(), ...maskRows()];
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
