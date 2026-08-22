#!/usr/bin/env tsx
/**
 * DM-2360 source-derived blend/filter pixel-stage oracle.
 *
 * This deliberately grades flat, interior device pixels and named kernel-edge
 * samples. It does not use whole-image MAE, so a candidate cannot hide a wrong
 * SourceGraphic/backdrop choice in a large unchanged page.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

export const BLEND_FILTER_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const BLUR_IDENTITY_SIGMA = 0.03;
export const BLUR_KERNEL_RADIUS_MULTIPLIER = 3;
export const STAGE_CHANNEL_TOLERANCE = 4;
export const MUTATION_MIN_CHANNEL_DISTANCE = 8;

export const blendModes = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter",
] as const;

export type BlendMode = (typeof blendModes)[number];
export interface Rgba { r: number; g: number; b: number; a: number }
interface PmRgba extends Rgba {}
export type Pixel = [number, number, number, number];

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const inv = (value: number): number => 1 - value;

export function premultiply(color: Rgba): PmRgba {
  return { r: color.r * color.a, g: color.g * color.a, b: color.b * color.a, a: color.a };
}

export function unpremultiply(color: PmRgba): Rgba {
  if (color.a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: clamp(color.r / color.a),
    g: clamp(color.g / color.a),
    b: clamp(color.b / color.a),
    a: clamp(color.a),
  };
}

function blendChannel(mode: BlendMode, s: number, d: number, sa: number, da: number): number {
  switch (mode) {
    case "normal": return s + d * inv(sa);
    case "multiply": return s * d + s * inv(da) + d * inv(sa);
    case "screen": return s + d - s * d;
    case "darken": return s + d - Math.max(s * da, d * sa);
    case "lighten": return s + d - Math.min(s * da, d * sa);
    case "difference": return s + d - 2 * Math.min(s * da, d * sa);
    case "exclusion": return s + d - 2 * s * d;
    case "color-burn":
      if (d === da) return d + s * inv(da);
      if (s === 0) return d * inv(sa);
      return sa * (da - Math.min(da, ((da - d) * sa) / s)) + s * inv(da) + d * inv(sa);
    case "color-dodge":
      if (d === 0) return s * inv(da);
      if (s === sa) return s + d * inv(sa);
      return sa * Math.min(da, (d * sa) / (sa - s)) + s * inv(da) + d * inv(sa);
    case "hard-light":
      return s * inv(da) + d * inv(sa)
        + (2 * s <= sa ? 2 * s * d : sa * da - 2 * (da - d) * (sa - s));
    case "overlay":
      return s * inv(da) + d * inv(sa)
        + (2 * d <= da ? 2 * s * d : sa * da - 2 * (da - d) * (sa - s));
    case "soft-light": {
      const m = da > 0 ? d / da : 0;
      const s2 = 2 * s;
      const m4 = 4 * m;
      const darkSource = d * (sa + (s2 - sa) * (1 - m));
      const darkDestination = (m4 * m4 + m4) * (m - 1) + 7 * m;
      const lightDestination = Math.sqrt(m) - m;
      const lightSource = d * sa + da * (s2 - sa)
        * (4 * d <= da ? darkDestination : lightDestination);
      return s * inv(da) + d * inv(sa) + (s2 <= sa ? darkSource : lightSource);
    }
    case "plus-lighter": return Math.min(s + d, 1);
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      throw new Error(`${mode} is evaluated as a three-channel stage`);
  }
}

const luminance = (color: [number, number, number]): number =>
  color[0] * 0.30 + color[1] * 0.59 + color[2] * 0.11;
const saturation = (color: [number, number, number]): number =>
  Math.max(...color) - Math.min(...color);

function setSaturation(color: [number, number, number], target: number): [number, number, number] {
  const minimum = Math.min(...color);
  const span = Math.max(...color) - minimum;
  const scale = span === 0 ? 0 : target / span;
  return color.map((value) => (value - minimum) * scale) as [number, number, number];
}

function setLuminance(color: [number, number, number], target: number): [number, number, number] {
  const delta = target - luminance(color);
  return color.map((value) => value + delta) as [number, number, number];
}

function clipColor(color: [number, number, number], alpha: number): [number, number, number] {
  const minimum = Math.min(...color);
  const maximum = Math.max(...color);
  const light = luminance(color);
  return color.map((channel) => {
    let result = channel;
    if (minimum < 0 && light !== minimum) result = light + (result - light) * light / (light - minimum);
    if (maximum > alpha && light !== maximum) result = light + (result - light) * (alpha - light) / (maximum - light);
    return Math.max(result, 0);
  }) as [number, number, number];
}

function nonseparable(mode: "hue" | "saturation" | "color" | "luminosity", source: PmRgba, destination: PmRgba): PmRgba {
  const s: [number, number, number] = [source.r, source.g, source.b];
  const d: [number, number, number] = [destination.r, destination.g, destination.b];
  let mixed: [number, number, number];
  if (mode === "hue") {
    mixed = setSaturation(s.map((value) => value * source.a) as [number, number, number], saturation(d) * source.a);
    mixed = setLuminance(mixed, luminance(d) * source.a);
  } else if (mode === "saturation") {
    mixed = setSaturation(d.map((value) => value * source.a) as [number, number, number], saturation(s) * destination.a);
    mixed = setLuminance(mixed, luminance(d) * source.a);
  } else if (mode === "color") {
    mixed = s.map((value) => value * destination.a) as [number, number, number];
    mixed = setLuminance(mixed, luminance(d) * source.a);
  } else {
    mixed = d.map((value) => value * source.a) as [number, number, number];
    mixed = setLuminance(mixed, luminance(s) * destination.a);
  }
  mixed = clipColor(mixed, source.a * destination.a);
  const alpha = source.a + destination.a - source.a * destination.a;
  return {
    r: source.r * inv(destination.a) + destination.r * inv(source.a) + mixed[0],
    g: source.g * inv(destination.a) + destination.g * inv(source.a) + mixed[1],
    b: source.b * inv(destination.a) + destination.b * inv(source.a) + mixed[2],
    a: alpha,
  };
}

/** Transcription of SkRasterPipeline's premultiplied blend stages at 62efacd3. */
export function blend(mode: BlendMode, source: Rgba, destination: Rgba): Rgba {
  const s = premultiply(source);
  const d = premultiply(destination);
  const result = mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity"
    ? nonseparable(mode, s, d)
    : {
        r: blendChannel(mode, s.r, d.r, s.a, d.a),
        g: blendChannel(mode, s.g, d.g, s.a, d.a),
        b: blendChannel(mode, s.b, d.b, s.a, d.a),
        a: mode === "plus-lighter" ? Math.min(s.a + d.a, 1) : s.a + d.a * inv(s.a),
      };
  return unpremultiply(result);
}

