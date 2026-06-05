import { chromium } from "@playwright/test";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
await context.routeFromHAR("tests/cache/real-world/resend-mobile.har", { url: "**/*", notFound: "fallback" });
const page = await context.newPage();
await page.goto("https://resend.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
const rawHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
const fullH = Math.min(6000, Math.max(844, rawHeight));
await page.setViewportSize({ width: 390, height: fullH });
await page.evaluate(async () => {
  for (let h = 0; h < document.body.scrollHeight; h += 600) { window.scrollTo(0, h); await new Promise((r) => setTimeout(r, 20)); }
  window.scrollTo(0, 0);
});
const { tree } = await captureElementTreeWithWarnings(page, "body", { width: 390, height: fullH });

// Find parent of the first text-red-11 icon (the icon-box), then its parent (row), then dump preorder.
let iconEl = null, parents = [];
function find(el, stack) {
  if (iconEl) return;
  if (el.svgContent && el.svgContent.includes("text-red-11")) { iconEl = el; parents = [...stack]; return; }
  for (const c of el.children || []) find(c, [...stack, el]);
}
for (const root of tree) find(root, []);
if (!iconEl) { console.log("icon not found"); await browser.close(); process.exit(0); }

// The row = 2 ancestors up (icon-box -> row). Dump the row's subtree preorder.
const rowAncestor = parents[parents.length - 3] || parents[parents.length - 1];
function summ(el, depth, out) {
  out.push({
    d: depth, tag: el.tag,
    x: Math.round(el.x), y: Math.round(el.y * 10) / 10, w: Math.round(el.width), h: Math.round(el.height),
    pos: el.styles?.position !== "static" ? el.styles?.position : "", z: el.styles?.zIndex !== "auto" ? el.styles?.zIndex : "",
    xform: el.styles?.transform && el.styles.transform !== "none" ? "T" : "",
    bg: el.styles?.backgroundColor && el.styles.backgroundColor !== "rgba(0, 0, 0, 0)" ? el.styles.backgroundColor.slice(0, 22) : (el.styles?.backgroundImage && el.styles.backgroundImage !== "none" ? "IMG" : ""),
    svg: el.svgContent ? "SVG(" + (el.svgContent.match(/text-\w+-\d+/) || [""])[0] + ")" : "",
    txt: (el.text || "").slice(0, 14),
  });
  for (const c of el.children || []) summ(c, depth + 1, out);
}
const out = [];
summ(rowAncestor, 0, out);
console.log("ROW ANCESTOR tag=" + rowAncestor.tag + " y=" + Math.round(rowAncestor.y));
for (const e of out) {
  console.log(`${"  ".repeat(e.d)}${e.tag} y=${e.y} h=${e.h} x=${e.x} w=${e.w} ${e.pos}${e.z !== "" ? " z=" + e.z : ""}${e.xform ? " " + e.xform : ""} ${e.bg ? "bg=" + e.bg : ""} ${e.svg} ${e.txt}`);
}
await browser.close();
