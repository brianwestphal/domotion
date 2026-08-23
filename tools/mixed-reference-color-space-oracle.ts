#!/usr/bin/env tsx
/**
 * DM-2535 pinned mixed reference-linearRGB / shorthand-sRGB stage oracle.
 *
 * The oracle keeps Chromium's compositor seam native. It models named flat
 * pixels and premultiplied intermediate surfaces, then proves that Domotion's
 * copied reference filter and CSS list reach the same terminal browser stage.
 * It does not lower the chain to a hand-authored SVG graph or grade a whole
 * image with a similarity threshold.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import {
  MUTATION_MIN_CHANNEL_DISTANCE,
  STAGE_CHANNEL_TOLERANCE,
  applyColorFilters,
  blend,
  premultiply,
  type ColorFilterOperation,
  type Pixel,
  type Rgba,
} from "./blend-filter-pixel-stage-oracle.js";

export const MIXED_COLOR_SPACE_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const MIXED_COLOR_SPACE_WIDTH = 760;
export const MIXED_COLOR_SPACE_HEIGHT = 340;

export const MIXED_SOURCE: Rgba = {
  r: 52 / 255,
  g: 164 / 255,
  b: 231 / 255,
  a: .58,
};

export const MIXED_DESTINATION: Rgba = {
  r: 194 / 255,
  g: 79 / 255,
  b: 43 / 255,
  a: 1,
};

export const MIXED_LOCAL_DESTINATION: Rgba = {
  r: 51 / 255,
  g: 136 / 255,
  b: 94 / 255,
  a: 1,
};

export const MIXED_SHORTHAND: readonly ColorFilterOperation[] = [
  { type: "brightness", amount: .74 },
  { type: "invert", amount: .19 },
  { type: "opacity", amount: .67 },
];

const SHORTHAND_CSS = "brightness(0.74) invert(0.19) opacity(0.67)";
const MIXED_CSS = `url(\"#linear-matrix\") ${SHORTHAND_CSS}`;
const EXPLICIT_BOUNDARY_CSS = `url(\"#linear-matrix\") url(\"#srgb-identity\") ${SHORTHAND_CSS}`;
const SHORTHAND_FIRST_CSS = `${SHORTHAND_CSS} url(\"#linear-matrix\")`;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** IEC 61966-2-1 EOTF used by Skia's pinned sRGB -> linear color filter. */
export function srgbChannelToLinear(value: number): number {
  const channel = clamp(value);
  return channel <= .04045
    ? channel / 12.92
    : ((channel + .055) / 1.055) ** 2.4;
}

/** IEC 61966-2-1 inverse EOTF used by Skia's pinned linear -> sRGB filter. */
export function linearChannelToSrgb(value: number): number {
  const channel = clamp(value);
  return channel <= .0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - .055;
}

export function srgbToLinear(color: Rgba): Rgba {
  return {
    r: srgbChannelToLinear(color.r),
    g: srgbChannelToLinear(color.g),
    b: srgbChannelToLinear(color.b),
    a: color.a,
  };
}

export function linearToSrgb(color: Rgba): Rgba {
  return {
    r: linearChannelToSrgb(color.r),
    g: linearChannelToSrgb(color.g),
    b: linearChannelToSrgb(color.b),
    a: color.a,
  };
}

/** The fixture's linearRGB feColorMatrix, evaluated on straight channels. */
export function applyLinearReferenceMatrix(color: Rgba): Rgba {
  return {
    r: clamp(.82 * color.r + .07),
    g: clamp(.68 * color.g + .10),
    b: clamp(.91 * color.b + .02),
    a: color.a,
  };
}

export interface LogicalColorSurface {
  id: string;
  interpolationSpace: "sRGB" | "linearRGB" | "linearRGB-values/shorthand-assumes-sRGB";
  operation: string;
  straight: Rgba;
  premultiplied: Rgba;
}

