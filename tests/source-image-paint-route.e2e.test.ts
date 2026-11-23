import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);
async function rgba(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).ensureAlpha().raw().toBuffer();
}

async function checkerUri(): Promise<string> {
  const pixels = Buffer.alloc(32 * 32 * 3);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const index = (y * 32 + x) * 3;
      pixels[index] = y % 4 < 2 ? 255 : 0;
      pixels[index + 1] = x % 4 < 2 ? 255 : 0;
      pixels[index + 2] = 128;
    }
  const bytes = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();
  return "data:image/png;base64," + bytes.toString("base64");
}

it("distinguishes inline SVG root paint mapping from its fractional DOM CTM (DM-7PGR0X)", async () => {
  const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
  const path =
    '<path fill="rgb(83,58,253)" d="M13.75 6.75H10.25V5H15.5V10.25H13.75ZM6.75 10.25H5V15.5H10.25V13.75H6.75Z"/>';
  const style = "<style>body{margin:0;background:rgb(245,245,255)}svg{display:block}</style>";
  try {
    await page.setContent(
      `${style}<svg style="position:absolute;left:29px;top:29.484375px" width="20" height="20" viewBox="0 0 20 20">${path}</svg>`,
    );
    const facts = await page.locator("svg").evaluate((svg) => {
      if (!(svg instanceof SVGSVGElement)) throw new Error("expected native SVG root");
      return { layoutY: svg.getBoundingClientRect().y, ctmY: svg.getScreenCTM()!.f };
    });
    expect(facts).toEqual({ layoutY: 29.484375, ctmY: 29.484375 });
    const source = await rgba(await screenshotAfterPresentedFrame(page));
    for (const y of [29.484375, 29.5, 29]) {
      await page.setContent(
        `${style}<svg width="80" height="80"><svg x="29" y="${y}" width="20" height="20" viewBox="0 0 20 20">${path}</svg></svg>`,
      );
      const nested = await rgba(await page.screenshot());
      if (y === 29) expect(nested).toEqual(source);
      else expect(nested).not.toEqual(source);
    }
  } finally {
    await page.close();
  }
});

it("distinguishes HTML image pixel-snapped paint from fractional SVG image paint (DM-7PGR0X)", async () => {
  const uri = await checkerUri();
  const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
  const style = "<style>body{margin:0;background:white}</style>";
  try {
    await page.setContent(
      `${style}<img style="position:absolute;left:16px;top:10.484375px;width:38px;height:40.234375px;object-fit:fill" src="${uri}">`,
    );
    await page.locator("img").evaluate((image) => {
      if (!(image instanceof HTMLImageElement)) throw new Error("expected native IMG");
      return image.decode();
    });
    const rect = await page.locator("img").evaluate((image) => {
      const box = image.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    expect(rect).toEqual({ x: 16, y: 10.484375, width: 38, height: 40.234375 });
    const source = await rgba(await screenshotAfterPresentedFrame(page));
    for (const paint of [
      { y: 10.484375, height: 40.234375 },
      { y: 10, height: 41 },
    ]) {
      await page.setContent(
        `${style}<svg width="80" height="80"><image href="${uri}" x="16" y="${paint.y}" width="38" height="${paint.height}" preserveAspectRatio="none"/></svg>`,
      );
      const svg = await rgba(await page.screenshot());
      if (paint.y === 10) expect(svg).toEqual(source);
      else expect(svg).not.toEqual(source);
    }
  } finally {
    await page.close();
  }
});

it("retains identical DOM geometry while native paint isolation resets subpixel accumulation (DM-7PGR0X)", async () => {
  const uri = await checkerUri();
  const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
  const style = "<style>body{margin:0;background:white}</style>";
  const sources: Buffer[] = [];
  try {
    for (const contain of ["layout", "layout style"]) {
      await page.setContent(
        `${style}<div style="position:absolute;left:16px;top:10.484375px;width:38px;height:39.5px;contain:${contain}"><img style="display:block;width:38px;height:40.234375px;object-fit:fill" src="${uri}"></div>`,
      );
      await page.locator("img").evaluate((image) => {
        if (!(image instanceof HTMLImageElement)) throw new Error("expected native IMG");
        return image.decode();
      });
      const rect = await page.locator("img").evaluate((image) => {
        const box = image.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
      expect(rect).toEqual({ x: 16, y: 10.484375, width: 38, height: 40.234375 });
      const source = await rgba(await screenshotAfterPresentedFrame(page));
      sources.push(source);
      const paintHeight = contain === "layout" ? 41 : 40;
      await page.setContent(
        `${style}<svg width="80" height="80"><image href="${uri}" x="16" y="10" width="38" height="${paintHeight}" preserveAspectRatio="none"/></svg>`,
      );
      expect(await rgba(await page.screenshot()), contain).toEqual(source);
    }
    expect(sources[0]).not.toEqual(sources[1]);
  } finally {
    await page.close();
  }
});
