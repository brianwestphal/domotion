// Probe: what does Chrome resolve for `rotate: 20deg` and `scale: 1.4` in
// computed style? Specifically: does `cs.transform` include them as a
// matrix(), or are they kept on `cs.rotate` / `cs.scale` and applied
// separately by the paint phase?
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/21-transform-2d.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const rot = document.querySelector(".new-rotate");
  const sca = document.querySelector(".new-scale");
  const oldRot = document.querySelector(".rotate");
  if (!rot || !sca || !oldRot) return { error: "selectors missing" };
  const dump = (el, label) => {
    const cs = getComputedStyle(el);
    return {
      label,
      transform: cs.transform,
      rotate: cs.rotate,
      scale: cs.scale,
      translate: cs.translate,
      transformOrigin: cs.transformOrigin,
      rect: el.getBoundingClientRect(),
    };
  };
  return [dump(rot, "new-rotate"), dump(sca, "new-scale"), dump(oldRot, "transform-rotate-20deg")];
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
