// Inspect ::before / ::after on .g-promo-slim-items.svelte-1vbzn4a — see
// whether NYT's right-edge fade comes from a pseudo-element with a gradient
// OR from the parent's webkit-mask-image, or both.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.setViewportSize({ width: 390, height: 6000 });
await page.waitForTimeout(400);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll(".g-promo-slim-items"));
  return els.map((el) => {
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, "::before");
    const after = getComputedStyle(el, "::after");
    const r = el.getBoundingClientRect();
    return {
      y: r.y + window.scrollY,
      w: r.width, h: r.height,
      mask: { maskImage: cs.maskImage, webkitMaskImage: cs.webkitMaskImage },
      before: {
        content: before.content,
        bgImage: before.backgroundImage,
        position: before.position,
        width: before.width,
        height: before.height,
        right: before.right,
        top: before.top,
      },
      after: {
        content: after.content,
        bgImage: after.backgroundImage,
        position: after.position,
        width: after.width,
        height: after.height,
        right: after.right,
        top: after.top,
      },
    };
  });
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
