// Probe DM-582 — find the "We use cookies" popup and check for duplication.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");
const HAR = resolve(CACHE_DIR, "framer-mobile.har");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(HAR, { url: "**/*", update: false, notFound: "abort" });
  const page = await context.newPage();
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(`(() => {
    function describe(el) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: typeof el.className === 'string' ? el.className : '',
        text: ((el).innerText || el.textContent || '').trim().slice(0, 80),
        outerHTML: el.outerHTML.slice(0, 400),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        cs: {
          display: cs.display,
          position: cs.position,
          transform: cs.transform,
          left: cs.left,
          right: cs.right,
          top: cs.top,
          bottom: cs.bottom,
          width: cs.width,
          height: cs.height,
          opacity: cs.opacity,
          visibility: cs.visibility,
          backgroundColor: cs.backgroundColor,
          backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
          mask: cs.mask || cs.webkitMask,
          zIndex: cs.zIndex,
        },
      };
    }
    var hits = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t.indexOf('We use cookies') === 0 && t.length < 300) {
        hits.push(describe(all[i]));
        // walk up 3 ancestors
        var p = all[i].parentElement;
        var depth = 0;
        while (p && depth < 4) {
          hits.push(describe(p));
          p = p.parentElement;
          depth++;
        }
        break;
      }
    }
    return hits;
  })()`);

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
