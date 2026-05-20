// Probe resend page to find the element holding the bottom gradient + the content
// elements ("Contact management" / "Broadcast analytics") and their relative paint order.
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const HAR = resolve(process.cwd(), "tests/cache/real-world/resend-desktop.har");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await ctx.routeFromHAR(HAR, { update: false });
  const page = await ctx.newPage();
  await page.goto("https://resend.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  // Scroll so the bottom section is in layout
  await page.evaluate(() => window.scrollTo(0, 5500));
  await page.waitForTimeout(500);

  const probe = await page.evaluate(`(function() {
    // Look for "Contact management" text in the page
    function findByText(text) {
      var all = document.querySelectorAll('h2, h3, h4, p, span, div, a, li');
      for (var i = 0; i < all.length; i++) {
        if (all[i].textContent && all[i].textContent.trim() === text) return all[i];
      }
      return null;
    }
    var cm = findByText('Contact management');
    if (!cm) return { error: 'Contact management not found' };
    // Find the icon (svg) above contact management
    var iconParent = cm.parentElement; // z-10 div contains icon + h2 + p
    var iconInfo = null;
    if (iconParent) {
      var firstSvg = iconParent.querySelector('svg');
      if (firstSvg) {
        var ir = firstSvg.getBoundingClientRect();
        var ics = getComputedStyle(firstSvg);
        var p = firstSvg.parentElement;
        var pcs = p ? getComputedStyle(p) : null;
        iconInfo = {
          iconTag: firstSvg.tagName, iconRect: { x: +ir.x.toFixed(1), y: +ir.y.toFixed(1), w: +ir.width.toFixed(1), h: +ir.height.toFixed(1) },
          iconPosition: ics.position, iconZ: ics.zIndex,
          iconParentTag: p ? p.tagName : null,
          iconParentCls: p ? (p.className && p.className.toString && p.className.toString()) || '' : '',
          iconParentPosition: pcs ? pcs.position : null,
          iconParentZ: pcs ? pcs.zIndex : null,
        };
      }
    }
    var r = cm.getBoundingClientRect();
    // Walk up to a common ancestor, listing each ancestor's rect + style
    var info = [];
    var el = cm;
    for (var i = 0; i < 10 && el; i++) {
      var cs = getComputedStyle(el);
      var ar = el.getBoundingClientRect();
      var before = getComputedStyle(el, '::before');
      var after = getComputedStyle(el, '::after');
      info.push({
        i: i,
        tag: el.tagName,
        id: el.id || '',
        cls: (el.className && el.className.toString && el.className.toString()) || '',
        rect: { x: +ar.x.toFixed(1), y: +ar.y.toFixed(1), w: +ar.width.toFixed(1), h: +ar.height.toFixed(1) },
        position: cs.position,
        zIndex: cs.zIndex,
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage,
        beforeContent: before.content,
        beforeBgImage: before.backgroundImage,
        beforeZIndex: before.zIndex,
        afterContent: after.content,
        afterBgImage: after.backgroundImage,
        afterZIndex: after.zIndex,
      });
      el = el.parentElement;
    }
    // Also dump depth-2 ancestor's children — the card-level container.
    var card = cm.parentElement && cm.parentElement.parentElement;
    var siblings = [];
    if (card) {
      for (var i = 0; i < card.children.length; i++) {
        var c = card.children[i];
        var cs = getComputedStyle(c);
        var ar = c.getBoundingClientRect();
        var before = getComputedStyle(c, '::before');
        var after = getComputedStyle(c, '::after');
        siblings.push({
          i: i,
          tag: c.tagName,
          cls: (c.className && c.className.toString && c.className.toString()) || '',
          rect: { x: +ar.x.toFixed(1), y: +ar.y.toFixed(1), w: +ar.width.toFixed(1), h: +ar.height.toFixed(1) },
          position: cs.position,
          zIndex: cs.zIndex,
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage,
          beforeContent: before.content,
          beforeBgImage: before.backgroundImage,
          beforeZIndex: before.zIndex,
          beforePosition: before.position,
          afterContent: after.content,
          afterBgImage: after.backgroundImage,
          afterZIndex: after.zIndex,
          afterPosition: after.position,
        });
      }
    }
    return { contactMgmt: info, cardChildren: siblings, cardClass: card ? card.className : null, iconInfo: iconInfo };
  })()`);
  console.log(JSON.stringify(probe, null, 2));

  await browser.close();
})();
