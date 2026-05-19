/**
 * Probe: run captureElementTree against slashdot mobile and inspect what we
 * captured for "Most Discussed".
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";

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
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Apply the same freeze step real-world.tsx applies.
  await page.evaluate(() => {
    if (typeof document.getAnimations === "function") {
      for (const a of document.getAnimations()) { try { a.pause(); } catch { /* */ } }
    }
    const probe = window.setTimeout(() => {}, 0) as unknown as number;
    window.clearTimeout(probe);
    for (let i = 1; i <= probe; i++) {
      try { window.clearTimeout(i); } catch { /* */ }
      try { window.clearInterval(i); } catch { /* */ }
    }
  });

  const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 390, height: 844 });

  function walk(node: any, depth: number = 0): void {
    if (depth > 30) return;
    const text = node.text ?? node.textContent ?? "";
    const looks = node.styles?.fontStyle?.includes?.("italic")
      || node.styles?.textDecorationLine?.includes?.("underline")
      || (typeof text === "string" && text.includes("Most Discussed"));
    if (looks) {
      console.log(`[${depth}] <${node.tag ?? "?"}> rect=(${node.x?.toFixed?.(0)},${node.y?.toFixed?.(0)} ${node.width?.toFixed?.(0)}×${node.height?.toFixed?.(0)}) fontStyle=${node.styles?.fontStyle} td=${node.styles?.textDecorationLine} text=${JSON.stringify(typeof text === "string" ? text.slice(0, 60) : "")}`);
      // Also print full styles for italic / underline carriers
      if (typeof text === "string" && text.includes("Most Discussed")) {
        console.log("  textSegments:", JSON.stringify(node.textSegments));
        console.log("  styles:", JSON.stringify({
          fontStyle: node.styles?.fontStyle,
          fontWeight: node.styles?.fontWeight,
          fontFamily: node.styles?.fontFamily,
          textDecorationLine: node.styles?.textDecorationLine,
          textDecorationColor: node.styles?.textDecorationColor,
          textDecorationStyle: node.styles?.textDecorationStyle,
          display: node.styles?.display,
        }));
      }
    }
    for (const c of (node.children ?? [])) walk(c, depth + 1);
  }
  for (const root of cap.tree) walk(root);
  await browser.close();
}
void main();
