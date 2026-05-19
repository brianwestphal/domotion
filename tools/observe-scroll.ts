/**
 * Probe: render the DM-668 nytimes-desktop-scroll SVG via Playwright and
 * screenshot it at evenly-spaced animation timepoints. Lets us see whether
 * content "pops in" or scrolls cleanly across segment boundaries.
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const SVG_PATH = resolve(TOOLS_DIR, "..", "tests/output/real-world/nytimes-desktop-scroll.svg");
const OUT_DIR = "/tmp/claude/dm668-frames";

async function main() {
  if (!existsSync(SVG_PATH)) throw new Error(`SVG not found: ${SVG_PATH}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const svg = readFileSync(SVG_PATH, "utf8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#000;}svg{display:block;}</style></head><body>${svg.replace(/^<\?xml[^?]*\?>/, "")}</body></html>`;
  const wrapperPath = "/tmp/claude/dm668-wrapper.html";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(wrapperPath, html);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`file://${wrapperPath}`);
  await page.waitForTimeout(300);

  // Sample around the s0/s1 → s2 boundary (5.263%). Two frames either side of
  // the boundary to make a pop visible if it exists.
  const TOTAL_MS = 12008;
  // Zoom in on the s1→s2 boundary at 5.263% (scroll-y=800). Step in 0.05%
  // increments so any single-frame pop is visible.
  // Sample around the s5→s6 boundary where the user observed the pop
  // (~3.3s of the 12.008s cycle = 27.5% pct). Capture at 60 fps spacing.
  const samples: Array<{ tag: string; pct: number }> = [];
  for (let frame = 195; frame <= 205; frame++) {
    const pct = (frame / 60) / 12.008 * 100;
    samples.push({ tag: `f${frame}_${pct.toFixed(2).replace(".", "_")}`, pct });
  }
  for (const s of samples) {
    const ms = (s.pct / 100) * TOTAL_MS;
    await page.evaluate((tMs) => {
      for (const a of document.getAnimations()) {
        try { a.currentTime = tMs; a.pause(); } catch { /* */ }
      }
    }, ms);
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${OUT_DIR}/${s.tag}.png` });
  }
  console.log(`Saved samples to ${OUT_DIR}`);
  await browser.close();
}
void main();
