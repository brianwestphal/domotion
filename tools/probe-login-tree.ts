/**
 * Probe: dump the captured tree for the Slashdot mobile fold login area
 * (x≈296, y≈6, w=89, h=31) — see if "Login" text and the "+" sprite are
 * actually captured.
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
  const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 390, height: 844 });
  console.log(`Top-level: ${cap.tree.length} entries`);
  for (const r of cap.tree) {
    console.log(`  <${r.tag}.${(r.classList ?? []).join(".")}> rect=(${r.x?.toFixed?.(0)},${r.y?.toFixed?.(0)} ${r.width?.toFixed?.(0)}×${r.height?.toFixed?.(0)}) float=${r.styles?.float ?? "none"} pos=${r.styles?.position}`);
  }
  console.log("---");

  function inRegion(n: any): boolean {
    const r = { x: 280, y: 0, w: 110, h: 50 };
    if (n.x == null || n.y == null) return false;
    const ix = Math.max(n.x, r.x), iy = Math.max(n.y, r.y);
    const ax = Math.min(n.x + (n.width ?? 0), r.x + r.w);
    const ay = Math.min(n.y + (n.height ?? 0), r.y + r.h);
    return ix < ax && iy < ay;
  }
  function walk(n: any, depth: number = 0): void {
    if (depth > 30) return;
    if (inRegion(n)) {
      const bg = n.styles?.backgroundImage?.slice(0, 80) ?? "";
      const text = typeof n.text === "string" ? n.text : "";
      console.log(`[${depth}] <${n.tag ?? "?"}.${(n.classList ?? []).join(".")}> rect=(${n.x?.toFixed?.(0)},${n.y?.toFixed?.(0)} ${n.width?.toFixed?.(0)}×${n.height?.toFixed?.(0)}) display=${n.styles?.display} text=${JSON.stringify(text.slice(0, 40))}${bg !== "" && bg !== "none" ? " bg=" + bg : ""}`);
      if (text.includes("Login")) {
        console.log("  textSegments:", JSON.stringify(n.textSegments));
      }
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  }
  for (const root of cap.tree) walk(root);
  await browser.close();
}
void main();
