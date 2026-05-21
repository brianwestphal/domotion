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

  // Probe ALL CSS rules matching the flower, including inherited
  const out = await page.evaluate(() => {
    const f4 = document.querySelector('.mday-icon.flower04') as HTMLElement;
    if (!f4) return null;
    // Sample the painted pixel at flower04's position to see if Chrome actually paints there
    // We can't sample pixels from JS directly but we can check getComputedStyle and walk
    const f4cs = getComputedStyle(f4);
    // Use CSSOM to enumerate rules matched against the element
    const allRules: any[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const walk = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule) {
              try {
                if (rule.selectorText.includes('mday-icon') || rule.selectorText.includes('flower') || rule.selectorText.includes('mothers-day')) {
                  allRules.push({
                    selector: rule.selectorText,
                    text: rule.style.cssText.slice(0, 200),
                    matches: f4.matches(rule.selectorText),
                  });
                }
              } catch {}
            } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
              walk(rule.cssRules);
            }
          }
        };
        walk(sheet.cssRules);
      } catch {}
    }
    return {
      f4opacity: f4cs.opacity,
      f4visibility: f4cs.visibility,
      f4animation: f4cs.animation,
      // Trigger reflow then re-read opacity
      reflow: f4.offsetWidth,
      opacityAfterReflow: getComputedStyle(f4).opacity,
      matchingRulesCount: allRules.length,
      rules: allRules.slice(0, 30),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
