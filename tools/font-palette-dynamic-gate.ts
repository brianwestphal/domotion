#!/usr/bin/env tsx
/**
 * Source-owned palette-mix / animation / shadow-scope extension to the static
 * COLRv0/COLRv1 font-palette gate. Browser launch is always headless.
 */

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";

import {
  attachWebfontTracker,
  captureElementTreeWithWarnings,
  discoverAndRegisterWebfonts,
} from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import {
  clearGlyphDefs,
  clearWebfonts,
  selectedGlyphRasterSpans,
} from "../src/render/text-to-path.js";
import {
  FONT_PALETTE_FIXTURE,
  FONT_PALETTE_SOURCE_PINS,
  readPaletteSourceFacts,
  type PaletteSourceFacts,
} from "./font-palette-ownership-audit.js";
import type { Colrv1SourceFacts } from "./font-palette-paint-gate.js";

type Dpr = 1 | 2;
type RgbaTuple = [number, number, number, number];
const V0_FAMILY = "DomotionPaletteDynamicV0";
const V1_FAMILY = "DomotionPaletteDynamicV1";
const V0_GLYPH = "A";
const V1_GLYPH = String.fromCodePoint(0xf0100);

export const FONT_PALETTE_DYNAMIC_SOURCE_PINS = {
  chromium: FONT_PALETTE_SOURCE_PINS.chromium,
  skia: FONT_PALETTE_SOURCE_PINS.skia,
  animation: "third_party/blink/renderer/core/animation/interpolable_font_palette.cc:51-82",
  mixNormalization: "third_party/blink/renderer/core/css/css_color_mix_value.cc:14-53",
  mixIdentity: "third_party/blink/renderer/platform/fonts/font_palette.cc:14-43,90-107",
  selectorResolution: "third_party/blink/renderer/core/css/css_font_selector.cc:50-108,166-190",
  mixPaint: "third_party/blink/renderer/platform/fonts/palette_interpolation.cc:12-123",
  skiaArguments: "include/core/SkFontArguments.h:34-54,87-94",
  shadowScope: "third_party/blink/renderer/core/css/style_engine.cc:3159-3167",
} as const;

export type DynamicV0CaseId =
  | "mix-srgb-30"
  | "animation-oklab-30"
  | "animation-oklab-50"
  | "shadow-document-rule"
  | "shadow-local-rule-ignored"
  | "document-adopted-rule";

interface V0Case {
  id: DynamicV0CaseId;
  computedPalette: string;
  expectedColors: string[];
}

export interface DynamicV0Row {
  id: DynamicV0CaseId;
  dpr: Dpr;
  computedPalette: string;
  expectedComputedPalette: string;
  expectedOpaqueColors: string[];
  observedOpaqueColors: string[];
  pngSha256: string;
  pass: boolean;
  blockers: string[];
}

export interface DynamicV1Row {
  id: "normal" | "base1" | "mix-srgb-50";
  dpr: Dpr;
  computedPalette: string;
  expectedComputedPalette: string;
  expectedEndpoints: [RgbaTuple, RgbaTuple];
  opaquePixelCount: number;
  channelMin: [number, number, number];
  channelMax: [number, number, number];
  pngSha256: string;
  pass: boolean;
  blockers: string[];
}