function surface(
  id: string,
  interpolationSpace: LogicalColorSurface["interpolationSpace"],
  operation: string,
  straight: Rgba,
): LogicalColorSurface {
  return { id, interpolationSpace, operation, straight, premultiplied: premultiply(straight) };
}

/**
 * Blink's pinned compositor list: reference output stays linear, shorthand
 * operates on those numeric values, and the conversion to sRGB occurs only at
 * the terminal boundary.
 */
export function tracePinnedMixedPipeline(sourceColor: Rgba = MIXED_SOURCE): LogicalColorSurface[] {
  const linearInput = srgbToLinear(sourceColor);
  const referenceOutput = applyLinearReferenceMatrix(linearInput);
  const shorthandWithoutTransition = applyColorFilters(referenceOutput, MIXED_SHORTHAND);
  const terminal = linearToSrgb(shorthandWithoutTransition);
  return [
    surface("source-srgb", "sRGB", "SourceGraphic", sourceColor),
    surface("reference-input-linear", "linearRGB", "Skia unpremul -> sRGB EOTF -> premul", linearInput),
    surface("reference-output-linear", "linearRGB", "linearRGB feColorMatrix", referenceOutput),
    surface(
      "shorthand-without-transition",
      "linearRGB-values/shorthand-assumes-sRGB",
      "Blink compositor TODO: shorthand list appended without linearRGB -> sRGB conversion",
      shorthandWithoutTransition,
    ),
    surface("terminal-srgb", "sRGB", "Skia unpremul -> inverse sRGB EOTF -> premul", terminal),
  ];
}

export function traceExplicitSrgbBoundary(sourceColor: Rgba = MIXED_SOURCE): LogicalColorSurface[] {
  const linearInput = srgbToLinear(sourceColor);
  const referenceOutput = applyLinearReferenceMatrix(linearInput);
  const explicitSrgb = linearToSrgb(referenceOutput);
  const shorthandOutput = applyColorFilters(explicitSrgb, MIXED_SHORTHAND);
  return [
    surface("source-srgb", "sRGB", "SourceGraphic", sourceColor),
    surface("reference-input-linear", "linearRGB", "sRGB -> linearRGB", linearInput),
    surface("reference-output-linear", "linearRGB", "linearRGB feColorMatrix", referenceOutput),
    surface("explicit-reference-boundary-srgb", "sRGB", "sRGB identity reference requests linearRGB -> sRGB", explicitSrgb),
    surface("shorthand-srgb", "sRGB", "CSS shorthand list", shorthandOutput),
  ];
}

/** Hostile control: transfer premultiplied channels without first unpremultiplying. */
export function wronglyDecodePremultiplied(color: Rgba): Rgba {
  const pm = premultiply(color);
  if (pm.a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: clamp(srgbChannelToLinear(pm.r) / pm.a),
    g: clamp(srgbChannelToLinear(pm.g) / pm.a),
    b: clamp(srgbChannelToLinear(pm.b) / pm.a),
    a: pm.a,
  };
}

export const MIXED_CHANNEL_TRANSFER_FACTS = {
  srgbHalfToLinear: srgbChannelToLinear(.5),
  linearHalfToSrgb: linearChannelToSrgb(.5),
  srgbBreakpointToLinear: srgbChannelToLinear(.04045),
  linearBreakpointToSrgb: linearChannelToSrgb(.0031308),
} as const;

export function mixedReferenceColorSpaceFixtureHtml(): string {
  return readFileSync(resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../tests/fixtures/html-test/38-mixed-reference-color-space-stage.html",
  ), "utf8");
}

function toPixel(color: Rgba): Pixel {
  return [color.r, color.g, color.b, color.a]
    .map((value) => Math.round(clamp(value) * 255)) as Pixel;
}

function maxDistance(left: Pixel, right: Pixel): number {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index])));
}

