/* eslint-disable */
// Drill into framer's chevron-icon div (.framer-GHm6V.framer-zvmo1m at REGION [1]).
// Dump every computed-style property that could shape it (mask*, clip-path, border*,
// background*, transform, ::before / ::after pseudo) plus the outerHTML of the div
// itself and its parent chain — so we can see whether framer is masking a white square
// or whether there's an inline <svg> we're failing to walk.
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
  await context.routeFromHAR(resolve(CACHE_DIR, "framer-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => {
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, 6000);
  await page.waitForTimeout(800);

  const out = await page.evaluate(() => {
    const el = document.querySelector('div.framer-GHm6V.framer-zvmo1m');
    if (el == null) return { error: 'not found' };
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    const after = getComputedStyle(el, '::after');
    const chain: any[] = [];
    let cur: Element | null = el;
    while (cur != null && chain.length < 8) {
      const ccs = getComputedStyle(cur);
      chain.push({
        tag: cur.nodeName.toLowerCase(),
        cls: ((cur as HTMLElement).className || '').toString().slice(0, 100),
        rect: (() => { const r = cur.getBoundingClientRect(); return { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 }; })(),
        background: ccs.backgroundColor,
        bgImage: ccs.backgroundImage === 'none' ? null : ccs.backgroundImage.slice(0, 200),
        maskImage: (ccs as any).maskImage || (ccs as any).webkitMaskImage,
        maskSize: (ccs as any).maskSize || (ccs as any).webkitMaskSize,
        maskPosition: (ccs as any).maskPosition || (ccs as any).webkitMaskPosition,
        maskRepeat: (ccs as any).maskRepeat || (ccs as any).webkitMaskRepeat,
        maskMode: (ccs as any).maskMode,
        clipPath: ccs.clipPath,
        border: ccs.border,
        borderRadius: ccs.borderRadius,
        transform: ccs.transform === 'none' ? null : ccs.transform,
        overflow: ccs.overflow,
      });
      cur = cur.parentElement;
    }
    return {
      el: {
        outerHTML: el.outerHTML.slice(0, 800),
        childCount: el.children.length,
        innerHTML: el.innerHTML.slice(0, 800),
      },
      pseudoBefore: {
        content: before.content,
        backgroundImage: before.backgroundImage,
        maskImage: (before as any).maskImage || (before as any).webkitMaskImage,
      },
      pseudoAfter: {
        content: after.content,
        backgroundImage: after.backgroundImage,
        maskImage: (after as any).maskImage || (after as any).webkitMaskImage,
      },
      chain,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