export interface DynamicProductionOrderEvidence {
  dpr: Dpr;
  order: DynamicV0CaseId[];
  sourcePngSha256: string[];
  capturedPngSha256: string[];
  capturedPngCount: number;
  capturedUniquePngCount: number;
  svgImageCount: number;
  selectedRepresentation: string | null;
  capturedPaletteRecords: unknown[];
  identityChecks: Record<string, boolean>;
  warnings: string[];
  pass: boolean;
  blockers: string[];
}

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const colorKey = (color: { red: number; green: number; blue: number; alpha: number }): string =>
  `${color.red},${color.green},${color.blue},${color.alpha}`;

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function opaqueColors(png: Buffer): Promise<string[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const colors = new Set<string>();
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 255) colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]},255`);
  }
  return [...colors].sort();
}

function sourceColors(facts: PaletteSourceFacts, palette: number): string[] {
  return facts.layerPaletteIndices.map((entry) => colorKey(facts.palettes[palette][entry])).sort();
}

function dynamicV0Cases(facts: PaletteSourceFacts): V0Case[] {
  return [
    // Exact expected records are transcribed from pinned Blink's
    // PaletteInterpolationTest MixCustomPalettesInSRGB / InOklab vectors for
    // base palettes 3 -> 7; only COLRv0 A's owned entries 3 and 7 are used.
    { id: "mix-srgb-30", computedPalette: "palette-mix(in srgb, --base3 70%, --base7)", expectedColors: ["0,255,179,255", "0,255,77,255"].sort() },
    { id: "animation-oklab-30", computedPalette: "palette-mix(in oklab, --base3 70%, --base7)", expectedColors: ["0,255,205,255", "0,255,128,255"].sort() },
    { id: "animation-oklab-50", computedPalette: "palette-mix(in oklab, --base3, --base7)", expectedColors: ["0,255,169,255"].sort() },
    { id: "shadow-document-rule", computedPalette: "--scope", expectedColors: sourceColors(facts, 3) },
    { id: "shadow-local-rule-ignored", computedPalette: "--shadow-only", expectedColors: sourceColors(facts, 0) },
    { id: "document-adopted-rule", computedPalette: "--adopted", expectedColors: sourceColors(facts, 3) },
  ];
}

export function adjudicateDynamicV0Row(
  row: Omit<DynamicV0Row, "pass" | "blockers">,
): DynamicV0Row {
  const blockers: string[] = [];
  if (row.computedPalette !== row.expectedComputedPalette) blockers.push("computed-palette");
  if (JSON.stringify(row.observedOpaqueColors) !== JSON.stringify(row.expectedOpaqueColors)) blockers.push("source-colors");
  return { ...row, pass: blockers.length === 0, blockers };
}

export function adjudicateDynamicV1Row(
  row: Omit<DynamicV1Row, "pass" | "blockers">,
): DynamicV1Row {
  const blockers: string[] = [];
  if (row.computedPalette !== row.expectedComputedPalette) blockers.push("computed-palette");
  if (row.opaquePixelCount === 0) blockers.push("no-opaque-paint");
  for (let channel = 0; channel < 3; channel += 1) {
    const low = Math.min(row.expectedEndpoints[0][channel], row.expectedEndpoints[1][channel]);
    const high = Math.max(row.expectedEndpoints[0][channel], row.expectedEndpoints[1][channel]);
    if (row.channelMin[channel] < low || row.channelMax[channel] > high) blockers.push(`channel-${channel}-outside-source`);
    if (low === high && (row.channelMin[channel] !== low || row.channelMax[channel] !== high)) blockers.push(`channel-${channel}-constant`);
    if (low !== high && row.channelMin[channel] === row.channelMax[channel]) blockers.push(`channel-${channel}-inert`);
  }
  return { ...row, pass: blockers.length === 0, blockers };
}

function paletteRules(family: string): string {
  return `
    @font-palette-values --base2{font-family:${family};base-palette:2}
    @font-palette-values --base3{font-family:${family};base-palette:3}
    @font-palette-values --base7{font-family:${family};base-palette:7}
    @font-palette-values --scope{font-family:${family};base-palette:3}
    @font-palette-values --adopted{font-family:${family};base-palette:2}
  `;
}

function lightSample(id: DynamicV0CaseId): string {
  return `<span id="${id}" class="sample">${V0_GLYPH}</span>`;
}

async function setDynamicV0Content(page: Page, fontUrl: string, order: DynamicV0CaseId[]): Promise<Map<DynamicV0CaseId, ReturnType<Page["locator"]>>> {
  // Open author shadow trees are deliberately outside the light-DOM walker.
  // A hyphenated host is the production custom-element raster boundary, so
  // these two cases exercise the same ownership path as real captures.
  const nodes = order.map((id) => id.startsWith("shadow-") ? `<x-palette id="host-${id}" class="host"></x-palette>` : lightSample(id)).join("");
  await page.setContent(`<style>
    @font-face{font-family:${V0_FAMILY};src:url('${fontUrl}') format('truetype');font-display:block}
    ${paletteRules(V0_FAMILY)}
    html,body{margin:0;background:transparent}#stage{display:flex;align-items:flex-start;width:600px;height:100px}
    .sample,.host{box-sizing:border-box;display:inline-block;flex:0 0 100px;width:100px;height:100px;font:100px/1 ${V0_FAMILY}}
    #mix-srgb-30{font-palette:palette-mix(in srgb,--base3 70%,--base7)}
    #animation-oklab-30,#animation-oklab-50{font-palette:--base3}
    #document-adopted-rule{font-palette:--adopted}
  </style><main id="stage">${nodes}</main>`);
  await page.evaluate(({ family }) => {
    const namedWindow = window as unknown as { __name?: (fn: unknown) => unknown };
    if (namedWindow.__name == null) {
      namedWindow.__name = (fn: unknown) => fn;
    }
    const adopted = new CSSStyleSheet();
    adopted.replaceSync(`@font-palette-values --adopted{font-family:${family};base-palette:3}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
    const makeShadow = (id: string, palette: string) => {
      const host = document.querySelector(`#host-${id}`)!;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        @font-palette-values --scope{font-family:${family};base-palette:7}
        @font-palette-values --shadow-only{font-family:${family};base-palette:7}
      </style><span id="${id}" style="display:inline-block;width:100px;height:100px;font:100px/1 ${family};font-palette:${palette}">A</span>`;
    };
    makeShadow("shadow-document-rule", "--scope");
    makeShadow("shadow-local-rule-ignored", "--shadow-only");
    const animate = (id: string, time: number) => {
      const element = document.querySelector(`#${id}`)!;
      const animation = element.animate([{ fontPalette: "--base3" }, { fontPalette: "--base7" }], { duration: 1000, fill: "both" });
      animation.pause();
      animation.currentTime = time;
    };
    animate("animation-oklab-30", 300);
    animate("animation-oklab-50", 500);
  }, { family: V0_FAMILY });
  await page.evaluate(async ({ family }) => {
    await document.fonts.ready;
    await document.fonts.load(`100px ${family}`, "A");
  }, { family: V0_FAMILY });
  const locators = new Map<DynamicV0CaseId, ReturnType<Page["locator"]>>();
  for (const id of order) {
    locators.set(id, id.startsWith("shadow-")
      ? page.locator(`#host-${id}`).locator(`#${id}`)
      : page.locator(`#${id}`));
  }
  return locators;
}

