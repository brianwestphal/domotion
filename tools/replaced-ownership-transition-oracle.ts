#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import sharp from "sharp";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";

import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement, CaptureWarning } from "../src/capture/types.js";
import { computeObjectFitRect } from "../src/render/element-tree-to-svg.js";
import {
  adjudicateReplacedOwnershipTransitions,
  type ReplacedOwnership,
  type ReplacedOwnershipAdjudication,
  type ReplacedOwnershipRequirements,
  type ReplacedOwnershipTransitionRow,
  type ReplacedPlatformFingerprint,
} from "./replaced-ownership-transition-gate.js";

type Rect = { x: number; y: number; width: number; height: number };

const VIEWPORT = { width: 1120, height: 760 } as const;
const LAUNCH_ARGS = ["--enable-blink-features=AppearanceBase"] as const;
const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaCheckout: "ebf5052",
  skiaPinnedByChromium: "62efacd3",
  harfbuzz: "4de187d",
} as const;

export const REPLACED_OWNERSHIP_REQUIREMENTS: ReplacedOwnershipRequirements = {
  pairIds: [
    "object.fit-mode",
    "object.intrinsic-dimensions",
    "object.effective-zoom",
    "object.axis-position",
    "image.decode-state",
    "surface.canvas-frame",
    "surface.video-frame",
    "control.checkbox",
    "control.radio",
    "control.button",
    "control.select",
    "control.progress",
    "control.meter",
    "control.accent-color",
    "control.color-scheme",
    "control.axis-zoom",
    "generated.placement",
  ],
  families: ["object-geometry", "image-decoding", "dynamic-surface", "native-control", "generated-box"],
  toleranceDevicePixels: 1,
};

export interface ReplacedOwnershipRunReport {
  schemaVersion: 2;
  sourceRevisions: typeof SOURCE_REVISIONS;
  fingerprint: ReplacedPlatformFingerprint;
  rows: ReplacedOwnershipTransitionRow[];
  requirements: ReplacedOwnershipRequirements;
  adjudication: ReplacedOwnershipAdjudication;
  verdict: "source-exact" | "source-drift";
}

export interface ReplacedOwnershipGateReport {
  schemaVersion: 2;
  generatedAt: string;
  requiredDeviceScaleFactors: number[];
  runs: ReplacedOwnershipRunReport[];
  verdict: "source-exact" | "source-drift";
}

const require = createRequire(import.meta.url);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalFingerprint(browser: Browser, deviceScaleFactor: number): ReplacedPlatformFingerprint {
  const base = {
    chromiumVersion: browser.version(),
    playwrightVersion: (require("playwright/package.json") as { version: string }).version,
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    deviceScaleFactor,
    colorScheme: "light" as const,
    forcedColors: "none" as const,
    launchArgs: [...LAUNCH_ARGS],
  };
  return { ...base, sha256: sha256(JSON.stringify(base)) };
}

function walk(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...walk(element.children ?? [])]);
}

function byAnimId(tree: CapturedElement[], id: string): CapturedElement | undefined {
  return walk(tree).find((element) => element.animId === id);
}

function rectDelta(a: Rect, b: Rect): number {
  return Math.max(...(["x", "y", "width", "height"] as const).map((key) => Math.abs(a[key] - b[key])));
}

