/* eslint-disable */
// One-off probe for DM-596 — inspect the slashdot masthead "Firehose" link
// and its chevron sibling. Loads the cached HAR (no network), walks the
// nav, prints rects + computed styles for the offending region.

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
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.routeFromHAR(HAR, { url: "**/*", update: false, notFound: "abort" });
  const page = await context.newPage();
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2000);

  // Find the "Firehose" link and dump its surroundings.
  const info = await page.evaluate(`(() => {
    function describe(el, label) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        label: label,
        tag: el.tagName,
        cls: el.className,
        text: (el.innerText || el.textContent || "").trim().slice(0, 80),
        outerHTML: el.outerHTML.slice(0, 300),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        cs: {
          display: cs.display,
          position: cs.position,
          padding: cs.padding,
          margin: cs.margin,
          marginLeft: cs.marginLeft,
          marginRight: cs.marginRight,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          letterSpacing: cs.letterSpacing,
          wordSpacing: cs.wordSpacing,
          beforeContent: window.getComputedStyle(el, '::before').content,
          beforeFontFamily: window.getComputedStyle(el, '::before').fontFamily,
          afterContent: window.getComputedStyle(el, '::after').content,
          afterFontFamily: window.getComputedStyle(el, '::after').fontFamily,
        },
      };
    }
    var all = Array.from(document.querySelectorAll("a, span, li, button"));
    var candidate = null;
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || "").trim();
      if (t === "Firehose" || t === "Firehose " || (t.indexOf("Firehose") >= 0 && t.length < 40)) {
        candidate = all[i];
        break;
      }
    }
    if (candidate == null) return { error: "no Firehose candidate found" };
    var result = {
      candidate: describe(candidate, "Firehose candidate"),
      parent: candidate.parentElement ? describe(candidate.parentElement, "parent") : null,
      grandparent: candidate.parentElement && candidate.parentElement.parentElement ? describe(candidate.parentElement.parentElement, "grandparent") : null,
      siblings: [],
      children: [],
      afterParent: [],
    };
    if (candidate.parentElement) {
      var sibs = Array.from(candidate.parentElement.children);
      for (var j = 0; j < sibs.length; j++) {
        if (sibs[j] === candidate) continue;
        var s = sibs[j];
        result.siblings.push(describe(s, "parent-child:" + s.tagName.toLowerCase() + "." + (s.className.split(/\\s+/)[0] || "")));
      }
    }
    var kids = Array.from(candidate.children);
    for (var k = 0; k < kids.length; k++) {
      result.children.push(describe(kids[k], "child#" + k));
    }
    var cur = candidate.parentElement ? candidate.parentElement.nextElementSibling : null;
    var count = 0;
    while (cur && count < 3) {
      result.afterParent.push(describe(cur, "afterParent:" + cur.tagName.toLowerCase() + "." + ((cur.className || "").split(/\\s+/)[0] || "")));
      cur = cur.nextElementSibling;
      count++;
    }
    return result;
  })()`);

  // Now probe the `<i class="icon-angle-right">` specifically and use a Range
  // to find the trailing-space's actual painted advance.
  const iconInfo = await page.evaluate(`(() => {
    var icon = document.querySelector('li.nav-label .icon-angle-right');
    if (!icon) return { error: 'no icon found' };
    var iconCs = window.getComputedStyle(icon);
    var iconBeforeCs = window.getComputedStyle(icon, '::before');
    var iconAfterCs = window.getComputedStyle(icon, '::after');
    var li = icon.parentElement;
    var liCs = window.getComputedStyle(li);

    // Walk text nodes inside the <li> and measure each char with a Range.
    var textChars = [];
    var iter = document.createNodeIterator(li, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = iter.nextNode())) {
      var text = node.textContent || '';
      for (var i = 0; i < text.length; i++) {
        var rng = document.createRange();
        rng.setStart(node, i);
        rng.setEnd(node, i + 1);
        var r = rng.getBoundingClientRect();
        textChars.push({
          ch: text[i],
          code: text.charCodeAt(i),
          x: r.left,
          right: r.right,
          width: r.width,
        });
      }
    }

    return {
      icon: {
        outerHTML: icon.outerHTML,
        rect: (function () { var r = icon.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })(),
        cs: {
          display: iconCs.display,
          position: iconCs.position,
          padding: iconCs.padding,
          margin: iconCs.margin,
          paddingLeft: iconCs.paddingLeft,
          marginLeft: iconCs.marginLeft,
          fontFamily: iconCs.fontFamily,
          fontSize: iconCs.fontSize,
          color: iconCs.color,
          left: iconCs.left,
          right: iconCs.right,
          top: iconCs.top,
          letterSpacing: iconCs.letterSpacing,
          textIndent: iconCs.textIndent,
        },
        beforeContent: iconBeforeCs.content,
        beforeContentEscaped: JSON.stringify(iconBeforeCs.content),
        beforeFontFamily: iconBeforeCs.fontFamily,
        beforeFontSize: iconBeforeCs.fontSize,
        beforePaddingLeft: iconBeforeCs.paddingLeft,
        beforeMarginLeft: iconBeforeCs.marginLeft,
        beforeLeft: iconBeforeCs.left,
        beforePosition: iconBeforeCs.position,
        beforeDisplay: iconBeforeCs.display,
        beforeTextIndent: iconBeforeCs.textIndent,
        afterContent: iconAfterCs.content,
      },
      li: {
        outerHTML: li.outerHTML,
        rect: (function () { var r = li.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })(),
        innerHTML: li.innerHTML,
        childNodes: Array.from(li.childNodes).map(function (n) {
          var info = { nodeType: n.nodeType, nodeName: n.nodeName, value: '' };
          if (n.nodeType === Node.TEXT_NODE) info.value = JSON.stringify(n.nodeValue);
          else if (n.nodeType === Node.ELEMENT_NODE) info.value = n.outerHTML;
          return info;
        }),
      },
      textChars: textChars,
    };
  })()`);

  console.log("=== Firehose surrounding context ===");
  console.log(JSON.stringify(info, null, 2));
  console.log("\n=== icon-angle-right details ===");
  console.log(JSON.stringify(iconInfo, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