async function nativeV0Rows(
  browser: Browser,
  fontUrl: string,
  facts: PaletteSourceFacts,
  dpr: Dpr,
  artifactDir?: string,
): Promise<DynamicV0Row[]> {
  const cases = dynamicV0Cases(facts);
  const order = cases.map((row) => row.id);
  const context = await browser.newContext({ viewport: { width: 620, height: 120 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  try {
    const locators = await setDynamicV0Content(page, fontUrl, order);
    const rows: DynamicV0Row[] = [];
    for (const spec of cases) {
      const locator = locators.get(spec.id)!;
      const png = await locator.screenshot({ omitBackground: true, type: "png" });
      const computedPalette = await locator.evaluate((element) => getComputedStyle(element).fontPalette);
      rows.push(adjudicateDynamicV0Row({
        id: spec.id,
        dpr,
        computedPalette,
        expectedComputedPalette: spec.computedPalette,
        expectedOpaqueColors: spec.expectedColors,
        observedOpaqueColors: await opaqueColors(png),
        pngSha256: sha256(png),
      }));
      if (artifactDir != null) writeFileSync(resolve(artifactDir, `dynamic-v0-${spec.id}-dpr${dpr}.png`), png);
    }
    return rows;
  } finally {
    await context.close();
  }
}

function mixSrgb(start: RgbaTuple, end: RgbaTuple, progress: number): RgbaTuple {
  return start.map((channel, index) => Math.round(channel * (1 - progress) + end[index] * progress)) as RgbaTuple;
}

async function nativeV1Rows(
  browser: Browser,
  fontUrl: string,
  facts: Colrv1SourceFacts,
  dpr: Dpr,
  artifactDir?: string,
): Promise<DynamicV1Row[]> {
  const context = await browser.newContext({ viewport: { width: 180, height: 140 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  try {
    await page.setContent(`<style>
      @font-face{font-family:${V1_FAMILY};src:url('${fontUrl}') format('truetype');font-display:block}
      @font-palette-values --base1{font-family:${V1_FAMILY};base-palette:1}
      html,body{margin:0;background:transparent}#sample{font:120px/1 ${V1_FAMILY};display:inline-block;width:130px;height:120px}
    </style><span id="sample">${V1_GLYPH}</span>`);
    await page.evaluate(async ({ family, glyph }) => {
      await document.fonts.ready;
      await document.fonts.load(`120px ${family}`, glyph);
    }, { family: V1_FAMILY, glyph: V1_GLYPH });
    const specs: Array<{ id: DynamicV1Row["id"]; value: string; computed: string; endpoints: [RgbaTuple, RgbaTuple] }> = [
      { id: "normal", value: "normal", computed: "normal", endpoints: facts.paletteEndpoints[0] },
      { id: "base1", value: "--base1", computed: "--base1", endpoints: facts.paletteEndpoints[1] },
      {
        id: "mix-srgb-50",
        value: "palette-mix(in srgb,normal,--base1)",
        computed: "palette-mix(in srgb, normal, --base1)",
        endpoints: [
          mixSrgb(facts.paletteEndpoints[0][0], facts.paletteEndpoints[1][0], 0.5),
          mixSrgb(facts.paletteEndpoints[0][1], facts.paletteEndpoints[1][1], 0.5),
        ],
      },
    ];
    const rows: DynamicV1Row[] = [];
    for (const spec of specs) {
      await page.locator("#sample").evaluate((element, value) => { (element as HTMLElement).style.fontPalette = value; }, spec.value);
      const png = await page.locator("#sample").screenshot({ omitBackground: true, type: "png" });
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const min: [number, number, number] = [255, 255, 255];
      const max: [number, number, number] = [0, 0, 0];
      let opaque = 0;
      for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset + 3] !== 255) continue;
        opaque += 1;
        for (let channel = 0; channel < 3; channel += 1) {
          min[channel] = Math.min(min[channel], data[offset + channel]);
          max[channel] = Math.max(max[channel], data[offset + channel]);
        }
      }
      const computedPalette = await page.locator("#sample").evaluate((element) => getComputedStyle(element).fontPalette);
      rows.push(adjudicateDynamicV1Row({
        id: spec.id,
        dpr,
        computedPalette,
        expectedComputedPalette: spec.computed,
        expectedEndpoints: spec.endpoints,
        opaquePixelCount: opaque,
        channelMin: min,
        channelMax: max,
        pngSha256: sha256(png),
      }));
      if (artifactDir != null) writeFileSync(resolve(artifactDir, `dynamic-v1-${spec.id}-dpr${dpr}.png`), png);
    }
    const hashes = new Set(rows.map((row) => row.pngSha256));
    if (hashes.size !== rows.length) {
      for (const row of rows) {
        row.pass = false;
        row.blockers.push("palette-mutation-inert");
      }
    }
    return rows;
  } finally {
    await context.close();
  }
}

function collectDataUris(value: unknown, out: string[] = []): string[] {
  if (value == null || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "dataUri" || key === "rasterDataUri") && typeof entry === "string" && entry.startsWith("data:image/png;base64,")) out.push(entry);
    else collectDataUris(entry, out);
  }
  return out;
}

function valuesForKey(value: unknown, wanted: string, out: unknown[] = []): unknown[] {
  if (value == null || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === wanted) out.push(entry);
    else valuesForKey(entry, wanted, out);
  }
  return out;
}

