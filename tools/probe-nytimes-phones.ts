// Probe DM-592 — find why the phone-mockup images are vertically squished.
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
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(HAR, { url: "**/*", update: false, notFound: "abort" });
  const page = await context.newPage();
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Find <img> / <picture> in the band y=552..685
  const info = await page.evaluate(`(() => {
    function describe(el) {
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: typeof el.className === 'string' ? el.className : (el.className.baseVal || ''),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        attrs: {
          src: el.currentSrc || el.src || '',
          natW: el.naturalWidth,
          natH: el.naturalHeight,
          width: el.getAttribute('width'),
          height: el.getAttribute('height'),
          aspectRatio: el.getAttribute('aspect-ratio'),
          srcset: el.getAttribute('srcset') ? el.getAttribute('srcset').slice(0, 200) : null,
        },
        cs: {
          width: cs.width,
          height: cs.height,
          objectFit: cs.objectFit,
          objectPosition: cs.objectPosition,
          aspectRatio: cs.aspectRatio,
          display: cs.display,
          maxWidth: cs.maxWidth,
          maxHeight: cs.maxHeight,
        },
      };
    }
    var hits = [];
    var imgs = document.querySelectorAll('img, picture, source');
    for (var i = 0; i < imgs.length; i++) {
      var r = imgs[i].getBoundingClientRect();
      if (r.bottom < 540 || r.top > 700) continue;
      if (r.width < 30 || r.height < 30) continue;
      hits.push(describe(imgs[i]));
    }
    return hits;
  })()`);

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
