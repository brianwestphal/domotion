/**
 * One-shot capture of nytimes.com (mobile top) into a self-contained SVG
 * fixture used by the install-demo build (`site/scripts/build-install-demo.ts`).
 *
 * Why a snapshot instead of capturing live at build time:
 *  - Build determinism: nytimes.com changes daily and is wrapped in cookie
 *    banners / paywall interstitials / GDPR consent flows that break a quiet
 *    `setContent` + capture flow.
 *  - Refreshability: re-running this script overwrites the fixture, so the
 *    install demo can be refreshed periodically without making the build
 *    network-dependent.
 *
 * The snapshot is a fully self-contained SVG (glyph defs included) sized to
 * match the install-demo phone preview's content area. It's read verbatim by
 * `build-install-demo.ts` and embedded inside the phone bezel overlay.
 *
 * Run via `npx tsx tools/capture-nytimes-snapshot.ts`.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureElementTree,
  elementTreeToSvg,
  launchChromium,
} from "../src/index.js";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const OUT = resolve(ROOT, "site/scripts/install-demo/nytimes-snapshot.svg");

// Mobile portrait viewport, matching the resolution used in the install
// demo's "Capturing https://www.nytimes.com (390×844)…" line. The capture
// rect is the top portion only — the install-demo phone preview is a
// thumbnail-sized window, so the part-of-page that actually matters is the
// masthead + lead headline + lead image.
const VIEWPORT_W = 390;
const VIEWPORT_H = 844;
const CAPTURE_H = 600;

async function main(): Promise<void> {
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();

    // nytimes.com fires analytics / ad pixels continuously, so `networkidle`
    // never settles — use `domcontentloaded` and then an explicit settle pause
    // below to let the lead images / fonts paint.
    await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});

    // Initial settle so the subscribe / GDPR modals have a chance to mount.
    await page.waitForTimeout(2500);

    // Best-effort dismissal of the common interstitials. Each click is wrapped
    // in a short timeout so missing elements don't fail the script.
    const dismissSelectors = [
      'button[data-testid="close-modal"]',
      'button[aria-label="Close"]',
      'button:has-text("Accept all")',
      'button:has-text("Reject")',
      'button:has-text("Continue")',
    ];
    for (const sel of dismissSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 1500 });
          await page.waitForTimeout(300);
        }
      } catch {
        // ignore — selector not present or click blocked
      }
    }

    // Let lazy-loaded images & fonts settle.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);

    const tree = await captureElementTree(page, "body", {
      x: 0,
      y: 0,
      width: VIEWPORT_W,
      height: CAPTURE_H,
    });
    const inner = elementTreeToSvg(tree, VIEWPORT_W, CAPTURE_H, "nyt-", /* includeGlyphDefs */ true);
    // Glyph defs use a global `g0`, `g1`, … counter that isn't prefixable
    // through the public API. The snapshot is embedded as a nested `<svg>`
    // inside the install-demo SVG, where IDs are document-global — so prefix
    // every `g{N}` def + reference now to namespace the snapshot's glyphs.
    const prefixed = inner
      .replace(/id="g(\d+)"/g, 'id="nyt-g$1"')
      .replace(/href="#g(\d+)"/g, 'href="#nyt-g$1"');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWPORT_W} ${CAPTURE_H}" width="${VIEWPORT_W}" height="${CAPTURE_H}">`
      + prefixed
      + `</svg>`;

    writeFileSync(OUT, svg);
    console.log(`Wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB, ${VIEWPORT_W}×${CAPTURE_H})`);
  } finally {
    await browser.close();
  }
}

void main();
