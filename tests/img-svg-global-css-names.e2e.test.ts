import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { inlineImgSvg } from "../src/render/svg-inline.js";

let browser: Browser | null = null;
afterAll(async () => browser?.close());
try {
  browser = await chromium.launch({ headless: true });
} catch {
  browser = null;
}
const describeBrowser = browser ? describe : describe.skip;

/** The `<img>` stays a separate Blink document; both source sheets define --tone. */
function source(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">
    <style><![CDATA[@property --tone { syntax: "<color>"; inherits: false; initial-value: ${color} }
      rect { fill: var(--tone) }]]></style><rect width="30" height="30"/></svg>`;
}

describeBrowser("inlined SVG image global CSS names", () => {
  it("preserves each image's registered-property paint when two sheets use one name", async () => {
    const red = source("red");
    const blue = source("blue");
    const placement = { y: 0, w: 30, h: 30, par: "xMidYMid meet" };
    const inlinedRed = inlineImgSvg(red, { ...placement, x: 0, idPrefix: "red-" });
    const inlinedBlue = inlineImgSvg(blue, { ...placement, x: 30, idPrefix: "blue-" });
    expect(inlinedRed).not.toBeNull();
    expect(inlinedBlue).not.toBeNull();
    const dataUrl = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const page = await browser!.newPage();
    try {
      await page.setContent(`<img id="source-red" src="${dataUrl(red)}"><img id="source-blue" src="${dataUrl(blue)}">
        <svg id="output" xmlns="http://www.w3.org/2000/svg" width="60" height="30">${inlinedRed}${inlinedBlue}</svg>`);
      const colors = await page.evaluate(async () => {
        const pixel = async (id: string): Promise<string> => {
          const img = document.getElementById(id) as HTMLImageElement;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 30;
          canvas.height = 30;
          const context = canvas.getContext("2d")!;
          context.drawImage(img, 0, 0);
          return Array.from(context.getImageData(15, 15, 1, 1).data).join(",");
        };
        const output = document.getElementById("output")!;
        const fills = Array.from(output.querySelectorAll("rect"), (rect) => getComputedStyle(rect).fill);
        return { sources: [await pixel("source-red"), await pixel("source-blue")], fills };
      });
      expect(colors.sources).toEqual(["255,0,0,255", "0,0,255,255"]);
      expect(colors.fills).toEqual(["rgb(255, 0, 0)", "rgb(0, 0, 255)"]);
    } finally {
      await page.close();
    }
  });
});
