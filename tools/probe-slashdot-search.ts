/* eslint-disable */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");
const HAR = resolve(CACHE_DIR, "slashdot-desktop.har");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.routeFromHAR(HAR, { url: "**/*", update: false, notFound: "abort" });
  const page = await context.newPage();
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2000);

  // Find the Search button and dump its surroundings
  const info = await page.evaluate(`(() => {
    function describe(el) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var beforeCs = window.getComputedStyle(el, '::before');
      var afterCs = window.getComputedStyle(el, '::after');
      return {
        tag: el.tagName,
        cls: typeof el.className === 'string' ? el.className : '',
        text: ((el).innerText || el.textContent || '').trim().slice(0, 60),
        outerHTML: el.outerHTML.slice(0, 400),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        cs: {
          display: cs.display,
          position: cs.position,
          fontFamily: cs.fontFamily,
        },
        before: beforeCs.content !== 'none' ? {
          content: beforeCs.content,
          contentChars: beforeCs.content.split('').map(function(c){ return 'U+' + c.charCodeAt(0).toString(16); }).join(' '),
          fontFamily: beforeCs.fontFamily,
          display: beforeCs.display,
        } : null,
        after: afterCs.content !== 'none' ? {
          content: afterCs.content,
          contentChars: afterCs.content.split('').map(function(c){ return 'U+' + c.charCodeAt(0).toString(16); }).join(' '),
          fontFamily: afterCs.fontFamily,
          display: afterCs.display,
        } : null,
      };
    }
    var hits = [];
    // Find button with text "Search" near the top of the page
    var btns = document.querySelectorAll('button, input[type="submit"], a, span');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (t === 'Search' || t === 'Sign In') {
        var r = btns[i].getBoundingClientRect();
        if (r.top < 100 && r.width < 200) {
          hits.push(describe(btns[i]));
          var kids = btns[i].querySelectorAll('*');
          for (var j = 0; j < kids.length && j < 10; j++) {
            hits.push(describe(kids[j]));
          }
          if (btns[i].parentElement) hits.push(describe(btns[i].parentElement));
          break;
        }
      }
    }
    return hits;
  })()`);

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
