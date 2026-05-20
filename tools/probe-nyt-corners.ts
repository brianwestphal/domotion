// Find every element with non-zero border-radius and dump its rect — then find ones near (102, 482, 39, 37).
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const HAR = resolve(process.cwd(), "tests/cache/real-world/nytimes-mobile.har");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  });
  await ctx.routeFromHAR(HAR, { update: false });
  const page = await ctx.newPage();
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: "/tmp/claude/nyt-probe-screenshot.png" });
  const matches = await page.evaluate(() => {
    const out: any[] = [];
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom < 0 || r.top > 844) continue;
      // Find anything with border-radius near y=482
      const cs = getComputedStyle(el);
      const tlr = parseFloat(cs.borderTopLeftRadius);
      const trr = parseFloat(cs.borderTopRightRadius);
      if (tlr < 3 && trr < 3) continue;
      if (r.bottom < 400 || r.top > 600) continue;
      if (r.width < 50) continue;
      out.push({
        tag: el.tagName,
        className: (el as any).className?.toString?.() ?? "",
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        borderRadius: cs.borderRadius,
        overflow: cs.overflow,
        outerHTML: el.outerHTML.slice(0, 200),
      });
    }
    return out;
  });
  console.log("matches near y=482:", matches.length);
  for (const m of matches) {
    console.log(JSON.stringify(m));
  }

  await browser.close();
})();
