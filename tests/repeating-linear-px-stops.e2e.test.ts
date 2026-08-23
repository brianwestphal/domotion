import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const W = 240;
const H = 220;
const PURE_COLORS = new Set(["225,29,72", "37,99,235", "255,255,255"]);
const cases = [
  { id: "wide-37", width: 180, height: 70, zoom: 1, gradient: "37deg, #e11d48 0px 7px, #2563eb 7px 19px", physical: ["0px", "7px", "19px"] },
  { id: "tall-143", width: 70, height: 180, zoom: 1, gradient: "143deg, #e11d48 -5px 7px, #2563eb 7px 19px", physical: ["-5px", "7px", "19px"] },
  { id: "zoomed", width: 90, height: 35, zoom: 2, gradient: "37deg, #e11d48 0px 7px, #2563eb 7px 19px", physical: ["0px", "14px", "38px"] },
  { id: "over-line", width: 100, height: 70, zoom: 1, gradient: "90deg, #e11d48 0px, #2563eb 240px", physical: ["0px", "240px"] },
  { id: "coincident", width: 180, height: 70, zoom: 1, gradient: "37deg, #e11d48 8px, #2563eb 8px", physical: ["8px"] },
  { id: "omitted", width: 180, height: 70, zoom: 1, gradient: "37deg, #e11d48, #2563eb", physical: [] },
] as const;

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function findById(tree: CapturedElement[], id: string): CapturedElement | null {
  for (const element of tree) {
    if (element.animId === id) return element;
    const child = findById(element.children, id);
    if (child != null) return child;
  }
  return null;
}

function logicalInteriorComparison(source: Buffer, rendered: Buffer, pixelWidth: number) {
  let checked = 0;
  let mismatches = 0;
  const pixelCount = source.length / 4;
  for (let pixel = pixelWidth + 1; pixel < pixelCount - pixelWidth - 1; pixel++) {
    const i = pixel * 4;
    const sourceKey = `${source[i]},${source[i + 1]},${source[i + 2]}`;
    const renderedKey = `${rendered[i]},${rendered[i + 1]},${rendered[i + 2]}`;
    if (!PURE_COLORS.has(sourceKey) || !PURE_COLORS.has(renderedKey)) continue;
    const neighbors = [pixel - pixelWidth, pixel + pixelWidth, pixel - 1, pixel + 1];
    if (neighbors.some((neighbor) => {
      const offset = neighbor * 4;
      return `${source[offset]},${source[offset + 1]},${source[offset + 2]}` !== sourceKey;
    })) continue;
    checked++;
    if (sourceKey !== renderedKey) mismatches++;
  }
  return { checked, mismatches };
}

describeBrowser("repeating linear px-stop source geometry", () => {
  for (const dpr of [1, 2]) {
    it(`matches Blink across angle, aspect ratio, zoom, and repeat domains at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const rendered = await context.newPage();
      try {
        for (const row of cases) {
          await source.setContent(`<!doctype html><style>html,body{margin:0;background:white}#${row.id}{width:${row.width}px;height:${row.height}px;zoom:${row.zoom};background:repeating-linear-gradient(${row.gradient})}</style><div id="${row.id}" data-domotion-anim="${row.id}"></div>`);
          const sourcePng = await source.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
          const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
          const captured = findById(tree, row.id);
          expect(captured, row.id).not.toBeNull();
          for (const token of row.physical) expect(captured!.styles.backgroundImage, `${row.id}/${token}`).toContain(token);
          const svg = elementTreeToSvg(tree, W, H);
          expect(svg, row.id).toContain("linearGradient");
          if (row.id === "coincident") expect(svg, row.id).not.toContain('spreadMethod="repeat"');
          else expect(svg, row.id).toContain('spreadMethod="repeat"');
          await rendered.setContent(`<body style="margin:0">${svg}</body>`);
          const renderedPng = await rendered.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
          const [a, b] = await Promise.all([
            sharp(sourcePng).ensureAlpha().raw().toBuffer(),
            sharp(renderedPng).ensureAlpha().raw().toBuffer(),
          ]);
          const logical = logicalInteriorComparison(a, b, W * dpr);
          expect(logical.checked, `${row.id}/non-vacuous-interior`).toBeGreaterThan(1_000 * dpr * dpr);
          expect(logical.mismatches, `${row.id}/logical-interior`).toBe(0);

          if (row.id === "wide-37") {
            const mutatedSvg = svg.replace('spreadMethod="repeat"', 'spreadMethod="pad"');
            expect(mutatedSvg).not.toBe(svg);
            await rendered.setContent(`<body style="margin:0">${mutatedSvg}</body>`);
            const mutatedPng = await rendered.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
            const mutated = await sharp(mutatedPng).ensureAlpha().raw().toBuffer();
            expect(logicalInteriorComparison(a, mutated, W * dpr).mismatches, "repeat mutation").toBeGreaterThan(1_000 * dpr * dpr);
          }
        }
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