interface PaletteRecord {
  token?: string;
  basePalette?: string;
  ruleScope?: string | null;
  mix?: {
    colorSpace?: string;
    hueInterpolationMethod?: string | null;
    startPercentage?: number;
    endPercentage?: number;
    normalizedPercentage?: number;
    alphaMultiplier?: number;
    start?: PaletteRecord;
    end?: PaletteRecord;
  };
}

function paletteRecord(value: unknown): PaletteRecord | null {
  if (value == null || typeof value !== "object") return null;
  const palette = (value as Record<string, unknown>).palette;
  return palette != null && typeof palette === "object" ? palette as PaletteRecord : null;
}

function shadowPaletteRecords(value: unknown): PaletteRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry == null || typeof entry !== "object") return [];
    const palette = (entry as Record<string, unknown>).palette;
    return palette != null && typeof palette === "object" ? [palette as PaletteRecord] : [];
  });
}

export function adjudicateDynamicProductionOrder(
  row: Omit<DynamicProductionOrderEvidence, "pass" | "blockers">,
): DynamicProductionOrderEvidence {
  const blockers: string[] = [];
  if (row.sourcePngSha256.length !== row.order.length) blockers.push("source-count");
  if (row.capturedPngCount !== row.order.length || row.capturedPngSha256.length !== row.order.length) blockers.push("capture-count");
  if (row.capturedPngSha256.some((hash, index) => hash !== row.sourcePngSha256[index])) blockers.push("capture-content");
  if (row.svgImageCount !== row.order.length) blockers.push("svg-image-count");
  if (row.selectedRepresentation !== "colr") blockers.push("representation");
  if (row.capturedPaletteRecords.length !== row.order.length) blockers.push("identity-count");
  for (const [name, active] of Object.entries(row.identityChecks)) if (!active) blockers.push(`identity-${name}`);
  if (row.warnings.length > 0) blockers.push("warnings");
  return { ...row, pass: blockers.length === 0, blockers };
}

