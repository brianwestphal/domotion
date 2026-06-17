/**
 * Build the phone-framed mobile demo (DM-217).
 *
 * Wraps the already-captured `mobile-screen.svg` (produced by a normal
 * `domotion capture … --mobile` run — see the gallery doc) inside a hand-drawn
 * phone bezel to produce `phone-screen.svg`.
 *
 * Why a build script and not a one-line `domotion capture`? Device chrome
 * (a phone / browser / window bezel wrapped around a capture) is not yet a
 * CLI feature — there is no `--chrome phone` flag. This script hand-rolls the
 * bezel the same way `site/scripts/build-install-demo.ts` does for its inline
 * phone preview: it reads the committed capture SVG and nests it inside the
 * bezel as a clipped `<svg>`. Once a `--chrome <device>` flag lands, the whole
 * demo collapses to:
 *
 *     domotion capture site/scripts/demos/phone-screen/mobile-screen.html \
 *       --chrome phone --width 390 --height 844 -o phone-screen.svg
 *
 * Nesting the committed capture (rather than re-rendering the element tree)
 * reuses the CLI's font setup, so the glyph paths are identical to the
 * standalone capture — no font-fallback drift.
 *
 * Regenerate after editing `mobile-screen.html`:
 *     domotion capture site/scripts/demos/phone-screen/mobile-screen.html \
 *       --width 390 --height 844 --mobile --optimize -o mobile-screen.svg
 *     npx tsx site/scripts/demos/phone-screen/build-phone-screen.ts
 */

import { writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Inner screen size — a real iPhone-class logical viewport.
const SCREEN_W = 390, SCREEN_H = 844;

// Bezel geometry. The body wraps the screen with an even rim; a notch pill
// floats at the top and a home indicator at the bottom.
const RIM = 14;
const RADIUS = 56;
const OUTER_W = SCREEN_W + RIM * 2;
const OUTER_H = SCREEN_H + RIM * 2;

function main(): void {
  // Read the committed capture and drop its outer <svg> wrapper so it can be
  // re-nested at the bezel's screen offset.
  const captureRaw = readFileSync(resolve(HERE, "mobile-screen.svg"), "utf8");
  const screenInner = captureRaw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTER_W}" height="${OUTER_H}" viewBox="0 0 ${OUTER_W} ${OUTER_H}">` +
    `<defs><clipPath id="phone-screen-clip"><rect x="${RIM}" y="${RIM}" width="${SCREEN_W}" height="${SCREEN_H}" rx="${RADIUS - RIM}"/></clipPath></defs>` +
    // Outer titanium-ish body + inner rim highlight.
    `<rect width="${OUTER_W}" height="${OUTER_H}" rx="${RADIUS}" fill="#1c1c1e"/>` +
    `<rect x="3" y="3" width="${OUTER_W - 6}" height="${OUTER_H - 6}" rx="${RADIUS - 3}" fill="none" stroke="#3a3a3c" stroke-width="1.5"/>` +
    // Screen backdrop (so any letterboxing reads as the page bg, not white).
    `<rect x="${RIM}" y="${RIM}" width="${SCREEN_W}" height="${SCREEN_H}" rx="${RADIUS - RIM}" fill="#0d1117"/>` +
    // Nested capture, clipped to the rounded screen.
    `<g clip-path="url(#phone-screen-clip)"><svg x="${RIM}" y="${RIM}" width="${SCREEN_W}" height="${SCREEN_H}" viewBox="0 0 ${SCREEN_W} ${SCREEN_H}">${screenInner}</svg></g>` +
    // Dynamic-island notch.
    `<rect x="${OUTER_W / 2 - 56}" y="${RIM + 9}" width="112" height="30" rx="15" fill="#000"/>` +
    // Home indicator.
    `<rect x="${OUTER_W / 2 - 65}" y="${OUTER_H - RIM - 12}" width="130" height="5" rx="2.5" fill="#e6edf3" opacity="0.85"/>` +
    `</svg>`;

  writeFileSync(resolve(HERE, "phone-screen.svg"), svg);
  console.log(`Wrote phone-screen.svg (${(svg.length / 1024).toFixed(1)} KB, ${OUTER_W}×${OUTER_H})`);
}

main();
