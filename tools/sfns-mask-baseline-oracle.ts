/**
 * macOS SFNS native-mask/baseline discriminator.
 *
 * The collector holds physical font bytes, axes, gids, and Skia's two-bit
 * subpixel position keys fixed while crossing three paint representations:
 * CoreText's native mask, CoreText's glyph path rasterized as SVG, and the
 * production Domotion path. See docs/168-sfns-mask-baseline-oracle.md.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { arch, tmpdir, version as osVersion } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import {
  clearFontResolutionCaches, clearGlyphDefs, setRenderTextMode,
} from "../src/render/font-resolution.js";
import {
  isGlyphHelperAvailable, resolvedGlyphHelperPathForEvidence,
} from "../src/render/glyph-helper.js";
import {
  getTextRunProvenance, resetTextRunProvenance, setTextRunProvenanceEnabled,
  type TextRunProvenanceDiagnostic,
} from "../src/render/text-run-provenance.js";
import {
  SFNS_BASE_AXES, SFNS_MUTATION_AXES, classifySfnsOracleRow,
  quantizeQuarter, sfnsOutlineLogicalDigest, validateSfnsExactOutlineArtifact,
  validateSfnsOracleArtifact,
  type CoverageDiff, type SfnsAxes, type SfnsOracleArtifact,
  type SfnsOracleRow, type SfnsScenarioId,
} from "./sfns-mask-baseline-schema.js";

const FONT_PATH = "/System/Library/Fonts/SFNS.ttf" as const;
const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3" as const;
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1" as const;
const TEXT = "zoom2!";
const WIDTH = 240;
const HEIGHT = 100;
const BROWSER_FONT_FAMILY = "DM2452 Exact SFNS";
const BROWSER_FONT_ORIGIN = "https://dm2452-sfns.invalid";

interface Scenario {
  id: SfnsScenarioId;
  css: string;
  axes: SfnsAxes;
  mutation: boolean;
}

const scenarios: Scenario[] = [
  { id: "zoom-2", css: "zoom:2", axes: { ...SFNS_BASE_AXES }, mutation: false },
  { id: "transform-scale-2", css: "transform:scale(2);transform-origin:0 0", axes: { ...SFNS_BASE_AXES }, mutation: false },
  { id: "zoom-2-transform-half", css: "zoom:2;transform:scale(.5);transform-origin:0 0", axes: { ...SFNS_BASE_AXES }, mutation: false },
  { id: "optical-sizing-none", css: "zoom:2;font-optical-sizing:none", axes: { ...SFNS_BASE_AXES }, mutation: false },
  { id: "opsz-26-mutation", css: "zoom:2", axes: { ...SFNS_MUTATION_AXES }, mutation: true },
];

interface NativePath {
  gid: number;
  svgPath: string;
  designSvgPath: string;
  commandCount: number;
  bounds: { x: number; y: number; width: number; height: number };
  advance: number;
}

interface NativeSample {
  id: SfnsScenarioId;
  maskPath: string;
  postscriptName: string;
  actualAxes: Partial<SfnsAxes>;
  mappedGlyphIds: number[];
  suppliedGlyphIds: number[];
  positions: Array<{ x: number; baselineY: number }>;
  glyphPaths: NativePath[];
  metrics: {
    pointSize: number;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    leading: number;
    capHeight: number;
    xHeight: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  };
}

interface NativeOutput {
  iterations: Array<{ iteration: number; samples: NativeSample[] }>;
}

interface PendingRow {
  scenario: Scenario;
  expectedPath: string;
  target: CapturedElement;
  rawOrigins: number[];
  quarterOrigins: number[];
  cssom: {
    rangeTop: number;
    logicalSize: number;
    computedSize: number;
    paintSize: number;
    canvasAscent: number;
    canvasDescent: number;
    chromiumAxes: Partial<SfnsAxes>;
  };
  chromiumPostscriptName: string;
  chromiumCustomFont: boolean;
  chromiumLifecycle: {
    coldSha256: [string, string];
    warmSha256: [string, string];
  };
  domotion: {
    coldSvg: string;
    coldSha256: [string, string];
    warmSha256: [string, string];
    coldSvgPath: string;
    coldPngPath: string;
    provenance: TextRunProvenanceDiagnostic;
    emittedOriginsRaw: number[];
    emittedBaseline: number;
    emittedScale: number;
  };
}

const argv = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};
const outputDirectory = resolve(value("--out") ?? "tests/output/sfns-mask-baseline");
const armValue = value("--arm");
if (armValue != null && armValue !== "proposal" && armValue !== "validation") {
  throw new Error(`invalid --arm ${JSON.stringify(armValue)} (expected proposal or validation)`);
}
const arm = (armValue ?? "proposal") as "proposal" | "validation";
const exactGateMode = armValue != null;

function scenarioHtml(scenario: Scenario, fontUrl: string): string {
  const axisCss = Object.entries(scenario.axes)
    .map(([tag, coordinate]) => `"${tag}" ${coordinate}`).join(",");
  return `<!doctype html><style>
    @font-face{font-family:"${BROWSER_FONT_FAMILY}";src:url("${fontUrl}") format("truetype");font-weight:100 900;font-stretch:50% 200%}
    *{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#000;overflow:hidden}
    #anchor{position:absolute;left:37.25px;top:18.25px}
    #target{display:inline-block;color:#fff;white-space:pre;font-family:"${BROWSER_FONT_FAMILY}";font-weight:700;font-size:13px;line-height:normal;font-variation-settings:${axisCss};${scenario.css}}
  </style><div id="anchor"><span id="target">${TEXT}</span></div>`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function findText(nodes: CapturedElement[]): CapturedElement {
  for (const node of nodes) {
    if (node.text === TEXT) return node;
    try { return findText(node.children ?? []); } catch { /* continue */ }
  }
  throw new Error(`captured text ${JSON.stringify(TEXT)} missing`);
}

