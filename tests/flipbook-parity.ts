import { expect } from "vitest";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { STRICT_CAPS, type CompareResult } from "../src/review/compare-pngs.js";

/**
 * Launch options every compressor e2e must use for the browser it rasterizes
 * its SVGs with.
 *
 * `--disable-lcd-text` turns off Chrome's subpixel (LCD) text antialiasing.
 * That is not cosmetic here — it is what makes the no-motion bar meaningful
 * off macOS. A compressed run wraps paired content in animated transform
 * groups, which Chrome promotes to their own compositing layers, and it does
 * NOT use LCD antialiasing inside a composited layer. So on a host where LCD
 * text is on (Linux; macOS has had it off since Big Sur) the compressed render
 * gets grayscale-antialiased glyphs while the flipbook gets LCD-antialiased
 * ones, and EVERY glyph edge in the frame differs. Measured on the 12-state
 * editor fixture in the Linux container: 829 px largest strict region and
 * 11423 px total with LCD text on, against 0 px for both with it off — while
 * macOS, which never had it on, sat at 88 px / 215 px either way. That spread
 * overlapped a known compressor break at 3712 px, which is why the caps could
 * only be calibrated for darwin at first.
 *
 * Turning it off costs nothing real: both images come out of our own renderer
 * and depict the same content, so the comparison is unchanged — it just stops
 * measuring the host's AA mode instead of the compressor. The fidelity sweeps,
 * which compare against Chrome's own paint, are untouched by this.
 */
export const PARITY_LAUNCH_OPTS = { args: ["--disable-lcd-text"] };

/** Recalibration hook. Set `FLIPBOOK_METRICS=<path>` to append one JSON line
 *  per parity check — the raw strict aggregates behind the caps, on whatever
 *  platform the run happens to be on. This is how the caps in `strictCapsFor`
 *  were sized: run the compressor e2e set with it on macOS and in the Linux
 *  container, take the max of each aggregate over a CORRECT build, then
 *  re-run against a deliberately broken build and confirm the two populations
 *  stay separated. Recording, not gating — the assertions below still run. */
function recordMetrics(cmp: CompareResult, label: string): void {
  const path = process.env.FLIPBOOK_METRICS;
  if (!path) return;
  const row = {
    label,
    platform: process.platform,
    strictRegionCount: cmp.strictRegionCount,
    strictRegionArea: cmp.strictRegionArea,
    strictMaxRegionArea: cmp.strictMaxRegionArea,
    regionCount: cmp.regionCount,
    nonAaPixels: cmp.nonAaPixels,
    shiftedPixels: cmp.shiftedPixels,
    verdict: cmp.verdict,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/**
 * The pixel bar every compressed-run e2e holds its output to: a compressed run,
 * rasterized at a given state, must match the uncompressed flipbook of the very
 * same state.
 *
 * It is deliberately STRICTER than the fidelity sweeps' `regionCount === 0`
 * gate. Those compare our SVG against Chrome's own paint, where whole
 * paragraphs differ in low-severity glyph-edge pixels with nothing structurally
 * wrong, so the comparator files low-severity components under
 * `shiftyRegionCount` and keeps them out of `regionCount` by design.
 *
 * Here BOTH images come out of our own renderer and depict the same captured
 * layout, which snaps at state boundaries: nothing may translate, and nothing
 * may swap paint order. "It only moved" is precisely the class of compressor
 * bug worth catching — a mis-parented glyph group, a waypoint attached to the
 * wrong state, a reopened variant landing at the wrong z-index. Under the
 * default gate a real case of that measured `regionCount === 0`, coverage 0%,
 * verdict "clean", while 3712 pixels differed: two equal-sized solid blocks
 * swapping z-order is a large-but-low-severity component, so the whole flip sat
 * in `shiftyRegionArea`. The strict aggregates count those components; the caps
 * bound them (both sized from measurement — see `strictCapsFor`).
 *
 * Two things are deliberately NOT tightened, both measured rather than assumed:
 *
 *   - The comparator's per-pixel sub-pixel-shift pre-filter. A compressed run
 *     wraps paired content in transform groups, which rasterize a sub-pixel
 *     phase off the flipbook's direct placement, so the CLEAN fixtures carry
 *     real shift-absorbed pixel counts (99 on the out-of-position fixture,
 *     ~5300 per state on the 12-state editor one) with zero real change. A
 *     pixel-level shift-inclusive bar fails on correct output.
 *   - The `MIN_REGION_AREA` scatter floor, which is what forgives the few
 *     pixels of independent-rasterization noise the text-heavy fixtures carry.
 *
 * The caps are the SAME on every platform. That relies on two things every
 * compressor fixture must do, both documented where they live: rasterize with
 * `PARITY_LAUNCH_OPTS` (above) and pin its fonts through `tests/fixture-fonts.ts`.
 * Skip either and the fixture starts measuring the host instead of the
 * compressor, and these caps will not hold off macOS.
 */
export function expectFlipbookParity(cmp: CompareResult, label: string): void {
  // First, so a run that trips an assertion below still reports its numbers —
  // measuring a deliberately-broken build is half of sizing the caps.
  recordMetrics(cmp, label);
  const detail = `strict ${cmp.strictRegionCount} region(s), ${cmp.strictRegionArea} px total, `
    + `${cmp.strictMaxRegionArea} px largest (regions ${cmp.regionCount}, nonAa ${cmp.nonAaPixels}, `
    + `shifted ${cmp.shiftedPixels}, verdict ${cmp.verdict})`;
  expect(cmp.regionCount, `${label}: ${detail}`).toBe(0);
  // A single block-sized component that the default gate suppressed: content
  // moved, or two elements swapped paint order.
  expect(
    cmp.strictMaxRegionArea,
    `${label}: a block-sized suppressed region — content moved or swapped paint order. ${detail}`,
  ).toBeLessThanOrEqual(STRICT_CAPS.maxRegionArea);
  // ...and the backstop, for a bug that scatters mid-sized components instead.
  expect(
    cmp.strictRegionArea,
    `${label}: too much suppressed change in total. ${detail}`,
  ).toBeLessThanOrEqual(STRICT_CAPS.totalRegionArea);
}
