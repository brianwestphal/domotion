#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { launchChromium } from "../src/index.js";
import { captureNativeScrollbarFingerprint } from "../src/capture/native-scrollbar-raster.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const PINNED_CHROMIUM_SOURCE = "7d859f271cbda744098ac69f44978d4edfa62be3";

async function main(): Promise<void> {
  const outputIndex = process.argv.indexOf("--json");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const browser = await launchChromium({ args: ["--enable-blink-features=AppearanceBase"] });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
    const platform = await captureNativeScrollbarFingerprint(page);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const report = {
      schemaVersion: 1,
      sourceRevision: PINNED_CHROMIUM_SOURCE,
      platform,
      userAgent,
      matrix: {
        controls: ["checkbox", "radio", "range", "progress", "meter", "file", "date", "select", "details"],
        deviceScaleFactors: [1, 2],
        schemes: ["light", "dark"],
        forcedColors: ["none", "active"],
        directions: ["ltr", "rtl"],
      },
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath == null) process.stdout.write(json);
    else {
      const absolute = resolve(outputPath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, json);
    }
  } finally {
    await closeBrowserSafely(browser);
  }
}

await main();
