#!/usr/bin/env tsx
/** Device-pixel phase oracle for CSS borders and outlines (DM-2184).
 * Chromium paints HTML, then Domotion captures the same grid and Chromium
 * paints its SVG through an <img>. Edge alpha profiles expose raster phase.
 * Usage: npm run borders:phase-oracle [--json path] [--keep dir]
 *   [--dsf 1,2,4] [--zoom 0.8,1,1.25] [--report-only]
 *   [--max-edge-error 0.56] [--max-profile-rmse 0.48]
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";

export type PrimitiveKind = "border" | "outline";
export type PrimitiveStyle = "solid" | "dashed" | "dotted" | "double";
export interface PhaseCase { id: string; kind: PrimitiveKind; style: PrimitiveStyle; width: number; phase: number; x: number; y: number; boxWidth: number; boxHeight: number; nominalCenter: number }
export interface EdgeProfile { values: number[]; origin: number; outer: number; inner: number; center: number }
export interface SnapSample { nominalCenter: number; observedCenter: number; width: number }
export interface SnapFit { rule: "none" | "css-edge-round" | "device-center-round"; mae: number }
export interface PhaseScenario { id: string; dsf: number; zoom: number }

/** Inputs consumed by Blink's `BoxBorderPainter::PaintBorderFastPath`.
 * This is a decision oracle, not an SVG implementation preference: keeping the
 * branch visible prevents a good corner screenshot from hiding that Domotion
 * exercised a different paint model. */
export interface BorderPaintDecisionInput {
  id: string;
  uniformColor: boolean;
  uniformStyle: boolean;
  uniformWidth: boolean;
  innerRenderable: boolean;
  innerRoundCurvature: boolean;
  style: PrimitiveStyle;
  allEdges: boolean;
  outerRounded: boolean;
  transparent: boolean;
}

export type BorderPaintDecision =
  | "solid-rect-fast-path"
  | "solid-drrect-fast-path"
  | "double-drrect-fast-path"
  | "partial-transparent-path-fast-path"
  | "complex-rounded-close-edge-clips"
  | "complex-rounded-hull-clips"
  | "complex-straight-sides";

/** Source transcription of `PaintBorderFastPath`, followed by the rounded
 * clip split in `ClipBorderSidePolygon`. Revision and source are recorded in
 * docs/129 and the parity matrix. */
export function classifyBorderPaintDecision(input: BorderPaintDecisionInput): BorderPaintDecision {
  const eligible = input.uniformColor && input.uniformStyle
    && input.innerRenderable && input.innerRoundCurvature
    && (input.style === "solid" || input.style === "double");
  if (eligible && input.allEdges) {
    if (input.style === "double") return "double-drrect-fast-path";
    if (input.uniformWidth && !input.outerRounded) return "solid-rect-fast-path";
    return "solid-drrect-fast-path";
  }
  if (eligible && input.style === "solid" && !input.outerRounded && input.transparent)
    return "partial-transparent-path-fast-path";
  if (!input.outerRounded) return "complex-straight-sides";
  return input.innerRenderable && input.innerRoundCurvature
    ? "complex-rounded-close-edge-clips"
    : "complex-rounded-hull-clips";
}

export function buildBorderPaintDecisionCases(): BorderPaintDecisionInput[] {
  const base: Omit<BorderPaintDecisionInput, "id"> = {
    uniformColor: true, uniformStyle: true, uniformWidth: true,
    innerRenderable: true, innerRoundCurvature: true, style: "solid",
    allEdges: true, outerRounded: false, transparent: false,
  };
  const rows: BorderPaintDecisionInput[] = [];
  const add = (id: string, patch: Partial<Omit<BorderPaintDecisionInput, "id">>) => rows.push({ id, ...base, ...patch });
  add("uniform-solid-rect", {});
  add("uniform-solid-rounded", { outerRounded: true });
  add("mixed-width-solid-rounded", { uniformWidth: false, outerRounded: true });
  add("uniform-double-rounded", { style: "double", outerRounded: true });
  add("partial-transparent-solid", { allEdges: false, transparent: true });
  add("mixed-color-straight", { uniformColor: false });
  add("mixed-style-rounded", { uniformStyle: false, outerRounded: true });
  add("dashed-rounded", { style: "dashed", outerRounded: true });
  add("rounded-nonrenderable-inner", { outerRounded: true, innerRenderable: false });
  add("rounded-nonround-inner", { outerRounded: true, innerRoundCurvature: false });
  return rows;
}

const DEFAULT_DSF = 4, PAGE_WIDTH = 760, ROW_HEIGHT = 56, TOP_PAD = 18;
const BOX_WIDTH = 132, BOX_HEIGHT = 34, OUTLINE_OFFSET = 3;

