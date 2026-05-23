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
  await context.routeFromHAR(resolve(CACHE_DIR, "nytimes-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const out: any = { useToSvg: [], useToOther: [] };
    const uses = document.querySelectorAll('use');
    for (const u of uses) {
      const href = u.getAttribute('href') || u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      if (!href.startsWith('#')) continue;
      const t = document.getElementById(href.slice(1));
      if (!t) continue;
      const ur = u.getBoundingClientRect();
      const ucs = getComputedStyle(u);
      const targetTag = t.tagName.toLowerCase();
      const targetCs = getComputedStyle(t);
      const tr = (t as Element).getBoundingClientRect();
      const item = {
        href, targetTag,
        useRect: { x: Math.round(ur.left), y: Math.round(ur.top), w: Math.round(ur.width), h: Math.round(ur.height) },
        useAttrs: { x: u.getAttribute('x'), y: u.getAttribute('y'), w: u.getAttribute('width'), h: u.getAttribute('height') },
        useStyleW: ucs.width, useStyleH: ucs.height,
        targetCsW: targetCs.width, targetCsH: targetCs.height,
        targetRectW: Math.round(tr.width), targetRectH: Math.round(tr.height),
        targetParent: (t.parentElement?.tagName || '') + ' style:' + ((t.parentElement as HTMLElement | null)?.style?.cssText?.slice(0, 80) ?? ''),
        targetAttrs: { w: t.getAttribute('width'), h: t.getAttribute('height'), viewBox: t.getAttribute('viewBox') },
      };
      if (targetTag === 'svg') out.useToSvg.push(item);
      else out.useToOther.push({ targetTag, useRect: item.useRect });
    }
    return out;
  });

  console.log(`<use> → <svg> targets: ${result.useToSvg.length}`);
  console.log(`<use> → other targets: ${result.useToOther.length}`);
  console.log('\nSample <use> → <svg>:');
  for (const u of result.useToSvg.slice(0, 8)) {
    console.log(JSON.stringify(u));
  }
  console.log('\nTarget tag distribution for <use> → other:');
  const dist: Record<string, number> = {};
  for (const u of result.useToOther) dist[u.targetTag] = (dist[u.targetTag] ?? 0) + 1;
  console.log(JSON.stringify(dist));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
