import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
await ctx.routeFromHAR("tests/cache/real-world/resend-mobile.har", { notFound: "fallback" });
const page = await ctx.newPage();
await page.goto("https://resend.com/", { waitUntil: "networkidle" }).catch(() => {});
// Force full lazy content to lay out, then measure doc-absolute boxes from scroll 0.
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 20)); }
  window.scrollTo(0, 0);
});
const info = await page.evaluate(() => {
  const wantY = [{ lo: 3600, hi: 3700 }, { lo: 3790, hi: 3870 }];
  const out = [];
  for (const svg of document.querySelectorAll("svg")) {
    const r = svg.getBoundingClientRect();
    const docY = r.top + window.scrollY;
    if (r.left > 120) continue;
    if (!wantY.some((w) => docY >= w.lo && docY <= w.hi)) continue;
    const cs = getComputedStyle(svg);
    out.push({
      docY: Math.round(docY), x: Math.round(r.left + window.scrollX), w: Math.round(r.width), h: Math.round(r.height),
      cls: svg.getAttribute("class"), color: cs.color, fill: svg.getAttribute("fill"),
      parentBg: (() => { const p = svg.parentElement; return p ? getComputedStyle(p).backgroundImage.slice(0, 70) : null; })(),
      html: svg.outerHTML.slice(0, 700),
    });
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
