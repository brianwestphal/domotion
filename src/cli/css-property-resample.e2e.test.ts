import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Browser } from "@playwright/test";
import { composeAnimateConfig, launchChromium, validateAnimateConfig } from "../index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { buildCssPropertyResampleAnimation } from "./css-property-resample.js";

const html = `<!doctype html><style>
  @property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
  @keyframes turn { from { --angle: 0deg; } to { --angle: 180deg; } }
  body { margin: 0; background: white; }
  #tile { width: 60px; height: 60px; animation: turn 120ms linear both;
    background: conic-gradient(from var(--angle), red 0 25%, blue 25% 50%, green 50% 75%, yellow 75% 100%); }
</style><div id="tile"></div>`;
const dir = mkdtempSync(join(tmpdir(), "domotion-css-property-resample-"));
const htmlPath = join(dir, "conic.html");
writeFileSync(htmlPath, html);
let browser: Browser | null = null;
try {
  browser = await launchChromium();
} catch {
  /* browser unavailable */
}
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closeBrowserSafely(browser);
});
const describeBrowser = browser ? describe : describe.skip;

describeBrowser("source-owned conic animation capture", () => {
  it("samples a registered custom-property transition after a page action", async () => {
    const context = await browser!.newContext({ viewport: { width: 100, height: 100 } });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><style>
        @property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
        #tile { width: 60px; height: 60px; --angle: 0deg; transition: --angle 120ms linear;
          background: conic-gradient(from var(--angle), red 0 25%, blue 25% 50%, green 50% 75%, yellow 75% 100%); }
      </style><div id="tile"></div>`);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await page
        .locator("#tile")
        .evaluate((element) => (element as HTMLElement).style.setProperty("--angle", "180deg"));
      const result = await buildCssPropertyResampleAnimation(
        page,
        { selector: "#tile", fps: 25 },
        {
          width: 100,
          height: 100,
          durationMs: 120,
          framePrefix: "ct0_",
        },
      );
      const tiles = [...result.svgContent.matchAll(/href="(data:image\/png;base64,[^"]+)"/g)].map((match) => match[1]);
      expect(new Set(tiles).size).toBeGreaterThan(1);
      expect(
        await page
          .locator("#tile")
          .evaluate((element) => element.getAnimations().every((a) => a.playState !== "paused")),
      ).toBe(true);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("samples visibly different Chromium conic tiles and restores the CSS animation", async () => {
    const context = await browser!.newContext({ viewport: { width: 100, height: 100 } });
    try {
      const page = await context.newPage();
      await page.goto(`file://${htmlPath}`);
      const result = await buildCssPropertyResampleAnimation(
        page,
        { selector: "#tile", fps: 25 },
        {
          width: 100,
          height: 100,
          durationMs: 120,
          framePrefix: "cp0_",
        },
      );
      expect(result.periodMs).toBe(120);
      const tiles = [...result.svgContent.matchAll(/href="(data:image\/png;base64,[^"]+)"/g)].map((match) => match[1]);
      expect(tiles.length).toBeGreaterThanOrEqual(4);
      const first = await sharp(Buffer.from(tiles[0].split(",")[1], "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const last = await sharp(Buffer.from(tiles.at(-1)!.split(",")[1], "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (data: Buffer, channels: number) => [
        ...data.subarray((5 * 60 + 30) * channels, (5 * 60 + 30) * channels + 3),
      ];
      expect(at(first.data, first.info.channels)).not.toEqual(at(last.data, last.info.channels));
      expect(await page.locator("#tile").evaluate((element) => element.getAnimations()[0]?.playState)).toBe("running");
    } finally {
      await context.close();
    }
  }, 120_000);

  it("nests the sampled frames inside one config frame", async () => {
    const config = validateAnimateConfig({
      width: 100,
      height: 100,
      frames: [{ input: htmlPath, duration: 120, cssPropertyResample: { selector: "#tile", fps: 25 } }],
    });
    const svg = await composeAnimateConfig(browser!, config, dir);
    expect(svg).toContain("cp0_f-3");
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(1);
  }, 120_000);
});
