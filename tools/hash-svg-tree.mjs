// DM-1086 byte oracle: capture a tree with inline <svg> icons (CSS-styled
// fill/stroke, <use> refs, currentColor) — exercises captureInlineSvg.
import { chromium } from "@playwright/test";
import { captureElementTree } from "/Users/westphal/Documents/domotion/dist/capture/index.js";
import { createHash } from "node:crypto";
const html = `<!doctype html><meta charset=utf8><style>
.icon-btn { color: #c30; } .icon-btn svg { fill: none; stroke: currentColor; stroke-width: 2; }
svg.css-geom circle { fill: green; } .css-geom { color: blue; }
</style><body style="margin:0;font-size:16px">
<button class=icon-btn><svg width=24 height=24 viewBox="0 0 24 24"><path d="M4 12 L20 12"/><circle cx=12 cy=6 r=3 fill="currentColor"/></svg></button>
<svg class=css-geom width=40 height=40 viewBox="0 0 40 40"><defs><g id=sym><rect x=2 y=2 width=10 height=10/></g></defs><use href="#sym" x=5 y=5 fill="currentColor"/><circle cx=30 cy=30 r=6/></svg>
<svg width=30 height=30 viewBox="0 0 30 30"><symbol id=s2 viewBox="0 0 10 10"><path d="M0 0 L10 10"/></symbol><use href="#s2" width=20 height=20 stroke="red"/></svg>
</body>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 300, height: 200 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 300, height: 200 });
console.log(createHash("sha256").update(JSON.stringify(tree)).digest("hex"));
await browser.close();
