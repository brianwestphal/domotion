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
    const out: any = { sdhjrl: [], allAfter: [] };
    // Find all .css-sdhjrl elements
    const matches = document.querySelectorAll('.css-sdhjrl');
    for (const el of matches) {
      const cs = getComputedStyle(el as Element);
      const acs = getComputedStyle(el as Element, '::after');
      const bcs = getComputedStyle(el as Element, '::before');
      const r = (el as Element).getBoundingClientRect();
      out.sdhjrl.push({
        tag: el.tagName,
        className: (el as HTMLElement).className.slice(0, 80),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        position: cs.position, overflow: cs.overflow, display: cs.display,
        after: {
          content: acs.content,
          display: acs.display,
          position: acs.position,
          backgroundImage: acs.backgroundImage,
          backgroundColor: acs.backgroundColor,
          width: acs.width, height: acs.height,
          top: acs.top, right: acs.right, bottom: acs.bottom, left: acs.left,
          opacity: acs.opacity, zIndex: acs.zIndex,
        },
        before: {
          content: bcs.content,
          backgroundImage: bcs.backgroundImage,
        },
      });
    }
    // Also: find ALL elements whose ::after has a linear-gradient background
    const all = document.querySelectorAll('*');
    let count = 0;
    for (const el of all) {
      const acs = getComputedStyle(el as Element, '::after');
      const bg = acs.backgroundImage;
      if (bg && bg !== 'none' && bg.includes('linear-gradient') && acs.content !== 'none' && acs.content !== 'normal') {
        const r = (el as Element).getBoundingClientRect();
        // Only count visible ones
        if (r.top < 6000 && r.bottom > 0) {
          count++;
          if (count <= 12) {
            out.allAfter.push({
              tag: el.tagName,
              cls: (el as HTMLElement).className?.toString?.().slice(0, 70) ?? '',
              rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
              afterBg: bg.slice(0, 120),
              afterWidth: acs.width, afterHeight: acs.height,
              afterPos: acs.position, afterRight: acs.right, afterTop: acs.top,
              afterContent: acs.content.slice(0, 30),
              afterZIndex: acs.zIndex,
            });
          }
        }
      }
    }
    out.totalAfterWithGrad = count;
    return out;
  });

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
