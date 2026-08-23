#!/usr/bin/env tsx
/**
 * DM-2488 release oracle for generated-pseudo backdrop source ownership.
 *
 * The corpus is intentionally independent of the SVG paint planner: live
 * Chromium supplies pseudo backend nodes and final pixels, DOMSnapshot-owned
 * records identify the exact pseudo slot, and destructive under-/over-capture
 * mutations prove that a merely plausible final image cannot pass.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { Page } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type { CapturedElement, CapturedPseudoFragmentSet } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import {
  pseudoFragmentPaintSlot,
  renderPseudoFragmentRecord,
  type PseudoFragmentPaintSlot,
} from "../src/render/pseudo-fragments.js";

export const PSEUDO_BACKDROP_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const PSEUDO_BACKDROP_REQUIRED_STATES = [
  "active", "none", "hidden", "empty",
  "before", "after", "checkmark",
  "positioned", "negative", "positive",
  "ancestor-root", "zoom", "nested", "overlapping",
] as const;

export const PSEUDO_BACKDROP_THRESHOLDS = {
  sourceMeanAbsoluteChannelDelta: 7,
  changedPixelChannel: 4,
  mutationMinChangedFraction: .002,
  mutationMinChannelDelta: 16,
} as const;

const CELL_WIDTH = 190;
const CELL_HEIGHT = 132;
const COLUMNS = 4;

interface CaseSpec {
  id: string;
  pseudo: "::checkmark" | "::before" | "::after";
  slot: PseudoFragmentPaintSlot;
  active: boolean;
  states: readonly (typeof PSEUDO_BACKDROP_REQUIRED_STATES)[number][];
}

export const PSEUDO_BACKDROP_CASES: readonly CaseSpec[] = [
  { id: "before-text", pseudo: "::before", slot: "before", active: true, states: ["active", "before"] },
  { id: "after-image", pseudo: "::after", slot: "after", active: true, states: ["after"] },
  { id: "positioned", pseudo: "::before", slot: "positioned", active: true, states: ["positioned"] },
  { id: "negative", pseudo: "::before", slot: "negative", active: true, states: ["negative"] },
  { id: "positive", pseudo: "::after", slot: "positive", active: true, states: ["positive"] },
  { id: "ancestor-root", pseudo: "::before", slot: "positioned", active: true, states: ["ancestor-root"] },
  { id: "zoom", pseudo: "::before", slot: "positioned", active: true, states: ["zoom"] },
  { id: "nested-outer", pseudo: "::before", slot: "positioned", active: true, states: ["nested"] },
  { id: "nested-inner", pseudo: "::after", slot: "positioned", active: true, states: ["nested"] },
  { id: "overlap-a", pseudo: "::before", slot: "positioned", active: true, states: ["overlapping"] },
  { id: "overlap-b", pseudo: "::after", slot: "positive", active: true, states: ["overlapping"] },
  { id: "checkmark", pseudo: "::checkmark", slot: "before", active: true, states: ["checkmark"] },
  { id: "none", pseudo: "::before", slot: "positioned", active: false, states: ["none"] },
  { id: "hidden", pseudo: "::after", slot: "positioned", active: false, states: ["hidden"] },
  { id: "empty", pseudo: "::before", slot: "before", active: false, states: ["empty"] },
] as const;

export const PSEUDO_BACKDROP_VIEWPORT = {
  width: CELL_WIDTH * COLUMNS,
  height: CELL_HEIGHT * Math.ceil(PSEUDO_BACKDROP_CASES.length / COLUMNS),
} as const;

const tinyImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='16'%3E%3Crect width='22' height='16' rx='4' fill='%23ffcf33'/%3E%3Cpath d='M3 12L10 4l9 8' fill='none' stroke='%23561d86' stroke-width='3'/%3E%3C/svg%3E";

function cell(spec: CaseSpec, index: number): string {
  const style = `left:${index % COLUMNS * CELL_WIDTH}px;top:${Math.floor(index / COLUMNS) * CELL_HEIGHT}px`;
  if (spec.id === "checkmark") {
    return `<section class="case case-${spec.id}" style="${style}"><div class="under"></div><input id="${spec.id}" data-domotion-anim="${spec.id}" type="checkbox" checked></section>`;
  }
  return `<section class="case case-${spec.id}" style="${style}"><div class="under"></div><div class="ancestor"><div id="${spec.id}" data-domotion-anim="${spec.id}" class="host"><span class="host-child"></span></div></div></section>`;
}

export function pseudoBackdropFixtureHtml(): string {
  const cells = PSEUDO_BACKDROP_CASES.map(cell).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:#0d1730}body{overflow:hidden}
    #stage{position:relative;width:${PSEUDO_BACKDROP_VIEWPORT.width}px;height:${PSEUDO_BACKDROP_VIEWPORT.height}px;background:#172342;overflow:hidden}
    .case{position:absolute;width:180px;height:122px;margin:5px;overflow:hidden;border:2px solid #43587e;border-radius:8px;background:#15203b;isolation:isolate}
    .under{position:absolute;inset:0;background:#e5484d;border-left:56px solid #235fd0;border-bottom:39px solid #f7cb42;box-shadow:inset -42px 34px 0 #19a974}
    .ancestor{position:absolute;inset:0}.host{position:absolute;left:17px;top:14px;width:144px;height:88px;color:#f8fbff;font:700 17px/24px Arial,sans-serif}
    .host-child{position:absolute;left:92px;top:53px;width:42px;height:24px;background:rgba(242,44,116,.75);border:2px solid #50133d;border-radius:5px}
    .host::before,.host::after,#checkmark::checkmark{box-sizing:border-box;border:3px solid rgba(255,255,255,.72);border-radius:11px;background:rgba(232,244,255,.23);color:#fff;-webkit-backdrop-filter:blur(7px) saturate(1.4);backdrop-filter:blur(7px) saturate(1.4)}
    #before-text::before{content:"PX";display:inline-block;width:84px;height:48px;padding:8px}
    #after-image::after{content:url("${tinyImage}");display:inline-block;width:82px;height:49px;padding:10px;margin:17px 0 0 38px}
    #positioned::before,#negative::before,#zoom::before,#ancestor-root::before,#none::before{content:"";position:absolute;left:20px;top:15px;width:93px;height:57px}
    #positioned::before{z-index:auto}.case-negative #negative{z-index:0}#negative::before{z-index:-1}#positive::after{content:"+";position:absolute;left:27px;top:18px;width:92px;height:56px;padding:12px;z-index:3}
    .case-ancestor-root .ancestor{opacity:.73}.case-zoom .ancestor{zoom:1.25}.case-zoom .host{left:11px;top:9px}
    #nested-outer::before{content:"";position:absolute;left:6px;top:7px;width:118px;height:67px}
    #nested-outer .host-child{left:35px;top:24px;width:78px;height:47px;background:transparent;border:0}
    #nested-inner::after{content:"";position:absolute;left:31px;top:23px;width:82px;height:48px}
    #overlap-a::before{content:"A";position:absolute;left:8px;top:11px;width:96px;height:58px;padding:10px}
    #overlap-b::after{content:"B";position:absolute;left:47px;top:31px;width:88px;height:51px;padding:9px;z-index:2}
    #checkmark{appearance:base;position:absolute;left:55px;top:35px;width:58px;height:48px;margin:0;color:white;font-size:24px}
    #checkmark::checkmark{content:"◆" / "";display:block;width:46px;height:38px;padding:4px}
    #none::before{-webkit-backdrop-filter:none;backdrop-filter:none}
    #hidden::after{content:"hidden";position:absolute;left:18px;top:14px;width:96px;height:54px;visibility:hidden}
    #empty::before{content:"";display:block;width:0;height:0;border:0;background:transparent}
  </style></head><body><main id="stage">
    ${cells}
    <script>
      // The nested and overlap families use two independently correlated hosts
      // in the same cell so each pseudo receives its own backend/effect node.
      (function(){
        var nested=document.querySelector('.case-nested-outer');
        var inner=nested.querySelector('.host-child');inner.id='nested-inner';inner.setAttribute('data-domotion-anim','nested-inner');inner.className='host';
        var overlap=document.querySelector('.case-overlap-a');
        var second=overlap.querySelector('.host-child');second.id='overlap-b';second.setAttribute('data-domotion-anim','overlap-b');second.className='host';
      })();
    </script>
  </main></body></html>`;
}

interface DecodedImage { width: number; height: number; channels: number; data: Buffer }
export interface PseudoBackdropPixelComparison {
  pixels: number;
  changedPixels: number;
  changedFraction: number;
  meanAbsoluteChannelDelta: number;
  maxChannelDelta: number;
}

async function decode(png: Buffer): Promise<DecodedImage> {
  const result = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: result.info.width, height: result.info.height, channels: result.info.channels, data: result.data };
}

export function comparePseudoBackdropRegion(
  left: DecodedImage,
  right: DecodedImage,
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): PseudoBackdropPixelComparison {
  const x0 = Math.max(0, Math.floor(rect.x * dpr));
  const y0 = Math.max(0, Math.floor(rect.y * dpr));
  const x1 = Math.min(left.width, Math.ceil((rect.x + rect.width) * dpr));
  const y1 = Math.min(left.height, Math.ceil((rect.y + rect.height) * dpr));
  let pixels = 0;
  let changedPixels = 0;
  let sum = 0;
  let maximum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * left.width + x) * left.channels;
    let pixelMax = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(left.data[offset + channel] - right.data[offset + channel]);
      sum += delta;
      maximum = Math.max(maximum, delta);
      pixelMax = Math.max(pixelMax, delta);
    }
    if (pixelMax > PSEUDO_BACKDROP_THRESHOLDS.changedPixelChannel) changedPixels++;
    pixels++;
  }
  return {
    pixels,
    changedPixels,
    changedFraction: pixels === 0 ? 0 : changedPixels / pixels,
    meanAbsoluteChannelDelta: pixels === 0 ? 0 : sum / (pixels * 4),
    maxChannelDelta: maximum,
  };
}

function mutationDiscriminates(comparison: PseudoBackdropPixelComparison): boolean {
  return comparison.changedFraction >= PSEUDO_BACKDROP_THRESHOLDS.mutationMinChangedFraction
    && comparison.maxChannelDelta >= PSEUDO_BACKDROP_THRESHOLDS.mutationMinChannelDelta;
}

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function byAnimId(tree: CapturedElement[], id: string): CapturedElement | undefined {
  return flatten(tree).find((element) => element.animId === id);
}

function pseudoRecords(tree: CapturedElement[]): CapturedPseudoFragmentSet[] {
  return flatten(tree).flatMap((element) => element.pseudoFragments ?? []);
}

async function replaceWithFinalCrops(tree: CapturedElement[], source: Buffer, dpr: number): Promise<void> {
  const metadata = await sharp(source).metadata();
  await Promise.all(pseudoRecords(tree).flatMap((record) => {
    const raster = record.backdropFilterRaster;
    if (raster == null) return [];
    const left = Math.max(0, Math.floor(raster.rect.x * dpr));
    const top = Math.max(0, Math.floor(raster.rect.y * dpr));
    const right = Math.min(metadata.width ?? 0, Math.ceil((raster.rect.x + raster.rect.width) * dpr));
    const bottom = Math.min(metadata.height ?? 0, Math.ceil((raster.rect.y + raster.rect.height) * dpr));
    if (right <= left || bottom <= top) return [];
    return [sharp(source).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer()
      .then((png) => { raster.dataUri = `data:image/png;base64,${png.toString("base64")}`; })];
  }));
}

async function renderSvg(page: Page, svg: string): Promise<Buffer> {
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${PSEUDO_BACKDROP_VIEWPORT.width}px;height:${PSEUDO_BACKDROP_VIEWPORT.height}px}</style><img id="render" src="${uri}">`);
  await page.locator("#render").evaluate((image) => (image as HTMLImageElement).decode());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return Buffer.from(await page.screenshot({
    clip: { x: 0, y: 0, width: PSEUDO_BACKDROP_VIEWPORT.width, height: PSEUDO_BACKDROP_VIEWPORT.height },
    omitBackground: true,
    type: "png",
  }));
}

export interface PseudoBackdropOracleRow {
  id: string;
  pseudo: CaseSpec["pseudo"];
  dpr: number;
  expectedSlot: PseudoFragmentPaintSlot;
  actualSlot: PseudoFragmentPaintSlot | null;
  expectedRasterOwners: 0 | 1;
  actualRasterOwners: number;
  noHostWideRaster: boolean;
  sourceVsRendered: PseudoBackdropPixelComparison | null;
  underCapture: { applicable: boolean; comparison: PseudoBackdropPixelComparison | null; discriminated: boolean };
  overCapture: { applicable: boolean; comparison: PseudoBackdropPixelComparison | null; discriminated: boolean };
  rasterBeforeVector: boolean | null;
  findings: string[];
  pass: boolean;
}

export interface PseudoBackdropOracleReport {
  schemaVersion: 1;
  sourcePins: typeof PSEUDO_BACKDROP_SOURCE_PINS;
  producer: { chromiumVersion: string; platform: NodeJS.Platform; architecture: string };
  requiredStates: typeof PSEUDO_BACKDROP_REQUIRED_STATES;
  thresholds: typeof PSEUDO_BACKDROP_THRESHOLDS;
  rows: PseudoBackdropOracleRow[];
  warnings: string[];
  blockers: string[];
  verdict: "source-exact" | "source-drift";
}

export async function runPseudoBackdropSourceOracle(
  dprs: number[] = [1, 2],
  artifactDir?: string,
): Promise<PseudoBackdropOracleReport> {
  const browser = await launchChromium({ args: ["--enable-blink-features=AppearanceBase"] });
  const rows: PseudoBackdropOracleRow[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: PSEUDO_BACKDROP_VIEWPORT, deviceScaleFactor: dpr });
      const sourcePage = await context.newPage();
      const renderPage = await context.newPage();
      try {
        await sourcePage.setContent(pseudoBackdropFixtureHtml(), { waitUntil: "load" });
        await sourcePage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const source = Buffer.from(await sourcePage.screenshot({
          clip: { x: 0, y: 0, width: PSEUDO_BACKDROP_VIEWPORT.width, height: PSEUDO_BACKDROP_VIEWPORT.height },
          omitBackground: true,
          type: "png",
        }));
        const capture = await captureElementTreeWithWarnings(sourcePage, "#stage", {
          x: 0, y: 0, width: PSEUDO_BACKDROP_VIEWPORT.width, height: PSEUDO_BACKDROP_VIEWPORT.height,
        });
        warnings.push(...capture.warnings.map((warning) => `DPR${dpr}:${JSON.stringify(warning)}`));
        const svg = elementTreeToSvg(capture.tree, PSEUDO_BACKDROP_VIEWPORT.width, PSEUDO_BACKDROP_VIEWPORT.height);
        const underTree = structuredClone(capture.tree);
        for (const record of pseudoRecords(underTree)) if (record.backdropFilterRaster != null) record.backdropFilterRaster.dataUri = undefined;
        const underSvg = elementTreeToSvg(underTree, PSEUDO_BACKDROP_VIEWPORT.width, PSEUDO_BACKDROP_VIEWPORT.height);
        const overTree = structuredClone(capture.tree);
        await replaceWithFinalCrops(overTree, source, dpr);
        const overSvg = elementTreeToSvg(overTree, PSEUDO_BACKDROP_VIEWPORT.width, PSEUDO_BACKDROP_VIEWPORT.height);
        const rendered = await renderSvg(renderPage, svg);
        const under = await renderSvg(renderPage, underSvg);
        const over = await renderSvg(renderPage, overSvg);
        const [sourceImage, renderedImage, underImage, overImage] = await Promise.all([
          decode(source), decode(rendered), decode(under), decode(over),
        ]);

        for (const spec of PSEUDO_BACKDROP_CASES) {
          const host = byAnimId(capture.tree, spec.id);
          const record = host?.pseudoFragments?.find((candidate) => candidate.pseudo === spec.pseudo);
          const raster = record?.backdropFilterRaster;
          const actualRasterOwners = raster?.dataUri == null ? 0 : 1;
          const expectedRasterOwners = spec.active ? 1 : 0;
          const actualSlot = record == null ? null : pseudoFragmentPaintSlot(record);
          const rect = raster?.rect ?? record?.boxFragments[0]?.physicalRect ?? null;
          const sourceVsRendered = rect == null ? null : comparePseudoBackdropRegion(sourceImage, renderedImage, rect, dpr);
          const underComparison = rect == null ? null : comparePseudoBackdropRegion(renderedImage, underImage, rect, dpr);
          const overComparison = rect == null ? null : comparePseudoBackdropRegion(renderedImage, overImage, rect, dpr);
          const recordMarkup = record == null ? "" : renderPseudoFragmentRecord(record, { imageHref: (url) => url });
          const rasterAt = raster?.dataUri == null ? -1 : recordMarkup.indexOf(raster.dataUri);
          const backdropOwnerAt = raster?.dataUri == null ? -1 : recordMarkup.lastIndexOf("data-domotion-pseudo-backdrop-owner", rasterAt);
          const vectorAt = backdropOwnerAt < 0 ? -1 : recordMarkup.indexOf("data-domotion-pseudo-vector-owner", rasterAt);
          const findings: string[] = [];
          if (record == null && spec.id !== "empty") findings.push("missing source-owned pseudo record");
          if (actualSlot != null && actualSlot !== spec.slot) findings.push(`slot ${actualSlot}, expected ${spec.slot}`);
          if (actualRasterOwners !== expectedRasterOwners) findings.push(`serialized ${actualRasterOwners}/${expectedRasterOwners} pseudo backdrop owners`);
          if (host?.backdropFilterRaster != null) findings.push("backdrop was flattened onto the host");
          if (spec.active && sourceVsRendered != null
              && sourceVsRendered.meanAbsoluteChannelDelta > PSEUDO_BACKDROP_THRESHOLDS.sourceMeanAbsoluteChannelDelta) {
            findings.push(`source/render drift ${sourceVsRendered.changedFraction.toFixed(4)} changed, ${sourceVsRendered.meanAbsoluteChannelDelta.toFixed(3)} mean delta`);
          }
          if (spec.active && (underComparison == null || !mutationDiscriminates(underComparison))) findings.push("under-capture mutation was inert");
          if (spec.active && (overComparison == null || !mutationDiscriminates(overComparison))) findings.push("final-composite over-capture mutation was inert");
          if (spec.active && !(backdropOwnerAt >= 0 && vectorAt > rasterAt)) findings.push("pseudo vector did not follow its backdrop boundary");
          rows.push({
            id: spec.id,
            pseudo: spec.pseudo,
            dpr,
            expectedSlot: spec.slot,
            actualSlot,
            expectedRasterOwners,
            actualRasterOwners,
            noHostWideRaster: host?.backdropFilterRaster == null,
            sourceVsRendered,
            underCapture: { applicable: spec.active, comparison: underComparison, discriminated: spec.active && underComparison != null && mutationDiscriminates(underComparison) },
            overCapture: { applicable: spec.active, comparison: overComparison, discriminated: spec.active && overComparison != null && mutationDiscriminates(overComparison) },
            rasterBeforeVector: spec.active ? backdropOwnerAt >= 0 && vectorAt > rasterAt : null,
            findings,
            pass: findings.length === 0,
          });
        }

        if (artifactDir != null) {
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(`${artifactDir}/source-dpr${dpr}.png`, source);
          writeFileSync(`${artifactDir}/rendered-dpr${dpr}.png`, rendered);
          writeFileSync(`${artifactDir}/under-capture-dpr${dpr}.png`, under);
          writeFileSync(`${artifactDir}/over-capture-dpr${dpr}.png`, over);
          writeFileSync(`${artifactDir}/rendered-dpr${dpr}.svg`, svg);
        }
      } finally {
        await renderPage.close();
        await sourcePage.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  for (const dpr of dprs) {
    const states = new Set(PSEUDO_BACKDROP_CASES.flatMap((spec) => spec.states));
    for (const state of PSEUDO_BACKDROP_REQUIRED_STATES) if (!states.has(state)) blockers.push(`DPR${dpr}:missing state ${state}`);
  }
  blockers.push(...warnings.filter((warning) => warning.includes("backdrop")));
  blockers.push(...rows.filter((row) => !row.pass).map((row) => `DPR${row.dpr}:${row.id}:${row.findings.join("; ")}`));
  return {
    schemaVersion: 1,
    sourcePins: PSEUDO_BACKDROP_SOURCE_PINS,
    producer: { chromiumVersion: browser.version(), platform: process.platform, architecture: process.arch },
    requiredStates: PSEUDO_BACKDROP_REQUIRED_STATES,
    thresholds: PSEUDO_BACKDROP_THRESHOLDS,
    rows,
    warnings,
    blockers,
    verdict: blockers.length === 0 ? "source-exact" : "source-drift",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dprAt = args.indexOf("--dpr");
  const jsonAt = args.indexOf("--json");
  const artifactAt = args.indexOf("--artifact-dir");
  const dprs = dprAt < 0 ? [1, 2] : args[dprAt + 1].split(",").map(Number).filter((value) => value > 0 && Number.isFinite(value));
  const jsonPath = jsonAt < 0 ? undefined : args[jsonAt + 1];
  const artifactDir = artifactAt < 0 ? undefined : args[artifactAt + 1];
  const report = await runPseudoBackdropSourceOracle(dprs, artifactDir);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonPath != null) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, body);
  }
  process.stdout.write(body);
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
