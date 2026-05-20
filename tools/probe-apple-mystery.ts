// Probe what's at the Apple "Mystery" promo card to find filter/text-shadow
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const HAR = resolve(process.cwd(), "tests/cache/real-world/apple-desktop.har");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await ctx.routeFromHAR(HAR, { update: false });
  const page = await ctx.newPage();
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  // Scroll to "Mystery" content area (y=4550)
  await page.evaluate(() => window.scrollTo(0, 4500));
  await page.waitForTimeout(800);

  const info = await page.evaluate(`(function() {
    var nodes = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var txt = (el.childNodes.length > 0 && el.childNodes[0].nodeType === Node.TEXT_NODE) ? el.childNodes[0].textContent : '';
      if (txt && txt.indexOf('Mystery') >= 0 && txt.length < 60) {
        nodes.push(el);
      }
    }
    var out = [];
    for (var n = 0; n < nodes.length; n++) {
      var e = nodes[n];
      var chain = [];
      var cur = e;
      for (var j = 0; j < 8 && cur; j++) {
        var cs = getComputedStyle(cur);
        var r = cur.getBoundingClientRect();
        chain.push({
          tag: cur.tagName,
          cls: (cur.className && cur.className.toString && cur.className.toString()) || '',
          rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
          color: cs.color,
          filter: cs.filter,
          backdropFilter: cs.backdropFilter,
          textShadow: cs.textShadow,
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage,
          mixBlendMode: cs.mixBlendMode,
          opacity: cs.opacity,
          position: cs.position,
          zIndex: cs.zIndex,
        });
        cur = cur.parentElement;
      }
      out.push({ text: (e.textContent || '').slice(0, 80), chain: chain });
    }
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
