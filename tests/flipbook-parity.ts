import { expect } from "vitest";
import { STRICT_CAPS, type CompareResult } from "../src/review/compare-pngs.js";

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
 * On a host with no calibrated caps this degrades to the platform-agnostic
 * `regionCount === 0` these sites enforced before — see `strictCapsFor` for why
 * the Linux numbers don't admit a meaningful cap yet.
 */
export function expectFlipbookParity(cmp: CompareResult, label: string): void {
  const detail = `strict ${cmp.strictRegionCount} region(s), ${cmp.strictRegionArea} px total, `
    + `${cmp.strictMaxRegionArea} px largest (regions ${cmp.regionCount}, nonAa ${cmp.nonAaPixels}, `
    + `shifted ${cmp.shiftedPixels}, verdict ${cmp.verdict})`;
  expect(cmp.regionCount, `${label}: ${detail}`).toBe(0);
  if (STRICT_CAPS == null) return;
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
