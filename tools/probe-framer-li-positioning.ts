import { chromium } from "@playwright/test";
import { resolve } from "node:path";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve("./tests/cache/real-world/framer-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => { window.scrollTo(0, h); await new Promise((r) => setTimeout(r, 400)); window.scrollTo(0, 0); }, 6000);
  await page.waitForTimeout(800);
  const out = await page.evaluate(() => {
    const found: any[] = [];
    document.querySelectorAll("li").forEach((li, i) => {
      const r = li.getBoundingClientRect();
      if (r.y < 1010 || r.y > 1050) return;
      const cs = getComputedStyle(li);
      const parent = li.parentElement;
      const pcs = parent ? getComputedStyle(parent) : null;
      found.push({
        idx: i,
        x: r.x, y: r.y, w: r.width, h: r.height,
        float: cs.float,
        position: cs.position,
        display: cs.display,
        parentTag: parent?.nodeName,
        parentDisplay: pcs?.display,
        parentFloat: pcs?.float,
      });
    });
    return found;
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
