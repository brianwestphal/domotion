#!/usr/bin/env node
/**
 * One-shot probe that measures the rendered content height of every
 * `external/html-test/**.html` fixture and emits a TypeScript-ready map of
 * fixtures whose content overruns the 1024 × 768 default capture viewport
 * (DM-781). Re-run whenever fixtures grow taller and paste the new entries
 * into `FIXTURE_HEIGHT_OVERRIDES` in `tests/html-test-suite.tsx`.
 *
 *   node tools/probe-html-test-heights.mjs
 *
 * Output is sorted alphabetically by flattened fixture name (the same name
 * the runner uses for output PNGs and the override-map key). Each entry's
 * height is the lowest visible element's bottom edge, rounded up to the
 * next 8 px with an additional 8 px safety buffer.
 */
import { chromium } from "playwright";
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "external", "html-test");
const WIDTH = 1024;
const BASE_HEIGHT = 768;

function walk(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const full = resolve(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, rel));
    } else if (name.endsWith(".html") && rel !== "index.html") {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(ROOT).sort();
console.error(`Probing ${files.length} fixtures…`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: BASE_HEIGHT } });
const page = await ctx.newPage();

const entries = [];
for (const file of files) {
  await page.goto(`file://${resolve(ROOT, file)}`);
  await page.waitForTimeout(80);
  const measure = await page.evaluate(() => {
    let maxBottom = 0;
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    return {
      scrollH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      maxBottom: Math.ceil(maxBottom),
    };
  });
  const required = Math.max(measure.scrollH, measure.maxBottom);
  if (required > BASE_HEIGHT) {
    const name = file.replace(/\.html$/, "").replace(/\//g, "-");
    entries.push({ name, height: Math.ceil((required + 8) / 8) * 8 });
  }
}

await browser.close();

entries.sort((a, b) => a.name.localeCompare(b.name));
console.error(`${entries.length} fixtures exceed ${BASE_HEIGHT} px.\n`);
console.log("const FIXTURE_HEIGHT_OVERRIDES: Record<string, number> = {");
for (const e of entries) console.log(`  ${JSON.stringify(e.name)}: ${e.height},`);
console.log("};");
