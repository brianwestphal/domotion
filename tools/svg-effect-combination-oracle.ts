#!/usr/bin/env tsx
/** Live capture→SVG oracle for the generated DM-2358 effect corpus. */
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import type { CapturedElement } from "../src/capture/types.js";
import {
  SVG_EFFECT_CASES,
  SVG_EFFECT_SOURCE_DECISIONS,
  SVG_EFFECT_SOURCE_REVISION,
  SVG_EFFECT_TILE,
  SVG_EFFECT_VIEWPORT,
  buildSvgEffectCombinationHtml,
  svgEffectPairCoverage,
  validateSvgEffectCombinationCorpus,
} from "./svg-effect-combination-corpus.js";

const require = createRequire(import.meta.url);
const playwrightVersion = (require("@playwright/test/package.json") as { version: string }).version;

export const SVG_EFFECT_PIXEL_THRESHOLDS = {
  maxMeanAbsoluteChannelError: 2,
  maxChangedPixelFraction: 0.04,
  maxInkBoundsDeltaDevicePx: 2,
  changedPixelChannelThreshold: 16,
  minimumMutationChangedPixelsAtDpr1: 40,
} as const;

interface PixelBounds { left: number; top: number; right: number; bottom: number; pixels: number }

export interface SvgEffectPixelResult {
  meanAbsoluteChannelError: number;
  changedPixelFraction: number;
  maxChannelDelta: number;
  sourceInkBounds: PixelBounds | null;
  generatedInkBounds: PixelBounds | null;
  maxInkBoundsDeltaDevicePx: number | null;
  pass: boolean;
}

export interface SvgEffectOracleRow {
  id: string;
  deviceScaleFactor: number;
  structuralErrors: string[];
  pixels: SvgEffectPixelResult;
  pass: boolean;
}

export interface SvgEffectMutationResult {
  id: "strip-marker-properties" | "strip-vector-effect" | "strip-color-interpolation";
  deviceScaleFactor: number;
  changedPixels: number;
  maxChannelDelta: number;
  moved: boolean;
}

export interface SvgEffectCombinationReport {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevision: string;
  sourceDecisions: typeof SVG_EFFECT_SOURCE_DECISIONS;
  fingerprint: {
    chromiumVersion: string;
    playwrightVersion: string;
    userAgent: string;
    os: string;
    osRelease: string;
    architecture: string;
    node: string;
    viewport: typeof SVG_EFFECT_VIEWPORT;
    deviceScaleFactors: number[];
    thresholds: typeof SVG_EFFECT_PIXEL_THRESHOLDS;
  };
  corpus: {
    cases: number;
    expectedPairs: number;
    coveredPairs: number;
  };
  grammar: {
    bareUrlSupported: boolean;
    urlPlusGeometryBoxRejected: boolean;
  };
  rows: SvgEffectOracleRow[];
  mutations: SvgEffectMutationResult[];
  structuralErrors: string[];
  verdict: "source-exact-native-svg-delegation" | "svg-effect-combination-drift";
}

interface DecodedRgb { data: Buffer; width: number; height: number; channels: number }

async function decodeRgb(png: Buffer): Promise<DecodedRgb> {
  const { data, info } = await sharp(png).flatten({ background: "#fff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function tileBounds(image: DecodedRgb, ordinal: number, dpr: number): PixelBounds | null {
  const x0 = (ordinal % SVG_EFFECT_TILE.columns) * SVG_EFFECT_TILE.width * dpr;
  const y0 = Math.floor(ordinal / SVG_EFFECT_TILE.columns) * SVG_EFFECT_TILE.height * dpr;
  const width = SVG_EFFECT_TILE.width * dpr;
  const height = SVG_EFFECT_TILE.height * dpr;
  let left = x0 + width;
  let top = y0 + height;
  let right = -1;
  let bottom = -1;
  let pixels = 0;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const offset = (y * image.width + x) * image.channels;
      const distanceFromWhite = 765 - image.data[offset] - image.data[offset + 1] - image.data[offset + 2];
      if (distanceFromWhite <= 30) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      pixels++;
    }
  }
  return pixels === 0 ? null : { left, top, right, bottom, pixels };
}

function maxBoundsDelta(left: PixelBounds | null, right: PixelBounds | null): number | null {
  if (left == null || right == null) return null;
  return Math.max(
    Math.abs(left.left - right.left),
    Math.abs(left.top - right.top),
    Math.abs(left.right - right.right),
    Math.abs(left.bottom - right.bottom),
  );
}

