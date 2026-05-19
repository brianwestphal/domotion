/**
 * Probe: what @font-face rules does the Slashdot mobile page declare, and
 * which `Open Sans` variant does Chromium actually pick for the italic `<I>`
 * inside the river-story abstract (the one DM-664 flagged as over-slanted)?
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "slashdot-mobile.har"), { url: "**/*", notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://slashdot.org/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 1) Every @font-face declared in any reachable stylesheet.
  const fontFaces = await page.evaluate(() => {
    const out: any[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSFontFaceRule) {
          out.push({
            family: rule.style.getPropertyValue("font-family"),
            style: rule.style.getPropertyValue("font-style"),
            weight: rule.style.getPropertyValue("font-weight"),
            src: rule.style.getPropertyValue("src").slice(0, 200),
          });
        }
      }
    }
    return out;
  });
  console.log("=== @font-face rules ===");
  for (const f of fontFaces) console.log(JSON.stringify(f));

  // 2) document.fonts API — what's actually registered + loaded.
  const docFonts = await page.evaluate(() => {
    const out: any[] = [];
    document.fonts.forEach((ff) => {
      out.push({ family: ff.family, style: ff.style, weight: ff.weight, status: ff.status, unicodeRange: ff.unicodeRange });
    });
    return out;
  });
  console.log("\n=== document.fonts ===");
  for (const f of docFonts) console.log(JSON.stringify(f));

  // 3) Measure the painted width of the same `<I>` text Chromium painted, then
  //    compare to what we'd get if we forced Helvetica (the fallback chain
  //    bottom). If our actual is using Helvetica, the widths should differ.
  const widths = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:14px;font-style:italic;white-space:pre;";
    probe.textContent = "The settlement will resolve a 2025 lawsuit";
    document.body.appendChild(probe);
    const measure = (ff: string) => { probe.style.fontFamily = ff; return probe.getBoundingClientRect().width; };
    const out = {
      openSansChain: measure(`"Open Sans", "Droid Sans", Helvetica`),
      openSansOnly: measure(`"Open Sans"`),
      helveticaOnly: measure(`Helvetica`),
      droidSansOnly: measure(`"Droid Sans"`),
    };
    probe.remove();
    return out;
  });
  console.log("\n=== Measured widths (italic 14px) ===");
  console.log(JSON.stringify(widths, null, 2));

  await browser.close();
}
void main();
