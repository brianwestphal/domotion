import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
await ctx.routeFromHAR("tests/cache/real-world/resend-mobile.har", { notFound: "fallback" });
const page = await ctx.newPage();
await page.goto("https://resend.com/", { waitUntil: "networkidle" }).catch(()=>{});
await page.waitForTimeout(500);
const info = await page.evaluate(() => {
  const all = [...document.querySelectorAll("a.rainbow-border")];
  const el = all.find(e => /Announcing Resend Forward/.test(e.textContent||""));
  if (!el) return "not found";
  const dump = (s) => ({ bgImage: s.backgroundImage, bgClip: s.backgroundClip + " / " + s.webkitBackgroundClip, bgColor: s.backgroundColor, zIndex: s.zIndex, filter: s.filter, opacity: s.opacity, transform: s.transform, inset: s.inset, content: s.content, position: s.position });
  return { self: dump(getComputedStyle(el)), after: dump(getComputedStyle(el,"::after")), childSpanBg: getComputedStyle(el.querySelector("span")||el).backgroundColor };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
