// What does Chrome's getBoundingClientRect return for a `transform: scale(2)
// transform-origin: 0 0` element compared to its unscaled sibling? And how
// does our capture store it?
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/niche/zoom-text-rendering.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const scaled = document.querySelector(".scaled.scale-2");
  const plain = document.querySelectorAll(".scaled")[1]; // "untouched neighbor"
  const dump = (el, label) => {
    if (!el) return { label, error: "missing" };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      label,
      transform: cs.transform,
      transformOrigin: cs.transformOrigin,
      rotate: cs.rotate,
      scale: cs.scale,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      offsetW: el.offsetWidth,
      offsetH: el.offsetHeight,
    };
  };
  return [dump(scaled, "scale-2"), dump(plain, "untouched")];
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