async function productionOrder(
  browser: Browser,
  fontUrl: string,
  order: DynamicV0CaseId[],
  dpr: Dpr,
  artifactDir?: string,
): Promise<DynamicProductionOrderEvidence> {
  const context = await browser.newContext({ viewport: { width: 620, height: 120 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const tracker = attachWebfontTracker(page);
  try {
    const locators = await setDynamicV0Content(page, fontUrl, order);
    const sourcePngs = await Promise.all(order.map((id) => {
      const locator = id.startsWith("shadow-") ? page.locator(`#host-${id}`) : locators.get(id)!;
      return locator.screenshot({ omitBackground: true, type: "png" });
    }));
    clearWebfonts();
    clearGlyphDefs();
    const registration = await discoverAndRegisterWebfonts(page, tracker.urls);
    if (!registration.some((row) => row.ok && row.family === V0_FAMILY)) {
      throw new Error(`dynamic palette webfont registration failed: ${JSON.stringify(registration)}`);
    }
    const selected = selectedGlyphRasterSpans(V0_GLYPH, [{ start: 0, end: 1 }], {
      fontSize: 100,
      fontFamily: V0_FAMILY,
      fontWeight: 400,
      fontStyle: "normal",
      fontStretch: "100%",
      lang: "en",
    })[0];
    const capture = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, width: 620, height: 120 });
    const dataUris = collectDataUris(capture.tree);
    const capturedPngs = dataUris.map((uri) => Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
    const glyphRecords = valuesForKey(capture.tree, "colorGlyphIdentity");
    const palettes = [
      ...glyphRecords.map(paletteRecord).filter((record): record is PaletteRecord => record != null),
      ...valuesForKey(capture.tree, "shadowFontPaletteIdentities").flatMap(shadowPaletteRecords),
    ];
    const paletteFor = (token: string): PaletteRecord | null => palettes.find((record) => record.token === token) ?? null;
    const byId = new Map<DynamicV0CaseId, PaletteRecord | null>([
      ["mix-srgb-30", paletteFor("palette-mix(in srgb, --base3 70%, --base7)")],
      ["animation-oklab-30", paletteFor("palette-mix(in oklab, --base3 70%, --base7)")],
      ["animation-oklab-50", paletteFor("palette-mix(in oklab, --base3 50%, --base7)") ?? paletteFor("palette-mix(in oklab, --base3, --base7)")],
      ["shadow-document-rule", paletteFor("--scope")],
      ["shadow-local-rule-ignored", paletteFor("--shadow-only")],
      ["document-adopted-rule", paletteFor("--adopted")],
    ]);
    const identityChecks = {
      mixSpace: byId.get("mix-srgb-30")?.mix?.colorSpace === "srgb",
      mixDefaultHue: byId.get("mix-srgb-30")?.mix?.hueInterpolationMethod === "shorter",
      mixWeights: byId.get("mix-srgb-30")?.mix?.startPercentage === 70
        && byId.get("mix-srgb-30")?.mix?.endPercentage === 30
        && byId.get("mix-srgb-30")?.mix?.normalizedPercentage === 0.3
        && byId.get("mix-srgb-30")?.mix?.alphaMultiplier === 1,
      mixEndpoints: byId.get("mix-srgb-30")?.mix?.start?.basePalette === "3"
        && byId.get("mix-srgb-30")?.mix?.start?.ruleScope === "document"
        && byId.get("mix-srgb-30")?.mix?.end?.basePalette === "7"
        && byId.get("mix-srgb-30")?.mix?.end?.ruleScope === "document",
      animationTime30: byId.get("animation-oklab-30")?.mix?.normalizedPercentage === 0.3,
      animationTime50: byId.get("animation-oklab-50")?.mix?.normalizedPercentage === 0.5,
      animationDefaultSpace: byId.get("animation-oklab-30")?.mix?.colorSpace === "oklab",
      animationImplicitHue: byId.get("animation-oklab-30")?.mix?.hueInterpolationMethod === null,
      animationEndpoints: byId.get("animation-oklab-30")?.mix?.start?.basePalette === "3"
        && byId.get("animation-oklab-30")?.mix?.end?.basePalette === "7",
      shadowDocumentRule: byId.get("shadow-document-rule")?.ruleScope === "document" && byId.get("shadow-document-rule")?.basePalette === "3",
      shadowLocalIgnored: byId.get("shadow-local-rule-ignored")?.ruleScope == null && byId.get("shadow-local-rule-ignored")?.basePalette === "normal",
      adoptedDocumentRule: byId.get("document-adopted-rule")?.ruleScope === "document" && byId.get("document-adopted-rule")?.basePalette === "3",
    };
    const svg = elementTreeToSvgInner(capture.tree, 620, 120);
    if (artifactDir != null) {
      const label = order[0] === "mix-srgb-30" ? "forward" : "reverse";
      sourcePngs.forEach((png, index) => writeFileSync(resolve(artifactDir, `dynamic-source-${label}-${index}-dpr${dpr}.png`), png));
      capturedPngs.forEach((png, index) => writeFileSync(resolve(artifactDir, `dynamic-captured-${label}-${index}-dpr${dpr}.png`), png));
      writeFileSync(resolve(artifactDir, `dynamic-captured-${label}-dpr${dpr}.svg`), svg);
    }
    return adjudicateDynamicProductionOrder({
      dpr,
      order,
      sourcePngSha256: sourcePngs.map(sha256),
      capturedPngSha256: capturedPngs.map(sha256),
      capturedPngCount: capturedPngs.length,
      capturedUniquePngCount: new Set(capturedPngs.map(sha256)).size,
      svgImageCount: (svg.match(/<image\b/g) ?? []).length,
      selectedRepresentation: selected?.representation ?? null,
      capturedPaletteRecords: palettes,
      identityChecks,
      warnings: capture.warnings.map((warning) => `${warning.feature}:${warning.status}`),
    });
  } finally {
    tracker.detach();
    clearWebfonts();
    clearGlyphDefs();
    await context.close();
  }
}

function fixtureServer(v0: Buffer, v1: Buffer): Promise<{ server: Server; v0Url: string; v1Url: string }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Type", "font/ttf");
      response.end(request.url === "/v1.ttf" ? v1 : v0);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") return reject(new Error("dynamic palette server did not bind a TCP port"));
      const base = `http://127.0.0.1:${address.port}`;
      resolveServer({ server, v0Url: `${base}/v0.ttf`, v1Url: `${base}/v1.ttf` });
    });
  });
}

