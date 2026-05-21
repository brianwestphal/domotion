// Probe the actual transform-origin on dom-graphic__content + verify the
// round-trip math: live_y = scale_compose(cleared_y) ?
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
  // Same resize + pre-scroll the entire-page mode does
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
    const stripeContent = document.querySelectorAll('.dom-graphic__content');
    const results = [];
    for (let i = 0; i < stripeContent.length; i++) {
      const el = stripeContent[i];
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.transform === 'none' || cs.transform.indexOf('matrix(0.6') === -1) continue;
      results.push({
        i: i,
        rect_live: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        transform: cs.transform,
        transformOrigin: cs.transformOrigin,
        position: cs.position,
      });
      // Find the payment-method-item rows inside this
      const rows = el.querySelectorAll('.payments-graphic__checkout-payment-methods-item');
      const rowData = [];
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        const rcs = getComputedStyle(row);
        const rr = row.getBoundingClientRect();
        // The label text — extract for identification
        const label = row.querySelector('.payments-graphic__checkout-payment-methods-item-label--card, .payments-graphic__checkout-payment-methods-item-label--affirm, .payments-graphic__checkout-payment-methods-item-label--cashapp, .payments-graphic__checkout-payment-methods-item-label--crypto, .payments-graphic__checkout-payment-methods-item-label--us-bank-account');
        rowData.push({
          j: j,
          label: label ? (label.className || '').split(' ').slice(-1)[0] : '?',
          rect_live: { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
          transform: rcs.transform === 'none' ? null : rcs.transform,
          transformOrigin: rcs.transformOrigin,
        });
      }
      results[results.length - 1].rows = rowData;
    }
    return results;
  })()`);
  console.log("Live state (no freeze):", JSON.stringify(out, null, 2));

  // Now clear all transforms top-down and re-measure
  const cleared = await page.evaluate(`(function() {
    const allWithTransform = document.querySelectorAll('*');
    const saved = [];
    for (const el of allWithTransform) {
      const cs = getComputedStyle(el);
      if (cs.transform !== 'none') {
        saved.push({ el: el, t: el.style.transform });
        el.style.transform = 'translate(0)';
      }
    }
    // Now re-measure the rows
    const rows = document.querySelectorAll('.payments-graphic__checkout-payment-methods-item');
    const rowData = [];
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      const label = row.querySelector('[class*="payments-graphic__checkout-payment-methods-item-label--"]');
      const rr = row.getBoundingClientRect();
      rowData.push({
        j: j,
        label: label ? (label.className || '').split(' ').slice(-1)[0] : '?',
        rect_cleared: { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
      });
    }
    // Restore
    for (const s of saved) s.el.style.transform = s.t;
    return rowData;
  })()`);
  console.log("\nCleared transforms re-measure:", JSON.stringify(cleared, null, 2));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
