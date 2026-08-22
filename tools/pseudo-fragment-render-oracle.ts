#!/usr/bin/env tsx
/** DM-2468 live Chromium-vs-SVG generated-pseudo paint oracle. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement, CapturedPseudoFragmentSet } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { pseudoFragmentRecordErrors } from "../src/render/pseudo-fragments.js";

const WIDTH = 820;
const HEIGHT = 1460;
const TARGET = { red: 207, green: 0, blue: 159 };

export const pseudoRenderRequiredStates = [
  "before", "after", "child-first", "child-last", "one-line", "two-lines", "three-lines",
  "vertical-align:baseline", "vertical-align:middle", "vertical-align:text-top", "vertical-align:text-bottom",
  "vertical-align:top", "vertical-align:bottom", "vertical-align:sub", "vertical-align:super",
  "vertical-align:length", "vertical-align:percent", "mixed-fallback-fonts", "mixed-font-sizes",
  "LTR", "RTL", "vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr",
  "text-url-text", "asymmetric-edges", "slice", "clone", "multicol", "inline-block", "flex", "grid",
  "absolute", "fixed", "affine-transform", "zoom", "DPR:1", "DPR:2",
  "content:none", "display:none", "visibility:hidden", "opacity:0",
  "ordinary-text-unaffected", "first-letter-unaffected", "line-clamp-unaffected", "list-marker-unaffected",
] as const;

export function pseudoFragmentRenderFixture(): string {
  const align = ["baseline", "middle", "text-top", "text-bottom", "top", "bottom", "sub", "super", "7px", "45%"];
  const alignRules = align.map((value, index) => `#va${index}::before{content:"V${index}";vertical-align:${value}}`).join("");
  const alignHtml = align.map((_, index) => `<span class="probe va" id="va${index}"><b>T</b></span>`).join("");
  const image = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='9'%3E%3Crect width='11' height='9' fill='rgb(207,0,159)'/%3E%3C/svg%3E`;
  return `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:white}body{font:16px/22px Arial,sans-serif;color:#17212b}
    #stage{width:${WIDTH}px;height:${HEIGHT}px;padding:18px;display:block}
    .probe{display:block;width:178px;min-height:34px;margin:5px;padding:2px;background:rgb(245,247,249)}
    .probe::before,.probe::after{color:rgb(${TARGET.red},${TARGET.green},${TARGET.blue});border-color:rgb(${TARGET.red},${TARGET.green},${TARGET.blue})}
    #before::before{content:"BEFORE ";font-weight:700}#after::after{content:" AFTER";font-style:italic}
    #wrap1{width:178px}#wrap1::before{content:"one"}#wrap2{width:75px}#wrap2::before{content:"one two three"}#wrap3{width:58px}#wrap3::after{content:"one two three four five"}
    .va{display:inline-block;width:68px;height:52px;line-height:44px}.va b{font-size:27px}.va::before{font-size:13px;border-block:1px solid}
    ${alignRules}
    #fallback::before{content:"Latin 漢 😀 Ω";font:700 18px/27px Georgia,"Arial Unicode MS",serif}
    #rtl{direction:rtl}#rtl::after{content:"אבג (12) xyz";unicode-bidi:isolate}
    .vertical{display:inline-block;width:64px;height:122px;vertical-align:top}.vertical::before,.vertical::after{content:"縦A";border:1px solid;padding:2px}
    #vrl{writing-mode:vertical-rl}#vlr{writing-mode:vertical-lr}#srl{writing-mode:sideways-rl}#slr{writing-mode:sideways-lr}
    #vlr::before,#slr::before{content:none}#vlr::after,#slr::after{content:"縦A"}
    #mixed::before{content:"L" url("${image}") "R";border:1px solid;padding:3px}
    #slice,#clone{width:82px;line-height:18px}#slice::before,#clone::after{content:"asymmetric edge ownership wraps";border-inline-start:2px solid;border-inline-end:5px solid;border-block-start:1px solid;border-block-end:3px solid;padding-inline:3px 7px;background:rgba(207,0,159,.18)}
    #slice::before{box-decoration-break:slice}#clone::after{box-decoration-break:clone}
    #columns{width:360px;height:92px;columns:3;column-gap:24px;column-fill:auto;line-height:18px}#columns::before{content:"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four";background:rgba(207,0,159,.18)}
    #ib{display:inline-block}#ib::before{content:"inline-block"}#flex{display:flex}#flex::after{content:"flex"}#grid{display:grid}#grid::before{content:"grid"}
    #absolute{position:relative;height:45px}#absolute::before{content:"absolute";position:absolute;left:31px;top:8px;border:1px solid}
    #fixed::after{content:"fixed";position:fixed;left:650px;top:25px;border:1px solid}
    #transform{transform:rotate(4deg) translate(4px,2px);transform-origin:20% 65%}#transform::after{content:"affine";border:1px solid}
    #zoom{zoom:1.25}#zoom::before{content:"zoom";border:1px solid}
    #none::before{content:none}#display-none::before{content:"display";display:none}#hidden::before{content:"hidden";visibility:hidden}#transparent::after{content:"transparent";opacity:0}
    #negative{position:relative}#negative::before{content:"negative";position:absolute;z-index:-1;background:rgb(${TARGET.red},${TARGET.green},${TARGET.blue});color:white;left:20px;top:2px}
    #ordinary::first-letter{font-size:31px;color:#0055aa}#clamp{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;width:80px}li::marker{color:#0055aa}
  </style><main id="stage">
    <div class="probe" id="before">host child-last</div><div class="probe" id="after"><span>child-first</span></div>
    <div class="probe" id="wrap1"></div><div class="probe" id="wrap2"></div><div class="probe" id="wrap3"></div>
    <div>${alignHtml}</div><div class="probe" id="fallback"></div><div class="probe" id="rtl"></div>
    <div><span class="vertical" id="vrl"></span><span class="vertical" id="vlr"></span><span class="vertical" id="srl"></span><span class="vertical" id="slr"></span></div>
    <div class="probe" id="mixed"></div><div class="probe" id="slice"></div><div class="probe" id="clone"></div><div class="probe" id="columns"></div>
    <span class="probe" id="ib"></span><div class="probe" id="flex"></div><div class="probe" id="grid"></div>
    <div class="probe" id="absolute"></div><div class="probe" id="fixed"></div><div class="probe" id="transform"></div><div class="probe" id="zoom"></div>
    <div class="probe" id="none"></div><div class="probe" id="display-none"></div><div class="probe" id="hidden"></div><div class="probe" id="transparent"></div><div class="probe" id="negative"></div>
    <p id="ordinary">ordinary first-letter unaffected</p><p id="clamp">ordinary clamped text remains ordinary</p><ul><li>list marker unaffected</li></ul>
  </main>`;
}

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

async function targetEdges(png: Buffer): Promise<{ width: number; height: number; edges: Uint8Array; count: number }> {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index++) {
    const red = decoded.data[index * channels];
    const green = decoded.data[index * channels + 1];
    const blue = decoded.data[index * channels + 2];
    if (red > 110 && blue > 75 && green < 115 && red + blue > green * 3) mask[index] = 1;
  }
  const edges = new Uint8Array(mask.length);
  let count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = y * width + x;
    if (mask[index] === 0) continue;
    if (mask[index - 1] === 0 || mask[index + 1] === 0 || mask[index - width] === 0 || mask[index + width] === 0) {
      edges[index] = 1;
      count++;
    }
  }
  return { width, height, edges, count };
}

function directedEdgeDistance(source: Awaited<ReturnType<typeof targetEdges>>, target: Awaited<ReturnType<typeof targetEdges>>, radius: number): { max: number; misses: number } {
  let max = 0;
  let misses = 0;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if (source.edges[y * source.width + x] === 0) continue;
    let best = Number.POSITIVE_INFINITY;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      // The acceptance threshold is a Euclidean device-pixel radius, not a
      // square/Chebyshev neighborhood. Excluding diagonal points outside the
      // disk keeps the search and reported maximum on one unchanged 4px
      // criterion instead of admitting sqrt(4^2 + 4^2) as an accidental 4px
      // match.
      if (dx * dx + dy * dy > radius * radius) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height || target.edges[ty * target.width + tx] === 0) continue;
      best = Math.min(best, Math.hypot(dx, dy));
    }
    if (!Number.isFinite(best)) misses++;
    else max = Math.max(max, best);
  }
  return { max, misses };
}

export interface PseudoRenderOracleRow {
  dpr: number;
  exactRecords: number;
  terminalRecords: number;
  terminalReasons: string[];
  renderedRecords: number;
  sourceEdges: number;
  renderedEdges: number;
  maxEdgeDistanceDevicePixels: number;
  unmatchedSourceEdges: number;
  unmatchedRenderedEdges: number;
  structuralErrors: string[];
  pass: boolean;
}

export interface PseudoRenderOracleReport {
  schemaVersion: 1;
  chromiumVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  toleranceDevicePixels: 4;
  requiredStates: readonly string[];
  rows: PseudoRenderOracleRow[];
  verdict: "source-exact" | "source-drift";
}

export async function runPseudoFragmentRenderOracle(
  dprs: number[] = [1, 2],
  artifactDir?: string,
): Promise<PseudoRenderOracleReport> {
  const browser = await chromium.launch({ headless: true });
  const rows: PseudoRenderOracleRow[] = [];
  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      await source.setContent(pseudoFragmentRenderFixture(), { waitUntil: "load" });
      await source.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const sourcePng = Buffer.from(await source.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }));
      const captured = await captureElementTreeWithWarnings(source, "#stage", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      const records = flatten(captured.tree).flatMap((element) => element.pseudoFragments ?? []);
      const exact = records.filter((record) => record.status === "exact");
      const terminal = records.filter((record) => record.status === "terminal-raster");
      const structuralErrors = exact.flatMap((record, index) => pseudoFragmentRecordErrors(record).map((error) => `${index}:${error}`));
      const svg = elementTreeToSvg(captured.tree, WIDTH, HEIGHT);
      if (artifactDir != null) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.svg`, svg);
      }
      const renderedRecords = (svg.match(/data-domotion-pseudo-source="blink-pseudo-fragment-v1"/g) ?? []).length;
      const rendered = await context.newPage();
      await rendered.setContent(`<!doctype html><style>html,body{margin:0;background:white}</style>${svg}`, { waitUntil: "load" });
      await rendered.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
      const renderedPng = Buffer.from(await rendered.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }));
      if (artifactDir != null) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(`${artifactDir}/source-dpr${dpr}.png`, sourcePng);
        writeFileSync(`${artifactDir}/rendered-dpr${dpr}.png`, renderedPng);
      }
      const [sourceMask, renderedMask] = await Promise.all([targetEdges(sourcePng), targetEdges(renderedPng)]);
      // Screenshot buffers are already in device-pixel coordinates at every
      // deviceScaleFactor. Keep the acceptance disk at four DEVICE pixels;
      // multiplying here would silently weaken DPR2 to an eight-pixel gate.
      const radius = 4;
      const forward = directedEdgeDistance(sourceMask, renderedMask, radius);
      const reverse = directedEdgeDistance(renderedMask, sourceMask, radius);
      const expectedRendered = records.filter((record: CapturedPseudoFragmentSet) =>
        record.status !== "unpainted"
        && record.paint.visibility !== "hidden" && record.paint.visibility !== "collapse"
        && record.paint.opacity !== 0).length;
      rows.push({
        dpr,
        exactRecords: exact.length,
        terminalRecords: terminal.length,
        terminalReasons: terminal.map((record) => `${record.pseudo}:${record.reason ?? "unknown"}`),
        renderedRecords,
        sourceEdges: sourceMask.count,
        renderedEdges: renderedMask.count,
        maxEdgeDistanceDevicePixels: Math.max(forward.max, reverse.max),
        unmatchedSourceEdges: forward.misses,
        unmatchedRenderedEdges: reverse.misses,
        structuralErrors,
        pass: structuralErrors.length === 0
          && terminal.length === 0
          && renderedRecords === expectedRendered
          && sourceMask.count > 0 && renderedMask.count > 0
          && forward.misses === 0 && reverse.misses === 0
          && Math.max(forward.max, reverse.max) <= radius,
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
    toleranceDevicePixels: 4,
    requiredStates: pseudoRenderRequiredStates,
    rows,
    verdict: rows.every((row) => row.pass) ? "source-exact" : "source-drift",
  };
}

async function main(): Promise<void> {
  const outputIndex = process.argv.indexOf("--json");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const artifactIndex = process.argv.indexOf("--artifact-dir");
  const artifactDir = artifactIndex >= 0 ? process.argv[artifactIndex + 1] : undefined;
  const report = await runPseudoFragmentRenderOracle(undefined, artifactDir);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output != null) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json);
  } else process.stdout.write(json);
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