function expectedPixels(): Map<string, Pixel> {
  const linearInput = srgbToLinear(MIXED_SOURCE);
  const referenceOutputLinear = applyLinearReferenceMatrix(linearInput);
  const referenceOutputSrgb = linearToSrgb(referenceOutputLinear);
  const shorthandSrgb = applyColorFilters(MIXED_SOURCE, MIXED_SHORTHAND);
  const mixedPinned = linearToSrgb(applyColorFilters(referenceOutputLinear, MIXED_SHORTHAND));
  const explicitBoundary = applyColorFilters(referenceOutputSrgb, MIXED_SHORTHAND);
  const shorthandFirst = linearToSrgb(applyLinearReferenceMatrix(
    srgbToLinear(applyColorFilters(MIXED_SOURCE, MIXED_SHORTHAND)),
  ));
  const identityMixed = linearToSrgb(applyColorFilters(srgbToLinear(MIXED_SOURCE), MIXED_SHORTHAND));
  return new Map([
    ["stage.source", toPixel(MIXED_SOURCE)],
    ["stage.linear-reference", toPixel(referenceOutputSrgb)],
    ["stage.srgb-shorthand", toPixel(shorthandSrgb)],
    ["stage.mixed-reference-shorthand", toPixel(mixedPinned)],
    ["stage.explicit-srgb-boundary", toPixel(explicitBoundary)],
    ["stage.shorthand-first", toPixel(shorthandFirst)],
    ["stage.linear-identity", toPixel(MIXED_SOURCE)],
    ["stage.identity-mixed", toPixel(identityMixed)],
    ["stage.identity-explicit", toPixel(shorthandSrgb)],
    ["blend.nonisolated", toPixel(blend("multiply", mixedPinned, MIXED_DESTINATION))],
    ["blend.isolated", toPixel(blend("normal", mixedPinned, MIXED_DESTINATION))],
    ["blend.local-isolated", toPixel(blend("multiply", mixedPinned, MIXED_LOCAL_DESTINATION))],
  ]);
}

interface DecodedImage {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

async function decode(png: Buffer): Promise<DecodedImage> {
  const result = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: result.info.width,
    height: result.info.height,
    channels: result.info.channels,
    data: result.data,
  };
}

function sample(image: DecodedImage, point: [number, number], dpr: number): Pixel {
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(point[0] * dpr)));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(point[1] * dpr)));
  const offset = (y * image.width + x) * image.channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  }));
}

async function screenshotSvg(page: Page, svg: string): Promise<Buffer> {
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
    { waitUntil: "load" },
  );
  await settle(page);
  return Buffer.from(await page.screenshot({
    clip: { x: 0, y: 0, width: MIXED_COLOR_SPACE_WIDTH, height: MIXED_COLOR_SPACE_HEIGHT },
    omitBackground: true,
  }));
}

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function cloneTree(tree: CapturedElement[]): CapturedElement[] {
  return JSON.parse(JSON.stringify(tree)) as CapturedElement[];
}

type MutationOperation =
  | { type: "filter"; target: string; value: string }
  | { type: "blend"; target: string; value: string }
  | { type: "isolation"; target: string; value: string }
  | { type: "filter-space"; filterId: string; value: "sRGB" | "linearRGB" };

interface MutationSpec {
  id: string;
  probe: string;
  movement: "moved" | "stable";
  operation: MutationOperation;
}

