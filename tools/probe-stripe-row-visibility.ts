// Multiple payment-method rows live at the same y. Chrome shows only one.
// Dump every visibility-related CSS prop on each overlapping row + each
// ancestor up to .dom-graphic__content so we can spot the differentiator.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, 6000);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  const out = await page.evaluate(`(function() {
    var rows = document.querySelectorAll('.payments-graphic__checkout-payment-methods-item');
    var data = [];
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var cs = getComputedStyle(row);
      var r = row.getBoundingClientRect();
      // Walk ancestors up to .dom-graphic__content for relevant visibility properties
      var ancestors = [];
      var cur = row;
      var depth = 0;
      while (cur && depth < 8) {
        var acs = getComputedStyle(cur);
        ancestors.push({
          tag: cur.tagName,
          cls: (cur.className||'').toString().slice(0, 45),
          opacity: acs.opacity,
          visibility: acs.visibility,
          display: acs.display,
          clipPath: acs.clipPath,
          overflow: acs.overflow,
          overflowX: acs.overflowX,
          overflowY: acs.overflowY,
          zIndex: acs.zIndex,
          position: acs.position,
          maskImage: acs.maskImage === 'none' ? null : acs.maskImage,
          isolation: acs.isolation,
          mixBlendMode: acs.mixBlendMode,
          contain: acs.contain,
        });
        cur = cur.parentElement;
        depth++;
      }
      // Text content for identification
      var txt = (row.textContent || '').trim().slice(0, 40);
      data.push({
        j: j,
        text: txt,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        own_opacity: cs.opacity,
        own_visibility: cs.visibility,
        own_display: cs.display,
        own_transform: cs.transform === 'none' ? null : cs.transform,
        own_clipPath: cs.clipPath,
        own_zIndex: cs.zIndex,
        own_position: cs.position,
        ancestors: ancestors,
      });
    }
    return data;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
