import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import type { CapturedElement } from "./types.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

// An `<img>` SVG's `@supports` conditions are decided by the page's own
// Chromium during capture and recorded on the img's capture record.
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>` +
  `@supports (display: grid) { rect { fill: green } } ` +
  `@supports (not-a-property: 1) { rect { fill: red } } ` +
  `@supports selector(rect:has(> g)) { g {} } ` +
  `@supports display: grid { circle {} }` +
  `</style><rect width="10" height="10"/></svg>`;

describe("captureImageSvgSupports", () => {
  it("records conditions from a data-imported image stylesheet", async () => {
    const imported = `@supports (display: grid) { rect { fill: red } }`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import url("data:text/css,${encodeURIComponent(imported)}") supports(display: block);</style><rect width="10" height="10"/></svg>`;
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<body><img src="data:image/svg+xml,${encodeURIComponent(source)}" width="50" height="50"></body>`,
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 100, height: 100 });
      const imgs: CapturedElement[] = [];
      forEachElement(tree, (el) => {
        if (el.tag === "img") imgs.push(el);
      });
      expect(imgs).toHaveLength(1);
      expect(imgs[0].imageSvgSupports).toEqual({ "(display: block)": true, "(display: grid)": true });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("records the page's answer for every @supports prelude of an <img> SVG", async () => {
    const page = await browser.newPage({ viewport: { width: 200, height: 100 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<!doctype html><body style="margin:0"><img src="data:image/svg+xml,${encodeURIComponent(svg)}" style="display:block;width:50px;height:50px"></body>`,
        { waitUntil: "load" },
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 200, height: 100 });
      const imgs: CapturedElement[] = [];
      forEachElement(tree, (el) => {
        if (el.tag === "img") imgs.push(el);
      });
      expect(imgs).toHaveLength(1);
      expect(imgs[0].imageSvgSupports).toEqual({
        "(display: grid)": true,
        "(not-a-property: 1)": false,
        "selector(rect:has(> g))": true,
        // CSS.supports would accept a bare declaration; an @supports prelude does not.
        "display: grid": false,
      });
    } finally {
      await page.close();
    }
  }, 60_000);
});
