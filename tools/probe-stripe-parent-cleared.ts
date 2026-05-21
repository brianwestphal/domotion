// Probe parent element rect (cleared) + the WHOLE ancestor chain rect both live and cleared.
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
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const h = 6000;
  await page.setViewportSize({ width: 390, height: h });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, ${h});
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  // Find the right .dom-graphic__content (the one with scale)
  const out = await page.evaluate(`(function() {
    const all = document.querySelectorAll('.dom-graphic__content');
    let target = null;
    for (const e of all) {
      const cs = getComputedStyle(e);
      if (cs.transform.indexOf('0.6') !== -1) { target = e; break; }
    }
    if (!target) return { error: 'no target' };

    // Walk ancestors, dump live rects + transforms
    const ancestors = [];
    let cur = target;
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      const r = cur.getBoundingClientRect();
      ancestors.push({
        tag: cur.tagName,
        cls: (cur.className||'').toString().slice(0, 40),
        rect_live: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        transform: cs.transform === 'none' ? null : cs.transform.slice(0, 50),
        transformOrigin: cs.transformOrigin,
        position: cs.position,
      });
      cur = cur.parentElement;
    }

    // Now clear all transforms top-down
    const allElems = document.querySelectorAll('*');
    const saved = [];
    for (const el of allElems) {
      const cs = getComputedStyle(el);
      if (cs.transform !== 'none') {
        saved.push({ el: el, t: el.style.transform });
        el.style.transform = 'translate(0)';
      }
    }
    // Re-measure ancestors
    const cleared = [];
    cur = target;
    while (cur && cur !== document.documentElement) {
      const r = cur.getBoundingClientRect();
      cleared.push({
        rect_cleared: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      });
      cur = cur.parentElement;
    }
    // Restore
    for (const s of saved) s.el.style.transform = s.t;

    return { ancestors, cleared };
  })()`);

  console.log("Ancestors (live → cleared):");
  for (let i = 0; i < out.ancestors.length; i++) {
    const a = out.ancestors[i];
    const c = out.cleared[i];
    console.log(`  [${i}] ${a.tag}.${a.cls}`);
    console.log(`      live: ${JSON.stringify(a.rect_live)} transform=${a.transform} origin=${a.transformOrigin} pos=${a.position}`);
    console.log(`      cleared: ${JSON.stringify(c.rect_cleared)}`);
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
