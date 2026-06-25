/**
 * DM-994 post-capture pass: refine `seg.y` of `::first-letter` styled
 * segments with `initial-letter: N M` by pixel-walking the painted
 * region to find Chrome's actual ink top.
 *
 * Why this exists: Chrome scales the drop cap glyph by a factor derived
 * from `cap-height = N × parent line-height`, then places it via inline
 * layout machinery (`LayoutInitialLetterBox::PostPlaceInitialLetterBox`,
 * `AdjustInitialLetterInTextPosition`) that resolves against fragment
 * state we can't reproduce from `getComputedStyle()` alone. The closest
 * pure-CSS-derived placement we tried (`seg.y = Range.top + effectiveCap
 * − effectiveAscent`) was within ±12 px on the largest drop caps but
 * left a 1.65% diff on `tests/output/html-test/24-deep-initial-letter`.
 *
 * Side-step the layout-engine reverse-engineering: take a small
 * `page.screenshot({ clip })` of the float's painted area, find the
 * first row with significant ink (the painted cap-top), and adjust
 * `seg.y` so the renderer's `baseline = seg.y + segAscent` math puts
 * the rendered glyph's ink top at exactly Chrome's painted cap-top.
 *
 * Capture-side (`src/capture/script/walker/text-segments.ts`) tags the
 * styled segment with `_initialLetterProbe = { rect, capHeight, ascent }`
 * where `rect` is the screenshot clip area (viewport-relative, padded
 * upward to catch raised caps and downward to catch sinks). This pass
 * walks the captured tree, takes one screenshot per probe, computes
 * Chrome's painted ink top via a per-row dark-pixel scan, updates
 * `seg.y`, and strips the `_initialLetterProbe` field before the
 * renderer sees it.
 */

import type { Page } from "@playwright/test";
import sharp from "sharp";
import type { CapturedElement, TextSegment } from "./types.js";
import { clipRectForScreenshot } from "./clip-rect.js";

// `seg._initialLetterProbe` is added by the capture script; declared loosely
// since it lives only between capture and this post-pass (the renderer never
// sees it). Cast through any to keep TextSegment's public shape clean.
interface InitialLetterProbe {
  rect: { x: number; y: number; width: number; height: number };
  capHeight: number;
  ascent: number;
}

export async function refineInitialLetterPositions(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<void> {
  interface Job {
    seg: TextSegment;
    probe: InitialLetterProbe;
  }
  const jobs: Job[] = [];

  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      if (el.textSegments != null) {
        for (const seg of el.textSegments) {
          const probe = (seg as unknown as { _initialLetterProbe?: InitialLetterProbe })._initialLetterProbe;
          if (probe != null) jobs.push({ seg, probe });
        }
      }
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (jobs.length === 0) return;

  for (const { seg, probe } of jobs) {
    const stripField = (): void => {
      delete (seg as unknown as { _initialLetterProbe?: unknown })._initialLetterProbe;
    };
    // Convert viewport-relative probe rect to page-absolute clip coordinates;
    const clip = clipRectForScreenshot(probe.rect, viewport);
    let buf: Buffer;
    try {
      buf = await page.screenshot({ clip, omitBackground: false, type: "png" });
    } catch {
      stripField();
      continue;
    }
    // Greyscale + raw-pixels for a per-row dark-pixel histogram.
    let raw: { data: Buffer; info: { width: number; height: number } };
    try {
      raw = await sharp(buf).raw().greyscale().toBuffer({ resolveWithObject: true });
    } catch {
      stripField();
      continue;
    }
    // Build a per-row dark-pixel histogram, then find the LARGEST
    // CONTIGUOUS BLOCK of ink-bearing rows — the drop cap is the
    // tallest single ink region in the probe area (~80–200 rows tall),
    // far larger than any section-header text above it (~7–14 rows tall)
    // or body-text lines wrapping around it (~14 rows tall per line,
    // typically isolated). Take the FIRST ROW of that largest block
    // as Chrome's painted cap-top.
    const rowDarkCounts: number[] = [];
    for (let y = 0; y < raw.info.height; y++) {
      let dark = 0;
      const rowStart = y * raw.info.width;
      for (let x = 0; x < raw.info.width; x++) {
        if (raw.data[rowStart + x] < 200) dark++;
      }
      rowDarkCounts.push(dark);
    }
    // Ink-bearing row threshold: 3+ dark pixels catches the thin top
    // strokes of letters like W (top corners are very narrow ink tips)
    // and B (top of the upper bowl), while filtering anti-aliasing
    // fringes around the glyph. A higher threshold (e.g. 6+) misses
    // the cap-top rows of W and shifts the detected ink-top down by
    // 5–10 px (visible as the rendered drop cap painted below Chrome's).
    const isInk = rowDarkCounts.map((d) => d >= 3);
    // Walk to find each contiguous run of inky rows; track the longest.
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let y = 0; y < isInk.length; y++) {
      if (isInk[y]) {
        if (curStart === -1) { curStart = y; curLen = 1; } else curLen++;
      } else {
        if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
        curStart = -1; curLen = 0;
      }
    }
    if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    const inkRowOffset: number | null = bestStart >= 0 ? bestStart : null;
    if (inkRowOffset == null) { stripField(); continue; }
    // Chrome's painted ink-top, in viewport-relative coords:
    const chromeInkTopVp = probe.rect.y + inkRowOffset;
    // Renderer math: rendered baseline = seg.y + segAscent. Rendered
    // ink-top of a cap letter ≈ baseline − capHeight = seg.y + ascent −
    // capHeight. Setting this equal to Chrome's painted ink-top:
    //   seg.y = chromeInkTopVp − ascent + capHeight
    seg.y = chromeInkTopVp - probe.ascent + probe.capHeight;
    stripField();
  }
}