const MUTATIONS: readonly MutationSpec[] = [
  {
    id: "linear-reference-space-to-srgb",
    probe: "stage.linear-reference",
    movement: "moved",
    operation: { type: "filter-space", filterId: "linear-matrix", value: "sRGB" },
  },
  {
    id: "mixed-drop-reference",
    probe: "stage.mixed-reference-shorthand",
    movement: "moved",
    operation: { type: "filter", target: "stage-mixed", value: SHORTHAND_CSS },
  },
  {
    id: "mixed-insert-explicit-srgb-boundary",
    probe: "stage.mixed-reference-shorthand",
    movement: "moved",
    operation: { type: "filter", target: "stage-mixed", value: EXPLICIT_BOUNDARY_CSS },
  },
  {
    id: "mixed-reverse-list-order",
    probe: "stage.mixed-reference-shorthand",
    movement: "moved",
    operation: { type: "filter", target: "stage-mixed", value: SHORTHAND_FIRST_CSS },
  },
  {
    id: "explicit-boundary-drop-srgb-reference",
    probe: "stage.explicit-srgb-boundary",
    movement: "moved",
    operation: { type: "filter", target: "stage-explicit", value: MIXED_CSS },
  },
  {
    id: "nonisolated-drop-blend",
    probe: "blend.nonisolated",
    movement: "moved",
    operation: { type: "blend", target: "blend-nonisolated", value: "normal" },
  },
  {
    id: "isolated-drop-isolation",
    probe: "blend.isolated",
    movement: "moved",
    operation: { type: "isolation", target: "isolation-owner", value: "auto" },
  },
  {
    id: "isolated-drop-inert-blend",
    probe: "blend.isolated",
    movement: "stable",
    operation: { type: "blend", target: "blend-isolated", value: "normal" },
  },
  {
    id: "local-isolated-drop-blend",
    probe: "blend.local-isolated",
    movement: "moved",
    operation: { type: "blend", target: "blend-local-isolated", value: "normal" },
  },
] as const;

// Investigation-only ratchet. These are the two observed wrapper-order pixel
// gaps and the three mutations they make inert. Any different row/mutation is
// unexpected drift; landing the follow-up may remove entries without making a
// newly exact build fail.
const KNOWN_PRODUCTION_GAP_PROBES = new Set([
  "blend.nonisolated",
  "blend.local-isolated",
]);
const KNOWN_PRODUCTION_GAP_MUTATIONS = new Set([
  "nonisolated-drop-blend",
  "isolated-drop-isolation",
  "local-isolated-drop-blend",
]);

