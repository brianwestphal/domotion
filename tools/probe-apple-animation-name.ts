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

  // Search for all CSS rules in all stylesheets containing "opacity" related to mday-icon
  const out = await page.evaluate(() => {
    const results: any[] = [];
    // Get the FULL CSS text from all stylesheets - search for 'mday-icon'
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const dump = (rules: CSSRuleList, prefix = '') => {
          for (const rule of Array.from(rules)) {
            const text = rule.cssText;
            if (text.includes('mday-icon') || text.includes('mothers-day') || text.includes('flower') || text.includes('--flower')) {
              results.push({ prefix, type: rule.constructor.name, text: text.slice(0, 400) });
            }
            if (rule instanceof CSSMediaRule) dump(rule.cssRules, prefix + ' @media ' + rule.conditionText.slice(0, 30) + ' >');
            else if (rule instanceof CSSSupportsRule) dump(rule.cssRules, prefix + ' @supports ' + rule.conditionText.slice(0, 30) + ' >');
          }
        };
        dump(sheet.cssRules);
      } catch (e) {
        results.push({ error: 'sheet inaccessible (cross-origin?)', href: sheet.href });
      }
    }
    return results;
  });

  for (const r of out.slice(0, 50)) console.log(JSON.stringify(r));
  console.log("Total:", out.length);
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
