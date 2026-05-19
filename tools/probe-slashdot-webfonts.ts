/**
 * Probe: walk the same path real-world.tsx uses to register webfonts for the
 * Slashdot mobile fold, then print the contents of webfontRegistry for the
 * "open sans" key. Verifies whether the italic variant ends up registered.
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { __pickWebfontVariantMetaForTest } from "../src/render/text-to-path.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "slashdot-mobile.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();

  const fontUrls = new Set<string>();
  page.on("requestfinished", (req) => {
    const url = req.url();
    if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url)) fontUrls.add(url);
  });

  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const report = await discoverAndRegisterWebfonts(page, fontUrls);
  console.log("=== discoverAndRegisterWebfonts report ===");
  for (const r of report) {
    console.log(JSON.stringify(r));
  }

  console.log("\n=== Variant scoring for 'open sans' ===");
  console.log("regular:", JSON.stringify(__pickWebfontVariantMetaForTest("open sans", 400, false)));
  console.log("italic :", JSON.stringify(__pickWebfontVariantMetaForTest("open sans", 400, true)));
  console.log("bold   :", JSON.stringify(__pickWebfontVariantMetaForTest("open sans", 700, false)));

  await browser.close();
}
void main();
