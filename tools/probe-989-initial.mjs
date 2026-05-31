// Probe 24-deep-initial-letter: where Chrome actually paints the first-letter
// glyph relative to its `Range.getBoundingClientRect`.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();

await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");

const data = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("p:first-of-type").forEach((p) => {
    const parent = p.closest("[class*='drop-'], [class*='raise'], [class*='multi'], [class*='sans-']");
    if (!parent) return;
    const cls = Array.from(parent.classList).join(" ");
    const flStyle = getComputedStyle(p, "::first-letter");
    const pRect = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const firstNode = Array.from(p.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (!firstNode) return;
    const raw = firstNode.textContent ?? "";
    const trimmed = raw.replace(/^\s+/, "");
    const offset = raw.length - trimmed.length;
    const chars = [];
    for (let i = offset; i < offset + 3; i++) {
      const r = document.createRange();
      r.setStart(firstNode, i);
      r.setEnd(firstNode, i + 1);
      const cr = r.getBoundingClientRect();
      chars.push({ ch: raw[i], x: +cr.x.toFixed(2), y: +cr.y.toFixed(2), w: +cr.width.toFixed(2), h: +cr.height.toFixed(2) });
    }
    out.push({
      cls,
      pRect: { x: +pRect.x.toFixed(2), y: +pRect.y.toFixed(2), w: +pRect.width.toFixed(2), h: +pRect.height.toFixed(2) },
      pStyle: { fontSize: cs.fontSize, lineHeight: cs.lineHeight, padding: cs.padding },
      pseudoFontSize: flStyle.fontSize,
      pseudoFloat: flStyle.float || flStyle.cssFloat || "",
      pseudoInitialLetter: flStyle.initialLetter || flStyle.webkitInitialLetter || "(unset)",
      pseudoPadding: `${flStyle.paddingTop} ${flStyle.paddingRight} ${flStyle.paddingBottom} ${flStyle.paddingLeft}`,
      pseudoMargin: `${flStyle.marginTop} ${flStyle.marginRight} ${flStyle.marginBottom} ${flStyle.marginLeft}`,
      pseudoBg: flStyle.backgroundColor,
      pseudoBgImage: flStyle.backgroundImage,
      pseudoBorderRadius: flStyle.borderRadius,
      pseudoLineHeight: flStyle.lineHeight,
      chars,
    });
  });
  return out;
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
