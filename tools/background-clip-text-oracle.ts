#!/usr/bin/env tsx
/** DM-2366 live Chromium-vs-vector background-clip:text paint oracle. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

const WIDTH = 760;
const HEIGHT = 650;
const EDGE_RADIUS_DEVICE_PIXELS = 4;

const SIGNALS = [
  [0, 190, 255],
  [246, 42, 132],
  [36, 204, 112],
  [255, 145, 0],
] as const;

export const backgroundClipTextRequiredStates = [
  "url-image", "background-color", "bottom-layer-color", "multiple-layers",
  "transparent-fill", "opaque-fill", "text-stroke", "inherited-descendant",
  "fragmented-inline", "slice", "clone", "background-size",
  "background-position", "background-repeat", "background-origin",
  "DPR:1", "DPR:2", "vector-text-only",
] as const;

const TILE = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='16' viewBox='0 0 24 16'%3E%3Cpath fill='rgb(0,190,255)' d='M0 0h8v16H0z'/%3E%3Cpath fill='rgb(246,42,132)' d='M16 0h8v16h-8z'/%3E%3C/svg%3E`;

export function backgroundClipTextFixture(): string {
  return `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:white}body{font:700 42px/1.08 Arial,sans-serif;color:#101827}
    #stage{width:${WIDTH}px;height:${HEIGHT}px;padding:22px;background:white}
    .row{display:block;margin:0 0 18px 0;min-height:52px}
    .clip{color:transparent;-webkit-text-fill-color:transparent;background-clip:text;-webkit-background-clip:text}
    #url{background-image:url("${TILE}");background-size:24px 16px;background-position:7px 5px;background-repeat:repeat;background-origin:content-box;padding:3px 11px}
    #color{background-color:rgb(36,204,112)}
    #stack{background-color:rgb(255,145,0);background-image:linear-gradient(90deg,rgba(255,255,255,0) 45%,rgba(246,42,132,.58)),url("${TILE}");background-size:100% 100%,31px 19px;background-position:0 0,right 9px bottom 3px;background-repeat:no-repeat,repeat-x;background-clip:text,text;-webkit-background-clip:text,text}
    #opaque{color:rgba(16,24,39,.46);-webkit-text-fill-color:rgba(16,24,39,.46);-webkit-text-stroke:3px rgba(246,42,132,.72);background-image:url("${TILE}");background-size:29px 17px;background-position:5px 2px;background-repeat:repeat;background-clip:text;-webkit-background-clip:text}
    #owner{display:inline-block;background-color:rgb(255,145,0);background-image:url("${TILE}");background-size:27px 15px;background-position:4px 3px;background-repeat:repeat;background-clip:text;-webkit-background-clip:text;color:transparent;-webkit-text-fill-color:transparent}
    #owner b{font:700 38px/1.1 Arial,sans-serif}
    #wraps{display:flex;gap:28px;align-items:flex-start}.wrap{display:inline;width:218px;font-size:34px;line-height:39px;color:transparent;-webkit-text-fill-color:transparent;background-image:url("${TILE}");background-size:33px 17px;background-position:9px 4px;background-repeat:repeat;background-origin:content-box;background-clip:text;-webkit-background-clip:text;padding-inline:5px}
    #slice{box-decoration-break:slice;-webkit-box-decoration-break:slice}#clone{box-decoration-break:clone;-webkit-box-decoration-break:clone}
  </style><main id="stage">
    <p class="row clip" id="url">URL TILE POSITION</p>
    <p class="row clip" id="color">COLOR ONLY MASK</p>
    <p class="row clip" id="stack">COLOR + TWO LAYERS</p>
    <p class="row" id="opaque">OPAQUE FILL + STROKE</p>
    <p class="row"><span id="owner"><b>DESCENDANT OWNER</b></span></p>
    <div id="wraps"><span class="wrap" id="slice">SLICE WRAPS ACROSS THREE LINES EXACTLY</span><span class="wrap" id="clone">CLONE RESTARTS ACROSS THREE LINES EXACTLY</span></div>
  </main>`;
}

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function removeTextRasterEscape(tree: CapturedElement[]): string[] {
  const errors: string[] = [];
  for (const element of flatten(tree)) {
    const identity = element.animId ?? element.tag;
    if (element.elementRaster != null) errors.push(`${identity}:elementRaster`);
    if (element.transformSubtreeRaster != null) errors.push(`${identity}:transformSubtreeRaster`);
    element.elementRaster = undefined;
    element.transformSubtreeRaster = undefined;
    for (const segment of element.textSegments ?? []) {
      const paintedRasterGlyph = segment.rasterGlyphs?.some((glyph) => glyph.dataUri != null) === true;
      if (segment.rasterDataUri != null || paintedRasterGlyph) {
        errors.push(`${identity}:segment-raster`);
      }
      // Candidate geometry without pixel data is not a raster paint owner,
      // but remove the whole escape shape anyway so this leg can only emit
      // path/text glyphs even if a later renderer starts interpreting it.
      segment.rasterDataUri = undefined;
      segment.rasterRect = undefined;
      segment.rasterGlyphs = undefined;
    }
  }
  return errors;
}

async function signalEdges(png: Buffer): Promise<{ width: number; height: number; edges: Uint8Array; pixels: number; count: number }> {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  const mask = new Uint8Array(width * height);
  let pixels = 0;
  for (let index = 0; index < width * height; index++) {
    const red = decoded.data[index * channels];
    const green = decoded.data[index * channels + 1];
    const blue = decoded.data[index * channels + 2];
    const signal = SIGNALS.some(([sr, sg, sb]) => Math.hypot(red - sr, green - sg, blue - sb) <= 72);
    if (signal) { mask[index] = 1; pixels++; }
  }
  const edges = new Uint8Array(mask.length);
  let count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = y * width + x;
    if (mask[index] === 0) continue;
    if (mask[index - 1] === 0 || mask[index + 1] === 0 || mask[index - width] === 0 || mask[index + width] === 0) {
      edges[index] = 1; count++;
    }
  }
  return { width, height, edges, pixels, count };
}

function directedDistance(
  source: Awaited<ReturnType<typeof signalEdges>>,
  target: Awaited<ReturnType<typeof signalEdges>>,
): { max: number; misses: number } {
  let max = 0;
  let misses = 0;
  const radius = EDGE_RADIUS_DEVICE_PIXELS;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if (source.edges[y * source.width + x] === 0) continue;
    let best = Number.POSITIVE_INFINITY;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      if (target.edges[ty * target.width + tx] !== 0) best = Math.min(best, Math.hypot(dx, dy));
    }
    if (!Number.isFinite(best)) misses++;
    else max = Math.max(max, best);
  }
  return { max, misses };
}

export interface BackgroundClipTextOracleRow {
  dpr: number;
  capturedUrlLayers: number;
  alphaMasks: number;
  vectorPatterns: number;
  sourceSignalPixels: number;
  renderedSignalPixels: number;
  sourceEdges: number;
  renderedEdges: number;
  maxEdgeDistanceDevicePixels: number;
  unmatchedSourceEdges: number;
  unmatchedRenderedEdges: number;
  structuralErrors: string[];
  pass: boolean;
}

export interface BackgroundClipTextOracleReport {
  schemaVersion: 1;
  chromiumVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  toleranceDevicePixels: 4;
  requiredStates: readonly string[];
  rows: BackgroundClipTextOracleRow[];
  verdict: "source-exact" | "source-drift";
}

export async function runBackgroundClipTextOracle(
  dprs: number[] = [1, 2],
  artifactDir?: string,
): Promise<BackgroundClipTextOracleReport> {
  const browser = await chromium.launch({ headless: true });
  const rows: BackgroundClipTextOracleRow[] = [];
  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      await source.setContent(backgroundClipTextFixture(), { waitUntil: "load" });
      await source.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const sourcePng = Buffer.from(await source.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }));
      const captured = await captureElementTreeWithWarnings(source, "#stage", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      const flat = flatten(captured.tree);
      const structuralErrors = removeTextRasterEscape(captured.tree);
      const urlRecords = flat.flatMap((element) => element.styles.backgroundImages ?? []).filter((record) => record != null);
      const loadedUrlRecords = urlRecords.filter((record) => record?.loadState === "loaded");
      if (loadedUrlRecords.length < 5) structuralErrors.push(`expected >=5 loaded URL layer records, received ${loadedUrlRecords.length}`);
      if (urlRecords.some((record) => record?.loadState !== "loaded" || record.naturalSizingState !== "resolved")) {
        structuralErrors.push("URL selected candidate/natural sizing record was not exact");
      }
      const svg = elementTreeToSvg(captured.tree, WIDTH, HEIGHT);
      const alphaMasks = (svg.match(/mask-type:alpha/g) ?? []).length;
      const vectorPatterns = (svg.match(/<pattern id="bg/g) ?? []).length;
      if (alphaMasks < 6) structuralErrors.push(`expected >=6 alpha glyph masks, received ${alphaMasks}`);
      if (vectorPatterns < 5) structuralErrors.push(`expected >=5 URL pattern defs, received ${vectorPatterns}`);
      if (/<image[^>]+(?:elementRaster|transformSubtreeRaster)/.test(svg)) structuralErrors.push("text raster marker reached SVG");
      if (!/fill="rgb\(36,\s*204,\s*112\)"[^>]+mask="url\(#tbgm/.test(svg)) structuralErrors.push("color-only masked fill missing");
      if (!/fill="rgb\(255,\s*145,\s*0\)"[^>]+mask="url\(#tbgm/.test(svg)) structuralErrors.push("bottom-layer masked color missing");

      const rendered = await context.newPage();
      await rendered.setContent(`<!doctype html><style>html,body{margin:0;background:white}</style>${svg}`, { waitUntil: "load" });
      await rendered.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
      const renderedPng = Buffer.from(await rendered.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }));
      if (artifactDir != null) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(`${artifactDir}/source-dpr${dpr}.png`, sourcePng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.png`, renderedPng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.svg`, svg);
      }
      const [sourceSignal, renderedSignal] = await Promise.all([signalEdges(sourcePng), signalEdges(renderedPng)]);
      const forward = directedDistance(sourceSignal, renderedSignal);
      const reverse = directedDistance(renderedSignal, sourceSignal);
      const unmatchedSourceRatio = sourceSignal.count === 0 ? 1 : forward.misses / sourceSignal.count;
      const unmatchedRenderedRatio = renderedSignal.count === 0 ? 1 : reverse.misses / renderedSignal.count;
      const pixelRatio = sourceSignal.pixels === 0 ? 0 : renderedSignal.pixels / sourceSignal.pixels;
      const pass = structuralErrors.length === 0
        && sourceSignal.count > 0 && renderedSignal.count > 0
        && unmatchedSourceRatio <= 0.025 && unmatchedRenderedRatio <= 0.025
        && pixelRatio >= 0.82 && pixelRatio <= 1.18;
      rows.push({
        dpr,
        capturedUrlLayers: loadedUrlRecords.length,
        alphaMasks,
        vectorPatterns,
        sourceSignalPixels: sourceSignal.pixels,
        renderedSignalPixels: renderedSignal.pixels,
        sourceEdges: sourceSignal.count,
        renderedEdges: renderedSignal.count,
        maxEdgeDistanceDevicePixels: Math.max(forward.max, reverse.max),
        unmatchedSourceEdges: forward.misses,
        unmatchedRenderedEdges: reverse.misses,
        structuralErrors,
        pass,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return {
    schemaVersion: 1,
    chromiumVersion: browser.version(),
    platform: process.platform,
    architecture: process.arch,
    toleranceDevicePixels: EDGE_RADIUS_DEVICE_PIXELS,
    requiredStates: backgroundClipTextRequiredStates,
    rows,
    verdict: rows.every((row) => row.pass) ? "source-exact" : "source-drift",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf("--json");
  const artifactAt = args.indexOf("--artifact-dir");
  const dprAt = args.indexOf("--dpr");
  const jsonPath = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const artifactDir = artifactAt >= 0 ? args[artifactAt + 1] : undefined;
  const dprs = dprAt >= 0 ? args[dprAt + 1].split(",").map(Number).filter(Number.isFinite) : [1, 2];
  const report = await runBackgroundClipTextOracle(dprs, artifactDir);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonPath != null) { mkdirSync(dirname(jsonPath), { recursive: true }); writeFileSync(jsonPath, body); }
  process.stdout.write(body);
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
