import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
await ctx.routeFromHAR("tests/cache/real-world/resend-mobile.har", { notFound: "fallback" });
const page = await ctx.newPage();
await page.goto("https://resend.com/", { waitUntil: "networkidle" }).catch(() => {});
const info = await page.evaluate(() => {
  const cands = [...document.querySelectorAll("a")].filter((a) => {
    const r = a.getBoundingClientRect();
    return r.width > 150 && r.width < 320 && r.height > 20 && r.height < 60 && /Announcing/i.test(a.textContent || "");
  });
  const a = cands[0];
  if (!a) return { error: "not found", count: document.querySelectorAll("a").length };
  const self = getComputedStyle(a);
  const after = getComputedStyle(a, "::after");
  const r = a.getBoundingClientRect();
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    self: { zIndex: self.zIndex, position: self.position, filter: self.filter, bgImage: self.backgroundImage.slice(0, 80), borderRadius: self.borderRadius },
    after: { zIndex: after.zIndex, position: after.position, filter: after.filter, transform: after.transform, transformOrigin: after.transformOrigin, borderRadius: after.borderRadius, bgImage: after.backgroundImage.slice(0, 80), content: after.content },
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