function cloneTree(tree: CapturedElement[]): CapturedElement[] {
  return structuredClone(tree);
}

function routeQuarterOrigins(target: CapturedElement, origins: number[]): void {
  const segment = target.textSegments?.find((candidate) => candidate.text === TEXT);
  if (segment == null) throw new Error("captured text segment missing");
  segment.xOffsets = [...origins];
  segment.x = origins[0];
  target.textLeft = origins[0];
}

function routeDomotionSystemFace(target: CapturedElement): void {
  // Chromium consumes a routed copy of the exact bytes so its source identity
  // is provable. Domotion's production system-ui route opens the same bytes at
  // /System/Library/Fonts/SFNS.ttf; retain every captured geometry/metric fact
  // while changing only the family lookup back to that production route.
  // The structured Blink family record is authoritative over the legacy
  // string, so update both carriers or a current capture keeps the isolated
  // custom family and falls through to the standard font.
  const fontFamilyStack = {
    source: "blink-font-family-stack-v1" as const,
    entries: [
      { name: "system-ui", type: "generic-family" as const },
      { name: "sans-serif", type: "generic-family" as const },
    ],
    genericFamily: "sans-serif" as const,
  };
  target.fontFamily = "system-ui, sans-serif";
  target.fontFamilyStack = structuredClone(fontFamilyStack);
  target.styles.fontFamily = "system-ui, sans-serif";
  target.styles.fontFamilyStack = structuredClone(fontFamilyStack);
  const segment = target.textSegments?.find((candidate) => candidate.text === TEXT);
  if (segment != null) {
    segment.fontFamily = "system-ui, sans-serif";
    segment.fontFamilyStack = structuredClone(fontFamilyStack);
  }
}