export type ColorFilterOperation =
  | { type: "grayscale" | "sepia" | "saturate" | "invert" | "opacity" | "brightness" | "contrast"; amount: number }
  | { type: "hue-rotate"; amount: number };

function matrixFilter(color: Rgba, matrix: number[]): Rgba {
  const input = [color.r, color.g, color.b, color.a, 1];
  const output = [0, 1, 2, 3].map((row) =>
    matrix.slice(row * 5, row * 5 + 5).reduce((sum, coefficient, index) => sum + coefficient * input[index], 0));
  return { r: clamp(output[0]), g: clamp(output[1]), b: clamp(output[2]), a: clamp(output[3]) };
}

function colorMatrix(operation: Exclude<ColorFilterOperation, { type: "invert" | "opacity" | "brightness" | "contrast" }>): number[] {
  if (operation.type === "grayscale") {
    const s = clamp(1 - operation.amount);
    return [
      .2126 + .7874 * s, .7152 - .7152 * s, .0722 - .0722 * s, 0, 0,
      .2126 - .2126 * s, .7152 + .2848 * s, .0722 - .0722 * s, 0, 0,
      .2126 - .2126 * s, .7152 - .7152 * s, .0722 + .9278 * s, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  if (operation.type === "sepia") {
    const s = clamp(1 - operation.amount);
    return [
      .393 + .607 * s, .769 - .769 * s, .189 - .189 * s, 0, 0,
      .349 - .349 * s, .686 + .314 * s, .168 - .168 * s, 0, 0,
      .272 - .272 * s, .534 - .534 * s, .131 + .869 * s, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  if (operation.type === "saturate") {
    const s = Math.max(0, operation.amount);
    return [
      .213 + .787 * s, .715 - .715 * s, .072 - .072 * s, 0, 0,
      .213 - .213 * s, .715 + .285 * s, .072 - .072 * s, 0, 0,
      .213 - .213 * s, .715 - .715 * s, .072 + .928 * s, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  const radians = operation.amount * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  return [
    .213 + c * .787 - s * .213, .715 - c * .715 - s * .715, .072 - c * .072 + s * .928, 0, 0,
    .213 - c * .213 + s * .143, .715 + c * .285 + s * .140, .072 - c * .072 - s * .283, 0, 0,
    .213 - c * .213 - s * .787, .715 - c * .715 + s * .715, .072 + c * .928 + s * .072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** Blink shorthand operations in list order, in their forced sRGB space. */
export function applyColorFilters(input: Rgba, operations: readonly ColorFilterOperation[]): Rgba {
  let color = { ...input };
  for (const operation of operations) {
    if (operation.type === "invert") {
      const amount = clamp(operation.amount);
      color = { ...color,
        r: clamp(amount + color.r * (1 - 2 * amount)),
        g: clamp(amount + color.g * (1 - 2 * amount)),
        b: clamp(amount + color.b * (1 - 2 * amount)) };
    } else if (operation.type === "opacity") {
      color = { ...color, a: clamp(color.a * clamp(operation.amount)) };
    } else if (operation.type === "brightness") {
      const amount = Math.max(0, operation.amount);
      color = { ...color, r: clamp(color.r * amount), g: clamp(color.g * amount), b: clamp(color.b * amount) };
    } else if (operation.type === "contrast") {
      const amount = Math.max(0, operation.amount);
      const intercept = .5 - .5 * amount;
      color = { ...color,
        r: clamp(color.r * amount + intercept),
        g: clamp(color.g * amount + intercept),
        b: clamp(color.b * amount + intercept) };
    } else {
      color = matrixFilter(color, colorMatrix(operation));
    }
  }
  return color;
}

const WIDTH = 900;
const HEIGHT = 610;
const DESTINATION: Rgba = { r: 196 / 255, g: 82 / 255, b: 43 / 255, a: 1 };
const SOURCE: Rgba = { r: 38 / 255, g: 171 / 255, b: 224 / 255, a: .65 };
const OPAQUE_SOURCE: Rgba = { ...SOURCE, a: 1 };
const COLOR_CHAIN: readonly ColorFilterOperation[] = [
  { type: "grayscale", amount: .37 }, { type: "sepia", amount: .44 },
  { type: "saturate", amount: 1.35 }, { type: "hue-rotate", amount: 37 },
  { type: "invert", amount: .18 }, { type: "brightness", amount: 1.12 },
  { type: "contrast", amount: .83 },
];
const REVERSE_COLOR_CHAIN = [...COLOR_CHAIN].reverse();

export function blendFilterFixtureHtml(): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/html-test/37-blend-filter-pixel-stage.html"), "utf8");
}

function toPixel(color: Rgba): Pixel {
  return [color.r, color.g, color.b, color.a].map((value) => Math.round(clamp(value) * 255)) as Pixel;
}

function expectedPixels(source: Rgba = SOURCE): Map<string, Pixel> {
  const expected = new Map<string, Pixel>();
  for (const mode of blendModes) expected.set(`blend.${mode}`, toPixel(blend(mode, source, DESTINATION)));
  expected.set("filter.color-chain", toPixel(blend("normal", applyColorFilters(OPAQUE_SOURCE, COLOR_CHAIN), DESTINATION)));
  expected.set("filter.reverse-chain", toPixel(blend("normal", applyColorFilters(OPAQUE_SOURCE, REVERSE_COLOR_CHAIN), DESTINATION)));
  expected.set("filter.own-source", toPixel(blend("normal", applyColorFilters(source, [{ type: "invert", amount: 1 }]), DESTINATION)));
  expected.set("filter.opacity-chain", toPixel(blend("normal", applyColorFilters(source, [
    { type: "opacity", amount: .55 }, { type: "brightness", amount: 1.18 },
  ]), DESTINATION)));
  expected.set("surface.isolated", toPixel(blend("normal", source, DESTINATION)));
  expected.set("surface.nonisolated", toPixel(blend("multiply", source, DESTINATION)));
  expected.set("surface.filter-own-source", toPixel(blend("normal", applyColorFilters(source, [{ type: "invert", amount: 1 }]), DESTINATION)));
  const backgroundBottom = blend("multiply", { r: 40 / 255, g: 190 / 255, b: 96 / 255, a: 1 }, { r: 220 / 255, g: 170 / 255, b: 32 / 255, a: 1 });
  expected.set("surface.background-stack", toPixel(blend("screen", { r: 48 / 255, g: 82 / 255, b: 220 / 255, a: 1 }, backgroundBottom)));
  expected.set("surface.opacity-blend", toPixel(blend("normal", { ...OPAQUE_SOURCE, a: .58 }, DESTINATION)));
  return expected;
}

interface DecodedImage { width: number; height: number; channels: number; data: Buffer }
async function decode(png: Buffer): Promise<DecodedImage> {
  const result = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: result.info.width, height: result.info.height, channels: result.info.channels, data: result.data };
}

function sample(image: DecodedImage, xCss: number, yCss: number, dpr: number): Pixel {
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(xCss * dpr)));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(yCss * dpr)));
  const offset = (y * image.width + x) * image.channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

const maxDistance = (left: Pixel, right: Pixel): number => Math.max(...left.map((value, index) => Math.abs(value - right[index])));

async function screenshotSvg(page: Page, svg: string): Promise<Buffer> {
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`, { waitUntil: "load" });
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  return Buffer.from(await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, omitBackground: true }));
}

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

type MutationKind = "no-filter" | "no-blend" | "no-isolation";
interface ProbeSpec { mutation: MutationKind; movement: "moved" | "stable" }

function probeSpecs(ids: readonly string[]): Map<string, ProbeSpec> {
  const result = new Map<string, ProbeSpec>();
  for (const id of ids) {
    if (id.startsWith("blend.")) result.set(id, { mutation: "no-blend", movement: id === "blend.normal" ? "stable" : "moved" });
    else if (id === "surface.isolated") result.set(id, { mutation: "no-isolation", movement: "moved" });
    else if (id === "surface.nonisolated") result.set(id, { mutation: "no-isolation", movement: "stable" });
    else if (id === "surface.background-stack") result.set(id, { mutation: "no-blend", movement: "moved" });
    else if (id === "surface.opacity-blend") result.set(id, { mutation: "no-blend", movement: "stable" });
    else result.set(id, { mutation: "no-filter", movement: "moved" });
  }
  return result;
}

export interface BlendFilterProbeRow {
  id: string;
  dpr: number;
  pointCss: [number, number];
  expected: Pixel | null;
  source: Pixel;
  rendered: Pixel;
  mutation: Pixel;
  sourceModelMaxChannelError: number | null;
  renderedMaxChannelError: number;
  mutationMaxChannelDistance: number;
  mutationKind: MutationKind;
  mutationExpectation: "moved" | "stable";
  pass: boolean;
}

export interface BlendFilterBoundaryRow {
  id: string;
  expected: "vector" | "chromium-raster";
  actual: "vector" | "chromium-raster" | "missing";
  pass: boolean;
}

export interface BlendFilterPixelStageReport {
  schemaVersion: 2;
  sourcePins: typeof BLEND_FILTER_SOURCE_PINS;
  producer: { chromiumVersion: string; platform: NodeJS.Platform; architecture: string };
  tolerances: { maxChannelCode: 4; mutationMinChannelDistance: 8 };
  sourceRules: {
    shorthandInterpolation: "sRGB";
    primitiveClip: "disabled";
    blurTileMode: "decal";
    blurIdentitySigma: 0.03;
    blurKernelRadius: "ceil(3*sigma)";
    blendRepresentation: "premultiplied-rgba";
  };
  rows: BlendFilterProbeRow[];
  boundaries: BlendFilterBoundaryRow[];
  warnings: string[];
  structuralErrors: string[];
  unexpectedFailures: string[];
  verdict: "source-exact" | "unexpected-drift";
}

export async function runBlendFilterPixelStageOracle(
  dprs: number[] = [1, 2],
  artifactDir?: string,
): Promise<BlendFilterPixelStageReport> {
  const browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  const rows: BlendFilterProbeRow[] = [];
  const boundaries: BlendFilterBoundaryRow[] = [];
  const structuralErrors: string[] = [];
  const warnings: string[] = [];
  const fixture = blendFilterFixtureHtml();
  const expected = expectedPixels();
  let boundaryCaptured = false;
  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const sourcePage = await context.newPage();
      await sourcePage.setContent(fixture, { waitUntil: "load" });
      await sourcePage.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
      const points = await sourcePage.locator("[data-probe]").evaluateAll((elements) => Object.fromEntries(elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return [element.getAttribute("data-probe")!, [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      }))) as Record<string, [number, number]>;
      const sourcePng = Buffer.from(await sourcePage.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, omitBackground: true }));
      const captured = await captureElementTreeWithWarnings(sourcePage, "#stage", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      warnings.push(...captured.warnings.map((warning) =>
        `DPR${dpr}:${typeof warning === "string" ? warning : JSON.stringify(warning)}`));
      const svg = elementTreeToSvg(captured.tree, WIDTH, HEIGHT);

      if (!boundaryCaptured) {
        const byAnimId = new Map(flatten(captured.tree).filter((element) => element.animId != null).map((element) => [element.animId!, element]));
        const ownership = (id: string): "vector" | "chromium-raster" | "missing" => {
          const element = byAnimId.get(id);
          if (element == null) return "missing";
          const raster = element.backdropFilterRaster?.dataUri != null
            || element.urlFilterRaster?.dataUri != null
            || element.elementRaster?.dataUri != null
            || element.transformSubtreeRaster?.dataUri != null;
          return raster ? "chromium-raster" : "vector";
        };
        for (const [id, expectedOwnership] of [
          ["boundary-filter", "vector"], ["boundary-blend", "vector"],
          ["boundary-backdrop", "chromium-raster"], ["boundary-convolve", "chromium-raster"],
          ["boundary-url-color", "vector"], ["boundary-native-convolve", "vector"],
        ] as const) {
          const actual = ownership(id);
          boundaries.push({ id, expected: expectedOwnership, actual, pass: actual === expectedOwnership });
        }
        boundaryCaptured = true;
      }

      const mutated = {
        "no-filter": svg.replace(/(?<!backdrop-)filter:[^;&\"]+/g, "filter:none"),
        "no-blend": svg.replace(/mix-blend-mode:[^;&\"]+/g, "mix-blend-mode:normal"),
        "no-isolation": svg.replace(/isolation:isolate/g, "isolation:auto"),
      } as const;
      const renderPage = await context.newPage();
      const renderedPng = await screenshotSvg(renderPage, svg);
      const mutationPngs = {
        "no-filter": await screenshotSvg(renderPage, mutated["no-filter"]),
        "no-blend": await screenshotSvg(renderPage, mutated["no-blend"]),
        "no-isolation": await screenshotSvg(renderPage, mutated["no-isolation"]),
      } as const;
      const [sourceImage, renderedImage, noFilterImage, noBlendImage, noIsolationImage] = await Promise.all([
        decode(sourcePng), decode(renderedPng), decode(mutationPngs["no-filter"]),
        decode(mutationPngs["no-blend"]), decode(mutationPngs["no-isolation"]),
      ]);
      const mutationImages = { "no-filter": noFilterImage, "no-blend": noBlendImage, "no-isolation": noIsolationImage } as const;
      const specs = probeSpecs(Object.keys(points));
      for (const [id, point] of Object.entries(points)) {
        if (id === "boundary.backdrop") continue;
        const spec = specs.get(id);
        if (spec == null) { structuralErrors.push(`missing probe specification: ${id}`); continue; }
        const sourcePixel = sample(sourceImage, point[0], point[1], dpr);
        const renderedPixel = sample(renderedImage, point[0], point[1], dpr);
        const mutationPixel = sample(mutationImages[spec.mutation], point[0], point[1], dpr);
        const expectedPixel = expected.get(id) ?? null;
        const modelError = expectedPixel == null ? null : maxDistance(sourcePixel, expectedPixel);
        const renderedError = maxDistance(sourcePixel, renderedPixel);
        // Measure activation against the candidate, not the source. A known
        // candidate defect must not make an otherwise inert mutation look
        // active merely because both differ from Chromium.
        const mutationDistance = maxDistance(renderedPixel, mutationPixel);
        const mutationPass = spec.movement === "moved"
          ? mutationDistance >= MUTATION_MIN_CHANNEL_DISTANCE
          : mutationDistance <= STAGE_CHANNEL_TOLERANCE;
        const basePass = (modelError == null || modelError <= STAGE_CHANNEL_TOLERANCE)
          && renderedError <= STAGE_CHANNEL_TOLERANCE && mutationPass;
        rows.push({
          id, dpr, pointCss: point, expected: expectedPixel, source: sourcePixel,
          rendered: renderedPixel, mutation: mutationPixel,
          sourceModelMaxChannelError: modelError,
          renderedMaxChannelError: renderedError,
          mutationMaxChannelDistance: mutationDistance,
          mutationKind: spec.mutation,
          mutationExpectation: spec.movement,
          pass: basePass,
        });
      }
      if (artifactDir != null) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(`${artifactDir}/source-dpr${dpr}.png`, sourcePng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.png`, renderedPng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.svg`, svg);
        for (const [kind, png] of Object.entries(mutationPngs)) writeFileSync(`${artifactDir}/${kind}-dpr${dpr}.png`, png);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failedRows = rows.filter((row) => !row.pass);
  const unexpectedFailures = [
    ...failedRows.map((row) => row.id),
    ...boundaries.filter((row) => !row.pass).map((row) => row.id),
    ...structuralErrors,
  ];
  const verdict = unexpectedFailures.length > 0 ? "unexpected-drift" : "source-exact";
  return {
    schemaVersion: 2,
    sourcePins: BLEND_FILTER_SOURCE_PINS,
    producer: { chromiumVersion, platform: process.platform, architecture: process.arch },
    tolerances: { maxChannelCode: STAGE_CHANNEL_TOLERANCE, mutationMinChannelDistance: MUTATION_MIN_CHANNEL_DISTANCE },
    sourceRules: {
      shorthandInterpolation: "sRGB", primitiveClip: "disabled", blurTileMode: "decal",
      blurIdentitySigma: BLUR_IDENTITY_SIGMA, blurKernelRadius: "ceil(3*sigma)",
      blendRepresentation: "premultiplied-rgba",
    },
    rows,
    boundaries,
    warnings,
    structuralErrors,
    unexpectedFailures,
    verdict,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dprAt = args.indexOf("--dpr");
  const jsonAt = args.indexOf("--json");
  const artifactsAt = args.indexOf("--artifact-dir");
  const dprs = dprAt >= 0 ? args[dprAt + 1].split(",").map(Number).filter(Number.isFinite) : [1, 2];
  const jsonPath = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const artifactDir = artifactsAt >= 0 ? args[artifactsAt + 1] : undefined;
  const report = await runBlendFilterPixelStageOracle(dprs, artifactDir);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonPath != null) { mkdirSync(dirname(jsonPath), { recursive: true }); writeFileSync(jsonPath, body); }
  process.stdout.write(body);
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
