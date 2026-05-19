import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "slashdot-mobile.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const found = await page.evaluate(() => {
    const out: any[] = [];
    for (const sel of [".login", ".submit-story", ".sprite", "#session", ".header", "#content", "#home", ".stages", ".stage-center", ".river-prop", "body", "html"]) {
      const el = document.querySelector(sel);
      if (el == null) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({
        sel,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        position: cs.position, zIndex: cs.zIndex,
        display: cs.display, transform: cs.transform,
        opacity: cs.opacity, visibility: cs.visibility,
        order: cs.order, flexDirection: cs.flexDirection,
        float: cs.float, overflow: cs.overflow,
        isolation: cs.isolation, filter: cs.filter,
      });
    }
    return out;
  });
  for (const e of found) console.log(JSON.stringify(e));
  await browser.close();
}
void main();
