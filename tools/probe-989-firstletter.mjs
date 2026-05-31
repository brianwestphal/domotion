// Probe Chrome's ::first-letter behavior on the fixture corpus.
// Reports: which chars Chrome actually selected as the first-letter pseudo,
// and the painted rect of those chars vs the body Range.
//
// Strategy: getComputedStyle(p, '::first-letter') tells us the pseudo's
// computed style; to find the SELECTION we render and visually compare. Chrome
// doesn't expose the selection directly, so we infer by comparing the painted
// width/position of leading chars vs body-font expectations. The most robust
// probe: read the painted color of the leftmost rendered ink at multiple
// x positions and see how many leading chars share the pseudo color.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();

await page.setContent(readFileSync("external/html-test/20-deep-first-letter-line.html", "utf-8"));
await page.waitForLoadState("networkidle");

const data = await page.evaluate(() => {
  const out = [];
  // Walk every <p> inside an element with .fl-* class and report:
  // - first text node content
  // - pseudo color, fontSize, float
  // - per-char Range rects for the first ~10 chars
  document.querySelectorAll("p").forEach((p) => {
    const parent = p.closest("[class*='fl-']");
    if (!parent) return;
    const cls = Array.from(parent.classList).find((c) => c.startsWith("fl-")) ?? "(none)";
    const flStyle = getComputedStyle(p, "::first-letter");
    const pStyle = getComputedStyle(p);
    const firstNode = Array.from(p.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (!firstNode) return;
    const raw = firstNode.textContent ?? "";
    const trimmed = raw.replace(/^\s+/, "");
    const offset = raw.length - trimmed.length;
    const chars = [];
    for (let i = offset; i < Math.min(raw.length, offset + 12); i++) {
      const r = document.createRange();
      r.setStart(firstNode, i);
      r.setEnd(firstNode, i + 1);
      const cr = r.getBoundingClientRect();
      chars.push({ ch: raw[i], width: +cr.width.toFixed(2), height: +cr.height.toFixed(2), x: +cr.x.toFixed(2) });
    }
    out.push({
      cls,
      text: raw.slice(offset, offset + 30),
      pseudoColor: flStyle.color,
      pseudoFontSize: flStyle.fontSize,
      pseudoFontWeight: flStyle.fontWeight,
      pseudoFloat: flStyle.float || flStyle.cssFloat || "",
      pseudoBg: flStyle.backgroundColor,
      pseudoBgImage: flStyle.backgroundImage,
      pseudoPadding: `${flStyle.paddingTop} ${flStyle.paddingRight} ${flStyle.paddingBottom} ${flStyle.paddingLeft}`,
      pseudoBorderRadius: flStyle.borderRadius,
      pStyle: { fontSize: pStyle.fontSize, color: pStyle.color },
      chars,
    });
  });
  return out;
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
