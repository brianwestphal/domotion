// One-off probe for DM-579 — inspect the missing separator at y≈153 on
// nytimes-mobile-entire-page. Find what element lives there and dump its
// rect + computed style.

import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");
const HAR = resolve(CACHE_DIR, "nytimes-mobile.har");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(HAR, { url: "**/*", update: false, notFound: "abort" });
  const page = await context.newPage();
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Find every element whose rect intersects the band y=148..170.
  const found = await page.evaluate(`(() => {
    function describe(el) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: el.className,
        text: ((el).innerText || el.textContent || "").trim().slice(0, 40),
        outerHTML: el.outerHTML.slice(0, 200),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        cs: {
          display: cs.display,
          position: cs.position,
          backgroundColor: cs.backgroundColor,
          backgroundImage: cs.backgroundImage,
          borderTopWidth: cs.borderTopWidth,
          borderTopStyle: cs.borderTopStyle,
          borderTopColor: cs.borderTopColor,
          borderBottomWidth: cs.borderBottomWidth,
          borderBottomStyle: cs.borderBottomStyle,
          borderBottomColor: cs.borderBottomColor,
          height: cs.height,
          padding: cs.padding,
          margin: cs.margin,
          overflow: cs.overflow,
        },
      };
    }
    var all = document.querySelectorAll('*');
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      // The separator is around y=153. Find elements whose rect overlaps
      // that band and have either zero height or zero content-height with
      // visible border.
      var bandTop = 150, bandBot = 180;
      if (r.bottom >= bandTop && r.top <= bandBot && r.width > 100) {
        hits.push(describe(all[i]));
      }
    }
    return hits;
  })()`);

  console.log("=== ALL elements in band y=150-180, filtered to h <= 6 ===");
  const thin = (found as any[]).filter((el) => el.rect.h <= 6);
  console.log(JSON.stringify(thin.slice(0, 20), null, 2));
  console.log("\n=== Total in band: " + found.length + " ===");

  // Also probe ::before/::after on any element in the band for content.
  const pseudoInfo = await page.evaluate(`(() => {
    var all = document.querySelectorAll('*');
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.bottom < 148 || r.top > 180) continue;
      if (r.width < 100) continue;
      var beforeCs = window.getComputedStyle(all[i], '::before');
      var afterCs = window.getComputedStyle(all[i], '::after');
      var hasBeforePaint = (beforeCs.content !== 'none' && beforeCs.content !== 'normal')
        || (beforeCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && beforeCs.backgroundColor !== 'transparent')
        || (parseFloat(beforeCs.height) > 0 && parseFloat(beforeCs.width) > 0);
      var hasAfterPaint = (afterCs.content !== 'none' && afterCs.content !== 'normal')
        || (afterCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && afterCs.backgroundColor !== 'transparent')
        || (parseFloat(afterCs.height) > 0 && parseFloat(afterCs.width) > 0);
      if (hasBeforePaint || hasAfterPaint) {
        hits.push({
          tag: all[i].tagName,
          cls: all[i].className,
          rect: { x: r.left, y: r.top, w: r.width, h: r.height },
          before: hasBeforePaint ? {
            content: beforeCs.content,
            bg: beforeCs.backgroundColor,
            border: beforeCs.borderTop + ' / ' + beforeCs.borderBottom,
            height: beforeCs.height,
            width: beforeCs.width,
            position: beforeCs.position,
            top: beforeCs.top,
          } : null,
          after: hasAfterPaint ? {
            content: afterCs.content,
            bg: afterCs.backgroundColor,
            border: afterCs.borderTop + ' / ' + afterCs.borderBottom,
            height: afterCs.height,
            width: afterCs.width,
            position: afterCs.position,
            top: afterCs.top,
          } : null,
        });
      }
    }
    return hits;
  })()`);
  console.log("\n=== Elements with ::before/::after paint in band ===");
  console.log(JSON.stringify(pseudoInfo, null, 2));

  // Probe the css-mx1q46 specifically — measure where the ::before's paint
  // actually lands by inserting a stand-in element with the same styles.
  const sepProbe = await page.evaluate(`(() => {
    var all = document.querySelectorAll('.css-mx1q46');
    var host = null;
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.top >= 140 && r.top <= 160) { host = all[i]; break; }
    }
    if (!host) return { error: 'no host in band; count=' + all.length };
    var hostCs = window.getComputedStyle(host);
    var hostRect = host.getBoundingClientRect();
    var beforeCs = window.getComputedStyle(host, '::before');
    return {
      host: {
        cls: host.className,
        rect: { x: hostRect.left, y: hostRect.top, w: hostRect.width, h: hostRect.height },
        cs: {
          padding: hostCs.padding,
          paddingTop: hostCs.paddingTop,
          margin: hostCs.margin,
          display: hostCs.display,
          position: hostCs.position,
          overflow: hostCs.overflow,
        },
      },
      before: {
        content: beforeCs.content,
        height: beforeCs.height,
        width: beforeCs.width,
        margin: beforeCs.margin,
        marginTop: beforeCs.marginTop,
        marginLeft: beforeCs.marginLeft,
        padding: beforeCs.padding,
        position: beforeCs.position,
        top: beforeCs.top,
        left: beforeCs.left,
        display: beforeCs.display,
        borderTop: beforeCs.borderTop,
        borderBottom: beforeCs.borderBottom,
        borderLeft: beforeCs.borderLeft,
        borderRight: beforeCs.borderRight,
        backgroundColor: beforeCs.backgroundColor,
      },
    };
  })()`);
  console.log("\n=== css-mx1q46 separator probe ===");
  console.log(JSON.stringify(sepProbe, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
