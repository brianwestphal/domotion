#!/usr/bin/env tsx
/** Device-pixel phase oracle for CSS borders and outlines (DM-2184).
 * Chromium paints HTML, then Domotion captures the same grid and Chromium
 * paints its SVG through an <img>. Edge alpha profiles expose raster phase.
 * Usage: npm run borders:phase-oracle [--json path] [--keep dir]
 *   [--max-edge-error 0.56] [--max-profile-rmse 0.48]
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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

const DSF = 4, PAGE_WIDTH = 760, ROW_HEIGHT = 56, TOP_PAD = 18;
const BOX_WIDTH = 132, BOX_HEIGHT = 34, OUTLINE_OFFSET = 3;

export function buildPhaseCases(): PhaseCase[] {
  const out: PhaseCase[] = [];
  let row = 0;
  for (const kind of ["border", "outline"] as const)
    for (const style of ["solid", "dashed", "dotted", "double"] as const)
      for (const width of [1, 2, 3, 5]) for (const phase of [0, 0.25, 0.5, 0.75]) {
        const x = 36 + phase, y = TOP_PAD + row * ROW_HEIGHT + phase;
        const nominalCenter = kind === "border" ? y + width / 2 : y - OUTLINE_OFFSET - width / 2;
        out.push({ id: `${kind}.${style}.w${width}.p${String(phase).replace(".", "_")}`, kind, style, width, phase, x, y, boxWidth: BOX_WIDTH, boxHeight: BOX_HEIGHT, nominalCenter });
        row++;
      }
  return out;
}

export function profileEdges(values: number[], origin: number, dsf = DSF): EdgeProfile {
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

export function deriveSnapRule(samples: SnapSample[], dsf = DSF): SnapFit[] {
  const predict = (s: SnapSample, rule: SnapFit["rule"]): number => rule === "css-edge-round"
    ? Math.round(s.nominalCenter - s.width / 2) + s.width / 2
    : rule === "device-center-round" ? Math.round(s.nominalCenter * dsf) / dsf : s.nominalCenter;
  return (["none", "css-edge-round", "device-center-round"] as const).map((rule) => ({ rule, mae: samples.reduce((n, s) => n + Math.abs(predict(s, rule) - s.observedCenter), 0) / Math.max(1, samples.length) })).sort((a, b) => a.mae - b.mae);
}

function pageHtml(cases: PhaseCase[]): string {
  const boxes = cases.map((c) => {
    const paint = c.kind === "border" ? `border:${c.width}px ${c.style} #000` : `outline:${c.width}px ${c.style} #000;outline-offset:${OUTLINE_OFFSET}px`;
    return `<div style="position:absolute;left:${c.x}px;top:${c.y}px;width:${c.boxWidth}px;height:${c.boxHeight}px;box-sizing:border-box;${paint}"></div>`;
  }).join("");
  return `<!doctype html><style>html,body{margin:0;background:transparent}</style>${boxes}`;
}

async function imageProfiles(png: Buffer, cases: PhaseCase[]): Promise<Map<string, EdgeProfile>> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = new Map<string, EdgeProfile>();
  for (const c of cases) {
    const nominalOuter = c.kind === "border" ? c.y : c.y - OUTLINE_OFFSET - c.width;
    const top = Math.max(0, Math.floor((nominalOuter - 3) * DSF));
    const bottom = Math.min(info.height, Math.ceil((nominalOuter + c.width + 3) * DSF));
    const x0 = Math.floor((c.x + c.boxWidth * 0.28) * DSF), x1 = Math.ceil((c.x + c.boxWidth * 0.72) * DSF);
    const values: number[] = [];
    for (let y = top; y < bottom; y++) {
      let max = 0;
      for (let x = x0; x < x1; x++) max = Math.max(max, data[(y * info.width + x) * info.channels + 3] / 255);
      values.push(max);
    }
    result.set(c.id, profileEdges(values, top / DSF));
  }
  return result;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback; };
  const jsonPath = option("--json", ""), keepDir = option("--keep", "");
  // Baseline envelopes are deliberately just above the measured 2026-08-15
  // maxima (0.551 / 0.471). A paint change may tighten them when it reduces
  // the named fixture residuals; widening them requires an explicit review.
  const maxEdgeError = Number(option("--max-edge-error", "0.56")), maxProfileRmse = Number(option("--max-profile-rmse", "0.48"));
  const cases = buildPhaseCases(), height = TOP_PAD + cases.length * ROW_HEIGHT + 20;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: PAGE_WIDTH, height }, deviceScaleFactor: DSF });
    const htmlPage = await context.newPage();
    await htmlPage.setContent(pageHtml(cases), { waitUntil: "load" });
    const htmlPng = await htmlPage.screenshot({ omitBackground: true });
    const tree = await captureElementTree(htmlPage, "body", { x: 0, y: 0, width: PAGE_WIDTH, height });
    const inner = elementTreeToSvgInner(tree, PAGE_WIDTH, height);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" viewBox="0 0 ${PAGE_WIDTH} ${height}">${inner}</svg>`;
    const svgPage = await context.newPage();
    await svgPage.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${PAGE_WIDTH}px;height:${height}px}</style><img>`, { waitUntil: "load" });
    await svgPage.locator("img").evaluate((img, src) => { (img as HTMLImageElement).src = `data:image/svg+xml;base64,${src}`; }, Buffer.from(svg).toString("base64"));
    await svgPage.locator("img").evaluate((img) => (img as HTMLImageElement).decode());
    const svgPng = await svgPage.screenshot({ omitBackground: true });
    const htmlProfiles = await imageProfiles(htmlPng, cases), svgProfiles = await imageProfiles(svgPng, cases);
    const rows = cases.map((c) => {
      const html = htmlProfiles.get(c.id)!, emitted = svgProfiles.get(c.id)!;
      return { ...c, html, svg: emitted, outerError: Math.abs(emitted.outer - html.outer), innerError: Math.abs(emitted.inner - html.inner), centerError: Math.abs(emitted.center - html.center), profileRmse: profileRmse(html.values, emitted.values) };
    });
    const finite = rows.filter((r) => Number.isFinite(r.outerError) && Number.isFinite(r.innerError));
    const worstEdge = Math.max(...finite.flatMap((r) => [r.outerError, r.innerError])), worstRmse = Math.max(...finite.map((r) => r.profileRmse));
    const snapFits = deriveSnapRule(finite.map((r) => ({ nominalCenter: r.nominalCenter, observedCenter: r.html.center, width: r.width })));
    const failed = rows.filter((r) => !Number.isFinite(r.outerError) || r.outerError > maxEdgeError || r.innerError > maxEdgeError || r.profileRmse > maxProfileRmse);
    const report = { meta: { dsf: DSF, cases: cases.length, maxEdgeError, maxProfileRmse }, snapFits, worstEdge, worstRmse, failed: failed.map((r) => r.id), rows };
    console.log(`border/outline phase oracle: ${rows.length - failed.length}/${rows.length} pass`);
    console.log(`worst edge=${worstEdge.toFixed(3)} CSS px; worst profile RMSE=${worstRmse.toFixed(3)}`);
    console.log(`best shared snap rule: ${snapFits[0].rule} (center MAE ${snapFits[0].mae.toFixed(3)} CSS px)`);
    if (failed.length) console.log(`failing cases: ${failed.map((r) => r.id).join(", ")}`);
    if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    if (keepDir) { mkdirSync(keepDir, { recursive: true }); writeFileSync(join(keepDir, "html.png"), htmlPng); writeFileSync(join(keepDir, "domotion.svg"), svg); writeFileSync(join(keepDir, "svg-img.png"), svgPng); }
    return failed.length ? 1 : 0;
  } finally { await browser.close(); }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error); process.exitCode = 2; });
