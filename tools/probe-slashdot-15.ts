import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const HAR = resolve(TESTS_DIR, "cache/real-world/slashdot-desktop.har");

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

  const info = await page.evaluate(`(() => {
    function describe(el) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var beforeCs = window.getComputedStyle(el, '::before');
      var afterCs = window.getComputedStyle(el, '::after');
      return {
        tag: el.tagName,
        cls: el.className,
        text: ((el).innerText || el.textContent || '').trim().slice(0, 40),
        outerHTML: el.outerHTML.slice(0, 500),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        cs: { display: cs.display, position: cs.position, bg: cs.backgroundColor, brad: cs.borderRadius, padding: cs.padding },
        before: beforeCs.content !== 'none' ? {
          content: beforeCs.content,
          display: beforeCs.display,
          position: beforeCs.position,
          width: beforeCs.width,
          height: beforeCs.height,
          top: beforeCs.top, bottom: beforeCs.bottom,
          left: beforeCs.left, right: beforeCs.right,
          borderTop: beforeCs.borderTop, borderRight: beforeCs.borderRight,
          borderBottom: beforeCs.borderBottom, borderLeft: beforeCs.borderLeft,
          backgroundColor: beforeCs.backgroundColor,
          clipPath: beforeCs.clipPath,
        } : null,
        after: afterCs.content !== 'none' ? {
          content: afterCs.content,
          display: afterCs.display,
          position: afterCs.position,
          width: afterCs.width,
          height: afterCs.height,
          top: afterCs.top, bottom: afterCs.bottom,
          left: afterCs.left, right: afterCs.right,
          borderTop: afterCs.borderTop, borderRight: afterCs.borderRight,
          borderBottom: afterCs.borderBottom, borderLeft: afterCs.borderLeft,
          backgroundColor: afterCs.backgroundColor,
          clipPath: afterCs.clipPath,
        } : null,
      };
    }
    var all = document.querySelectorAll('a, span');
    var found = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].textContent.trim() === '15') {
        var r = all[i].getBoundingClientRect();
        if (r.top < 200 && r.left > 800) {
          found.push(describe(all[i]));
          if (all[i].parentElement) found.push(describe(all[i].parentElement));
          if (all[i].parentElement && all[i].parentElement.parentElement) found.push(describe(all[i].parentElement.parentElement));
          break;
        }
      }
    }
    return found;
  })()`);

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
