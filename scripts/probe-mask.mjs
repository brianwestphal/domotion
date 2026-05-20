// Probe Chrome's computed mask-* styles for the 23-mask fixture cells.
// Reveals whether `cs.maskPosition` returns "25% 25%" or pre-resolved px,
// and what `cs.maskComposite` / `cs.maskMode` look like for the styled cases.

import { chromium } from "@playwright/test";
import path from "node:path";

const url = "file://" + path.resolve("external/html-test/") + "/23-mask.html";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto(url);

const data = await page.evaluate(() => {
  const figs = document.querySelectorAll("figure");
  const out = [];
  for (const fig of figs) {
    const div = fig.querySelector("div");
    const cs = getComputedStyle(div);
    const r = div.getBoundingClientRect();
    out.push({
      caption: fig.querySelector("figcaption")?.textContent,
      box: { x: r.left, y: r.top, w: r.width, h: r.height },
      mask: cs.mask,
      maskImage: cs.maskImage,
      maskMode: cs.maskMode,
      maskSize: cs.maskSize,
      maskPosition: cs.maskPosition,
      maskRepeat: cs.maskRepeat,
      maskComposite: cs.maskComposite,
    });
  }
  return out;
});

for (const e of data) console.log(e.caption, JSON.stringify({
  size: e.maskSize, pos: e.maskPosition, mode: e.maskMode, comp: e.maskComposite, repeat: e.maskRepeat,
}));

await browser.close();
