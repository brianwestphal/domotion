import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const content =
  '<div class="host"><div class="icon"><svg width="20" height="20" viewBox="0 0 20 20"><path fill="rgb(83,58,253)" d="M13.75 6.75H10.25V5H15.5V10.25H13.75ZM6.75 10.25H5V15.5H10.25V13.75H6.75Z"/></svg></div></div>';
function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

it.each(["nested-clips", "displayNone", "cullClass"] as const)(
  "preserves real descendant ancestor %s",
  async (name) => {
    const viewport = { width: 80, height: 80 };
    const page = await browser.newPage({ viewport });
    const output = await browser.newPage({ viewport });
    try {
      const css =
        name === "nested-clips"
          ? ".outer{position:relative;margin:20px;width:30px;height:30px;overflow:hidden}.host{margin:10px 0 0 10px;width:30px;height:30px;overflow:hidden}.host::after{inset:-10px;border-radius:0}"
          : "";
      await page.setContent(
        `<!doctype html><style>body{margin:0;background:white}.host{position:relative;margin:20px;width:38px;height:38px}.icon{position:relative;z-index:1;width:38px;height:38px;display:flex;align-items:center;justify-content:center}.host::after{content:"";position:absolute;inset:0;background:rgb(245,245,255);border-radius:4px;z-index:2}${css}</style>${name === "nested-clips" ? `<div class="outer">${content}</div>` : content}`,
      );
      const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      if (name !== "nested-clips") {
        const host = walk(captured.tree).find((node) => node.pseudoFragments?.length)!;
        if (name === "displayNone") host.displayNone = true;
        else host.cullClass = "synthetic-hidden";
        await page.locator(".host").evaluate((element) => {
          (element as HTMLElement).style.visibility = "hidden";
        });
      }
      const expected = await sharp(await page.screenshot())
        .ensureAlpha()
        .raw()
        .toBuffer();
      await output.setContent(
        `<style>body{margin:0}.synthetic-hidden{visibility:hidden}</style>${elementTreeToSvg(captured.tree, 80, 80)}`,
      );
      expect(
        await sharp(await output.screenshot())
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ).toEqual(expected);
    } finally {
      await page.close();
      await output.close();
    }
  },
  30_000,
);

it("retains containing-block clip escapes and atomic context effects", async () => {
  const viewport = { width: 80, height: 80 };
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  const cases = [
    { name: "absolute outside containing block", css: ".icon{position:absolute;left:15px;top:15px}" },
    { name: "absolute inside containing block", css: ".clip{position:relative}.icon{position:absolute;left:0;top:0}" },
    { name: "viewport fixed escapes clip", css: ".icon{position:fixed;left:15px;top:15px}" },
    {
      name: "fixed contained by transformed context",
      css: ".outer{transform:translate(0,0)}.icon{position:fixed;left:0;top:0}",
    },
    { name: "opacity context applies once", css: ".outer{opacity:.5}" },
    { name: "explicit context applies once", css: ".outer{position:relative;z-index:0}" },
    { name: "in-flow float clipping", css: ".icon{position:static;float:left}" },
    { name: "source inline SVG terminal surface", css: ".icon{position:relative;z-index:1}", svgRoot: true },
  ];
  try {
    for (const sample of cases) {
      const icon = content.match(/<svg.*<\/svg>/)![0];
      await page.setContent(
        `<!doctype html><style>body{margin:0;background:white}.outer{position:relative;margin:15px;width:25px;height:25px;overflow:hidden}.clip{width:15px;height:38px;overflow:hidden}.icon{position:relative;z-index:1;width:38px;height:38px;display:flex;align-items:center;justify-content:center}${sample.css}</style><div class="outer"><div class="clip">${sample.svgRoot ? icon.replace("<svg ", '<svg class="icon" ') : `<div class="icon">${icon}</div>`}</div></div>`,
      );
      const expected = await sharp(await page.screenshot())
        .ensureAlpha()
        .raw()
        .toBuffer();
      const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      expect(
        captured.warnings.map((warning) => warning.feature),
        sample.name,
      ).toEqual(sample.css.includes("position:fixed") ? ["position:fixed"] : []);
      await output.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(captured.tree, 80, 80)}`);
      expect(
        await sharp(await output.screenshot())
          .ensureAlpha()
          .raw()
          .toBuffer(),
        sample.name,
      ).toEqual(expected);
    }
  } finally {
    await page.close();
    await output.close();
  }
}, 30_000);

it("keeps real descendant cull and animation shorthands on independent owners", async () => {
  const viewport = { width: 80, height: 80 };
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<!doctype html><style>body{margin:0;background:white}.host{position:relative;margin:20px;width:38px;height:38px}.icon{position:relative;z-index:1;width:38px;height:38px;display:flex;align-items:center;justify-content:center}</style>${content}`,
    );
    const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
    const host = walk(captured.tree).find(
      (node) => node.styles.position === "relative" && node.children.some((child) => child.styles.zIndex === "1"),
    )!;
    host.cullClass = "animated-cull";
    host.animId = "motion";
    host.animatedProperties = [];
    await page.locator(".host").evaluate((element) => {
      (element as HTMLElement).style.visibility = "hidden";
    });
    const expected = await sharp(await page.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer();
    await output.setContent(
      `<style>body{margin:0}@keyframes hide{from,to{visibility:hidden}}@keyframes pose{from,to{transform:translateX(0px)}}.animated-cull{animation:hide 1s infinite}.anim-motion{animation:pose 1s infinite}</style>${elementTreeToSvg(captured.tree, 80, 80)}`,
    );
    expect(
      await sharp(await output.screenshot())
        .ensureAlpha()
        .raw()
        .toBuffer(),
    ).toEqual(expected);
  } finally {
    await page.close();
    await output.close();
  }
});
