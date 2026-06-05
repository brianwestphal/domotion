import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
await ctx.routeFromHAR("tests/cache/real-world/resend-mobile.har", { notFound: "fallback" });
const page = await ctx.newPage();
await page.goto("https://resend.com/", { waitUntil: "networkidle" }).catch(() => {});
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 20)); }
  window.scrollTo(0, 0);
});
const info = await page.evaluate(() => {
  // Find the heading containing "Integrate this morning".
  let h = null;
  for (const el of document.querySelectorAll("h1,h2,h3,p,div,span")) {
    if (el.children.length <= 6 && /Integrate this morning/i.test(el.textContent || "") && (el.textContent || "").length < 40) { h = el; break; }
  }
  if (!h) return "heading not found";
  function info(el) {
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, cls: (el.getAttribute("class") || "").slice(0, 40), text: (el.textContent || "").slice(0, 30),
      color: cs.color, bgClip: cs.webkitBackgroundClip || cs.backgroundClip,
      bgImage: cs.backgroundImage.slice(0, 110), textFill: cs.webkitTextFillColor,
    };
  }
  return { heading: info(h), children: [...h.children].map(info) };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
