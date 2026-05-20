// Probe Apple page for the bag icon area
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
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "/tmp/claude/apple-bag-probe.png", clip: { x: 1080, y: 60, width: 200, height: 90 } });

  // What's at the extraneous-dot location (around 1145, 100)?
  const dot = await page.evaluate(() => {
    const x = 1145, y = 100;
    const stack = (document as any).elementsFromPoint(x, y) as Element[];
    return stack.map(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: (el as HTMLElement).id,
        cls: (el as any).className?.toString?.() ?? "",
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage,
        radius: cs.borderRadius,
        before: getComputedStyle(el, '::before').content,
        after: getComputedStyle(el, '::after').content,
        beforeBg: getComputedStyle(el, '::before').backgroundColor,
      };
    });
  });
  console.log("dot location stack:", JSON.stringify(dot, null, 2));

  // Dump every child of the bag LI
  const bagInfo = await page.evaluate(`(function() {
    var bag = document.getElementById('globalnav-bag');
    if (!bag) return null;
    function dump(el, depth) {
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var before = getComputedStyle(el, '::before');
      var after = getComputedStyle(el, '::after');
      var dimStyles = {width: cs.width, height: cs.height, minWidth: cs.minWidth, minHeight: cs.minHeight, transform: cs.transform, overflow: cs.overflow, parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : null, parentOverflow: el.parentElement ? getComputedStyle(el.parentElement).overflow : null};
      var beforeDim = {content: before.content, width: before.width, height: before.height, display: before.display, position: before.position, backgroundColor: before.backgroundColor, borderRadius: before.borderRadius};
      var afterDim = {content: after.content, width: after.width, height: after.height, display: after.display, position: after.position, backgroundColor: after.backgroundColor, borderRadius: after.borderRadius};
      var kids = [];
      for (var i = 0; i < el.children.length; i++) kids.push(dump(el.children[i], depth + 1));
      return {
        tag: el.tagName,
        id: el.id || '',
        cls: (el.className && el.className.toString && el.className.toString()) || '',
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        dim: dimStyles,
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage,
        radius: cs.borderRadius,
        depth: depth,
        visibility: cs.visibility,
        display: cs.display,
        opacity: cs.opacity,
        position: cs.position,
        before: beforeDim,
        after: afterDim,
        kids: kids,
      };
    }
    return dump(bag, 0);
  })()`);
  console.log("bag subtree:", JSON.stringify(bagInfo, null, 2));

  const info = await page.evaluate(() => {
    const out: any[] = [];
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const r = el.getBoundingClientRect();
      // Around bag icon: roughly 1120-1170 x, 70-130 y
      if (r.right < 1100 || r.left > 1200) continue;
      if (r.bottom < 70 || r.top > 130) continue;
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      out.push({
        tag: el.tagName,
        id: (el as HTMLElement).id || "",
        className: (el as any).className?.toString?.() ?? "",
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        background: cs.backgroundColor,
        backgroundImage: cs.backgroundImage,
        borderRadius: cs.borderRadius,
        children: el.children.length,
        outerHTML: el.outerHTML.slice(0, 300),
      });
    }
    return out;
  });
  console.log("matches:", info.length);
  for (const m of info) {
    console.log(JSON.stringify(m));
  }
  await browser.close();
})();
