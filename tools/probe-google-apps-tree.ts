/**
 * Probe: dump captured-tree elements at the DM-665 apps icon region.
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
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "google-desktop.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 1280, height: 800 });

  function walk(n: any, depth: number = 0): void {
    if (depth > 30) return;
    const r = { x: 1131, y: 7, w: 66, h: 52 };
    const ix = Math.max(n.x ?? 0, r.x);
    const iy = Math.max(n.y ?? 0, r.y);
    const ax = Math.min((n.x ?? 0) + (n.width ?? 0), r.x + r.w);
    const ay = Math.min((n.y ?? 0) + (n.height ?? 0), r.y + r.h);
    if (ix < ax && iy < ay) {
      const text = (n.text ?? "").slice(0, 30);
      const styles = n.styles ?? {};
      console.log(`[${depth}] <${n.tag}> rect=(${n.x?.toFixed?.(0)},${n.y?.toFixed?.(0)} ${n.width?.toFixed?.(0)}×${n.height?.toFixed?.(0)}) bg=${styles.backgroundColor?.slice?.(0, 30)} color=${styles.color?.slice?.(0, 30)} bgImage=${styles.backgroundImage?.slice?.(0, 80) ?? "none"} text=${JSON.stringify(text)} replSnap=${n.replacedSnapshot != null} imgSrc=${n.imageSrc?.slice?.(0, 60)} maskImage=${styles.maskImage?.slice?.(0, 40)}`);
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  }
  for (const root of cap.tree) walk(root);
  await browser.close();
}
void main();
