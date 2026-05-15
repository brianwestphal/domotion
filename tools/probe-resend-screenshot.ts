/* eslint-disable */
/**
 * Reproduce the "Page.captureScreenshot: Unable to capture screenshot"
 * error on `resend-mobile-scroll.svg`. Loads the same HTML wrapper
 * `real-world.tsx` builds and tries to screenshot at the same clip.
 *
 * Captures Chromium console / page-error events so we can see whether the
 * page is crashing the renderer process or the screenshot is simply
 * timing out.
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SVG = resolve(HERE, "../tests/output/real-world/resend-mobile-scroll.svg");
const WRAPPER = resolve(HERE, "../tests/output/real-world/resend-mobile-scroll.wrapper.html");

async function main() {
  const svg = readFileSync(SVG, "utf8");
  console.log(`SVG: ${svg.length} chars (${(svg.length / 1024 / 1024).toFixed(2)} MB)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on("crash", () => console.log("PAGE CRASH"));
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text()); });

  if (!existsSync(WRAPPER)) {
    const wrapper = `<!doctype html><html><head>`
      + `<meta charset="utf-8">`
      + `<meta name="viewport" content="width=390, initial-scale=1, maximum-scale=1, user-scalable=no">`
      + `<style>html,body{margin:0;padding:0;background:#000;}svg{display:block;}</style>`
      + `</head><body>${svg.replace(/^<\?xml[^?]*\?>/, "")}</body></html>`;
    writeFileSync(WRAPPER, wrapper);
  }
  console.log(`Wrapper: ${WRAPPER}`);

  const t0 = Date.now();
  try {
    await page.goto(`file://${WRAPPER}`, { timeout: 60_000 });
    console.log(`page.goto OK (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`page.goto FAILED (${Date.now() - t0}ms):`, e instanceof Error ? e.message.split("\n")[0] : String(e));
  }

  await page.waitForTimeout(300);

  const t1 = Date.now();
  try {
    await page.screenshot({ path: "/tmp/claude/resend-screenshot-attempt.png", clip: { x: 0, y: 0, width: 390, height: 844 }, timeout: 60_000, animations: "disabled" });
    console.log(`screenshot OK (${Date.now() - t1}ms)`);
  } catch (e) {
    console.log(`screenshot FAILED (${Date.now() - t1}ms):`, e instanceof Error ? e.message.split("\n")[0] : String(e));
  }

  // Diagnostic: how many DOM nodes did the wrapper produce?
  try {
    const nodeCount = await page.evaluate(() => document.querySelectorAll("*").length);
    console.log(`DOM nodes: ${nodeCount}`);
    const svgEl = await page.evaluate(() => {
      const s = document.querySelector("svg");
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    console.log(`SVG bounding rect:`, svgEl);
  } catch (e) {
    console.log(`evaluate failed:`, e instanceof Error ? e.message.split("\n")[0] : String(e));
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
