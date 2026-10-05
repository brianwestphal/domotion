#!/usr/bin/env tsx
/** DM-24GQD3: native Windows MathML radical face and bar-route evidence. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arch, platform, release } from "node:os";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { isMain } from "./lib/cli.js";

export const RADICAL_SIZES = [12, 16, 22, 30, 40, 50, 60] as const;
export const RADICAL_STYLES = ["normal", "compact"] as const;
const WIDTH = 560;
const HEIGHT = 760;

type Box = { x: number; y: number; width: number; height: number };
type Bar = Box;

export function radicalProbeHtml(): string {
  const rows = RADICAL_STYLES.flatMap((style) =>
    RADICAL_SIZES.map(
      (size) =>
        `<math display="block" style="font-family:math;font-size:${size}px;math-style:${style};margin:8px 0"><msqrt id="radical-${style}-${size}" data-magic-key="radical-${style}-${size}"><mi id="base-${style}-${size}">x</mi><mo>+</mo><mi>y</mi></msqrt></math>`,
    ),
  ).join("\n");
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:white;color:black}body{padding:16px;box-sizing:border-box}</style>${rows}<math style="font-family:math;font-size:40px"><mo id="math-radical-sign">√</mo></math>`;
}

function findByKey(nodes: CapturedElement[], key: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.magicKey === key) return node;
    const child = findByKey(node.children ?? [], key);
    if (child != null) return child;
  }
  return null;
}

export function parseRadicalBar(markup: string): Bar | null {
  const match = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" fill=/.exec(markup);
  // At the smallest sizes Blink's snapped rule can be zero pixels tall.
  if (match == null) return null;
  return { x: +match[1], y: +match[2], width: +match[3], height: +match[4] };
}

export function paintedBarRows(
  rgb: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  baseRight: number,
  radicalTop: number,
  baseTop: number,
): number[] {
  const right = Math.min(imageWidth - 1, Math.floor(baseRight) - 2);
  const left = Math.max(0, right - 15);
  const rows: number[] = [];
  for (let y = Math.max(0, Math.floor(radicalTop) - 2); y < Math.min(imageHeight, Math.ceil(baseTop)); y++) {
    let dark = 0;
    for (let x = left; x <= right; x++) {
      const offset = (y * imageWidth + x) * 3;
      if (rgb[offset] < 192 && rgb[offset + 1] < 192 && rgb[offset + 2] < 192) dark++;
    }
    // A real bar covers this entire span; a radicand ascender can intersect
    // one column but cannot fill three quarters of its width.
    if (dark >= Math.ceil((right - left + 1) * 0.75)) rows.push(y);
  }
  return rows;
}

export function expectedBarRows(bar: Bar | null): number[] {
  if (bar == null) return [];
  return Array.from({ length: Math.round(bar.height) }, (_, index) => Math.round(bar.y) + index);
}

export async function run(outPath: string, allowNonWindows = false): Promise<void> {
  if (platform() !== "win32" && !allowNonWindows) throw new Error("native Windows probe requires win32");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.setContent(radicalProbeHtml());
    await page.evaluate(() => document.fonts.ready);
    const screenshot = await page.screenshot();
    const image = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const captured = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const renderedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${elementTreeToSvgInner(captured, WIDTH, HEIGHT)}</svg>`;
    const renderedPage = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await renderedPage.setContent(`<!doctype html><style>html,body{margin:0;background:white}</style>${renderedSvg}`);
    await renderedPage.evaluate(() => document.fonts.ready);
    const renderedPng = await renderedPage.screenshot();
    const renderedImage = await sharp(renderedPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId: signNodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#math-radical-sign",
    });
    if (!signNodeId) throw new Error("CDP math radical sign node missing");
    const radicalSignFonts = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: signNodeId })).fonts;
    if (radicalSignFonts.every((font) => font.glyphCount === 0))
      throw new Error("CDP direct math-family radical sign had no painted font");
    const rows = [];
    try {
      for (const style of RADICAL_STYLES) {
        for (const size of RADICAL_SIZES) {
          const id = `radical-${style}-${size}`;
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
          if (!nodeId) throw new Error(`${id}: CDP node missing`);
          const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
          const browserGeometry = await page.evaluate((key) => {
            const radical = document.getElementById(key)!;
            const children = Array.from(radical.children);
            const radicalRect = radical.getBoundingClientRect();
            const childRects = children.map((child) => child.getBoundingClientRect());
            return {
              radical: { x: radicalRect.x, y: radicalRect.y, width: radicalRect.width, height: radicalRect.height },
              baseTop: Math.min(...childRects.map((child) => child.top)),
              baseRight: Math.max(...childRects.map((child) => child.right)),
              mathStyle: getComputedStyle(radical).mathStyle,
              fontFamily: getComputedStyle(radical).fontFamily,
            };
          }, id);
          const node = findByKey(captured, id);
          if (node == null) throw new Error(`${id}: captured node missing`);
          const bar = parseRadicalBar(elementTreeToSvgInner([node], WIDTH, HEIGHT));
          const browserRows = paintedBarRows(
            image.data,
            image.info.width,
            image.info.height,
            browserGeometry.baseRight,
            browserGeometry.radical.y,
            browserGeometry.baseTop,
          );
          const renderedRows = paintedBarRows(
            renderedImage.data,
            renderedImage.info.width,
            renderedImage.info.height,
            browserGeometry.baseRight,
            browserGeometry.radical.y,
            browserGeometry.baseTop,
          );
          const capturedGeometry = {
            radical: { x: node.x, y: node.y, width: node.width, height: node.height },
            baseTop: Math.min(...node.children.map((child) => child.y)),
            baseRight: Math.max(...node.children.map((child) => child.x + child.width)),
            mathStyle: node.styles.mathStyle,
          };
          const browserBaseOffset = browserGeometry.baseTop - browserGeometry.radical.y;
          const capturedBaseOffset = capturedGeometry.baseTop - capturedGeometry.radical.y;
          const barRightMatches = bar == null || bar.x + bar.width === Math.floor(browserGeometry.baseRight + 0.5);
          rows.push({
            style,
            size,
            fonts,
            browserGeometry,
            capturedGeometry,
            browserBaseOffset,
            capturedBaseOffset,
            bar,
            rectRows: expectedBarRows(bar),
            barRightMatches,
            sampleSpan: [Math.floor(browserGeometry.baseRight) - 17, Math.floor(browserGeometry.baseRight) - 2],
            browserRows,
            renderedRows,
            matches:
              JSON.stringify(browserRows) === JSON.stringify(renderedRows) &&
              barRightMatches &&
              Math.abs(browserBaseOffset - capturedBaseOffset) <= 1 / 64 &&
              browserGeometry.mathStyle === capturedGeometry.mathStyle,
          });
        }
      }
    } finally {
      await cdp.detach();
    }
    const report = {
      schema: 1,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      chromiumVersion: browser.version(),
      radicalSignFonts,
      viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
      rows,
    };
    const output = resolve(outPath);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2));
    writeFileSync(output.replace(/\.json$/, ".png"), screenshot);
    writeFileSync(output.replace(/\.json$/, "-rendered.png"), renderedPng);
    const failures = rows.filter((row) => !row.matches || row.fonts.every((font) => font.glyphCount === 0));
    console.log(`MathML radical native ${platform()}: ${rows.length} rows, ${failures.length} differences; ${output}`);
    if (failures.length > 0 && platform() === "win32")
      throw new Error(`radical rows failed: ${failures.map((row) => `${row.style}/${row.size}`).join(", ")}`);
  } finally {
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  const outputFlag = process.argv.indexOf("--out");
  const output = outputFlag < 0 ? "tests/output/mathml-radical-windows.json" : process.argv[outputFlag + 1];
  if (!output) throw new Error("--out requires a path");
  run(output, process.argv.includes("--allow-nonwindows")).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
