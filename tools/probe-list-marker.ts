import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto("file://" + resolve("external/html-test/03-lists-style-types.html"));
  await page.waitForTimeout(200);

  const live = await page.evaluate(() => {
    const out: any[] = [];
    // Probe the live marker box by reading getBoundingClientRect of the
    // ::marker pseudo via a workaround: insert a span at the marker's
    // expected x and measure offsets. Or use Element.getBoxQuads which
    // includes ::marker since Chrome 122.
    for (const li of Array.from(document.querySelectorAll("li"))) {
      const r = li.getBoundingClientRect();
      if (r.top < 350 || r.top > 500) continue;
      // Try getBoxQuads if available; otherwise compute via marker pseudo
      // measurements.
      const liAny = li as any;
      let markerRect: any = null;
      if (typeof liAny.getBoxQuads === "function") {
        try {
          const quads = liAny.getBoxQuads({ box: "border", relativeTo: document });
          if (quads.length > 0) {
            const b = quads[0].getBounds();
            markerRect = { x: b.left, y: b.top, w: b.width, h: b.height };
          }
        } catch (e) { /* ignore */ }
      }
      const range = document.createRange();
      range.selectNodeContents(li);
      const tr = range.getBoundingClientRect();
      out.push({
        text: (li as HTMLElement).innerText.slice(0, 20),
        li: { x: r.left, y: r.top, w: r.width, h: r.height },
        textRange: { x: tr.left, y: tr.top, w: tr.width, h: tr.height },
        markerBox: markerRect,
        markerCs: {
          color: getComputedStyle(li, '::marker').color,
          fontSize: getComputedStyle(li, '::marker').fontSize,
          fontFamily: getComputedStyle(li, '::marker').fontFamily,
        },
        listStyleType: getComputedStyle(li).listStyleType,
      });
    }
    return out;
  });
  console.log("LIVE CHROME LI:");
  for (const e of live) console.log(" ", JSON.stringify(e));

  const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
  console.log("\nCAPTURED LI (with their text rects):");
  function walk(n: any): void {
    if (n.tag === 'li' && n.y > 350 && n.y < 500) {
      console.log(`  <li> rect=(${n.x.toFixed(1)}, ${n.y.toFixed(1)}, ${n.width.toFixed(1)}, ${n.height.toFixed(1)}) text="${n.text?.slice(0, 20)}" textLeft=${n.textLeft} textTop=${n.textTop} idx=${n.listItemIndex} lst=${n.styles?.listStyleType}`);
      if (n.textSegments) {
        for (const seg of n.textSegments.slice(0, 2)) {
          console.log(`    seg: "${seg.text?.slice(0, 15)}" x=${seg.x} y=${seg.y}`);
        }
      }
    }
    for (const c of (n.children ?? [])) walk(c);
  }
  for (const root of cap.tree) walk(root);
  await browser.close();
}
void main();
