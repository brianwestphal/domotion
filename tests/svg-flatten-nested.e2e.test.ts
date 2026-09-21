import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { inlineImgSvg, flattenImgSvg, type InlineSvgPlacement } from "../src/render/svg-inline.js";

// DM-K0S6ZS: the whole point of flattening is that it does NOT change the
// rendered result — it only replaces the nested `<svg>` wrapper with a
// `<g transform>` (+ clip) so tools that mishandle nested `<svg>` import cleanly.
// This renders the flattened output and the nested-`<svg>` baseline for the same
// source/placement and asserts Chrome paints them pixel-identically.
const W = 80;
const H = 80;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: W, height: H } });
});
afterAll(async () => {
  await browser.close();
});

async function shoot(inner: string): Promise<Buffer> {
  await page.setContent(
    `<!doctype html><body style="margin:0;background:#fff">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${inner}</svg></body>`,
  );
  return page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
}

interface Case {
  name: string;
  svg: string;
  place: InlineSvgPlacement;
}
const CASES: Case[] = [
  {
    name: "simple icon, meet, centered",
    svg: `<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#c33"/><circle cx="12" cy="12" r="5" fill="#39c"/></svg>`,
    place: { x: 10, y: 20, w: 40, h: 30, par: "xMidYMid meet", idPrefix: "a" },
  },
  {
    name: "gradient icon (objectBoundingBox %), slice",
    svg: `<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0%" stop-color="#f00"/><stop offset="100%" stop-color="#00f"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`,
    place: { x: 5, y: 5, w: 60, h: 40, par: "xMidYMid slice", idPrefix: "b" },
  },
  {
    name: "non-uniform (none), viewBox origin offset",
    svg: `<svg viewBox="2 3 20 10"><path d="M2 3h20v10H2z" fill="#282"/></svg>`,
    place: { x: 8, y: 8, w: 50, h: 50, par: "none", idPrefix: "c" },
  },
  {
    name: "bottom-right aligned, meet",
    svg: `<svg viewBox="0 0 30 10"><rect x="0" y="0" width="30" height="10" fill="#930"/></svg>`,
    place: { x: 4, y: 4, w: 60, h: 60, par: "xMaxYMax meet", idPrefix: "d" },
  },
];

describe("flattenImgSvg renders identically to the nested <svg> (DM-K0S6ZS)", () => {
  for (const c of CASES) {
    it(
      c.name,
      async () => {
        const nested = inlineImgSvg(c.svg, c.place);
        const flat = flattenImgSvg(c.svg, c.place);
        expect(nested).not.toBeNull();
        expect(flat).not.toBeNull();
        const [a, b] = [await shoot(nested!), await shoot(flat!)];
        expect(a.equals(b)).toBe(true);
      },
      30_000,
    );
  }
});
