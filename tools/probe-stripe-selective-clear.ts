// What if we cleared ONLY translation transforms (kept scales)? Probe what
// row j=2 (and other rows) would measure as.
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

  const out = await page.evaluate(`(function() {
    // Find all elements with transforms; clear ONLY pure translations
    function isPureTranslation(t) {
      if (!t || t === 'none') return false;
      // matrix(1, 0, 0, 1, tx, ty) is pure translation
      const m = t.match(/^matrix\\(([^)]+)\\)$/);
      if (!m) return false;
      const parts = m[1].split(',').map(s => parseFloat(s.trim()));
      if (parts.length !== 6) return false;
      return Math.abs(parts[0] - 1) < 1e-6 && Math.abs(parts[1]) < 1e-6
          && Math.abs(parts[2]) < 1e-6 && Math.abs(parts[3] - 1) < 1e-6;
    }
    const allElems = document.querySelectorAll('*');
    const saved = [];
    for (const el of allElems) {
      const cs = getComputedStyle(el);
      if (cs.transform !== 'none' && isPureTranslation(cs.transform)) {
        saved.push({ el: el, t: el.style.transform });
        el.style.transform = 'translate(0)';
      }
    }
    // Re-measure rows
    const rows = document.querySelectorAll('.payments-graphic__checkout-payment-methods-item');
    const rowData = [];
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      const rr = row.getBoundingClientRect();
      const rcs = getComputedStyle(row);
      rowData.push({
        j: j,
        rect: { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
        own_transform: rcs.transform === 'none' ? null : rcs.transform,
      });
    }
    // Also probe the scaled parent
    const stripeContent = document.querySelectorAll('.dom-graphic__content');
    let parentRect = null;
    for (const e of stripeContent) {
      const cs = getComputedStyle(e);
      if (cs.transform.indexOf('0.6') !== -1) {
        const r = e.getBoundingClientRect();
        parentRect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        break;
      }
    }
    // Restore
    for (const s of saved) s.el.style.transform = s.t;
    return { rows: rowData, parent: parentRect };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