function svgPlacement(svg: string): { origins: number[]; baseline: number; scale: number } {
  const labelIndex = svg.indexOf(`aria-label="${TEXT}"`);
  if (labelIndex < 0) throw new Error("Domotion SVG text group missing");
  const groupStart = svg.lastIndexOf("<g transform=\"translate(", labelIndex);
  const groupEnd = svg.indexOf("</g></g>", labelIndex);
  if (groupStart < 0 || groupEnd < 0) throw new Error("Domotion SVG placement group missing");
  const group = svg.slice(groupStart, groupEnd + 8);
  const translation = /translate\(([-0-9.]+),([-0-9.]+)\)/.exec(group);
  const scale = /scale\(([-0-9.]+),[-0-9.]+\)/.exec(group);
  if (translation == null || scale == null) throw new Error("Domotion SVG placement transforms missing");
  const origin = Number(translation[1]);
  const baseline = Number(translation[2]);
  const scalar = Math.abs(Number(scale[1]));
  const origins = [...group.matchAll(/<use\s+href="#[^"]+"\s+x="([-0-9.]+)"/g)]
    .map((match) => origin + Number(match[1]) * scalar);
  return { origins, baseline, scale: scalar };
}

interface CanonicalPathCommand { command: "M" | "L" | "Q" | "C" | "Z"; coordinates: number[] }

function canonicalPath(path: string): CanonicalPathCommand[] {
  const tokens = [...path.matchAll(/[MLHVQCZ]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi)]
    .map((match) => match[0]);
  const result: CanonicalPathCommand[] = [];
  let index = 0; let x = 0; let y = 0; let subpathX = 0; let subpathY = 0;
  const coordinate = (): number => {
    const token = tokens[index++];
    if (token == null || /^[A-Z]$/i.test(token)) throw new Error(`malformed SVG path ${path}`);
    return Number(token);
  };
  while (index < tokens.length) {
    const command = tokens[index++]?.toUpperCase();
    if (command === "Z") {
      result.push({ command: "Z", coordinates: [] }); x = subpathX; y = subpathY;
    } else if (command === "M" || command === "L") {
      x = coordinate(); y = coordinate();
      if (command === "M") { subpathX = x; subpathY = y; }
      result.push({ command, coordinates: [x, y] });
    } else if (command === "H") {
      x = coordinate(); result.push({ command: "L", coordinates: [x, y] });
    } else if (command === "V") {
      y = coordinate(); result.push({ command: "L", coordinates: [x, y] });
    } else if (command === "Q") {
      const cx = coordinate(); const cy = coordinate(); x = coordinate(); y = coordinate();
      result.push({ command: "Q", coordinates: [cx, cy, x, y] });
    } else if (command === "C") {
      const c1x = coordinate(); const c1y = coordinate();
      const c2x = coordinate(); const c2y = coordinate(); x = coordinate(); y = coordinate();
      result.push({ command: "C", coordinates: [c1x, c1y, c2x, c2y, x, y] });
    } else {
      throw new Error(`unsupported SVG path command ${command ?? "<end>"}`);
    }
  }
  return result;
}

function canonicalDesignUnit(value: number): number {
  const magnitude = Math.round(Math.abs(value) * 1000) / 1000;
  return Object.is(magnitude, 0) ? 0 : Math.sign(value) * magnitude;
}

function canonicalDesignPaths(paths: string[]): CanonicalPathCommand[][] {
  return paths.map((path) => canonicalPath(path).map((command) => ({
    command: command.command,
    coordinates: command.coordinates.map(canonicalDesignUnit),
  })));
}

function designCommandDigest(paths: string[]): string {
  return sha256(JSON.stringify(canonicalDesignPaths(paths)));
}

function domotionUsePaths(svg: string): string[] {
  const definitions = new Map([...svg.matchAll(/<path id="([^"]+)" d="([^"]*)"/g)]
    .map((match) => [match[1], match[2]]));
  return [...svg.matchAll(/<use\s+href="#([^"]+)"/g)].map((match) => {
    const path = definitions.get(match[1]);
    if (path == null) throw new Error(`Domotion glyph definition ${match[1]} missing`);
    return path;
  });
}

function domotionPathDigest(svg: string): string {
  return sha256(JSON.stringify(domotionUsePaths(svg)));
}

function comparePathGeometry(
  native: NativeSample, domotionSvg: string, serializedScale: number,
): SfnsOracleRow["pathGeometry"] {
  const domotion = domotionUsePaths(domotionSvg);
  const nativeInk = native.glyphPaths.filter((glyph) => glyph.designSvgPath !== "");
  const exactScale = native.metrics.pointSize / native.metrics.unitsPerEm;
  let topologyMatches = nativeInk.length === domotion.length;
  let maxDesignUnitDelta = 0; let sumPaintPixelDelta = 0; let coordinateCount = 0;
  for (let glyphIndex = 0; glyphIndex < Math.min(nativeInk.length, domotion.length); glyphIndex++) {
    const left = canonicalPath(nativeInk[glyphIndex].designSvgPath);
    const right = canonicalPath(domotion[glyphIndex]);
    if (left.length !== right.length) topologyMatches = false;
    for (let commandIndex = 0; commandIndex < Math.min(left.length, right.length); commandIndex++) {
      const a = left[commandIndex]; const b = right[commandIndex];
      if (a.command !== b.command || a.coordinates.length !== b.coordinates.length) {
        topologyMatches = false; continue;
      }
      for (let coordinateIndex = 0; coordinateIndex < a.coordinates.length; coordinateIndex++) {
        // The production helper's Swift protocol serializes design coordinates
        // at an exact 0.001-DU lattice. Canonicalize the independent native arm
        // to that same declared representation before exact equality; this is
        // neither a paint-pixel tolerance nor an inferred fit.
        const designUnitDelta = Math.abs(
          canonicalDesignUnit(a.coordinates[coordinateIndex])
          - canonicalDesignUnit(b.coordinates[coordinateIndex]),
        );
        maxDesignUnitDelta = Math.max(maxDesignUnitDelta, designUnitDelta);
        sumPaintPixelDelta += designUnitDelta * exactScale;
        coordinateCount++;
      }
    }
  }
  return {
    topologyMatches,
    designUnitQuantum: 0.001,
    maxDesignUnitDelta,
    maxPaintPixelDelta: maxDesignUnitDelta * exactScale,
    meanPaintPixelDelta: coordinateCount === 0 ? 0 : sumPaintPixelDelta / coordinateCount,
    exactScale,
    domotionSerializedScale: serializedScale,
  };
}

