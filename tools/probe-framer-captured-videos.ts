/* eslint-disable */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/capture/index.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "framer-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
  });

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });

  const found: any[] = [];
  const walk = (el: any, depth: number) => {
    if (el.tag === 'video' || el.tag === 'canvas' || el.tag === 'iframe') {
      found.push({
        depth, tag: el.tag,
        rect: { x: el.x, y: el.y, w: el.width, h: el.height },
        replacedSnapshot: el.replacedSnapshot ? { hasDataUri: el.replacedSnapshot.dataUri != null, dataUriLen: el.replacedSnapshot.dataUri?.length || 0 } : null,
        imageSrc: el.imageSrc ? (el.imageSrc.slice(0, 50)) : null,
        bg: el.styles?.backgroundColor,
        opacity: el.styles?.opacity,
      });
    }
    if (Array.isArray(el.children)) for (const c of el.children) walk(c, depth + 1);
  };
  for (const r of tree) walk(r, 0);
  console.log(JSON.stringify(found, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