function compareTile(source: DecodedRgb, generated: DecodedRgb, ordinal: number, dpr: number): SvgEffectPixelResult {
  const x0 = (ordinal % SVG_EFFECT_TILE.columns) * SVG_EFFECT_TILE.width * dpr;
  const y0 = Math.floor(ordinal / SVG_EFFECT_TILE.columns) * SVG_EFFECT_TILE.height * dpr;
  const width = SVG_EFFECT_TILE.width * dpr;
  const height = SVG_EFFECT_TILE.height * dpr;
  let sum = 0;
  let values = 0;
  let changed = 0;
  let maxChannelDelta = 0;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const sourceOffset = (y * source.width + x) * source.channels;
      const generatedOffset = (y * generated.width + x) * generated.channels;
      let pixelMax = 0;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(source.data[sourceOffset + channel] - generated.data[generatedOffset + channel]);
        sum += delta;
        values++;
        pixelMax = Math.max(pixelMax, delta);
        maxChannelDelta = Math.max(maxChannelDelta, delta);
      }
      if (pixelMax > SVG_EFFECT_PIXEL_THRESHOLDS.changedPixelChannelThreshold) changed++;
    }
  }
  const sourceInkBounds = tileBounds(source, ordinal, dpr);
  const generatedInkBounds = tileBounds(generated, ordinal, dpr);
  const maxInkBoundsDeltaDevicePx = maxBoundsDelta(sourceInkBounds, generatedInkBounds);
  const meanAbsoluteChannelError = values === 0 ? Infinity : sum / values;
  const changedPixelFraction = changed / (width * height);
  const pass = sourceInkBounds != null
    && generatedInkBounds != null
    && maxInkBoundsDeltaDevicePx != null
    && maxInkBoundsDeltaDevicePx <= SVG_EFFECT_PIXEL_THRESHOLDS.maxInkBoundsDeltaDevicePx
    && meanAbsoluteChannelError <= SVG_EFFECT_PIXEL_THRESHOLDS.maxMeanAbsoluteChannelError
    && changedPixelFraction <= SVG_EFFECT_PIXEL_THRESHOLDS.maxChangedPixelFraction;
  return { meanAbsoluteChannelError, changedPixelFraction, maxChannelDelta, sourceInkBounds, generatedInkBounds, maxInkBoundsDeltaDevicePx, pass };
}

function walk(nodes: readonly CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function capturedSvgByCase(nodes: readonly CapturedElement[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const element of walk(nodes)) {
    if (element.svgContent == null) continue;
    const match = /\bdata-effect-case="([^"]+)"/.exec(element.svgContent);
    if (match != null) result.set(match[1], element.svgContent);
  }
  return result;
}