function coreTextPathSvg(sample: NativeSample): string {
  const body = sample.glyphPaths.map((glyph, index) => glyph.svgPath === "" ? ""
    : `<path d="${glyph.svgPath}" transform="translate(${sample.positions[index].x},${sample.positions[index].baselineY}) scale(1,-1)"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#000"/><g fill="#fff">${body}</g></svg>`;
}

async function rasterSvg(page: Page, svg: string, output: string): Promise<void> {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(`<style>*{margin:0}</style><img src="${url}" width="${WIDTH}" height="${HEIGHT}">`, { waitUntil: "load" });
  await page.screenshot({ path: output, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
}

async function compareCoverage(page: Page, aPath: string, bPath: string): Promise<CoverageDiff> {
  const [a, b] = [aPath, bPath].map((path) => `data:image/png;base64,${readFileSync(path).toString("base64")}`);
  // tsx/esbuild annotates nested functions with its module-scope `__name`
  // helper. `page.evaluate` serializes only this callback, so provide the
  // no-op helper explicitly inside the isolated browser world.
  await page.evaluate("globalThis.__name = (value) => value");
  return page.evaluate(async ({ aUrl, bUrl, width, height }) => {
    const load = async (url: string): Promise<HTMLImageElement> => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    };
    const coverage = async (url: string): Promise<number[]> => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(await load(url), 0, 0, width, height);
      const rgba = context.getImageData(0, 0, width, height).data;
      const result = new Array<number>(width * height);
      for (let i = 0; i < result.length; i++) {
        result[i] = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
      }
      return result;
    };
    const [aa, bb] = await Promise.all([coverage(aUrl), coverage(bUrl)]);
    const score = (offsetY: number) => {
      let absolute = 0;
      let changed = 0;
      let max = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const by = y - offsetY;
        const bv = by < 0 || by >= height ? 0 : bb[by * width + x];
        const delta = Math.abs(aa[y * width + x] - bv);
        absolute += delta;
        if (delta > 0) changed++;
        max = Math.max(max, delta);
      }
      return { mean: absolute / (width * height * 255), changed, max: max / 255 };
    };
    const centroid = (pixels: number[]) => {
      let mass = 0; let yMass = 0; let ink = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const value = pixels[y * width + x];
        if (value > 0) ink++;
        mass += value; yMass += value * y;
      }
      return { ink, y: mass === 0 ? null : yMass / mass };
    };
    const fixed = score(0);
    const candidates = [-2, -1, 0, 1, 2].map((offsetY) => ({ offsetY, ...score(offsetY) }));
    candidates.sort((left, right) => left.mean - right.mean || Math.abs(left.offsetY) - Math.abs(right.offsetY));
    const ca = centroid(aa); const cb = centroid(bb);
    return {
      changedPixels: fixed.changed,
      meanAbsoluteCoverage: fixed.mean,
      maxAbsoluteCoverage: fixed.max,
      inkPixelsA: ca.ink,
      inkPixelsB: cb.ink,
      centroidYA: ca.y,
      centroidYB: cb.y,
      fixedYOffset: 0 as const,
      bestIntegerYOffset: candidates[0].offsetY,
      bestMeanAbsoluteCoverage: candidates[0].mean,
    };
  }, { aUrl: a, bUrl: b, width: WIDTH, height: HEIGHT });
}

function nativeSample(output: NativeOutput, iteration: number, id: SfnsScenarioId): NativeSample {
  const sample = output.iterations[iteration]?.samples.find((candidate) => candidate.id === id);
  if (sample == null) throw new Error(`native sample ${id}/${iteration} missing`);
  return sample;
}

function nativePathDigest(sample: NativeSample): string {
  return sha256(JSON.stringify(sample.glyphPaths.map(({ gid, svgPath, designSvgPath, commandCount }) => ({
    gid, svgPath, designSvgPath, commandCount,
  }))));
}

