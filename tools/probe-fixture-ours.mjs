// Measure OUR pipeline on the real fixture via SVG glyph-def reuse (reliable —
// no raster round-trip). Dominant reused <use> target = tofu glyph.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { captureElementTree, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";

const FIXTURE = process.argv[2];
const W = 1024, H = 1400;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(readFileSync(FIXTURE, "utf-8"), { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const nCells = await page.evaluate(() => document.querySelectorAll("x > g").length);
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
setRenderTextMode("paths");
const svg = elementTreeToSvgInner(tree, W, H);
await browser.close();

// Count <use> glyph references; the most-reused id is the tofu/.notdef glyph.
const uses = [...svg.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((m) => m[1]);
const c = new Map();
for (const u of uses) c.set(u, (c.get(u) || 0) + 1);
const sorted = [...c.values()].sort((a, b) => b - a);
const tofu = sorted[0] ?? 0;
const real = sorted.filter((n) => n === 1).length;
console.log(`${FIXTURE.split("/").pop()}: ${uses.length} glyph-uses, ${c.size} distinct; tofu-reuse=${tofu}, distinct-real=${real}, cells=${nCells}`);
