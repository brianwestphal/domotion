import { chromium } from "@playwright/test";
import { resolve } from "node:path";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.routeFromHAR(resolve("tests/cache/real-world/nytimes-desktop.har"), { url: "**/*", notFound: "fallback" });
  const page = await ctx.newPage();
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  for (const sy of [0, 800, 1600, 2400]) {
    await page.evaluate((y) => window.scrollTo(0, y), sy);
    await page.waitForTimeout(300);
    const data = await page.evaluate(() => {
      // Walk body's direct children and report any with overflow + bbox at scrollY
      const body = document.body;
      const kids: Array<{ tag: string; cls: string; overflow: string; bbox: { x: number; y: number; w: number; h: number }; height: string }> = [];
      for (const c of Array.from(body.children) as HTMLElement[]) {
        const cs = getComputedStyle(c);
        const r = c.getBoundingClientRect();
        kids.push({
          tag: c.tagName, cls: c.className.toString().slice(0, 60),
          overflow: cs.overflow, height: cs.height,
          bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
        });
      }
      return { scrollY: window.scrollY, bodyChildren: kids };
    });
    console.log(JSON.stringify({ sy, ...data }, null, 2));
    await page.screenshot({ path: `/tmp/ny-live-sy${sy}.png` });
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