function runNative(binary: string, input: string, output: string): NativeOutput {
  mkdirSync(output, { recursive: true });
  return JSON.parse(execFileSync(binary, [input, output], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  })) as NativeOutput;
}

async function renderDomotion(
  tree: CapturedElement[], id: SfnsScenarioId, output: string, cold: boolean,
): Promise<{ svg: string; provenance: TextRunProvenanceDiagnostic }> {
  if (cold) clearFontResolutionCaches();
  clearGlyphDefs();
  resetTextRunProvenance();
  const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
  const provenance = getTextRunProvenance().runs.find((run) => run.emitter === "paths" && run.sourceText === TEXT);
  if (provenance == null) throw new Error(`Domotion path provenance missing for ${id}`);
  writeFileSync(output, svg);
  return { svg, provenance };
}

if (process.platform !== "darwin") {
  throw new Error("SFNS mask/baseline oracle requires macOS");
}

mkdirSync(outputDirectory, { recursive: true });
const fontBytes = readFileSync(FONT_PATH);
const fontSha256 = sha256(fontBytes);
if (!isGlyphHelperAvailable()) {
  throw new Error("SFNS exact outline evidence requires the native glyph helper (fail closed)");
}
const helperPath = resolvedGlyphHelperPathForEvidence();
if (helperPath == null) {
  throw new Error("SFNS exact outline evidence could not authenticate the native glyph-helper path");
}
const helperSha256 = sha256(readFileSync(helperPath));
const swiftSource = new URL("./sfns-mask-baseline.swift", import.meta.url).pathname;
const buildDirectory = mkdtempSync(join(tmpdir(), "domotion-sfns-mask-"));
const nativeBinary = join(buildDirectory, "sfns-mask-baseline");
execFileSync("swiftc", ["-O", swiftSource, "-o", nativeBinary], { stdio: "inherit" });

// This diagnostic never needs a visible browser window. Keep it explicit so
// local parity work cannot interrupt an operator's live browser session.
const browser = await launchChromium({ headless: true });
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await context.route(`${BROWSER_FONT_ORIGIN}/**`, (route) => route.fulfill({
  status: 200, contentType: "font/ttf", body: fontBytes,
}));
const page = await context.newPage();
const lifecyclePage = await context.newPage();
const rasterPage = await context.newPage();
const comparePage = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
setRenderTextMode("paths");
setTextRunProvenanceEnabled(true);

