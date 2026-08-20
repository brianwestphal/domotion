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
import { buildLinearGradientDef, buildRadialGradientDef, normalizeRadialGradientDomain, parseGradientStops } from "../src/render/gradient-defs.js";
import { clipPathShapeForElement, clipReferenceBox, translateClipPath, type HtmlClipGeometryBox } from "../src/render/clip-path.js";
import { buildMaskDef, positionFragmentClipPathDef, positionFragmentMaskDef } from "../src/render/mask.js";
import { needsChromiumGradientRaster } from "../src/render/advanced-gradient-raster.js";

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

function interpolationRows(): OracleRow[] {
  const cases = [
    { id: "srgb", layer: "linear-gradient(90deg in srgb, red, blue)", raster: false, attr: 'color-interpolation="sRGB"' },
    { id: "srgb-linear", layer: "linear-gradient(90deg in srgb-linear, red, blue)", raster: false, attr: 'color-interpolation="linearRGB"' },
    ...["lab", "oklab", "lch", "oklch", "hsl", "hwb"].map((space) => ({ id: space, layer: `linear-gradient(90deg in ${space}, red, blue)`, raster: true, attr: "" })),
    { id: "oklch-longer-hue", layer: "linear-gradient(90deg in oklch longer hue, red, blue)", raster: true, attr: "" },
    { id: "premultiplied-alpha", layer: "linear-gradient(90deg in srgb, rgba(255,0,0,0), blue)", raster: true, attr: "" },
  ];
  return cases.map((test) => {
    const raster = needsChromiumGradientRaster(test.layer);
    const markup = raster ? "" : buildLinearGradientDef("gi", test.layer.slice(test.layer.indexOf("(") + 1, -1), false, 100, 20);
    const actual = { raster, nativeAttribute: test.attr === "" ? "" : (markup.includes(test.attr) ? test.attr : "") };
    const expected = { raster: test.raster, nativeAttribute: test.attr };
    const pass = actual.raster === expected.raster && actual.nativeAttribute === expected.nativeAttribute;
    return { id: `gradient.interpolation.${test.id}`, stage: "gradient" as const, source: "css_gradient_value.cc:1163-1188,1454-1460; Gradient::SetColorInterpolationSpace", expected, actual, maxAbsDelta: pass ? 0 : Infinity, pass };
  });
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

  const opaqueStop = (pos: number, r: number, b: number) => ({ pos, color: { r, g: 0, b, a: 1 } });
  const negativeRepeat = normalizeRadialGradientDomain([opaqueStop(-0.3, 255, 0), opaqueStop(-0.1, 0, 255)], 100, true);
  const negativeRepeatExpected = { innerRadius: 10, outerRadius: 30, offsets: [0, 1], repeat: true };
  const negativeRepeatActual = { innerRadius: negativeRepeat.innerRadius, outerRadius: negativeRepeat.outerRadius, offsets: negativeRepeat.stops.map((stop) => stop.pos), repeat: negativeRepeat.repeat };
  const negativeRepeatDelta = maxDelta(negativeRepeatExpected, negativeRepeatActual);
  rows.push({ id: "radial.repeating-negative-domain-shift", stage: "gradient", source: "css_gradient_value.cc:593-633,809-824", expected: negativeRepeatExpected, actual: negativeRepeatActual, maxAbsDelta: negativeRepeatDelta, pass: negativeRepeatDelta <= TOLERANCE });

  const nonRepeat = normalizeRadialGradientDomain([opaqueStop(-0.2, 255, 0), opaqueStop(0.8, 0, 255)], 100, false);
  const nonRepeatExpected = { innerRadius: 0, outerRadius: 80, offsets: [0, 1], boundaryColor: [204, 0, 51] };
  const nonRepeatActual = { innerRadius: nonRepeat.innerRadius, outerRadius: nonRepeat.outerRadius, offsets: nonRepeat.stops.map((stop) => stop.pos), boundaryColor: [nonRepeat.stops[0].color.r, nonRepeat.stops[0].color.g, nonRepeat.stops[0].color.b] };
  const nonRepeatDelta = maxDelta(nonRepeatExpected, nonRepeatActual);
  rows.push({ id: "radial.non-repeating-negative-domain-clamp", stage: "gradient", source: "css_gradient_value.cc:549-588,809-824", expected: nonRepeatExpected, actual: nonRepeatActual, maxAbsDelta: nonRepeatDelta, pass: nonRepeatDelta <= TOLERANCE });

  const linearLight = normalizeRadialGradientDomain([opaqueStop(-0.2, 255, 0), opaqueStop(0.8, 0, 255)], 100, false, "srgb-linear");
  const linearExpected = [231, 0, 124];
  const linearActual = [linearLight.stops[0].color.r, linearLight.stops[0].color.g, linearLight.stops[0].color.b];
  const linearDelta = maxDelta(linearExpected, linearActual);
  rows.push({ id: "radial.non-repeating-negative-domain-linear-light", stage: "gradient", source: "css_gradient_value.cc:549-588; Color::InterpolateColors", expected: linearExpected, actual: linearActual, maxAbsDelta: linearDelta, pass: linearDelta <= TOLERANCE });

  const outOfRange = normalizeRadialGradientDomain([opaqueStop(0.2, 255, 0), opaqueStop(1.4, 0, 255)], 100, false);
  const outOfRangeExpected = { innerRadius: 20, outerRadius: 140, offsets: [0, 1] };
  const outOfRangeActual = { innerRadius: outOfRange.innerRadius, outerRadius: outOfRange.outerRadius, offsets: outOfRange.stops.map((stop) => stop.pos) };
  const outOfRangeDelta = maxDelta(outOfRangeExpected, outOfRangeActual);
  rows.push({ id: "radial.non-repeating-out-of-range-domain", stage: "gradient", source: "css_gradient_value.cc:490-547,630-633,809-824", expected: outOfRangeExpected, actual: outOfRangeActual, maxAbsDelta: outOfRangeDelta, pass: outOfRangeDelta <= TOLERANCE });

  // Activation control: the former SVG-side clamp would produce [0, 0] for
  // an entirely negative repeat interval. The source-transcribed domain must
  // move both radii to the equivalent positive phase [10, 30].
  const legacyClamp = { innerRadius: Math.max(0, -30), outerRadius: Math.max(0, -10) };
  rows.push({ id: "radial.negative-domain-mutation-control", stage: "gradient", source: "css_gradient_value.cc:609-627", expected: { moved: true }, actual: { moved: negativeRepeat.innerRadius !== legacyClamp.innerRadius || negativeRepeat.outerRadius !== legacyClamp.outerRadius }, maxAbsDelta: 0, pass: negativeRepeat.innerRadius !== legacyClamp.innerRadius || negativeRepeat.outerRadius !== legacyClamp.outerRadius });

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
  const axisCases = [
    { id: "repeat-x", repeat: "repeat no-repeat", expected: [[-40, 65], [40, 65], [120, 65], [200, 65]] },
    { id: "repeat-y", repeat: "no-repeat repeat", expected: [[40, -15], [40, 25], [40, 65], [40, 105]] },
  ];
  for (const test of axisCases) {
    const def = buildMaskDef("ma", "linear-gradient(red, black)", 10, 20, 200, 100, "alpha", "80px 40px", "25% 75%", test.repeat, "add").def;
    const origins = [...def.matchAll(/<rect x="(-?\d+(?:\.\d+)?)" y="(-?\d+(?:\.\d+)?)" width="80" height="40"/g)].map((match) => [Number(match[1]), Number(match[2])]);
    const axisDelta = maxDelta(test.expected, origins);
    rows.push({ id: `mask.repeat.${test.id}`, stage: "mask", source: "background_image_geometry.cc:589-642", expected: test.expected, actual: origins, maxAbsDelta: axisDelta, pass: axisDelta <= TOLERANCE });
  }
  const roundDef = buildMaskDef("mround", "linear-gradient(red, black)", 10, 20, 200, 100, "alpha", "80px 40px", "25% 75%", "round no-repeat", "add").def;
  const roundTiles = [...roundDef.matchAll(/<rect x="(-?\d+(?:\.\d+)?)" y="65" width="(-?\d+(?:\.\d+)?)" height="40"/g)].map((match) => [Number(match[1]), Number(match[2])]);
  const expectedRoundTiles = [[-26.7, 66.7], [40, 66.7], [106.7, 66.7], [173.3, 66.7]];
  const roundDelta = maxDelta(expectedRoundTiles, roundTiles);
  rows.push({ id: "mask.repeat.round", stage: "mask", source: "background_image_geometry.cc:26-36,547-588", expected: expectedRoundTiles, actual: roundTiles, maxAbsDelta: roundDelta, pass: roundDelta <= TOLERANCE });
  const spaceDef = buildMaskDef("mspace", "linear-gradient(red, black)", 10, 20, 200, 100, "alpha", "80px 40px", "25% 75%", "space no-repeat", "add").def;
  const spaceOrigins = [...spaceDef.matchAll(/<rect x="(-?\d+(?:\.\d+)?)" y="65" width="80" height="40"/g)].map((match) => Number(match[1]));
  const expectedSpaceOrigins = [10, 130];
  const spaceDelta = maxDelta(expectedSpaceOrigins, spaceOrigins);
  rows.push({ id: "mask.repeat.space", stage: "mask", source: "background_image_geometry.cc:17-30,596-632", expected: expectedSpaceOrigins, actual: spaceOrigins, maxAbsDelta: spaceDelta, pass: spaceDelta <= TOLERANCE });
  const dataMask = 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2240%22%3E%3Crect width=%2280%22 height=%2240%22 fill=%22black%22/%3E%3C/svg%3E")';
  for (const test of [{ id: "round", repeat: "round no-repeat", expected: { x: 40, y: 65, width: 66.7, height: 200 } }, { id: "space", repeat: "space no-repeat", expected: { x: 10, y: 65, width: 120, height: 200 } }]) {
    const def = buildMaskDef("murl", dataMask, 10, 20, 200, 100, "alpha", "80px 40px", "25% 75%", test.repeat, "add").def;
    const pattern = /<pattern[^>]+/.exec(def)?.[0] ?? "";
    const patternActual = { x: numberAttr(pattern, "x"), y: numberAttr(pattern, "y"), width: numberAttr(pattern, "width"), height: numberAttr(pattern, "height") };
    const patternDelta = maxDelta(test.expected, patternActual);
    rows.push({ id: `mask.url-repeat.${test.id}`, stage: "mask", source: "background_image_geometry.cc:547-632", expected: test.expected, actual: patternActual, maxAbsDelta: patternDelta, pass: patternDelta <= TOLERANCE });
  }
  const fourLayers = Array.from({ length: 4 }, (_, index) => `linear-gradient(rgb(${index},0,0), black)`).join(",");
  const cyclicDef = buildMaskDef("mcycle", fourLayers, 0, 0, 100, 80, "alpha", "10px 10px,20px 20px", "0 0", "no-repeat", "add").def;
  const cyclicActual = [0, 1, 2, 3].map((index) => new RegExp(`<rect x="0" y="0" width="${index % 2 === 0 ? 10 : 20}" height="${index % 2 === 0 ? 10 : 20}" fill="url\\(#mcycleg${index}\\)"`).test(cyclicDef));
  rows.push({ id: "mask.layer-list.cyclic", stage: "mask", source: "FillLayer linked-list repetition", expected: [true, true, true, true], actual: cyclicActual, maxAbsDelta: cyclicActual.every(Boolean) ? 0 : Infinity, pass: cyclicActual.every(Boolean) });
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
  const threeLayers = `${twoLayers},linear-gradient(blue, transparent)`;
  const mixed = buildMaskDef("mmix", threeLayers, 0, 0, 100, 80, "alpha", "auto", "0% 0%", "no-repeat", "subtract,intersect").def;
  const mixedActual = {
    bottomFirst: mixed.includes('id="mmixraw2"') && mixed.includes('id="mmixacc1"'),
    intersectThenSubtract: mixed.includes('<g mask="url(#mmixraw1)"><rect x="0" y="0" width="100" height="80" fill="#fff" mask="url(#mmixraw2)"') && mixed.includes('id="mmixnota0"') && mixed.includes('<g mask="url(#mmixnota0)"><rect x="0" y="0" width="100" height="80" fill="#fff" mask="url(#mmixraw0)"'),
  };
  const mixedExpected = { bottomFirst: true, intersectThenSubtract: true };
  const mixedPass = mixedActual.bottomFirst && mixedActual.intersectThenSubtract;
  rows.push({ id: "mask.composite.mixed-sequential", stage: "mask", source: "svg_mask_painter.cc:91-113, IterateFillLayersReveresed", expected: mixedExpected, actual: mixedActual, maxAbsDelta: mixedPass ? 0 : Infinity, pass: mixedPass });
  const fragmentMask = positionFragmentMaskDef('<mask id="fm" x="0" y="0" width="1" height="1"><rect width="10" height="8"/></mask>', 13, 17, 90, 70);
  const fragmentMaskExpected = '<mask id="fm" maskUnits="userSpaceOnUse" x="13" y="17" width="90" height="70"><g transform="translate(13, 17)"><rect width="10" height="8"/></g></mask>';
  rows.push({ id: "mask.fragment.user-space", stage: "mask", source: "SVGResourceClipper/Masker HTML reference coordinate mapping", expected: fragmentMaskExpected, actual: fragmentMask, maxAbsDelta: fragmentMask === fragmentMaskExpected ? 0 : Infinity, pass: fragmentMask === fragmentMaskExpected });
  const fragmentClip = positionFragmentClipPathDef('<clipPath id="fc" clipPathUnits="userSpaceOnUse"><rect width="10" height="8"/></clipPath>', 13, 17);
  const fragmentClipExpected = '<clipPath id="fc" clipPathUnits="userSpaceOnUse" transform="translate(13, 17)"><rect width="10" height="8"/></clipPath>';
  rows.push({ id: "clip.fragment.user-space", stage: "clip", source: "ClipPathClipper local reference coordinate mapping", expected: fragmentClipExpected, actual: fragmentClip, maxAbsDelta: fragmentClip === fragmentClipExpected ? 0 : Infinity, pass: fragmentClip === fragmentClipExpected });
  return rows;
}

export function runPaintGeometryOracle(): { rows: OracleRow[]; movementProven: boolean; verdict: string } {
  const rows = [...gradientRows(), ...interpolationRows(), ...radialAndStopRows(), ...clipRows(), ...maskRows()];
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
