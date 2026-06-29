// DM-1436: prove a CAPTURE-side refactor leaves the captured tree byte-identical.
// Captures a curated representative set of external/html-test fixtures (all the
// forms / fieldset / multicol fixtures the item-2 blocks touch, plus a stride
// sample for broad coverage) through the real pipeline and writes a
// {fixture: sha256(JSON.stringify(tree))} manifest. Rebuild the capture script
// (npm run build:capture-script) before running so it reflects current source.
//
//   npx tsx tools/probe-1436-byte-validate-capture.mjs <out-manifest.json>

import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { captureElementTree } from "../src/capture/index.ts";

const OUT = process.argv[2] ?? "tools/scratch/capture-manifest.json";
const DIR = "external/html-test";
const all = readdirSync(DIR).filter((f) => f.endsWith(".html")).sort();
// Curate: everything touched by item 2 (forms/fieldset/column) + a stride sample.
const picked = all.filter((f, i) =>
  /form|fieldset|legend|column|multicol|input|table|text|inline|float|list/.test(f) || i % 7 === 0,
);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const manifest = {};
let n = 0;
for (const f of picked) {
  try {
    await page.setContent(readFileSync(join(DIR, f), "utf-8"));
    await page.waitForLoadState("domcontentloaded");
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
    manifest[f] = createHash("sha256").update(JSON.stringify(tree)).digest("hex").slice(0, 16);
  } catch (e) {
    manifest[f] = `ERROR:${e.message}`;
  }
  if (++n % 20 === 0) console.error(`...${n}/${picked.length}`);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(manifest, null, 0));
console.error(`captured ${n} fixtures → ${OUT}`);