function applyTreeMutation(tree: CapturedElement[], operation: MutationOperation): string | null {
  if (operation.type === "filter-space") {
    let changed = false;
    for (const root of tree) {
      for (const def of root.filterDefs ?? []) {
        if (def.id !== operation.filterId) continue;
        def.outerHTML = def.outerHTML.replace(
          /color-interpolation-filters=(['"])(?:linearRGB|sRGB)\1/i,
          `color-interpolation-filters=\"${operation.value}\"`,
        );
        changed = true;
      }
    }
    return changed ? null : `missing captured filter def: ${operation.filterId}`;
  }
  const target = flatten(tree).find((element) => element.animId === operation.target);
  if (target == null) return `missing captured mutation target: ${operation.target}`;
  if (operation.type === "filter") target.styles.filter = operation.value;
  else if (operation.type === "blend") target.styles.mixBlendMode = operation.value;
  else target.styles.isolation = operation.value;
  return null;
}

async function sourceMutationPng(page: Page, fixture: string, operation: MutationOperation): Promise<Buffer> {
  await page.setContent(fixture, { waitUntil: "load" });
  await page.evaluate((mutation) => {
    if (mutation.type === "filter-space") {
      document.getElementById(mutation.filterId)?.setAttribute("color-interpolation-filters", mutation.value);
      return;
    }
    const target = document.querySelector<HTMLElement>(`[data-domotion-anim="${mutation.target}"]`);
    if (target == null) throw new Error(`missing source mutation target: ${mutation.target}`);
    if (mutation.type === "filter") target.style.filter = mutation.value;
    else if (mutation.type === "blend") target.style.mixBlendMode = mutation.value;
    else target.style.isolation = mutation.value;
  }, operation);
  await settle(page);
  return Buffer.from(await page.screenshot({
    clip: { x: 0, y: 0, width: MIXED_COLOR_SPACE_WIDTH, height: MIXED_COLOR_SPACE_HEIGHT },
    omitBackground: true,
  }));
}

export interface MixedColorSpaceProbeRow {
  id: string;
  dpr: number;
  pointCss: [number, number];
  expected: Pixel;
  source: Pixel;
  rendered: Pixel;
  sourceModelMaxChannelError: number;
  renderedMaxChannelError: number;
  pass: boolean;
}

export interface MixedColorSpaceMutationRow {
  id: string;
  probe: string;
  dpr: number;
  expectation: "moved" | "stable";
  sourceMutationMaxChannelDistance: number;
  renderedMutationMaxChannelDistance: number;
  pass: boolean;
}

export interface MixedColorSpaceBoundaryRow {
  id: string;
  expected: "chromium-native-vector";
  actual: "chromium-native-vector" | "domotion-raster" | "missing";
  pass: boolean;
}

export interface MixedReferenceColorSpaceReport {
  schemaVersion: 1;
  sourcePins: typeof MIXED_COLOR_SPACE_SOURCE_PINS;
  producer: { chromiumVersion: string; platform: NodeJS.Platform; architecture: string };
  fixedBounds: { maxChannelCode: 4; mutationMinChannelDistance: 8 };
  sourceRules: {
    referencePrimitiveInterpolation: "per-primitive color-interpolation-filters";
    pinnedMixedTransition: "no linearRGB-to-sRGB conversion before shorthand";
    terminalConversion: "linearRGB-to-sRGB after the operation list";
    colorTransferAlphaOrder: "unpremultiply-transfer-premultiply";
    blendRepresentation: "sRGB-premultiplied-rgba";
    ownership: "chromium-native-vector-terminal";
  };
  computedFilterLists: Record<string, string>;
  channelTransferFacts: typeof MIXED_CHANNEL_TRANSFER_FACTS;
  stageTraces: {
    pinnedMixed: LogicalColorSurface[];
    explicitSrgbBoundary: LogicalColorSurface[];
  };
  hostileLogicalControls: Array<{
    id: string;
    maxChannelCodeDistance: number;
    pass: boolean;
  }>;
  rows: MixedColorSpaceProbeRow[];
  mutations: MixedColorSpaceMutationRow[];
  boundaries: MixedColorSpaceBoundaryRow[];
  warnings: string[];
  structuralErrors: string[];
  productionGaps: string[];
  unexpectedFailures: string[];
  verdict: "source-exact" | "production-gap" | "unexpected-drift";
}

function nativeOwnership(element: CapturedElement | undefined): MixedColorSpaceBoundaryRow["actual"] {
  if (element == null) return "missing";
  const raster = element.backdropFilterRaster?.dataUri != null
    || element.urlFilterRaster?.dataUri != null
    || element.elementRaster?.dataUri != null
    || element.transformSubtreeRaster?.dataUri != null;
  return raster ? "domotion-raster" : "chromium-native-vector";
}

export async function runMixedReferenceColorSpaceOracle(
  dprs: number[] = [1, 2],
  artifactDir?: string,
): Promise<MixedReferenceColorSpaceReport> {
  const fixture = mixedReferenceColorSpaceFixtureHtml();
  const expected = expectedPixels();
  const browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  const rows: MixedColorSpaceProbeRow[] = [];
  const mutationRows: MixedColorSpaceMutationRow[] = [];
  const boundaries: MixedColorSpaceBoundaryRow[] = [];
  const warnings: string[] = [];
  const structuralErrors: string[] = [];
  const computedFilterLists: Record<string, string> = {};
  let boundaryCaptured = false;

  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({
        viewport: { width: MIXED_COLOR_SPACE_WIDTH, height: MIXED_COLOR_SPACE_HEIGHT },
        deviceScaleFactor: dpr,
      });
      const sourcePage = await context.newPage();
      await sourcePage.setContent(fixture, { waitUntil: "load" });
      await settle(sourcePage);
      const points = await sourcePage.locator("[data-probe]").evaluateAll((elements) => Object.fromEntries(
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return [element.getAttribute("data-probe")!, [rect.left + rect.width / 2, rect.top + rect.height / 2]];
        }),
      )) as Record<string, [number, number]>;
      if (dpr === dprs[0]) {
        Object.assign(computedFilterLists, await sourcePage.locator("[data-domotion-anim]").evaluateAll((elements) =>
          Object.fromEntries(elements.map((element) => [
            element.getAttribute("data-domotion-anim")!,
            getComputedStyle(element).filter,
          ]))));
      }
      const sourcePng = Buffer.from(await sourcePage.screenshot({
        clip: { x: 0, y: 0, width: MIXED_COLOR_SPACE_WIDTH, height: MIXED_COLOR_SPACE_HEIGHT },
        omitBackground: true,
      }));
      const captured = await captureElementTreeWithWarnings(
        sourcePage,
        "#stage",
        { x: 0, y: 0, width: MIXED_COLOR_SPACE_WIDTH, height: MIXED_COLOR_SPACE_HEIGHT },
      );
      warnings.push(...captured.warnings.map((warning) =>
        `DPR${dpr}:${typeof warning === "string" ? warning : JSON.stringify(warning)}`));
      const svg = elementTreeToSvg(captured.tree, MIXED_COLOR_SPACE_WIDTH, MIXED_COLOR_SPACE_HEIGHT);

      if (!boundaryCaptured) {
        const byAnimId = new Map(flatten(captured.tree)
          .filter((element) => element.animId != null)
          .map((element) => [element.animId!, element]));
        for (const id of [
          "stage-linear-reference",
          "stage-mixed",
          "stage-explicit",
          "blend-nonisolated",
          "blend-isolated",
          "blend-local-isolated",
        ]) {
          const actual = nativeOwnership(byAnimId.get(id));
          boundaries.push({
            id,
            expected: "chromium-native-vector",
            actual,
            pass: actual === "chromium-native-vector",
          });
        }
        const definitions = captured.tree.flatMap((root) => root.filterDefs ?? []);
        for (const [id, interpolation] of [
          ["linear-matrix", "linearRGB"],
          ["linear-identity", "linearRGB"],
          ["srgb-identity", "sRGB"],
        ] as const) {
          const definition = definitions.find((candidate) => candidate.id === id);
          if (definition == null) structuralErrors.push(`missing captured filter def: ${id}`);
          else if (!new RegExp(`color-interpolation-filters=[\"']${interpolation}[\"']`, "i").test(definition.outerHTML)) {
            structuralErrors.push(`wrong captured interpolation space for ${id}`);
          }
        }
        boundaryCaptured = true;
      }

      const renderPage = await context.newPage();
      const renderedPng = await screenshotSvg(renderPage, svg);
      const [sourceImage, renderedImage] = await Promise.all([decode(sourcePng), decode(renderedPng)]);
      for (const [id, point] of Object.entries(points)) {
        const expectedPixel = expected.get(id);
        if (expectedPixel == null) {
          structuralErrors.push(`missing logical model for probe: ${id}`);
          continue;
        }
        const sourcePixel = sample(sourceImage, point, dpr);
        const renderedPixel = sample(renderedImage, point, dpr);
        const modelError = maxDistance(sourcePixel, expectedPixel);
        const renderedError = maxDistance(sourcePixel, renderedPixel);
        rows.push({
          id,
          dpr,
          pointCss: point,
          expected: expectedPixel,
          source: sourcePixel,
          rendered: renderedPixel,
          sourceModelMaxChannelError: modelError,
          renderedMaxChannelError: renderedError,
          pass: modelError <= STAGE_CHANNEL_TOLERANCE && renderedError <= STAGE_CHANNEL_TOLERANCE,
        });
      }

      for (const mutation of MUTATIONS) {
        const point = points[mutation.probe];
        if (point == null) {
          structuralErrors.push(`missing mutation probe: ${mutation.probe}`);
          continue;
        }
        const sourceMutation = await sourceMutationPng(sourcePage, fixture, mutation.operation);
        const mutatedTree = cloneTree(captured.tree);
        const mutationError = applyTreeMutation(mutatedTree, mutation.operation);
        if (mutationError != null) {
          structuralErrors.push(mutationError);
          continue;
        }
        const mutationSvg = elementTreeToSvg(
          mutatedTree,
          MIXED_COLOR_SPACE_WIDTH,
          MIXED_COLOR_SPACE_HEIGHT,
        );
        const renderedMutation = await screenshotSvg(renderPage, mutationSvg);
        const [sourceMutationImage, renderedMutationImage] = await Promise.all([
          decode(sourceMutation),
          decode(renderedMutation),
        ]);
        const sourceDistance = maxDistance(
          sample(sourceImage, point, dpr),
          sample(sourceMutationImage, point, dpr),
        );
        const renderedDistance = maxDistance(
          sample(renderedImage, point, dpr),
          sample(renderedMutationImage, point, dpr),
        );
        const pass = mutation.movement === "moved"
          ? sourceDistance >= MUTATION_MIN_CHANNEL_DISTANCE
            && renderedDistance >= MUTATION_MIN_CHANNEL_DISTANCE
          : sourceDistance <= STAGE_CHANNEL_TOLERANCE
            && renderedDistance <= STAGE_CHANNEL_TOLERANCE;
        mutationRows.push({
          id: mutation.id,
          probe: mutation.probe,
          dpr,
          expectation: mutation.movement,
          sourceMutationMaxChannelDistance: sourceDistance,
          renderedMutationMaxChannelDistance: renderedDistance,
          pass,
        });
        if (artifactDir != null) {
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(`${artifactDir}/${mutation.id}-source-dpr${dpr}.png`, sourceMutation);
          writeFileSync(`${artifactDir}/${mutation.id}-rendered-dpr${dpr}.png`, renderedMutation);
        }
      }

      if (artifactDir != null) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(`${artifactDir}/source-dpr${dpr}.png`, sourcePng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.png`, renderedPng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.svg`, svg);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const pinnedTerminal = tracePinnedMixedPipeline().at(-1)!.straight;
  const explicitTerminal = traceExplicitSrgbBoundary().at(-1)!.straight;
  const reorderedTerminal = linearToSrgb(applyLinearReferenceMatrix(
    srgbToLinear(applyColorFilters(MIXED_SOURCE, MIXED_SHORTHAND)),
  ));
  const correctDecoded = srgbToLinear(MIXED_SOURCE);
  const wrongDecoded = wronglyDecodePremultiplied(MIXED_SOURCE);
  const hostileLogicalControls = [
    {
      id: "transfer-premultiplied-without-unpremultiply",
      maxChannelCodeDistance: maxDistance(toPixel(correctDecoded), toPixel(wrongDecoded)),
      pass: maxDistance(toPixel(correctDecoded), toPixel(wrongDecoded)) >= MUTATION_MIN_CHANNEL_DISTANCE,
    },
    {
      id: "insert-early-linear-to-srgb-transition",
      maxChannelCodeDistance: maxDistance(toPixel(pinnedTerminal), toPixel(explicitTerminal)),
      pass: maxDistance(toPixel(pinnedTerminal), toPixel(explicitTerminal)) >= MUTATION_MIN_CHANNEL_DISTANCE,
    },
    {
      id: "reverse-reference-and-shorthand-order",
      maxChannelCodeDistance: maxDistance(toPixel(pinnedTerminal), toPixel(reorderedTerminal)),
      pass: maxDistance(toPixel(pinnedTerminal), toPixel(reorderedTerminal)) >= MUTATION_MIN_CHANNEL_DISTANCE,
    },
    {
      id: "remove-isolation-boundary",
      maxChannelCodeDistance: maxDistance(
        toPixel(blend("normal", pinnedTerminal, MIXED_DESTINATION)),
        toPixel(blend("multiply", pinnedTerminal, MIXED_DESTINATION)),
      ),
      pass: maxDistance(
        toPixel(blend("normal", pinnedTerminal, MIXED_DESTINATION)),
        toPixel(blend("multiply", pinnedTerminal, MIXED_DESTINATION)),
      ) >= MUTATION_MIN_CHANNEL_DISTANCE,
    },
  ];
  const productionGaps = rows
    .filter((row) => row.sourceModelMaxChannelError <= STAGE_CHANNEL_TOLERANCE
      && row.renderedMaxChannelError > STAGE_CHANNEL_TOLERANCE)
    .map((row) => `row:DPR${row.dpr}:${row.id}`);
  productionGaps.push(...mutationRows
    .filter((row) => !row.pass && KNOWN_PRODUCTION_GAP_MUTATIONS.has(row.id))
    .map((row) => `mutation:DPR${row.dpr}:${row.id}`));
  const unexpectedFailures = [
    ...rows.filter((row) => row.sourceModelMaxChannelError > STAGE_CHANNEL_TOLERANCE)
      .map((row) => `source-model:DPR${row.dpr}:${row.id}`),
    ...rows.filter((row) => row.sourceModelMaxChannelError <= STAGE_CHANNEL_TOLERANCE
      && row.renderedMaxChannelError > STAGE_CHANNEL_TOLERANCE
      && !KNOWN_PRODUCTION_GAP_PROBES.has(row.id))
      .map((row) => `unexpected-production-gap:DPR${row.dpr}:${row.id}`),
    ...mutationRows.filter((row) => !row.pass && !KNOWN_PRODUCTION_GAP_MUTATIONS.has(row.id))
      .map((row) => `mutation:DPR${row.dpr}:${row.id}`),
    ...boundaries.filter((row) => !row.pass).map((row) => `boundary:${row.id}`),
    ...hostileLogicalControls.filter((row) => !row.pass).map((row) => `hostile:${row.id}`),
    ...structuralErrors,
  ];
  const verdict = unexpectedFailures.length > 0
    ? "unexpected-drift"
    : productionGaps.length > 0
      ? "production-gap"
      : "source-exact";
  return {
    schemaVersion: 1,
    sourcePins: MIXED_COLOR_SPACE_SOURCE_PINS,
    producer: { chromiumVersion, platform: process.platform, architecture: process.arch },
    fixedBounds: {
      maxChannelCode: STAGE_CHANNEL_TOLERANCE,
      mutationMinChannelDistance: MUTATION_MIN_CHANNEL_DISTANCE,
    },
    sourceRules: {
      referencePrimitiveInterpolation: "per-primitive color-interpolation-filters",
      pinnedMixedTransition: "no linearRGB-to-sRGB conversion before shorthand",
      terminalConversion: "linearRGB-to-sRGB after the operation list",
      colorTransferAlphaOrder: "unpremultiply-transfer-premultiply",
      blendRepresentation: "sRGB-premultiplied-rgba",
      ownership: "chromium-native-vector-terminal",
    },
    computedFilterLists,
    channelTransferFacts: MIXED_CHANNEL_TRANSFER_FACTS,
    stageTraces: {
      pinnedMixed: tracePinnedMixedPipeline(),
      explicitSrgbBoundary: traceExplicitSrgbBoundary(),
    },
    hostileLogicalControls,
    rows,
    mutations: mutationRows,
    boundaries,
    warnings,
    structuralErrors,
    productionGaps,
    unexpectedFailures,
    verdict,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dprAt = args.indexOf("--dpr");
  const jsonAt = args.indexOf("--json");
  const artifactsAt = args.indexOf("--artifact-dir");
  const dprs = dprAt >= 0
    ? args[dprAt + 1].split(",").map(Number).filter(Number.isFinite)
    : [1, 2];
  const jsonPath = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const artifactDir = artifactsAt >= 0 ? args[artifactsAt + 1] : undefined;
  const report = await runMixedReferenceColorSpaceOracle(dprs, artifactDir);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonPath != null) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, body);
  }
  process.stdout.write(body);
  if (report.verdict === "unexpected-drift") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
