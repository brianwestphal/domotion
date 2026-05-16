/* eslint-disable */
// Walk the structure around a Card label to find the overflow:hidden ancestor.
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
    // Find ALL elements whose textContent starts with 'Card' and rect is in the row area
    var data = [];
    var allEls = document.querySelectorAll('*');
    for (var e of allEls) {
      var txt = (e.textContent || '').trim();
      if (txt === 'Card') {
        var r = e.getBoundingClientRect();
        if (r.left > 250 && r.left < 400 && r.top > 1000 && r.top < 1200) {
          var cs = getComputedStyle(e);
          // Walk up parents
          var ancestors = [];
          var cur = e.parentElement;
          for (var i = 0; i < 5 && cur; i++) {
            var acs = getComputedStyle(cur);
            var ar = cur.getBoundingClientRect();
            ancestors.push({
              tag: cur.tagName,
              cls: (cur.className||'').toString().slice(0, 60),
              rect: { x: Math.round(ar.left), y: Math.round(ar.top), w: Math.round(ar.width), h: Math.round(ar.height) },
              overflow: acs.overflow,
              overflowX: acs.overflowX,
              overflowY: acs.overflowY,
              clipPath: acs.clipPath === 'none' ? null : acs.clipPath,
              opacity: acs.opacity,
              display: acs.display,
              transform: acs.transform === 'none' ? null : acs.transform,
            });
            cur = cur.parentElement;
          }
          data.push({
            tag: e.tagName,
            text: txt,
            cls: (e.className||'').toString().slice(0, 60),
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            own_overflow: cs.overflow,
            own_opacity: cs.opacity,
            ancestors: ancestors,
          });
          break; // Just the first match
        }
      }
    }
    return data;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