const pending: PendingRow[] = [];
try {
  for (const scenario of scenarios) {
    const primaryFontUrl = `${BROWSER_FONT_ORIGIN}/${scenario.id}-cold-a.ttf`;
    await page.setContent(scenarioHtml(scenario, primaryFontUrl), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const expectedPath = join(outputDirectory, `${scenario.id}-chromium.png`);
    const chromiumColdA = await page.screenshot({
      path: expectedPath, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    const chromiumWarmA = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

    const secondFontUrl = `${BROWSER_FONT_ORIGIN}/${scenario.id}-cold-b.ttf`;
    await lifecyclePage.setContent(scenarioHtml(scenario, secondFontUrl), { waitUntil: "load" });
    await lifecyclePage.evaluate(() => document.fonts.ready);
    const chromiumColdB = await lifecyclePage.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    const chromiumWarmB = await lifecyclePage.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

    const cssom = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>("#target")!;
      const style = getComputedStyle(element);
      const range = document.createRange(); range.selectNodeContents(element);
      const rangeRect = range.getBoundingClientRect();
      let zoom = 1; let transform = 1;
      for (let node: Element | null = element; node != null; node = node.parentElement) {
        const current = getComputedStyle(node);
        const currentZoom = Number.parseFloat(current.zoom);
        if (Number.isFinite(currentZoom) && currentZoom > 0) zoom *= currentZoom;
        if (current.transform !== "none") {
          const matrix = new DOMMatrix(current.transform);
          transform *= Math.sqrt(Math.abs(matrix.a * matrix.d));
        }
      }
      const logicalSize = Number.parseFloat(style.fontSize);
      const computedSize = logicalSize * zoom;
      const paintSize = computedSize * transform;
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${computedSize}px ${style.fontFamily}`;
      const measured = canvas.measureText(element.textContent ?? "");
      const chromiumAxes: Record<string, number> = {};
      for (const match of style.fontVariationSettings.matchAll(/"([^"\n]{4})"\s+(-?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
        chromiumAxes[match[1]] = Number(match[2]);
      }
      return {
        rangeTop: rangeRect.top,
        logicalSize, computedSize, paintSize,
        canvasAscent: measured.fontBoundingBoxAscent * transform,
        canvasDescent: measured.fontBoundingBoxDescent * transform,
        chromiumAxes,
      };
    });

    const documentNode = await cdp.send("DOM.getDocument", { depth: -1 });
    const targetDom = await cdp.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#target" });
    const platformFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: targetDom.nodeId });
    const chromiumPostscriptName = platformFonts.fonts[0]?.postScriptName ?? "";
    const chromiumCustomFont = platformFonts.fonts[0]?.isCustomFont ?? false;
    if (chromiumPostscriptName === "") throw new Error(`Chromium platform face missing for ${scenario.id}`);
    if (!chromiumCustomFont) throw new Error(`Chromium did not paint routed SFNS bytes for ${scenario.id}`);

    const capturedTree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const capturedTarget = findText(capturedTree);
    const segment = capturedTarget.textSegments?.find((candidate) => candidate.text === TEXT);
    const rawOrigins = segment?.xOffsets;
    if (rawOrigins == null || rawOrigins.length !== TEXT.length) {
      throw new Error(`captured origins missing for ${scenario.id}`);
    }
    const quarterOrigins = rawOrigins.map(quantizeQuarter);
    const routedTree = cloneTree(capturedTree);
    const routedTarget = findText(routedTree);
    routeDomotionSystemFace(routedTarget);
    routeQuarterOrigins(routedTarget, quarterOrigins);

    const coldSvgPath = join(outputDirectory, `${scenario.id}-domotion.svg`);
    const coldA = await renderDomotion(routedTree, scenario.id, coldSvgPath, true);
    const warmA = await renderDomotion(routedTree, scenario.id, join(outputDirectory, `${scenario.id}-domotion-warm-a.svg`), false);
    const coldB = await renderDomotion(routedTree, scenario.id, join(outputDirectory, `${scenario.id}-domotion-cold-b.svg`), true);
    const warmB = await renderDomotion(routedTree, scenario.id, join(outputDirectory, `${scenario.id}-domotion-warm-b.svg`), false);
    const placement = svgPlacement(coldA.svg);
    const coldPngPath = join(outputDirectory, `${scenario.id}-domotion.png`);
    await rasterSvg(rasterPage, coldA.svg, coldPngPath);
    pending.push({
      scenario, expectedPath, target: routedTarget,
      rawOrigins: [...rawOrigins], quarterOrigins,
      cssom: { ...cssom, chromiumAxes: cssom.chromiumAxes as Partial<SfnsAxes> },
      chromiumPostscriptName, chromiumCustomFont,
      chromiumLifecycle: {
        coldSha256: [sha256(chromiumColdA), sha256(chromiumColdB)],
        warmSha256: [sha256(chromiumWarmA), sha256(chromiumWarmB)],
      },
      domotion: {
        coldSvg: coldA.svg,
        coldSha256: [sha256(coldA.svg), sha256(coldB.svg)],
        warmSha256: [sha256(warmA.svg), sha256(warmB.svg)],
        coldSvgPath, coldPngPath,
        provenance: coldA.provenance,
        emittedOriginsRaw: placement.origins,
        emittedBaseline: placement.baseline,
        emittedScale: placement.scale,
      },
    });
  }

  const nativeInputPath = join(outputDirectory, "native-input.json");
  const nativeSamples = pending.map((row) => ({
    id: row.scenario.id,
    text: TEXT,
    pointSize: row.cssom.paintSize,
    width: WIDTH,
    height: HEIGHT,
    axes: row.scenario.axes,
    glyphIds: row.domotion.provenance.glyphs.map((glyph) => glyph.id),
    positions: row.quarterOrigins.map((x) => ({ x, baselineY: row.domotion.emittedBaseline })),
  }));
  writeFileSync(nativeInputPath, JSON.stringify({ fontPath: FONT_PATH, repeatCount: 1, samples: nativeSamples }));
  const coldA = runNative(nativeBinary, nativeInputPath, join(outputDirectory, "native-cold-a"));
  const coldB = runNative(nativeBinary, nativeInputPath, join(outputDirectory, "native-cold-b"));
  writeFileSync(nativeInputPath, JSON.stringify({ fontPath: FONT_PATH, repeatCount: 2, samples: nativeSamples }));
  const warm = runNative(nativeBinary, nativeInputPath, join(outputDirectory, "native-warm"));

  const rows: SfnsOracleRow[] = [];
  for (const item of pending) {
    const native = nativeSample(coldA, 0, item.scenario.id);
    const nativeB = nativeSample(coldB, 0, item.scenario.id);
    const nativeWarmA = nativeSample(warm, 0, item.scenario.id);
    const nativeWarmB = nativeSample(warm, 1, item.scenario.id);
    const ctPathSvg = coreTextPathSvg(native);
    const ctPathSvgPath = join(outputDirectory, `${item.scenario.id}-coretext-path.svg`);
    const ctPathPngPath = join(outputDirectory, `${item.scenario.id}-coretext-path.png`);
    writeFileSync(ctPathSvgPath, ctPathSvg);
    await rasterSvg(rasterPage, ctPathSvg, ctPathPngPath);

    const comparisons = {
      chromiumVsNativeMask: await compareCoverage(comparePage, item.expectedPath, native.maskPath),
      chromiumVsCoreTextPath: await compareCoverage(comparePage, item.expectedPath, ctPathPngPath),
      chromiumVsDomotionPath: await compareCoverage(comparePage, item.expectedPath, item.domotion.coldPngPath),
      nativeMaskVsCoreTextPath: await compareCoverage(comparePage, native.maskPath, ctPathPngPath),
      coreTextPathVsDomotionPath: await compareCoverage(comparePage, ctPathPngPath, item.domotion.coldPngPath),
    };
    const selected = item.domotion.provenance.selected;
    const sourceSha = selected.sourceFile?.sha256 ?? "";
    const target = item.target;
    const row: SfnsOracleRow = {
      id: item.scenario.id,
      mutation: item.scenario.mutation,
      requestedAxes: item.scenario.axes,
      chromiumAxes: item.cssom.chromiumAxes,
      nativeAxes: native.actualAxes,
      domotionAxes: selected.variationAxes ?? {},
      nativeGlyphIds: native.suppliedGlyphIds,
      nativeMappedGlyphIds: native.mappedGlyphIds,
      domotionGlyphIds: item.domotion.provenance.glyphs.map((glyph) => glyph.id),
      rawOrigins: item.rawOrigins,
      quarterPixelOrigins: item.quarterOrigins,
      nativeOrigins: native.positions.map((position) => position.x),
      nativeBaselines: native.positions.map((position) => position.baselineY),
      domotionOrigins: item.domotion.emittedOriginsRaw.map(quantizeQuarter),
      domotionEmittedOriginsRaw: item.domotion.emittedOriginsRaw,
      sizes: { logical: item.cssom.logicalSize, computed: item.cssom.computedSize, paint: item.cssom.paintSize },
      sourceIdentity: {
        chromiumPostscriptName: item.chromiumPostscriptName,
        chromiumCustomFont: item.chromiumCustomFont,
        chromiumSourceSha256: fontSha256,
        nativePostscriptName: native.postscriptName,
        domotionPostscriptName: selected.instantiatedPostscriptName ?? selected.postscriptName ?? "",
        domotionSourcePath: selected.sourcePath ?? "",
        domotionSourceSha256: sourceSha,
      },
      pathCommandCounts: {
        native: native.glyphPaths.map((glyph) => glyph.commandCount),
        domotion: item.domotion.provenance.glyphs.map((glyph) => glyph.sourceOutline?.commandCount ?? null),
      },
      designCommandDigests: {
        native: designCommandDigest(native.glyphPaths
          .filter((glyph) => glyph.designSvgPath !== "")
          .map((glyph) => glyph.designSvgPath)),
        domotion: designCommandDigest(domotionUsePaths(item.domotion.coldSvg)),
      },
      outlineDispositions: item.domotion.provenance.glyphs.map(
        (glyph) => glyph.outlineDisposition ?? "missing-disposition",
      ),
      pathGeometry: comparePathGeometry(native, item.domotion.coldSvg, item.domotion.emittedScale),
      baseline: {
        rangeTop: item.cssom.rangeTop,
        capturedTextTop: target.textTop ?? Number.NaN,
        capturedAscent: target.fontAscent ?? Number.NaN,
        capturedDescent: target.fontDescent ?? Number.NaN,
        capturedBaseline: (target.textTop ?? Number.NaN) + (target.fontAscent ?? Number.NaN),
        capturedBaselineQuarterPixel: quantizeQuarter(
          (target.textTop ?? Number.NaN) + (target.fontAscent ?? Number.NaN),
        ),
        emittedBaseline: item.domotion.emittedBaseline,
        browserCanvasAscent: item.cssom.canvasAscent,
        browserCanvasDescent: item.cssom.canvasDescent,
        nativeAscent: native.metrics.ascent,
        nativeDescent: native.metrics.descent,
        nativeLeading: native.metrics.leading,
        nativeBoundingBox: native.metrics.boundingBox,
      },
      lifecycle: {
        chromiumColdSha256: item.chromiumLifecycle.coldSha256,
        chromiumWarmSha256: item.chromiumLifecycle.warmSha256,
        nativeColdMaskSha256: [sha256(readFileSync(native.maskPath)), sha256(readFileSync(nativeB.maskPath))],
        nativeColdPathSha256: [nativePathDigest(native), nativePathDigest(nativeB)],
        nativeWarmMaskSha256: [sha256(readFileSync(nativeWarmA.maskPath)), sha256(readFileSync(nativeWarmB.maskPath))],
        nativeWarmPathSha256: [nativePathDigest(nativeWarmA), nativePathDigest(nativeWarmB)],
        domotionColdSha256: item.domotion.coldSha256,
        domotionWarmSha256: item.domotion.warmSha256,
      },
      comparisons,
      stageDigests: {
        chromium: sha256(readFileSync(item.expectedPath)),
        nativeMask: sha256(readFileSync(native.maskPath)),
        coreTextPath: nativePathDigest(native),
        domotionPath: domotionPathDigest(item.domotion.coldSvg),
      },
      artifactPaths: {
        chromiumPng: item.expectedPath,
        nativeMaskPng: native.maskPath,
        coreTextPathSvg: ctPathSvgPath,
        coreTextPathPng: ctPathPngPath,
        domotionPathSvg: item.domotion.coldSvgPath,
        domotionPathPng: item.domotion.coldPngPath,
      },
    };
    rows.push(row);
  }

  const classifications = rows.map((row) => ({ id: row.id, ...classifySfnsOracleRow(row) }));
  const base = rows.find((row) => row.id === "zoom-2")!;
  const mutation = rows.find((row) => row.id === "opsz-26-mutation")!;
  const mutationControlMoved = base.stageDigests.chromium !== mutation.stageDigests.chromium
    && base.stageDigests.nativeMask !== mutation.stageDigests.nativeMask
    && base.stageDigests.coreTextPath !== mutation.stageDigests.coreTextPath
    && base.stageDigests.domotionPath !== mutation.stageDigests.domotionPath;
  const artifact: SfnsOracleArtifact = {
    schemaVersion: 2,
    authority: "diagnostic-only",
    arm,
    observationId: `${arm}:${process.pid}:${Date.now()}:${randomUUID()}`,
    logicalDigest: "",
    environment: {
      platform: "darwin",
      chromiumRevision: CHROMIUM_REVISION,
      skiaRevision: SKIA_REVISION,
      fontPath: FONT_PATH,
      fontSha256,
      deviceScaleFactor: 1,
      chromiumVersion: await browser.version(),
      osVersion: osVersion(),
      arch: arch(),
      helper: { available: true, path: helperPath, sha256: helperSha256 },
    },
    rows,
    classifications,
    mutationControlMoved,
  };
  artifact.logicalDigest = sfnsOutlineLogicalDigest(artifact);
  const errors = exactGateMode
    ? validateSfnsExactOutlineArtifact(artifact)
    : validateSfnsOracleArtifact(artifact);
  const reportPath = join(outputDirectory, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`SFNS mask/baseline oracle: ${rows.length} rows; mutation moved=${mutationControlMoved}`);
  for (const result of classifications) {
    const row = rows.find((candidate) => candidate.id === result.id)!;
    console.log(`${result.id}: ${result.classification}; closest=${result.closestRepresentation}; baseline shifts mask/path/domotion=${result.baselineResidual.nativeMaskBestIntegerYOffset}/${result.baselineResidual.coreTextPathBestIntegerYOffset}/${result.baselineResidual.domotionPathBestIntegerYOffset}; CT-path↔Domotion changed=${row.comparisons.coreTextPathVsDomotionPath.changedPixels}; max path delta=${row.pathGeometry.maxPaintPixelDelta.toFixed(6)}px`);
  }
  console.log(`wrote ${reportPath}`);
  if (errors.length > 0) {
    console.error(`oracle integrity failure: ${errors.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  setTextRunProvenanceEnabled(false);
  setRenderTextMode("embedded-font");
  await context.close();
  await browser.close();
}
