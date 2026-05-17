/* eslint-disable */
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
  await context.routeFromHAR(resolve(CACHE_DIR, "nytimes-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, 6000);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  // Find "Heidi Klum Moved" text element
  const out = await page.evaluate(`(function() {
    var els = Array.from(document.querySelectorAll('h1, h2, h3, h4, a, p, span'));
    var results = [];
    for (var el of els) {
      var t = (el.textContent || '').trim();
      if (t.indexOf('Heidi Klum') >= 0 && t.length < 100) {
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        // Walk parents to find any positioned/transformed ancestor with a black bg
        var chain = [];
        var cur = el;
        for (var i = 0; i < 6 && cur; i++) {
          var cr = cur.getBoundingClientRect();
          var ccs = getComputedStyle(cur);
          chain.push({
            d: i, tag: cur.tagName, cls: (cur.className||'').toString().slice(0, 50),
            rect: { x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
            position: ccs.position, transform: ccs.transform === 'none' ? null : ccs.transform.slice(0, 30),
            bg: ccs.backgroundColor, color: ccs.color, textDecoration: ccs.textDecoration,
          });
          cur = cur.parentElement;
        }
        results.push({ text: t.slice(0, 80), tag: el.tagName, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, color: cs.color, textDecoration: cs.textDecoration, chain: chain });
        if (results.length >= 3) break;
      }
    }
    return results;
  })()`);
  console.log(JSON.stringify(out, null, 2));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
