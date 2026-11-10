import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const icon =
  '<svg width="20" height="20" viewBox="0 0 20 20"><path fill="rgb(83,58,253)" d="M13.75 6.75H10.25V5H15.5V10.25H13.75ZM6.75 10.25H5V15.5H10.25V13.75H6.75Z"/></svg>';
const content = `<div class="host"><div class="icon">${icon}</div></div>`;
function html(css: string, markup = content, pseudo = "after"): string {
  return `<!doctype html><style>body{margin:0;background:white}.host{position:relative;z-index:auto;margin:20px;width:38px;height:38px}.icon{position:relative;z-index:1;width:38px;height:38px;display:flex;align-items:center;justify-content:center}.host::${pseudo}{content:"";position:absolute;inset:0;background:rgb(245,245,255);border-radius:4px;z-index:2}${css}</style>${markup}`;
}
function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}
async function rgba(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).ensureAlpha().raw().toBuffer();
}
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

describe("source nonnegative pseudo ancestor ownership (DM-NAG7AD)", () => {
  it("preserves native deep flex layer order when layer ancestry is unavailable", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      for (const depth of [0, 3]) {
        const wrap = (value: string): string => '<div class="wrap">'.repeat(depth) + value + "</div>".repeat(depth);
        const a =
          depth === 0 ? '<div class="A host"></div>' : `<div class="A">${wrap('<div class="host"></div>')}</div>`;
        const b = `<div class="B">${wrap(`<div class="icon">${icon}</div>`)}</div>`;
        await page.setContent(
          html(
            ".flex{display:flex;position:relative;margin:20px;width:38px;height:38px}.A,.B{flex:0 0 38px;width:38px;height:38px;margin-right:-38px}.A{order:1}.B{order:0}.host,.wrap{width:38px;height:38px}.host{position:static;margin:0}.host::after{z-index:1;border-radius:0}",
            `<div class="flex">${a}${b}</div>`,
          ),
        );
        const expected = await page.screenshot();
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
        const warnings: typeof captured.warnings = [];
        const svg = elementTreeToSvg(captured.tree, 80, 80, { warnings });
        expect(warnings.some((warning) => warning.detail.includes("native layer order"))).toBe(depth === 3);
        await output.setContent(`<style>body{margin:0}</style>${svg}`);
        expect(await rgba(await output.screenshot()), `native parent/grandparent limit depth${depth}`).toEqual(
          await rgba(expected),
        );
      }
    } finally {
      await page.close();
      await output.close();
    }
  });

  it("matches full pixels for before/after ties and keeps the negative path unchanged", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      for (const pseudo of ["before", "after"])
        for (const z of ["-1", "auto", "0", "1", "2"]) {
          await page.setContent(html(`.host::${pseudo}{z-index:${z}}`, content, pseudo));
          const expected = await page.screenshot();
          const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
          expect(captured.warnings).toEqual([]);
          const records = walk(captured.tree).flatMap((node) => node.pseudoFragments ?? []);
          const original = JSON.stringify(records);
          const svg = elementTreeToSvg(captured.tree, 80, 80);
          expect(JSON.stringify(records)).toBe(original);
          expect(svg.match(/data-domotion-pseudo="/g)).toHaveLength(1);
          await output.setContent(`<style>body{margin:0}</style>${svg}`);
          expect(await rgba(await output.screenshot()), `${pseudo} z${z}`).toEqual(await rgba(expected));
        }
    } finally {
      await page.close();
      await output.close();
    }
  }, 60_000);

  it("retains nested/sibling ownership, clipping and genuine context barriers", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const cases = [
      {
        name: "nested non-context",
        css: ".outer{position:relative;margin:20px}.host{margin:0}",
        markup: `<div class="outer">${content}</div>`,
      },
      ...[false, true].map((pseudoLast) => ({
        name: `sibling tie pseudo-last ${pseudoLast}`,
        css: ".outer{position:relative;margin:20px;width:38px;height:38px}.host{position:absolute;inset:0;margin:0}.host::after{z-index:1}",
        markup: `<div class="outer">${pseudoLast ? `<div class="icon">${icon}</div><div class="host"></div>` : `<div class="host"></div><div class="icon">${icon}</div>`}</div>`,
      })),
      {
        name: "negative ancestor remains atomic",
        css: ".outer{position:relative;z-index:0;margin:20px;width:38px;height:38px}.negative{position:relative;z-index:-1}.host{margin:0}.sibling{position:absolute;inset:0;z-index:0;background:pink}",
        markup: `<div class="outer"><div class="negative">${content}</div><div class="sibling"></div></div>`,
      },
      ...["opacity:.5", "transform:translate(0px,0px)", "contain:layout"].map((barrier) => ({
        name: `real context ${barrier}`,
        css: `.outer{position:relative;z-index:0;margin:20px;width:38px;height:38px}.host{margin:0;${barrier}}.sibling{position:absolute;inset:0;left:19px;z-index:0;background:pink}`,
        markup: `<div class="outer">${content}<div class="sibling"></div></div>`,
      })),
      {
        name: "own containing block clip",
        css: ".host{width:20px;overflow:hidden}.host::after{left:-10px;right:-10px;border-radius:0}",
      },
      {
        name: "nested pseudo clip intersection",
        css: ".outer{position:relative;margin:20px;width:30px;height:30px;overflow:hidden}.host{margin:10px 0 0 10px;width:30px;height:30px;overflow:hidden}.host::after{inset:-10px;border-radius:0}.icon{position:static;z-index:auto}",
        markup: `<div class="outer">${content}</div>`,
      },
      {
        name: "absolute escapes non-containing clip",
        css: ".outer{position:relative;margin:20px;width:38px;height:38px}.clip{width:20px;height:38px;overflow:hidden}.host{position:static;margin:0}.host::after{border-radius:0}",
        markup: `<div class="outer"><div class="clip">${content}</div></div>`,
      },
      {
        name: "fixed escapes non-containing clip",
        css: ".host{overflow:hidden;width:20px}.host::after{position:fixed;inset:auto;left:20px;top:20px;width:38px;height:38px;border-radius:0}",
      },
      { name: "single translucent emission", css: ".host::after{opacity:.5}" },
    ];
    try {
      for (const item of cases) {
        await page.setContent(html(item.css, item.markup));
        const expected = await page.screenshot();
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
        expect(captured.warnings, item.name).toEqual([]);
        const svg = elementTreeToSvg(captured.tree, 80, 80);
        expect(svg.match(/data-domotion-pseudo="/g), item.name).toHaveLength(1);
        await output.setContent(`<style>body{margin:0}</style>${svg}`);
        expect(await rgba(await output.screenshot()), item.name).toEqual(await rgba(expected));
      }
    } finally {
      await page.close();
      await output.close();
    }
  }, 60_000);

  it("uses captured in-flow grid order and ignores out-of-flow authored order", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      for (const position of ["relative", "absolute"])
        for (const order of [-1, 0, 1]) {
          await page.setContent(
            html(
              `.host{display:grid}.icon{grid-area:1/1}.host::after{position:${position};grid-area:1/1;width:38px;height:38px;z-index:1;order:${order}}`,
            ),
          );
          const expected = await page.screenshot();
          const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
          const record = walk(captured.tree).flatMap((node) => node.pseudoFragments ?? [])[0];
          expect(record.paint.order).toBe(order);
          await output.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(captured.tree, 80, 80)}`);
          expect(await rgba(await output.screenshot()), `${position} order${order}`).toEqual(await rgba(expected));
        }
    } finally {
      await page.close();
      await output.close();
    }
  }, 60_000);

  it.each(["displayNone", "cullClass"] as const)(
    "retains source-owner %s around escaped generated paint",
    async (state) => {
      const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
      const output = await browser.newPage({ viewport: { width: 80, height: 80 } });
      try {
        // Only generated paint escapes; real-descendant ancestry is covered by DM-9PEZBK.
        await page.setContent(html(".icon{position:static;z-index:auto}"));
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
        const host = walk(captured.tree).find((node) => node.pseudoFragments?.length)!;
        if (state === "displayNone") host.displayNone = true;
        else host.cullClass = "synthetic-hidden";
        await page.locator(".host").evaluate((element) => {
          (element as HTMLElement).style.visibility = "hidden";
        });
        const expected = await page.screenshot();
        await output.setContent(
          `<style>body{margin:0}.synthetic-hidden{visibility:hidden}</style>${elementTreeToSvg(captured.tree, 80, 80)}`,
        );
        expect(await rgba(await output.screenshot())).toEqual(await rgba(expected));
      } finally {
        await page.close();
        await output.close();
      }
    },
  );
  it("keeps cull and animation shorthands on separate inherited owners", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      await page.setContent(html(".icon{position:static;z-index:auto}"));
      const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
      const host = walk(captured.tree).find((node) => node.pseudoFragments?.length)!;
      host.cullClass = "animated-cull";
      host.animId = "motion";
      host.animatedProperties = [];
      await page.locator(".host").evaluate((element) => {
        (element as HTMLElement).style.visibility = "hidden";
      });
      const expected = await page.screenshot();
      await output.setContent(
        `<style>body{margin:0}@keyframes hide{from,to{visibility:hidden}}@keyframes pose{from,to{transform:translateX(0px)}}.animated-cull{animation:hide 1s infinite}.anim-motion{animation:pose 1s infinite}</style>${elementTreeToSvg(captured.tree, 80, 80)}`,
      );
      expect(await rgba(await output.screenshot())).toEqual(await rgba(expected));
    } finally {
      await page.close();
      await output.close();
    }
  });
  it.each(["row", "row-reverse"])(
    "uses native in-flow flex order with direction %s",
    async (direction) => {
      const page = await browser.newPage({ viewport: { width: 160, height: 80 } });
      const output = await browser.newPage({ viewport: { width: 160, height: 80 } });
      try {
        for (const order of [-1, 0, 1]) {
          const left = direction === "row" ? (order < 0 ? 38 : -38) : order < 0 ? -38 : 38;
          await page.setContent(
            html(
              `.host{display:flex;flex-direction:${direction};margin:20px 0 0 60px}.icon{flex:0 0 38px}.host::after{position:relative;inset:auto;left:${left}px;flex:0 0 38px;width:38px;height:38px;z-index:1;order:${order}}`,
            ),
          );
          const expected = await page.screenshot();
          const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 160, height: 80 });
          const record = walk(captured.tree).flatMap((node) => node.pseudoFragments ?? [])[0];
          expect(record.paint.order).toBe(order);
          await output.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(captured.tree, 160, 80)}`);
          expect(await rgba(await output.screenshot()), `${direction} order${order}`).toEqual(await rgba(expected));
        }
      } finally {
        await page.close();
        await output.close();
      }
    },
    30_000,
  );
});
