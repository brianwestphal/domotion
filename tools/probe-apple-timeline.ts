/* eslint-disable */
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
  await context.routeFromHAR(resolve(CACHE_DIR, "apple-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);

  const out = await page.evaluate(() => {
    const f4 = document.querySelector('.mday-icon.flower04');
    if (!f4) return null;
    const cs = getComputedStyle(f4);
    // Check ALL animations on the element including subtree
    const allAnims = document.getAnimations({ subtree: true });
    const f4Anims = (f4 as HTMLElement).getAnimations({ subtree: true });
    // Get inline style
    const inline = (f4 as HTMLElement).style.cssText;
    // Get CSS custom properties that might affect opacity
    const customProps: any = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs.item(i);
      if (prop.startsWith('--')) {
        customProps[prop] = cs.getPropertyValue(prop);
      }
    }
    // List ALL CSS rules matching this element
    const matching: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          try {
            if (rule instanceof CSSStyleRule) {
              if (f4.matches(rule.selectorText)) {
                matching.push(rule.selectorText + ': ' + rule.style.cssText.slice(0, 120));
              }
            }
          } catch {}
        }
      } catch {}
    }
    return {
      opacity: cs.opacity,
      animationName: cs.animationName,
      animationTimeline: (cs as any).animationTimeline,
      animationRangeStart: (cs as any).animationRangeStart,
      animationRangeEnd: (cs as any).animationRangeEnd,
      viewTimeline: (cs as any).viewTimeline,
      transition: cs.transition,
      inline,
      allAnimsCount: allAnims.length,
      f4AnimsCount: f4Anims.length,
      customProps: Object.keys(customProps).length > 0 ? customProps : null,
      matchingRulesCount: matching.length,
      matchingRules: matching.slice(0, 20),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
