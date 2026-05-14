/* eslint-disable */
// Probe DM-583 — find the Philippines selector + body bg.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");
const HAR = resolve(CACHE_DIR, "apple-mobile.har");

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
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(`(() => {
    function describe(el) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var beforeCs = window.getComputedStyle(el, '::before');
      var afterCs = window.getComputedStyle(el, '::after');
      return {
        tag: el.tagName,
        cls: el.className,
        text: ((el).innerText || el.textContent || '').trim().slice(0, 60),
        outerHTML: el.outerHTML.slice(0, 1500),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        cs: {
          display: cs.display,
          position: cs.position,
          backgroundColor: cs.backgroundColor,
          borderRadius: cs.borderRadius,
          width: cs.width,
          height: cs.height,
          appearance: cs.appearance,
          webkitAppearance: cs.webkitAppearance,
        },
        before: beforeCs.content !== 'none' ? {
          content: beforeCs.content,
          fontFamily: beforeCs.fontFamily,
          display: beforeCs.display,
          width: beforeCs.width,
          height: beforeCs.height,
          backgroundImage: beforeCs.backgroundImage,
        } : null,
        after: afterCs.content !== 'none' ? {
          content: afterCs.content,
          contentRaw: JSON.stringify(afterCs.content),
          contentChars: afterCs.content.length > 0 ? afterCs.content.split('').map(function(c){ return 'U+' + c.charCodeAt(0).toString(16); }).join(' ') : 'EMPTY',
          fontFamily: afterCs.fontFamily,
          display: afterCs.display,
          position: afterCs.position,
          top: afterCs.top,
          right: afterCs.right,
          bottom: afterCs.bottom,
          left: afterCs.left,
          width: afterCs.width,
          height: afterCs.height,
          backgroundImage: afterCs.backgroundImage,
          maskImage: afterCs.maskImage || afterCs.webkitMaskImage,
          fontSize: afterCs.fontSize,
          color: afterCs.color,
        } : null,
      };
    }
    var html = document.documentElement;
    var body = document.body;
    var result = {
      pageBg: {
        html: window.getComputedStyle(html).backgroundColor,
        body: window.getComputedStyle(body).backgroundColor,
        htmlBgImage: window.getComputedStyle(html).backgroundImage,
        bodyBgImage: window.getComputedStyle(body).backgroundImage,
      },
      candidates: [],
    };
    // Find any element with "Philippines" text
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t === 'Philippines') {
        result.candidates.push(describe(all[i]));
        if (all[i].parentElement) result.candidates.push(describe(all[i].parentElement));
        if (all[i].parentElement && all[i].parentElement.parentElement) result.candidates.push(describe(all[i].parentElement.parentElement));
        // Also look at the next sibling (chevron likely)
        var sib = all[i].nextElementSibling;
        var k = 0;
        while (sib && k < 3) {
          result.candidates.push(describe(sib));
          sib = sib.nextElementSibling;
          k++;
        }
        // And parent's siblings
        if (all[i].parentElement) {
          var psib = all[i].parentElement.nextElementSibling;
          var kk = 0;
          while (psib && kk < 3) {
            result.candidates.push(describe(psib));
            psib = psib.nextElementSibling;
            kk++;
          }
        }
        break;
      }
    }
    return result;
  })()`);

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
