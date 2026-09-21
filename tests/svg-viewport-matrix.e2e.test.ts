import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { computeViewportMatrix, parsePreserveAspectRatio } from "../src/render/svg-viewport-matrix.js";

// DM-DQXZ6K: confirm the transcribed viewport→viewBox matrix against what Chrome
// actually paints. For each case we render a nested `<svg>` with a 2×2 marker
// rect at a known viewBox coordinate, read Chrome's client rect for that rect,
// and compare its center to `computeViewportMatrix` applied to the same viewBox
// point. Agreement means our matrix reproduces Blink's viewport transform.
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 400, height: 400 } });
});
afterAll(async () => {
  await browser.close();
});

interface Case {
  name: string;
  place: { x: number; y: number; w: number; h: number };
  viewBox: [number, number, number, number];
  par: string;
  rect: [number, number]; // marker rect top-left in viewBox coords
}

const CASES: Case[] = [
  { name: "none", place: { x: 0, y: 0, w: 120, h: 120 }, viewBox: [0, 0, 100, 50], par: "none", rect: [40, 20] },
  {
    name: "xMidYMid meet",
    place: { x: 0, y: 0, w: 120, h: 120 },
    viewBox: [0, 0, 100, 50],
    par: "xMidYMid meet",
    rect: [50, 25],
  },
  {
    name: "xMidYMid slice",
    place: { x: 0, y: 0, w: 120, h: 120 },
    viewBox: [0, 0, 100, 50],
    par: "xMidYMid slice",
    rect: [50, 25],
  },
  {
    name: "xMaxYMax meet + offset",
    place: { x: 20, y: 30, w: 100, h: 100 },
    viewBox: [10, 5, 100, 50],
    par: "xMaxYMax meet",
    rect: [60, 30],
  },
  {
    name: "icon 24→16",
    place: { x: 8, y: 8, w: 16, h: 16 },
    viewBox: [0, 0, 24, 24],
    par: "xMidYMid meet",
    rect: [12, 12],
  },
];

describe("computeViewportMatrix vs Chrome-painted nested <svg> (DM-DQXZ6K)", () => {
  for (const c of CASES) {
    it(`matches Chrome for ${c.name}`, async () => {
      const [vx, vy, vw, vh] = c.viewBox;
      const [rx, ry] = c.rect;
      await page.setContent(
        `<!doctype html><body style="margin:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
          `<svg x="${c.place.x}" y="${c.place.y}" width="${c.place.w}" height="${c.place.h}" ` +
          `viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="${c.par}" overflow="visible">` +
          `<rect id="m" x="${rx}" y="${ry}" width="2" height="2" fill="red"/></svg></svg></body>`,
      );
      const chrome = await page.evaluate(() => {
        const r = document.getElementById("m")!.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      });
      const m = computeViewportMatrix(
        c.place,
        { minX: vx, minY: vy, width: vw, height: vh },
        parsePreserveAspectRatio(c.par),
      )!;
      // Marker center in viewBox coords, mapped through our matrix.
      const px = rx + 1;
      const py = ry + 1;
      const ourX = m.a * px + m.c * py + m.e;
      const ourY = m.b * px + m.d * py + m.f;
      expect(ourX).toBeCloseTo(chrome.cx, 1);
      expect(ourY).toBeCloseTo(chrome.cy, 1);
    }, 30_000);
  }
});
