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

  // Where does welcome-ad live in the DOM? What's its z-index? Its parent?
  const out = await page.evaluate(`(function() {
    var ad = document.getElementById('welcome-ad');
    if (!ad) return null;
    var chain = [];
    var cur = ad;
    var d = 0;
    while (cur && d < 10) {
      var cs = getComputedStyle(cur);
      var r = cur.getBoundingClientRect();
      chain.push({
        d: d, tag: cur.tagName, id: cur.id, cls: (cur.className||'').toString().slice(0, 50),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        position: cs.position, zIndex: cs.zIndex, display: cs.display,
        transform: cs.transform === 'none' ? null : cs.transform.slice(0, 40),
        visibility: cs.visibility, opacity: cs.opacity,
      });
      cur = cur.parentElement;
      d++;
    }
    // Also find any portal containers (.ReactModalPortal)
    var portals = Array.from(document.querySelectorAll('.ReactModalPortal'));
    var portalInfo = portals.map(function(p) {
      var cs = getComputedStyle(p);
      var r = p.getBoundingClientRect();
      var pcss = p.parentElement ? getComputedStyle(p.parentElement) : null;
      return {
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        position: cs.position, zIndex: cs.zIndex, display: cs.display,
        parentTag: p.parentElement?.tagName,
        parentRect: p.parentElement ? (function() { var pr = p.parentElement.getBoundingClientRect(); return { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) }; })() : null,
      };
    });
    return { chain: chain, portals: portalInfo };
  })()`);
  console.log("welcome-ad chain + portals:");
  console.log(JSON.stringify(out, null, 2));

  // Screenshot the page at this moment to see what Chrome actually shows
  await page.screenshot({ path: "/tmp/nyt-now.png", clip: { x: 0, y: 0, width: 390, height: 6000 } });

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
