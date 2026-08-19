#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { chromium, type Page } from "playwright";
import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { computeObjectFitRect } from "../src/render/element-tree-to-svg.js";

type Rect = { x: number; y: number; width: number; height: number };
type Row = { id: string; expected: unknown; actual: unknown; maxAbsDelta: number; pass: boolean; source: string };
const TOLERANCE = 1;

function rectDelta(a: Rect, b: Rect): number {
  return Math.max(...(["x", "y", "width", "height"] as const).map((key) => Math.abs(a[key] - b[key])));
}

async function paintedColorRect(page: Page, rgb: [number, number, number]): Promise<Rect> {
  const png = await page.screenshot({ omitBackground: false });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const offset = (y * info.width + x) * 3;
    if (Math.abs(data[offset] - rgb[0]) > 2 || Math.abs(data[offset + 1] - rgb[1]) > 2 || Math.abs(data[offset + 2] - rgb[2]) > 2) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < 0) throw new Error(`paint color ${rgb.join(",")} was absent`);
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function find(tree: CapturedElement[], predicate: (element: CapturedElement) => boolean): CapturedElement | undefined {
  for (const element of tree) {
    if (predicate(element)) return element;
    const nested = find(element.children, predicate);
    if (nested != null) return nested;
  }
}

export async function runReplacedGeometryOracle(): Promise<{ rows: Row[]; mutationMoved: boolean }> {
  const browser = await chromium.launch({ headless: true });
  const rows: Row[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 260 }, deviceScaleFactor: 1 });
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#ed1234"/></svg>`;
    const src = `data:image/svg+xml,${encodeURIComponent(image)}`;
    const cases = [
      ["fill", "50% 50%"], ["contain", "25% 75%"], ["cover", "calc(100% - 10px) calc(100% - 20px)"],
      ["none", "right 10px bottom 20px"], ["scale-down", "30% 80%"],
    ] as const;
    for (const [fit, position] of cases) {
      await page.setContent(`<style>html,body{margin:0;background:white}img{display:block;margin:30px;width:200px;height:120px;object-fit:${fit};object-position:${position}}</style><img src="${src}">`);
      await page.locator("img").evaluate((element: HTMLImageElement) => element.decode());
      const expected = await paintedColorRect(page, [237, 18, 52]);
      const computedPosition = await page.locator("img").evaluate((element) => getComputedStyle(element).objectPosition);
      const concrete = computeObjectFitRect(30, 30, 200, 120, 80, 40, fit, computedPosition);
      const clipRight = Math.min(230, concrete.x + concrete.width);
      const clipBottom = Math.min(150, concrete.y + concrete.height);
      const actual = {
        x: Math.max(30, concrete.x), y: Math.max(30, concrete.y),
        width: Math.max(0, clipRight - Math.max(30, concrete.x)),
        height: Math.max(0, clipBottom - Math.max(30, concrete.y)),
      };
      const maxAbsDelta = rectDelta(expected, actual);
      rows.push({ id: `object-fit.${fit}`, expected, actual, maxAbsDelta, pass: maxAbsDelta <= TOLERANCE, source: "Blink LayoutReplaced concrete object rect observed from live painted pixels" });
    }

    for (const [id, tag, style, expectedRaster] of [
      ["checkbox-auto", '<input type="checkbox" checked>', "", true],
      ["checkbox-none", '<input type="checkbox" checked>', "appearance:none;width:20px;height:20px;background:#ed1234", false],
      ["select-auto", "<select><option>One</option></select>", "", true],
      ["button-authored", "<button>Go</button>", "background:#ed1234;border:0", false],
    ] as const) {
      await page.setContent(`<div id=root style="padding:20px"><span style="${style}">${tag}</span></div>`);
      if (style !== "") await page.locator("input,select,button").evaluate((element, css) => element.setAttribute("style", css), style);
      const tree = await captureElementTree(page, "#root", { x: 0, y: 0, width: 360, height: 260 });
      const control = find(tree, (element) => ["input", "select", "button"].includes(element.tag));
      const actual = control?.nativeControlRaster?.dataUri != null;
      rows.push({ id: `control.${id}`, expected: expectedRaster, actual, maxAbsDelta: actual === expectedRaster ? 0 : Infinity, pass: actual === expectedRaster, source: "Blink LayoutTheme ownership boundary from computed appearance and author paint" });
    }

    for (const pseudo of ["before", "after"] as const) {
      await page.setContent(`<style>html,body{margin:0;background:white}#host{position:relative;margin:30px;width:180px;height:100px}#host::${pseudo}{content:"";position:absolute;left:17px;top:23px;width:41px;height:29px;background:#ed1234}</style><div id=host></div>`);
      const expected = await paintedColorRect(page, [237, 18, 52]);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 260 });
      const box = find(tree, (element) => element.pseudoBoxes?.some((item) => item.pseudo === `::${pseudo}`))
        ?.pseudoBoxes?.find((item) => item.pseudo === `::${pseudo}`);
      const actual = box == null ? { x: Infinity, y: Infinity, width: 0, height: 0 } : { x: box.x, y: box.y, width: box.width, height: box.height };
      const maxAbsDelta = rectDelta(expected, actual);
      rows.push({ id: `generated.${pseudo}-box`, expected, actual, maxAbsDelta, pass: maxAbsDelta <= TOLERANCE, source: "live Chromium generated box paint vs captured pseudo box" });
    }
  } finally { await browser.close(); }
  const correct = computeObjectFitRect(0, 0, 200, 120, 80, 40, "contain", "25% 75%");
  const mutation = computeObjectFitRect(0, 0, 200, 120, 80, 40, "contain", "50% 50%");
  return { rows, mutationMoved: rectDelta(correct, mutation) > 1 };
}

async function main(): Promise<void> {
  const report = await runReplacedGeometryOracle();
  const failures = report.rows.filter((row) => !row.pass);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(`replaced geometry oracle: ${report.rows.length - failures.length}/${report.rows.length}; mutation control ${report.mutationMoved ? "moved" : "DID NOT MOVE"}`);
  for (const failure of failures) console.log(`FAIL ${failure.id}: expected=${JSON.stringify(failure.expected)} actual=${JSON.stringify(failure.actual)} delta=${failure.maxAbsDelta}`);
  if (failures.length > 0 || !report.mutationMoved) process.exitCode = 1;
}
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