function intersectRect(rect: Rect, clip: Rect): Rect {
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

async function colorRectFromPng(
  png: Buffer,
  rgb: readonly [number, number, number],
  deviceScaleFactor: number,
  competingColors: readonly (readonly [number, number, number])[] = [],
): Promise<Rect | null> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 3;
      // Include edge coverage, not just fully covered source-color pixels.
      // Skia anti-aliases a fractional/scaled box against the white fixture;
      // a strict RGB equality scan moves the observed edge inward by a whole
      // device pixel and makes a correct Blink physical quad look 1.5px late.
      const targetDistance = (data[offset] - rgb[0]) ** 2
        + (data[offset + 1] - rgb[1]) ** 2
        + (data[offset + 2] - rgb[2]) ** 2;
      const whiteDistance = (data[offset] - 255) ** 2
        + (data[offset + 1] - 255) ** 2
        + (data[offset + 2] - 255) ** 2;
      if (targetDistance > whiteDistance) continue;
      if (competingColors.some((candidate) => {
        const candidateDistance = (data[offset] - candidate[0]) ** 2
          + (data[offset + 1] - candidate[1]) ** 2
          + (data[offset + 2] - candidate[2]) ** 2;
        return candidateDistance < targetDistance;
      })) continue;
      mask[y * info.width + x] = 1;
    }
  }
  // A low-coverage edge from a differently colored affine box can be closer
  // to this target than to either white or that box's fully saturated source
  // color. Select the largest connected target component, not the union of
  // every qualifying pixel in the whole page.
  const visited = new Uint8Array(mask.length);
  let best: { count: number; minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] === 0 || visited[seed] !== 0) continue;
    const queue = [seed];
    visited[seed] = 1;
    let cursor = 0;
    let count = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    while (cursor < queue.length) {
      const index = queue[cursor++];
      const x = index % info.width;
      const y = Math.floor(index / info.width);
      count++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const next of [index - 1, index + 1, index - info.width, index + info.width]) {
        if (next < 0 || next >= mask.length || mask[next] === 0 || visited[next] !== 0) continue;
        const nextX = next % info.width;
        if (Math.abs(nextX - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    if (best == null || count > best.count) best = { count, minX, minY, maxX, maxY };
  }
  if (best == null) return null;
  return {
    x: best.minX / deviceScaleFactor,
    y: best.minY / deviceScaleFactor,
    width: (best.maxX - best.minX + 1) / deviceScaleFactor,
    height: (best.maxY - best.minY + 1) / deviceScaleFactor,
  };
}

function imageSvg(width: number, height: number, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function warningStrings(warnings: CaptureWarning[], prefixes: readonly string[]): string[] {
  return warnings
    .filter((warning) => prefixes.some((prefix) => warning.feature.startsWith(prefix)))
    .map((warning) => `${warning.selector}|${warning.feature}:${warning.detail}`);
}

interface ObjectCase {
  id: string;
  pairId: string;
  pairRole: string;
  fit: string;
  position: string;
  intrinsic: { width: number; height: number };
  width: number;
  height: number;
  zoom?: number;
  writingMode?: string;
  direction?: string;
  fractional?: boolean;
}

const OBJECT_CASES: readonly ObjectCase[] = [
  { id: "fill", pairId: "object.fit-mode", pairRole: "fill", fit: "fill", position: "50% 50%", intrinsic: { width: 80, height: 40 }, width: 200, height: 120 },
  { id: "contain", pairId: "object.fit-mode", pairRole: "contain", fit: "contain", position: "25% 75%", intrinsic: { width: 80, height: 40 }, width: 200, height: 120 },
  { id: "cover", pairId: "object.fit-mode", pairRole: "cover", fit: "cover", position: "calc(100% - 10px) calc(100% - 20px)", intrinsic: { width: 80, height: 40 }, width: 200, height: 120 },
  { id: "none", pairId: "object.fit-mode", pairRole: "none", fit: "none", position: "right 10px bottom 20px", intrinsic: { width: 80, height: 40 }, width: 200, height: 120 },
  { id: "scale-down-large", pairId: "object.fit-mode", pairRole: "scale-down-contain", fit: "scale-down", position: "30% 80%", intrinsic: { width: 320, height: 180 }, width: 200, height: 120 },
  { id: "intrinsic-landscape", pairId: "object.intrinsic-dimensions", pairRole: "landscape", fit: "contain", position: "50% 50%", intrinsic: { width: 160, height: 60 }, width: 200, height: 120 },
  { id: "intrinsic-portrait", pairId: "object.intrinsic-dimensions", pairRole: "portrait", fit: "contain", position: "50% 50%", intrinsic: { width: 60, height: 160 }, width: 200, height: 120 },
  { id: "zoom-1", pairId: "object.effective-zoom", pairRole: "1x", fit: "none", position: "50% 50%", intrinsic: { width: 80, height: 40 }, width: 200, height: 120, zoom: 1 },
  { id: "zoom-1_25", pairId: "object.effective-zoom", pairRole: "1.25x", fit: "none", position: "50% 50%", intrinsic: { width: 80, height: 40 }, width: 200, height: 120, zoom: 1.25 },
  { id: "vertical-rtl", pairId: "object.axis-position", pairRole: "vertical-rtl", fit: "contain", position: "right 13px bottom 9px", intrinsic: { width: 80, height: 40 }, width: 200, height: 120, writingMode: "vertical-rl", direction: "rtl" },
  { id: "fractional-calc", pairId: "object.axis-position", pairRole: "fractional-calc", fit: "none", position: "calc(37% + 4.25px) calc(63% - 2.5px)", intrinsic: { width: 91, height: 53 }, width: 201.5, height: 119.25, fractional: true },
];

async function objectGeometryRows(context: BrowserContext, dpr: number): Promise<ReplacedOwnershipTransitionRow[]> {
  const page = await context.newPage();
  const rows: ReplacedOwnershipTransitionRow[] = [];
  try {
    for (const test of OBJECT_CASES) {
      const src = imageSvg(test.intrinsic.width, test.intrinsic.height, "rgb(237,18,52)");
      const margin = test.fractional ? 30.25 : 30;
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;background:white}
        img{display:block;margin:${margin}px;width:${test.width}px;height:${test.height}px;
          object-fit:${test.fit};object-position:${test.position};zoom:${test.zoom ?? 1};
          writing-mode:${test.writingMode ?? "horizontal-tb"};direction:${test.direction ?? "ltr"}}
      </style><img src="${src}">`, { waitUntil: "load" });
      await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      const [png, browserFacts] = await Promise.all([
        page.screenshot({ type: "png" }),
        page.locator("img").evaluate((image: HTMLImageElement) => {
          const style = getComputedStyle(image);
          const rect = image.getBoundingClientRect();
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            fit: style.objectFit,
            position: style.objectPosition,
            effectiveZoom: Number.parseFloat(style.zoom) || 1,
            writingMode: style.writingMode,
            direction: style.direction,
          };
        }),
      ]);
      const sourcePixels = await colorRectFromPng(Buffer.from(png), [237, 18, 52], dpr);
      const concrete = computeObjectFitRect(
        browserFacts.rect.x,
        browserFacts.rect.y,
        browserFacts.rect.width,
        browserFacts.rect.height,
        browserFacts.naturalWidth * browserFacts.effectiveZoom,
        browserFacts.naturalHeight * browserFacts.effectiveZoom,
        browserFacts.fit,
        browserFacts.position,
      );
      const capturedGeometry = intersectRect(concrete, browserFacts.rect);
      const maxDevicePixelDelta = sourcePixels == null
        ? Number.POSITIVE_INFINITY
        : rectDelta(sourcePixels, capturedGeometry) * dpr;
      rows.push({
        id: `object.${test.id}`,
        family: "object-geometry",
        pairId: test.pairId,
        pairRole: test.pairRole,
        pairMode: "geometry-transition",
        expectedOwner: "vector-image",
        actualOwner: "vector-image",
        source: "Chromium LayoutReplaced::ComputeObjectFitAndPositionRect + LayoutImage::GetNaturalDimensions(EffectiveZoom)",
        facts: { ...browserFacts, sourcePixels, capturedGeometry },
        exactCapture: sourcePixels != null,
        maxDevicePixelDelta,
      });
    }
  } finally {
    await page.close();
  }
  return rows;
}

function actualControlOwner(element: CapturedElement): ReplacedOwnership {
  if (element.nativeControlRaster != null) return "whole-host-raster";
  if (element.nativeControlDecorationRaster != null) return "partial-decoration-raster";
  if ((element.pseudoFragments ?? []).some((record) => record.status === "exact")) return "generated-pseudo-vector";
  return "structural-vector";
}

function controlExact(element: CapturedElement, expected: ReplacedOwnership): boolean {
  if (expected === "whole-host-raster") {
    const raster = element.nativeControlRaster;
    return raster != null && (raster.dataUri != null || raster.empty === true);
  }
  if (expected === "partial-decoration-raster") {
    const raster = element.nativeControlDecorationRaster;
    return raster != null && (raster.dataUri != null || raster.empty === true);
  }
  if (expected === "generated-pseudo-vector") {
    return (element.pseudoFragments ?? []).some((record) => record.status === "exact");
  }
  return element.nativeControlRaster == null && typeof element.styles.effectiveAppearance === "string";
}

interface ControlCase {
  id: string;
  pairId: string;
  pairRole: string;
  pairMode: "ownership-transition" | "state-mutation";
  expectedOwner: ReplacedOwnership;
}

const CONTROL_CASES: readonly ControlCase[] = [
  { id: "checkbox-auto", pairId: "control.checkbox", pairRole: "native-auto", pairMode: "ownership-transition", expectedOwner: "whole-host-raster" },
  { id: "checkbox-none", pairId: "control.checkbox", pairRole: "appearance-none", pairMode: "ownership-transition", expectedOwner: "structural-vector" },
  { id: "checkbox-base", pairId: "control.checkbox", pairRole: "appearance-base", pairMode: "ownership-transition", expectedOwner: "generated-pseudo-vector" },
  { id: "radio-auto", pairId: "control.radio", pairRole: "native-auto", pairMode: "ownership-transition", expectedOwner: "whole-host-raster" },
  { id: "radio-none", pairId: "control.radio", pairRole: "appearance-none", pairMode: "ownership-transition", expectedOwner: "structural-vector" },
  { id: "button-auto", pairId: "control.button", pairRole: "native-auto", pairMode: "ownership-transition", expectedOwner: "whole-host-raster" },
  { id: "button-author", pairId: "control.button", pairRole: "author-background-border", pairMode: "ownership-transition", expectedOwner: "structural-vector" },
  { id: "select-auto", pairId: "control.select", pairRole: "native-auto", pairMode: "ownership-transition", expectedOwner: "whole-host-raster" },
  { id: "select-author", pairId: "control.select", pairRole: "menulist-button", pairMode: "ownership-transition", expectedOwner: "partial-decoration-raster" },
  { id: "progress-auto", pairId: "control.progress", pairRole: "native-auto", pairMode: "ownership-transition", expectedOwner: "whole-host-raster" },
  { id: "progress-author", pairId: "control.progress", pairRole: "author-track-value", pairMode: "ownership-transition", expectedOwner: "structural-vector" },
  { id: "meter-auto", pairId: "control.meter", pairRole: "native-auto", pairMode: "ownership-transition", expectedOwner: "whole-host-raster" },
  { id: "meter-author", pairId: "control.meter", pairRole: "author-bar-value", pairMode: "ownership-transition", expectedOwner: "structural-vector" },
  { id: "accent-red", pairId: "control.accent-color", pairRole: "red", pairMode: "state-mutation", expectedOwner: "whole-host-raster" },
  { id: "accent-blue", pairId: "control.accent-color", pairRole: "blue", pairMode: "state-mutation", expectedOwner: "whole-host-raster" },
  { id: "scheme-light", pairId: "control.color-scheme", pairRole: "light", pairMode: "state-mutation", expectedOwner: "whole-host-raster" },
  { id: "scheme-dark", pairId: "control.color-scheme", pairRole: "dark", pairMode: "state-mutation", expectedOwner: "whole-host-raster" },
  { id: "zoom-checkbox", pairId: "control.axis-zoom", pairRole: "zoom-1.25", pairMode: "state-mutation", expectedOwner: "whole-host-raster" },
  { id: "vertical-range", pairId: "control.axis-zoom", pairRole: "vertical-rl-rtl", pairMode: "state-mutation", expectedOwner: "whole-host-raster" },
];

function controlFixture(): string {
  return `<!doctype html><style>
    html,body{margin:0;background:white;color-scheme:light dark}
    #stage{display:grid;grid-template-columns:repeat(5,190px);gap:20px;padding:24px;font:16px Arial}
    input,button,select,progress,meter{min-height:28px;accent-color:rgb(191,31,58)}
    .check{width:28px;height:28px;margin:0}
    #checkbox-none,#radio-none{appearance:none;border:2px solid rgb(24,84,158);background:rgb(225,239,252)}
    #checkbox-base{appearance:base;color:rgb(191,31,58)}
    #checkbox-base::checkmark{content:"◆" / "";color:rgb(191,31,58)}
    #button-author{background:rgb(225,239,252);border:2px solid rgb(24,84,158);border-radius:7px}
    #select-author{background:rgb(225,239,252);border:2px solid rgb(24,84,158);width:170px}
    #progress-author,#meter-author{appearance:none;border:2px solid rgb(88,28,135);background:rgb(243,232,255);width:170px}
    #progress-author::-webkit-progress-bar{background:rgb(243,232,255)}
    #progress-author::-webkit-progress-value{background:rgb(126,34,206)}
    #meter-author::-webkit-meter-bar{background:rgb(243,232,255)}
    #meter-author::-webkit-meter-optimum-value{background:rgb(126,34,206)}
    #accent-red{accent-color:rgb(220,20,60)}#accent-blue{accent-color:rgb(20,80,220)}
    #scheme-light{color-scheme:light}#scheme-dark{color-scheme:dark}
    #zoom-checkbox{zoom:1.25;transform:translate(.25px,.5px)}
    #vertical-range{writing-mode:vertical-rl;direction:rtl;width:32px;height:120px}
  </style><main id="stage">
    <input data-domotion-anim="checkbox-auto" id="checkbox-auto" class="check" type="checkbox" checked>
    <input data-domotion-anim="checkbox-none" id="checkbox-none" class="check" type="checkbox" checked>
    <input data-domotion-anim="checkbox-base" id="checkbox-base" class="check" type="checkbox" checked>
    <input data-domotion-anim="radio-auto" id="radio-auto" class="check" type="radio" checked>
    <input data-domotion-anim="radio-none" id="radio-none" class="check" type="radio" checked>
    <button data-domotion-anim="button-auto" id="button-auto">Native</button>
    <button data-domotion-anim="button-author" id="button-author">Author</button>
    <select data-domotion-anim="select-auto" id="select-auto"><option>Native</option></select>
    <select data-domotion-anim="select-author" id="select-author"><option>Author</option></select>
    <progress data-domotion-anim="progress-auto" id="progress-auto" max="1" value=".42"></progress>
    <progress data-domotion-anim="progress-author" id="progress-author" max="1" value=".58"></progress>
    <meter data-domotion-anim="meter-auto" id="meter-auto" min="0" max="1" value=".42"></meter>
    <meter data-domotion-anim="meter-author" id="meter-author" min="0" max="1" value=".58"></meter>
    <input data-domotion-anim="accent-red" id="accent-red" class="check" type="checkbox" checked>
    <input data-domotion-anim="accent-blue" id="accent-blue" class="check" type="checkbox" checked>
    <input data-domotion-anim="scheme-light" id="scheme-light" class="check" type="checkbox">
    <input data-domotion-anim="scheme-dark" id="scheme-dark" class="check" type="checkbox">
    <input data-domotion-anim="zoom-checkbox" id="zoom-checkbox" class="check" type="checkbox" checked>
    <input data-domotion-anim="vertical-range" id="vertical-range" type="range" min="0" max="100" value="37">
  </main>`;
}

async function nativeControlRows(context: BrowserContext): Promise<ReplacedOwnershipTransitionRow[]> {
  const page = await context.newPage();
  try {
    await page.setContent(controlFixture(), { waitUntil: "load" });
    const captured = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, ...VIEWPORT });
    const rows = CONTROL_CASES.map((test): ReplacedOwnershipTransitionRow => {
      const element = byAnimId(captured.tree, test.id);
      const raster = element?.nativeControlRaster;
      const decoration = element?.nativeControlDecorationRaster;
      const relevantWarnings = captured.warnings.filter((warning) => {
        const requiredFeature = warning.feature === "native-control-raster"
          || warning.feature === "native-control-decoration-raster"
          || warning.feature === "effective-appearance-cascade"
          || (test.expectedOwner === "generated-pseudo-vector"
            && warning.feature === "generated-pseudo-fragment-geometry");
        if (!requiredFeature) return false;
        // Candidate-local warnings belong only to that source owner. A setup
        // failure has a document/root selector and therefore remains global.
        if (warning.feature === "generated-pseudo-fragment-geometry") {
          return warning.selector.includes(`#${test.id}`);
        }
        return !warning.selector.includes("#") || warning.selector.includes(`#${test.id}`);
      }).map((warning) => `${warning.selector}|${warning.feature}:${warning.detail}`);
      return {
        id: `control.${test.id}`,
        family: "native-control",
        pairId: test.pairId,
        pairRole: test.pairRole,
        pairMode: test.pairMode,
        expectedOwner: test.expectedOwner,
        actualOwner: element == null ? "unpainted" : actualControlOwner(element),
        source: "Chromium LayoutTheme::AdjustAppearanceWithAuthorStyle + ThemePainter EffectiveAppearance dispatch",
        facts: element == null ? { missing: true } : {
          inputAppearance: element.styles.inputAppearance,
          effectiveAppearance: element.styles.effectiveAppearance,
          writingMode: element.styles.writingMode,
          direction: element.styles.direction,
          transform: element.styles.transform,
          rasterSha256: raster?.dataUri == null ? null : sha256(raster.dataUri),
          rasterEmpty: raster?.empty === true,
          decorationKinds: decoration?.kinds ?? [],
          decorationSha256: decoration?.dataUri == null ? null : sha256(decoration.dataUri),
          pseudoStatuses: (element.pseudoFragments ?? []).map((record) => `${record.pseudo}:${record.status}`),
        },
        exactCapture: element != null && controlExact(element, test.expectedOwner),
        unexpectedWarnings: relevantWarnings,
      };
    });
    const digest = (id: string): unknown => rows.find((row) => row.id === `control.${id}`)?.facts.rasterSha256;
    const markMutation = (id: string, different: boolean): void => {
      const row = rows.find((candidate) => candidate.id === `control.${id}`);
      if (row != null) {
        row.mutationRequired = true;
        row.mutationDiscriminated = different;
      }
    };
    markMutation("accent-blue", digest("accent-red") != null && digest("accent-red") !== digest("accent-blue"));
    markMutation("scheme-dark", digest("scheme-light") != null && digest("scheme-light") !== digest("scheme-dark"));
    markMutation("vertical-range", digest("zoom-checkbox") != null && digest("zoom-checkbox") !== digest("vertical-range"));
    return rows;
  } finally {
    await page.close();
  }
}

