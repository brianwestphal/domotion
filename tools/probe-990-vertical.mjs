// Probe vertical writing-mode fixtures. For each .box element with a
// vertical writing-mode, dump per-char Range rects to understand Chrome's
// actual layout: column orientation, char rotation, baseline placement.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-writing-mode.html", "utf-8"));
await page.waitForLoadState("networkidle");

const data = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".box").forEach((box) => {
    const cs = getComputedStyle(box);
    const cls = box.className;
    const text = box.textContent ?? "";
    const rect = box.getBoundingClientRect();
    const chars = [];
    // Find the text node directly inside the box.
    const textNode = Array.from(box.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (textNode) {
      const raw = textNode.textContent ?? "";
      for (let i = 0; i < raw.length; i++) {
        const r = document.createRange();
        r.setStart(textNode, i);
        r.setEnd(textNode, i + 1);
        const cr = r.getBoundingClientRect();
        chars.push({
          ch: raw[i],
          x: +cr.x.toFixed(2),
          y: +cr.y.toFixed(2),
          w: +cr.width.toFixed(2),
          h: +cr.height.toFixed(2),
        });
      }
    }
    out.push({
      cls,
      text: text.slice(0, 40),
      writingMode: cs.writingMode,
      textOrientation: cs.textOrientation,
      direction: cs.direction,
      boxRect: { x: +rect.x.toFixed(2), y: +rect.y.toFixed(2), w: +rect.width.toFixed(2), h: +rect.height.toFixed(2) },
      chars,
    });
  });
  return out;
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
