import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 320;
const HEIGHT = 140;
const FULL_TEXT = "abcdefghijklmno pqrstuvwxyz";
const HTML = readFileSync(new URL("./fixtures/truncation-marker.html", import.meta.url), "utf8");

function findText(nodes: readonly CapturedElement[], value: string): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.text === value) return node;
    const child = findText(node.children ?? [], value);
    if (child != null) return child;
  }
  return undefined;
}

async function redMarkerBounds(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 48; y < 104; y++) {
    for (let x = 220; x < 272; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 100 || data[offset] < data[offset + 1] * 1.8) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  return { minX, maxX, minY, maxY, count };
}

const browser = await launchChromium();
afterAll(async () => closeBrowserSafely(browser), 15_000);

describe("default-capture text-overflow marker", () => {
  it("retains the full source, emits the measured marker, and matches Chromium ink", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const expected = await page.screenshot();
      const { tree, warnings } = await captureElementTreeWithWarnings(page, "body", {
        x: 0,
        y: 0,
        width: WIDTH,
        height: HEIGHT,
      });
      const truncated = findText(tree, FULL_TEXT);
      expect(truncated?.textSegments?.[0]?.text).toBe(FULL_TEXT);
      expect(truncated?.textSegments?.[0]?.width).toBeGreaterThan(112);
      expect(truncated?.transformSubtreeRaster).toBeUndefined();
      expect(warnings).toEqual([]);
      expect(findText(tree, "short")?.transformSubtreeRaster).toBeUndefined();

      const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
      expect(svg.match(/role="img" aria-label="…"/g)).toHaveLength(1);
      expect(svg).not.toContain("<image");
      await page.setContent(`<body style="margin:0">${svg}</body>`, { waitUntil: "load" });
      const actual = await page.screenshot();
      const chrome = await redMarkerBounds(expected);
      const rendered = await redMarkerBounds(actual);
      expect(chrome.count).toBeGreaterThan(10);
      expect(rendered.count).toBeGreaterThan(10);
      for (const key of ["minX", "maxX", "minY", "maxY"] as const) {
        expect(
          Math.abs(rendered[key] - chrome[key]),
          `${key}: ${JSON.stringify({ chrome, rendered })}`,
        ).toBeLessThanOrEqual(4);
      }
    } finally {
      await page.close();
    }
  });
});
