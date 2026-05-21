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
    document.querySelectorAll("ul").forEach((ul, i) => {
      const r = ul.getBoundingClientRect();
      if (r.y < 1000 || r.y > 1050) return;
      const cs = getComputedStyle(ul);
      // Walk up the chain.
      const chain: any[] = [];
      let cur: Element | null = ul;
      while (cur != null && chain.length < 8) {
        const ccs = getComputedStyle(cur);
        const cr = cur.getBoundingClientRect();
        chain.push({
          tag: cur.nodeName.toLowerCase(),
          cls: ((cur as HTMLElement).className || '').toString().slice(0, 80),
          rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
          display: ccs.display,
          position: ccs.position,
          visibility: ccs.visibility,
          opacity: ccs.opacity,
          clip: ccs.clip,
          clipPath: ccs.clipPath,
          overflow: ccs.overflow,
          maskImage: ((ccs as any).maskImage || 'none').slice(0, 60),
          transform: ccs.transform === 'none' ? null : ccs.transform.slice(0, 50),
        });
        cur = cur.parentElement;
      }
      found.push({ idx: i, chain });
    });
    return found;
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