export interface FontPaletteDynamicGateReport {
  schemaVersion: 1;
  ticket: "DM-2534";
  verdict: "source-exact" | "source-drift";
  sourcePins: typeof FONT_PALETTE_DYNAMIC_SOURCE_PINS;
  fingerprint: Record<string, unknown>;
  colrv0Rows: DynamicV0Row[];
  colrv1Rows: DynamicV1Row[];
  productionOrders: DynamicProductionOrderEvidence[];
}

export async function runFontPaletteDynamicGate(options: {
  colrv1Source: Colrv1SourceFacts;
  colrv1Fixture: string;
  artifactDir?: string;
  dprs?: Dpr[];
}): Promise<FontPaletteDynamicGateReport> {
  const artifactDir = options.artifactDir == null ? undefined : resolve(options.artifactDir);
  if (artifactDir != null) mkdirSync(artifactDir, { recursive: true });
  const v0Facts = readPaletteSourceFacts();
  const hosted = await fixtureServer(readFileSync(resolve(FONT_PALETTE_FIXTURE)), readFileSync(resolve(options.colrv1Fixture)));
  const browser = await chromium.launch({ headless: true });
  try {
    const dprs = options.dprs ?? [1, 2];
    const colrv0Rows = (await Promise.all(dprs.map((dpr) => nativeV0Rows(browser, hosted.v0Url, v0Facts, dpr, artifactDir)))).flat();
    const colrv1Rows = (await Promise.all(dprs.map((dpr) => nativeV1Rows(browser, hosted.v1Url, options.colrv1Source, dpr, artifactDir)))).flat();
    const order = dynamicV0Cases(v0Facts).map((row) => row.id);
    // Production registries are process-global, so every cache-control arm is
    // serial. Reversing order must change only traversal order.
    const productionOrders: DynamicProductionOrderEvidence[] = [];
    for (const dpr of dprs) {
      productionOrders.push(await productionOrder(browser, hosted.v0Url, order, dpr, artifactDir));
      productionOrders.push(await productionOrder(browser, hosted.v0Url, [...order].reverse(), dpr, artifactDir));
    }
    const expectedV0 = dprs.length * dynamicV0Cases(v0Facts).length;
    const expectedV1 = dprs.length * 3;
    const expectedOrders = dprs.length * 2;
    const complete = colrv0Rows.length === expectedV0 && colrv1Rows.length === expectedV1 && productionOrders.length === expectedOrders;
    const verdict = complete && colrv0Rows.every((row) => row.pass) && colrv1Rows.every((row) => row.pass)
      && productionOrders.every((row) => row.pass) ? "source-exact" : "source-drift";
    const cdp = await browser.newBrowserCDPSession();
    const version = await cdp.send("Browser.getVersion");
    await cdp.detach();
    const report: FontPaletteDynamicGateReport = {
      schemaVersion: 1,
      ticket: "DM-2534",
      verdict,
      sourcePins: FONT_PALETTE_DYNAMIC_SOURCE_PINS,
      fingerprint: {
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        chromium: browser.version(),
        chromiumRevision: version.revision,
        browserExecutableSha256: await sha256File(chromium.executablePath()),
        node: process.version,
        colrv0FixtureSha256: v0Facts.sha256,
        colrv1FixtureSha256: options.colrv1Source.sha256,
        dprs,
      },
      colrv0Rows,
      colrv1Rows,
      productionOrders,
    };
    if (artifactDir != null) writeFileSync(resolve(artifactDir, "font-palette-dynamic-report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose) => hosted.server.close(() => resolveClose()));
  }
}
