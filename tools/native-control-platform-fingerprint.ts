#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { captureNativeScrollbarFingerprint } from "../src/capture/native-scrollbar-raster.js";
import { withBrowser } from "./lib/browser.js";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";

const PINNED_CHROMIUM_SOURCE = "7d859f271cbda744098ac69f44978d4edfa62be3";

export async function nativeControlPlatformFingerprint(argv: string[]): Promise<number> {
  const values = parseFlags(argv, { json: { type: "string" } });
  const outputPath = flag(values, "json");
  await withBrowser(
    async (browser) => {
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
        const absolute = resolve(String(outputPath));
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, json);
      }
    },
    { args: ["--enable-blink-features=AppearanceBase"] },
  );
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => nativeControlPlatformFingerprint(process.argv.slice(2)));