function caseStructuralErrors(id: string, markup: string | undefined): string[] {
  if (markup == null) return ["captured inline SVG owner missing"];
  const test = SVG_EFFECT_CASES.find((candidate) => candidate.id === id)!;
  const errors: string[] = [];
  const required = [
    `gradientUnits="${test.values.gradientUnits}"`,
    `clipPathUnits="${test.values.clipPathUnits}"`,
    `maskUnits="${test.values.maskUnits}"`,
    `maskContentUnits="${test.values.maskContentUnits}"`,
    `vector-effect: ${test.values.vectorEffect}`,
    `color-interpolation: ${test.values.gradientInterpolation.toLowerCase()}`,
  ];
  for (const fragment of required) if (!markup.includes(fragment)) errors.push(`missing ${fragment}`);
  if (test.values.viewport === "nested" && (markup.match(/<svg\b/g) ?? []).length < 2) errors.push("nested viewport missing");
  if (test.values.markers === "all") {
    // CSSOM coalesces three identical longhands to the `marker` shorthand.
    // A mixed declaration remains serialized as individual longhands.
    const shorthand = new RegExp(`marker: url\\((?:&quot;)?#marker-${test.ordinal}(?:&quot;)?\\)`).test(markup);
    for (const prop of ["marker-start", "marker-mid", "marker-end"]) {
      if (!shorthand && !new RegExp(`${prop}: url\\((?:&quot;)?#marker-${test.ordinal}(?:&quot;)?\\)`).test(markup)) errors.push(`${prop} resource missing`);
    }
  }
  if (test.values.clipRoute === "url" && !new RegExp(`clip-path: url\\((?:&quot;)?#clip-${test.ordinal}(?:&quot;)?\\)`).test(markup)) errors.push("URL clip resource missing");
  if (test.values.clipRoute !== "url" && !markup.includes(`${test.values.referenceBox}`)) errors.push("basic-shape reference box missing");
  return errors;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function mutationScreenshot(page: Page, svg: string, properties: readonly string[]): Promise<Buffer> {
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}svg{display:block}</style>${svg}`, { waitUntil: "load" });
  await page.evaluate((names) => {
    for (const element of document.querySelectorAll<HTMLElement | SVGElement>("[style]")) {
      for (const name of names) element.style.removeProperty(name);
    }
  }, properties);
  await settle(page);
  return page.screenshot({ type: "png" });
}

function mutationDelta(baseline: DecodedRgb, mutation: DecodedRgb, id: SvgEffectMutationResult["id"], dpr: number): SvgEffectMutationResult {
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel++) {
    let pixelMax = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(baseline.data[pixel * baseline.channels + channel] - mutation.data[pixel * mutation.channels + channel]);
      pixelMax = Math.max(pixelMax, delta);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelMax > SVG_EFFECT_PIXEL_THRESHOLDS.changedPixelChannelThreshold) changedPixels++;
  }
  const moved = changedPixels >= SVG_EFFECT_PIXEL_THRESHOLDS.minimumMutationChangedPixelsAtDpr1 * dpr * dpr && maxChannelDelta > 32;
  return { id, deviceScaleFactor: dpr, changedPixels, maxChannelDelta, moved };
}

export async function runSvgEffectCombinationOracle(options: { deviceScaleFactors?: number[] } = {}): Promise<SvgEffectCombinationReport> {
  const corpusErrors = validateSvgEffectCombinationCorpus();
  if (corpusErrors.length > 0) throw new Error(`invalid SVG effect corpus: ${corpusErrors.join("; ")}`);
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const capture = await import("../src/capture/index.js");
  const render = await import("../src/render/element-tree-to-svg.js");
  const dprs = options.deviceScaleFactors ?? [1, 2];
  const browser = await chromium.launch({ headless: true });
  const rows: SvgEffectOracleRow[] = [];
  const mutations: SvgEffectMutationResult[] = [];
  const structuralErrors: string[] = [];
  try {
    const fingerprintPage = await browser.newPage({ viewport: SVG_EFFECT_VIEWPORT });
    const userAgent = await fingerprintPage.evaluate(() => navigator.userAgent);
    await fingerprintPage.close();
    let grammar = { bareUrlSupported: false, urlPlusGeometryBoxRejected: false };

    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: SVG_EFFECT_VIEWPORT, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const output = await context.newPage();
      try {
        await source.setContent(buildSvgEffectCombinationHtml(), { waitUntil: "load" });
        await settle(source);
        if (dpr === dprs[0]) {
          grammar = await source.evaluate(() => ({
            bareUrlSupported: CSS.supports("clip-path", "url(#clip-0)"),
            urlPlusGeometryBoxRejected: ["fill-box", "stroke-box", "view-box"].every((box) =>
              !CSS.supports("clip-path", `url(#clip-0) ${box}`)
              && !CSS.supports("clip-path", `${box} url(#clip-0)`)),
          }));
        }
        const sourcePng = await source.screenshot({ type: "png" });
        const captured = await capture.captureElementTreeWithWarnings(source, "#stage", { x: 0, y: 0, ...SVG_EFFECT_VIEWPORT });
        const capturedByCase = capturedSvgByCase(captured.tree);
        if (capturedByCase.size !== SVG_EFFECT_CASES.length) structuralErrors.push(`dpr${dpr}: expected ${SVG_EFFECT_CASES.length} inline SVG owners, received ${capturedByCase.size}`);
        const rasterOwners = walk(captured.tree).filter((element) => element.elementRaster != null || element.transformSubtreeRaster != null);
        if (rasterOwners.length > 0) structuralErrors.push(`dpr${dpr}: ${rasterOwners.length} raster owners replaced native SVG`);
        const warnings = captured.warnings.map((warning) => typeof warning === "string" ? warning : JSON.stringify(warning));
        const effectWarnings = warnings.filter((warning) => /inline-svg|gradient|clip|mask|marker|vector-effect/i.test(warning));
        if (effectWarnings.length > 0) structuralErrors.push(`dpr${dpr}: relevant warnings: ${effectWarnings.join(" | ")}`);

        const svg = render.elementTreeToSvg(captured.tree, SVG_EFFECT_VIEWPORT.width, SVG_EFFECT_VIEWPORT.height, { hiDPIFactor: dpr });
        if (/<image\b/.test(svg)) structuralErrors.push(`dpr${dpr}: generated SVG contains an image owner`);
        await output.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}svg{display:block}</style>${svg}`, { waitUntil: "load" });
        await settle(output);
        const generatedPng = await output.screenshot({ type: "png" });
        const [sourcePixels, generatedPixels] = await Promise.all([decodeRgb(sourcePng), decodeRgb(generatedPng)]);
        if (sourcePixels.width !== generatedPixels.width || sourcePixels.height !== generatedPixels.height) {
          throw new Error(`pixel dimensions differ at DPR ${dpr}`);
        }
        for (const test of SVG_EFFECT_CASES) {
          const rowErrors = caseStructuralErrors(test.id, capturedByCase.get(test.id));
          const pixels = compareTile(sourcePixels, generatedPixels, test.ordinal, dpr);
          rows.push({ id: test.id, deviceScaleFactor: dpr, structuralErrors: rowErrors, pixels, pass: rowErrors.length === 0 && pixels.pass });
        }

        for (const mutation of [
          { id: "strip-marker-properties" as const, properties: ["marker-start", "marker-mid", "marker-end"] },
          { id: "strip-vector-effect" as const, properties: ["vector-effect"] },
          { id: "strip-color-interpolation" as const, properties: ["color-interpolation"] },
        ]) {
          const mutationPng = await mutationScreenshot(output, svg, mutation.properties);
          mutations.push(mutationDelta(generatedPixels, await decodeRgb(mutationPng), mutation.id, dpr));
        }
      } finally {
        await context.close();
      }
    }

    if (!grammar.bareUrlSupported) structuralErrors.push("Chromium rejected the bare URL clip control");
    if (!grammar.urlPlusGeometryBoxRejected) structuralErrors.push("Chromium accepted a URL-plus-geometry-box negative control");
    const coverage = svgEffectPairCoverage(SVG_EFFECT_CASES);
    const pass = structuralErrors.length === 0 && rows.every((row) => row.pass) && mutations.every((mutation) => mutation.moved);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRevision: SVG_EFFECT_SOURCE_REVISION,
      sourceDecisions: SVG_EFFECT_SOURCE_DECISIONS,
      fingerprint: {
        chromiumVersion: browser.version(),
        playwrightVersion,
        userAgent,
        os: platform(),
        osRelease: release(),
        architecture: arch(),
        node: process.version,
        viewport: SVG_EFFECT_VIEWPORT,
        deviceScaleFactors: dprs,
        thresholds: SVG_EFFECT_PIXEL_THRESHOLDS,
      },
      corpus: { cases: SVG_EFFECT_CASES.length, expectedPairs: coverage.expectedPairs, coveredPairs: coverage.coveredPairs },
      grammar,
      rows,
      mutations,
      structuralErrors,
      verdict: pass ? "source-exact-native-svg-delegation" : "svg-effect-combination-drift",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const dprIndex = process.argv.indexOf("--dpr");
  const deviceScaleFactors = dprIndex >= 0 && process.argv[dprIndex + 1] != null
    ? process.argv[dprIndex + 1].split(",").map(Number)
    : [1, 2];
  const report = await runSvgEffectCombinationOracle({ deviceScaleFactors });
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    const output = resolve(process.argv[jsonIndex + 1]);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  const passed = report.rows.filter((row) => row.pass).length;
  console.log(`SVG effect combinations: ${passed}/${report.rows.length} rows; ${report.corpus.coveredPairs}/${report.corpus.expectedPairs} pairs; ${report.verdict}`);
  for (const row of report.rows.filter((candidate) => !candidate.pass)) {
    console.log(`FAIL dpr=${row.deviceScaleFactor} ${row.id}: structural=${row.structuralErrors.join(" | ") || "none"}; mean=${row.pixels.meanAbsoluteChannelError.toFixed(3)}; changed=${(row.pixels.changedPixelFraction * 100).toFixed(3)}%; bounds=${row.pixels.maxInkBoundsDeltaDevicePx}`);
  }
  for (const mutation of report.mutations) console.log(`${mutation.moved ? "PASS" : "FAIL"} dpr=${mutation.deviceScaleFactor} ${mutation.id}: changed=${mutation.changedPixels}, max=${mutation.maxChannelDelta}`);
  for (const error of report.structuralErrors) console.log(`FAIL structural: ${error}`);
  return report.verdict === "source-exact-native-svg-delegation" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
