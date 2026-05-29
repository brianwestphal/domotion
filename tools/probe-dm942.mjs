// Probe how Chrome reports getBoundingClientRect() for chars across a
// soft-hyphen line break in the DM-942 fixture (02-deep-line-breaking).
// We want to see line 1's last few chars (..., a, SHY) and line 2's
// first few chars (t, i, o, n) — looking for whether the `t` lands on
// line 1's Y (which would cause our capture's Y-grouping to put it
// into the wrong line and trigger the apparent "missing t" rendering).
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/02-deep-line-breaking.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  // Find the col.h element ("hyphens: manual" with situa&shy;tion)
  const col = document.querySelector(".col.h");
  // The element's text content node — walk to find the text node containing "situa"
  const tw = document.createTreeWalker(col, NodeFilter.SHOW_TEXT);
  let node = null;
  while ((node = tw.nextNode())) {
    if (node.textContent.includes("situa")) break;
  }
  if (!node) return { error: "no situa text node" };
  const raw = node.textContent;
  const start = raw.indexOf("situa");
  // We need to scan a window around the soft-hyphen between "situa" and "tion".
  // The SHY is at index start+5. Let's dump chars from start to start+12.
  const results = [];
  for (let i = start; i < Math.min(raw.length, start + 14); i++) {
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + 1);
    const cr = r.getBoundingClientRect();
    const ch = raw[i];
    const codePoint = ch.charCodeAt(0).toString(16);
    results.push({ i, ch: ch === "­" ? "[SHY]" : ch, cp: codePoint, x: cr.left, y: cr.top, w: cr.width, h: cr.height });
  }
  return { rawSlice: raw.slice(start, start + 14).replace(/­/g, "[SHY]"), results };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