export function buildPhaseCases(): PhaseCase[] {
  const out: PhaseCase[] = [];
  let index = 0;
  for (const kind of ["border", "outline"] as const)
    for (const style of ["solid", "dashed", "dotted", "double"] as const)
      for (const width of [1, 2, 3, 5]) for (const phase of [0, 0.25, 0.5, 0.75]) {
        // Four columns keep DSF/zoom matrix screenshots below Chromium's image
        // dimension limits without changing any case's local paint inputs.
        const column = index % 4, row = Math.floor(index / 4);
        const x = 20 + column * 185 + phase, y = TOP_PAD + row * ROW_HEIGHT + phase;
        const nominalCenter = kind === "border" ? y + width / 2 : y - OUTLINE_OFFSET - width / 2;
        out.push({ id: `${kind}.${style}.w${width}.p${String(phase).replace(".", "_")}`, kind, style, width, phase, x, y, boxWidth: BOX_WIDTH, boxHeight: BOX_HEIGHT, nominalCenter });
        index++;
      }
  return out;
}

export function buildPhaseScenarios(dsfs: number[], zooms: number[]): PhaseScenario[] {
  return dsfs.flatMap((dsf) => zooms.map((zoom) => ({ id: `dsf${dsf}.zoom${zoom}`, dsf, zoom })));
}

export function profileEdges(values: number[], origin: number, dsf = DEFAULT_DSF): EdgeProfile {
  const active = values.map((v, i) => ({ v, i })).filter(({ v }) => v >= 1 / 255);
  if (!active.length) return { values, origin, outer: NaN, inner: NaN, center: NaN };
  const first = active[0].i, last = active.at(-1)!.i;
  const total = active.reduce((n, p) => n + p.v, 0);
  const centerIndex = active.reduce((n, p) => n + (p.i + 0.5) * p.v, 0) / total;
  const lead = values[first], tail = values[last];
  return { values, origin, outer: origin + (first + 1 - lead) / dsf, inner: origin + (last + tail) / dsf, center: origin + centerIndex / dsf };
}

export function profileRmse(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
  return Math.sqrt(sum / n);
}

export function deriveSnapRule(samples: SnapSample[], dsf = DEFAULT_DSF): SnapFit[] {
  const predict = (s: SnapSample, rule: SnapFit["rule"]): number => rule === "css-edge-round"
    ? Math.round(s.nominalCenter - s.width / 2) + s.width / 2
    : rule === "device-center-round" ? Math.round(s.nominalCenter * dsf) / dsf : s.nominalCenter;
  return (["none", "css-edge-round", "device-center-round"] as const).map((rule) => ({ rule, mae: samples.reduce((n, s) => n + Math.abs(predict(s, rule) - s.observedCenter), 0) / Math.max(1, samples.length) })).sort((a, b) => a.mae - b.mae);
}

function pageHtml(cases: PhaseCase[], zoom: number): string {
  const boxes = cases.map((c) => {
    const paint = c.kind === "border" ? `border:${c.width}px ${c.style} #000` : `outline:${c.width}px ${c.style} #000;outline-offset:${OUTLINE_OFFSET}px`;
    return `<div style="position:absolute;left:${c.x}px;top:${c.y}px;width:${c.boxWidth}px;height:${c.boxHeight}px;box-sizing:border-box;${paint}"></div>`;
  }).join("");
  return `<!doctype html><style>html,body{margin:0;background:transparent}body{zoom:${zoom}}</style>${boxes}`;
}

async function imageProfiles(png: Buffer, cases: PhaseCase[], scenario: PhaseScenario): Promise<Map<string, EdgeProfile>> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = new Map<string, EdgeProfile>();
  for (const c of cases) {
    const nominalOuter = (c.kind === "border" ? c.y : c.y - OUTLINE_OFFSET - c.width) * scenario.zoom;
    const paintedWidth = c.width * scenario.zoom;
    const top = Math.max(0, Math.floor((nominalOuter - 3) * scenario.dsf));
    const bottom = Math.min(info.height, Math.ceil((nominalOuter + paintedWidth + 3) * scenario.dsf));
    const x0 = Math.floor((c.x + c.boxWidth * 0.28) * scenario.zoom * scenario.dsf);
    const x1 = Math.ceil((c.x + c.boxWidth * 0.72) * scenario.zoom * scenario.dsf);
    const values: number[] = [];
    for (let y = top; y < bottom; y++) {
      let max = 0;
      for (let x = x0; x < x1; x++) max = Math.max(max, data[(y * info.width + x) * info.channels + 3] / 255);
      values.push(max);
    }
    result.set(c.id, profileEdges(values, top / scenario.dsf, scenario.dsf));
  }
  return result;
}