async function imageDecodingRows(context: BrowserContext): Promise<ReplacedOwnershipTransitionRow[]> {
  const page = await context.newPage();
  const pendingUrl = "https://dm2364.invalid/pending-image.png";
  let pendingRoute: Route | null = null;
  let routeSeenResolve: (() => void) | undefined;
  const routeSeen = new Promise<void>((resolve) => { routeSeenResolve = resolve; });
  let releaseRoute: (() => void) | undefined;
  const routeHold = new Promise<void>((resolve) => { releaseRoute = resolve; });
  await page.route(pendingUrl, async (route) => {
    pendingRoute = route;
    routeSeenResolve?.();
    await routeHold;
    await route.abort().catch(() => undefined);
  });
  try {
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:white}#stage{padding:24px;display:flex;gap:18px}img{width:120px;height:80px;border:1px solid #555}</style>
      <main id="stage">
        <img data-domotion-anim="decode-loaded" id="decode-loaded" alt="loaded" src="${imageSvg(80, 40, "rgb(237,18,52)")}">
        <img data-domotion-anim="decode-failed" id="decode-failed" alt="failed" src="data:image/png;base64,not-a-png">
        <img data-domotion-anim="decode-loading" id="decode-loading" alt="loading">
      </main>`, { waitUntil: "load" });
    await page.evaluate((src) => {
      (document.querySelector("#decode-loading") as HTMLImageElement).src = src;
    }, pendingUrl);
    await Promise.race([
      routeSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pending image request was not observed")), 5_000)),
    ]);
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#decode-loading");
      return image != null && image.complete === false;
    });
    const captured = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, ...VIEWPORT });
    const relevantWarnings = warningStrings(captured.warnings, ["broken-image"]);
    const cases = [
      { id: "decode-loaded", role: "loaded", expectedOwner: "vector-image" as const, loadState: "loaded" },
      { id: "decode-loading", role: "loading", expectedOwner: "broken-image-hybrid" as const, loadState: "loading" },
      { id: "decode-failed", role: "failed", expectedOwner: "broken-image-hybrid" as const, loadState: "failed" },
    ];
    return cases.map((test): ReplacedOwnershipTransitionRow => {
      const element = byAnimId(captured.tree, test.id);
      const record = element?.brokenImageFallback;
      const actualOwner: ReplacedOwnership = record?.paintOwnership === "hybrid-icon-raster-vector-text"
        ? "broken-image-hybrid"
        : record?.paintOwnership === "none"
          ? record.loadState === "loaded" ? "vector-image" : "unpainted"
          : "unpainted";
      return {
        id: `image.${test.role}`,
        family: "image-decoding",
        pairId: "image.decode-state",
        pairRole: test.role,
        pairMode: "ownership-transition",
        expectedOwner: test.expectedOwner,
        actualOwner,
        source: "Chromium ImageLoader state + LayoutImage broken-image UA-shadow paint ownership",
        facts: record == null ? { missing: true } : {
          loadState: record.loadState,
          disposition: record.disposition,
          captureStatus: record.captureStatus,
          paintOwnership: record.paintOwnership,
          complete: record.source.complete,
          naturalWidth: record.source.naturalWidth,
          naturalHeight: record.source.naturalHeight,
        },
        exactCapture: record?.captureStatus === "exact" && record.loadState === test.loadState,
        unexpectedWarnings: relevantWarnings,
      };
    });
  } finally {
    releaseRoute?.();
    if (pendingRoute != null) await pendingRoute.abort().catch(() => undefined);
    await page.unroute(pendingUrl).catch(() => undefined);
    await page.close();
  }
}

function snapshotFacts(element: CapturedElement | undefined): Record<string, unknown> {
  const snapshot = element?.replacedSnapshot;
  return snapshot == null ? { missing: true } : {
    x: snapshot.x,
    y: snapshot.y,
    width: snapshot.width,
    height: snapshot.height,
    pngSha256: snapshot.dataUri == null ? null : sha256(snapshot.dataUri),
    rasterToOutput: snapshot.rasterToOutput,
    transform: element?.styles.transform,
    writingMode: element?.styles.writingMode,
  };
}

async function dynamicSurfaceRows(context: BrowserContext): Promise<ReplacedOwnershipTransitionRow[]> {
  const page = await context.newPage();
  try {
    const posterA = imageSvg(96, 64, "rgb(220,40,70)");
    const posterB = imageSvg(96, 64, "rgb(20,90,220)");
    await page.setContent(`<!doctype html><style>
      html,body{margin:0;background:white}#stage{padding:36px;writing-mode:vertical-rl}
      #nest{transform:matrix(1,0.08,-0.06,1,7.25,5.5);transform-origin:0 0;zoom:1.1;display:flex;gap:24px}
      canvas,video{display:block;width:96px;height:64px;border:3px solid rgb(30,30,30)}
    </style><main id="stage"><div id="nest">
      <canvas data-domotion-anim="surface-canvas" id="surface-canvas" width="96" height="64"></canvas>
      <video data-domotion-anim="surface-video" id="surface-video" width="96" height="64" poster="${posterA}"></video>
    </div></main>`, { waitUntil: "load" });
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#surface-canvas")!;
      const context2d = canvas.getContext("2d")!;
      context2d.fillStyle = "rgb(220,40,70)";
      context2d.fillRect(0, 0, canvas.width, canvas.height);
    });
    const first = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, ...VIEWPORT });
    await page.evaluate((nextPoster) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#surface-canvas")!;
      const context2d = canvas.getContext("2d")!;
      context2d.fillStyle = "rgb(20,90,220)";
      context2d.fillRect(0, 0, canvas.width, canvas.height);
      document.querySelector<HTMLVideoElement>("#surface-video")!.poster = nextPoster;
      return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, posterB);
    const second = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, ...VIEWPORT });
    const rows: ReplacedOwnershipTransitionRow[] = [];
    for (const [id, pairId] of [["surface-canvas", "surface.canvas-frame"], ["surface-video", "surface.video-frame"]] as const) {
      const firstElement = byAnimId(first.tree, id);
      const secondElement = byAnimId(second.tree, id);
      const firstFacts = snapshotFacts(firstElement);
      const secondFacts = snapshotFacts(secondElement);
      const changed = firstFacts.pngSha256 != null && firstFacts.pngSha256 !== secondFacts.pngSha256;
      for (const [role, element, facts] of [["frame-a", firstElement, firstFacts], ["frame-b", secondElement, secondFacts]] as const) {
        const snapshot = element?.replacedSnapshot;
        rows.push({
          id: `${pairId}.${role}`,
          family: "dynamic-surface",
          pairId,
          pairRole: role,
          pairMode: "state-mutation",
          expectedOwner: "replaced-snapshot",
          actualOwner: snapshot == null ? "unpainted" : "replaced-snapshot",
          source: "Chromium ReplacedPainter source-frame surface + DOM.getBoxModel content quad",
          facts,
          exactCapture: snapshot?.dataUri != null && snapshot.rasterToOutput != null,
          mutationRequired: role === "frame-b",
          mutationDiscriminated: role === "frame-b" ? changed : undefined,
        });
      }
    }
    return rows;
  } finally {
    await page.close();
  }
}

interface GeneratedCase {
  id: string;
  pseudo: "::before" | "::after";
  color: readonly [number, number, number];
  role: string;
}

const GENERATED_CASES: readonly GeneratedCase[] = [
  { id: "generated-before", pseudo: "::before", color: [201, 17, 73], role: "positioned-before" },
  { id: "generated-after", pseudo: "::after", color: [13, 126, 143], role: "positioned-after" },
  { id: "generated-flow", pseudo: "::before", color: [113, 45, 183], role: "in-flow-before" },
  { id: "generated-vertical", pseudo: "::after", color: [213, 89, 20], role: "vertical-rtl-after" },
  { id: "generated-transform", pseudo: "::before", color: [22, 122, 67], role: "nested-affine-before" },
];

async function generatedBoxRows(context: BrowserContext, dpr: number): Promise<ReplacedOwnershipTransitionRow[]> {
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><style>
      html,body{margin:0;background:white}#stage{position:relative;width:900px;height:600px;background:white}
      article,aside,section,nav,figure{position:absolute;margin:0;background:transparent}
      article{left:30px;top:30px;width:180px;height:100px}article::before{content:"";position:absolute;left:17px;top:23px;width:41px;height:29px;background:rgb(201,17,73)}
      aside{left:250px;top:35px;width:180px;height:100px}aside::after{content:"";position:absolute;right:21px;bottom:14px;width:37px;height:31px;background:rgb(13,126,143)}
      section{left:30px;top:190px;width:180px;height:100px}section::before{content:"";display:block;width:63px;height:27px;background:rgb(113,45,183)}
      nav{left:250px;top:180px;width:120px;height:180px;writing-mode:vertical-rl;direction:rtl}nav::after{content:"";position:absolute;inset-inline-start:19px;inset-block-start:23px;width:32px;height:47px;background:rgb(213,89,20)}
      #affine{position:absolute;left:520px;top:80px;transform:matrix(1.1,0,0,.9,7.25,5.5);transform-origin:0 0}
      figure{position:relative;width:180px;height:120px}figure::before{content:"";position:absolute;left:29px;top:31px;width:53px;height:35px;background:rgb(22,122,67)}
    </style><main id="stage">
      <article data-domotion-anim="generated-before"></article>
      <aside data-domotion-anim="generated-after"></aside>
      <section data-domotion-anim="generated-flow"></section>
      <nav data-domotion-anim="generated-vertical"></nav>
      <div id="affine"><figure data-domotion-anim="generated-transform"></figure></div>
    </main>`, { waitUntil: "load" });
    const sourcePng = Buffer.from(await page.screenshot({ type: "png" }));
    const sourceRects = new Map<string, Rect | null>();
    const palette = GENERATED_CASES.map((test) => test.color);
    for (const test of GENERATED_CASES) {
      sourceRects.set(test.id, await colorRectFromPng(
        sourcePng,
        test.color,
        dpr,
        palette.filter((color) => color !== test.color),
      ));
    }
    const captured = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, ...VIEWPORT });
    const relevantWarnings = warningStrings(captured.warnings, ["generated-pseudo-fragment-geometry"]);
    return GENERATED_CASES.map((test): ReplacedOwnershipTransitionRow => {
      const element = byAnimId(captured.tree, test.id);
      const record = element?.pseudoFragments?.find((candidate) => candidate.pseudo === test.pseudo);
      const capturedRect = record == null ? null : unionRects(record.boxFragments.map((fragment) => fragment.physicalRect));
      const sourceRect = sourceRects.get(test.id) ?? null;
      const maxDevicePixelDelta = sourceRect == null || capturedRect == null
        ? Number.POSITIVE_INFINITY
        : rectDelta(sourceRect, capturedRect) * dpr;
      return {
        id: `generated.${test.role}`,
        family: "generated-box",
        pairId: "generated.placement",
        pairRole: test.role,
        pairMode: "geometry-transition",
        expectedOwner: "generated-pseudo-vector",
        actualOwner: record == null ? "unpainted" : "generated-pseudo-vector",
        source: "Chromium DOMSnapshot generated layout + DOM.getContentQuads physical pseudo fragments",
        facts: record == null ? { missing: true, sourceRect } : {
          pseudo: record.pseudo,
          status: record.status,
          writingMode: record.writingMode,
          direction: record.direction,
          boxFragments: record.boxFragments,
          sourceRect,
          capturedRect,
        },
        exactCapture: record?.status === "exact" && sourceRect != null && capturedRect != null,
        maxDevicePixelDelta,
        unexpectedWarnings: relevantWarnings,
      };
    });
  } finally {
    await page.close();
  }
}

