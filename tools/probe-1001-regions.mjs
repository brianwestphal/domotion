// Dump the 21 diff regions for nytimes-mobile-entire-page.
import { chromium } from "@playwright/test";
import { comparePngs } from "../dist/review/compare-pngs.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const expected = "tests/output/real-world/nytimes-mobile-entire-page-expected.png";
const actual = "tests/output/real-world/nytimes-mobile-entire-page-actual.png";
const diff = join(mkdtempSync(join(tmpdir(), "probe-")), "diff.png");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();

const r = await comparePngs(page, expected, actual, diff);
await browser.close();

console.log(`regionCount=${r.regionCount} diffPct=${r.diffPct.toFixed(2)}% verdict=${r.verdict}`);
console.log("regions sorted by area (largest first):");
const regions = (r.regions ?? []).slice();
regions.sort((a, b) => b.area - a.area);
for (let i = 0; i < regions.length; i++) {
  const reg = regions[i];
  console.log(`  [${i + 1}] x=${reg.x} y=${reg.y} w=${reg.w} h=${reg.h} area=${reg.area} maxSev=${reg.maxSeverity}`);
}