function numberList(raw: string, name: string): number[] {
  const values = raw.split(",").map(Number);
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error(`${name} must be a comma-separated list of positive numbers`);
  return [...new Set(values)];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback; };
  const jsonPath = option("--json", ""), keepDir = option("--keep", "");
  const scenarios = buildPhaseScenarios(numberList(option("--dsf", "4"), "--dsf"), numberList(option("--zoom", "1"), "--zoom"));
  const reportOnly = args.includes("--report-only");
  // Baseline envelopes are deliberately just above the measured 2026-08-15
  // maxima (0.551 / 0.471). A paint change may tighten them when it reduces
  // the named fixture residuals; widening them requires an explicit review.
  const maxEdgeError = Number(option("--max-edge-error", "0.56")), maxProfileRmse = Number(option("--max-profile-rmse", "0.48"));
  const cases = buildPhaseCases();
  const browser = await chromium.launch();
  try {
    const reports = [];
    for (const scenario of scenarios) {
      const baseHeight = TOP_PAD + Math.ceil(cases.length / 4) * ROW_HEIGHT + 20;
      const width = Math.ceil(PAGE_WIDTH * scenario.zoom), height = Math.ceil(baseHeight * scenario.zoom);
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scenario.dsf });
      try {
        const htmlPage = await context.newPage();
        await htmlPage.setContent(pageHtml(cases, scenario.zoom), { waitUntil: "load" });
        const htmlPng = await htmlPage.screenshot({ omitBackground: true });
        const tree = await captureElementTree(htmlPage, "body", { x: 0, y: 0, width, height });
        const inner = elementTreeToSvgInner(tree, width, height);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`;
        const svgPage = await context.newPage();
        await svgPage.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${width}px;height:${height}px}</style><img>`, { waitUntil: "load" });
        await svgPage.locator("img").evaluate((img, src) => { (img as HTMLImageElement).src = `data:image/svg+xml;base64,${src}`; }, Buffer.from(svg).toString("base64"));
        await svgPage.locator("img").evaluate((img) => (img as HTMLImageElement).decode());
        const svgPng = await svgPage.screenshot({ omitBackground: true });
        const htmlProfiles = await imageProfiles(htmlPng, cases, scenario), svgProfiles = await imageProfiles(svgPng, cases, scenario);
        const rows = cases.map((c) => {
          const html = htmlProfiles.get(c.id)!, emitted = svgProfiles.get(c.id)!;
          return { ...c, nominalCenter: c.nominalCenter * scenario.zoom, paintedWidth: c.width * scenario.zoom, html, svg: emitted, outerError: Math.abs(emitted.outer - html.outer), innerError: Math.abs(emitted.inner - html.inner), centerError: Math.abs(emitted.center - html.center), profileRmse: profileRmse(html.values, emitted.values) };
        });
        const finite = rows.filter((row) => Number.isFinite(row.outerError) && Number.isFinite(row.innerError));
        const worstEdge = Math.max(...finite.flatMap((row) => [row.outerError, row.innerError]));
        const worstRmse = Math.max(...finite.map((row) => row.profileRmse));
        const sample = (key: "html" | "svg") => finite.map((row) => ({ nominalCenter: row.nominalCenter, observedCenter: row[key].center, width: row.paintedWidth }));
        const geometry = { htmlSnapFits: deriveSnapRule(sample("html"), scenario.dsf), svgSnapFits: deriveSnapRule(sample("svg"), scenario.dsf) };
        const failed = rows.filter((row) => !Number.isFinite(row.outerError) || row.outerError > maxEdgeError || row.innerError > maxEdgeError || row.profileRmse > maxProfileRmse);
        reports.push({ scenario, geometry, paintResiduals: { worstEdge, worstRmse, failed: failed.map((row) => row.id) }, rows });
        console.log(`${scenario.id}: ${rows.length - failed.length}/${rows.length} pass; edge=${worstEdge.toFixed(3)} CSS px; profile=${worstRmse.toFixed(3)}; HTML snap=${geometry.htmlSnapFits[0].rule}; SVG snap=${geometry.svgSnapFits[0].rule}`);
        if (keepDir) {
          const dir = join(keepDir, scenario.id); mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "html.png"), htmlPng); writeFileSync(join(dir, "domotion.svg"), svg); writeFileSync(join(dir, "svg-img.png"), svgPng);
        }
      } finally { await context.close(); }
    }
    const browserVersion = browser.version();
    const report = { meta: { platform: platform(), arch: arch(), osRelease: release(), node: process.version, browserVersion, scenarios: scenarios.length, casesPerScenario: cases.length, maxEdgeError, maxProfileRmse, reportOnly }, scenarios: reports };
    if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    const failedCount = reports.reduce((count, entry) => count + entry.paintResiduals.failed.length, 0);
    if (failedCount && reportOnly) console.log(`diagnostic mode: recorded ${failedCount} paint-profile residual(s) without gating`);
    return failedCount && !reportOnly ? 1 : 0;
  } finally { await browser.close(); }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error); process.exitCode = 2; });