async function runWithBrowser(browser: Browser, deviceScaleFactor: number): Promise<ReplacedOwnershipRunReport> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor,
    colorScheme: "light",
    forcedColors: "none",
  });
  try {
    const rows = [
      ...await objectGeometryRows(context, deviceScaleFactor),
      ...await nativeControlRows(context),
      ...await imageDecodingRows(context),
      ...await dynamicSurfaceRows(context),
      ...await generatedBoxRows(context, deviceScaleFactor),
    ];
    const fingerprint = canonicalFingerprint(browser, deviceScaleFactor);
    const adjudication = adjudicateReplacedOwnershipTransitions(rows, fingerprint, REPLACED_OWNERSHIP_REQUIREMENTS);
    return {
      schemaVersion: 2,
      sourceRevisions: SOURCE_REVISIONS,
      fingerprint,
      rows,
      requirements: REPLACED_OWNERSHIP_REQUIREMENTS,
      adjudication,
      verdict: adjudication.pass ? "source-exact" : "source-drift",
    };
  } finally {
    await context.close();
  }
}

export async function runReplacedOwnershipTransitionOracle(deviceScaleFactor = 1): Promise<ReplacedOwnershipRunReport> {
  const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] });
  try {
    return await runWithBrowser(browser, deviceScaleFactor);
  } finally {
    await browser.close();
  }
}

export async function runReplacedOwnershipGate(
  deviceScaleFactors: number[] = [1, 2],
): Promise<ReplacedOwnershipGateReport> {
  const normalized = [...new Set(deviceScaleFactors)].sort((a, b) => a - b);
  const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] });
  try {
    const runs: ReplacedOwnershipRunReport[] = [];
    for (const dpr of normalized) runs.push(await runWithBrowser(browser, dpr));
    return {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      requiredDeviceScaleFactors: normalized,
      runs,
      verdict: runs.every((run) => run.adjudication.pass) ? "source-exact" : "source-drift",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const dprIndex = process.argv.indexOf("--dpr");
  const dprs = dprIndex >= 0 && process.argv[dprIndex + 1] != null
    ? process.argv[dprIndex + 1].split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [1];
  const report = await runReplacedOwnershipGate(dprs);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const run of report.runs) {
    console.log(`replaced ownership oracle DPR${run.fingerprint.deviceScaleFactor}: ${run.adjudication.passedRows}/${run.adjudication.totalRows}`);
    for (const error of run.adjudication.errors) console.log(`FAIL DPR${run.fingerprint.deviceScaleFactor} ${error}`);
  }
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
