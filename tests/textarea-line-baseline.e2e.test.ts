import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { PARITY_LAUNCH_OPTS } from "./flipbook-parity.js";

// A `<textarea>`'s per-line `textSegments` come from a soft-wrap probe that
// derives each line's y from a CHARACTER range rect. That rect's top is the
// font-box top — Chrome has ALREADY applied half-leading to it. `textTop`,
// meanwhile, folds half-leading in itself for the single-line `<input>` path.
// Adding the two double-counted the leading, so every line of a textarea
// painted ~half-leading too low: a 14px/21px monospace textarea sat a uniform
// ~3px down and clipped its last visible line.
//
// The oracle here is deliberately NOT our own leading arithmetic (that would
// re-assert the bug). It is a reference <div> laid out by Chrome with the same
// font, line-height and `white-space: pre-wrap`: the offset from its border-box
// top to its first character's rect IS the correct first-line offset, measured
// rather than computed.

const VIEW = { width: 800, height: 600 };

// 21px line-height over a 14px font ⇒ several px of positive half-leading, so a
// double-count is unmistakable rather than sub-pixel.
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; font: 14px/21px ui-monospace, "SF Mono", Menlo, monospace; }
  #ta, #ref {
    position: absolute; left: 40px; width: 400px;
    font: 14px/21px ui-monospace, "SF Mono", Menlo, monospace;
    padding: 8px; border: 1px solid #888; box-sizing: border-box;
    white-space: pre-wrap; margin: 0;
  }
  /* Deliberately a FRACTIONAL top: Chrome rounds the text origin to a whole
     device pixel vertically, so the captured line y must be an integer. */
  #ta  { top: 40.4375px; height: 120px; }
  /* The reference: same box, same type, laid out by Chrome as ordinary text. */
  #ref { top: 300px; height: auto; }
</style></head><body>
  <textarea id="ta">alpha
bravo
charlie</textarea>
  <div id="ref">alpha
bravo
charlie</div>
</body></html>`;

async function setup() {
  try {
    const browser = await launchChromium(PARITY_LAUNCH_OPTS);
    return { browser };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("textarea per-line segment baselines", () => {
  it("places each line at Chrome's own line offset — half-leading counted once", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: VIEW });
    const page = await ctx.newPage();
    await page.setContent(PAGE_HTML);
    await page.evaluate(() => document.fonts.ready);

    // Chrome's answer, measured: the reference div's first-character rect top
    // relative to its CONTENT-box top, plus the used line pitch.
    const oracle = await page.evaluate(() => {
      const ref = document.getElementById("ref")!;
      const box = ref.getBoundingClientRect();
      const cs = getComputedStyle(ref);
      const contentTop = box.top
        + (parseFloat(cs.borderTopWidth) || 0)
        + (parseFloat(cs.paddingTop) || 0);
      const node = ref.firstChild!;
      const first = document.createRange();
      first.setStart(node, 0);
      first.setEnd(node, 1);
      // "bravo" starts after "alpha\n" — index 6.
      const second = document.createRange();
      second.setStart(node, 6);
      second.setEnd(node, 7);
      return {
        firstLineOffset: first.getBoundingClientRect().top - contentTop,
        linePitch: second.getBoundingClientRect().top - first.getBoundingClientRect().top,
      };
    });

    // Sanity: the fixture really does have positive half-leading to double.
    expect(oracle.linePitch).toBeCloseTo(21, 0);
    expect(
      oracle.firstLineOffset,
      "fixture must have a non-trivial half-leading or the test proves nothing",
    ).toBeGreaterThan(1);

    const tree = await captureElementTree(page, "body", { x: 0, y: 0, ...VIEW });
    const found: CapturedElement[] = [];
    const walk = (n: CapturedElement): void => {
      if (n.tag === "textarea") found.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    for (const t of tree) walk(t);

    const ta = found[0];
    expect(ta, "the textarea must be captured").toBeDefined();
    const segs = ta.textSegments ?? [];
    expect(segs.map((s) => s.text)).toEqual(["alpha", "bravo", "charlie"]);

    // The textarea's own content-box top, from the captured geometry.
    const contentTop = ta.y
      + (parseFloat(ta.styles.borderTopWidth ?? "0") || 0)
      + (parseFloat(ta.styles.paddingTop ?? "0") || 0);

    // Line 0 must sit exactly one half-leading below the content top — the
    // offset Chrome itself produced for the reference — snapped to the whole
    // pixel Chrome rasterizes at. Before the fix this was off by a FURTHER
    // half-leading (~2.3px here), far outside this tolerance.
    expect(segs[0].y).toBeCloseTo(Math.round(contentTop + oracle.firstLineOffset), 1);

    // Chrome positions glyphs subpixel horizontally but rounds the vertical
    // origin, so a textarea on a fractional y must still yield integer line
    // tops. `#ta` is deliberately at 40.4375px to make this bite.
    expect(contentTop, "fixture must sit on a fractional y or this proves nothing")
      .not.toBe(Math.round(contentTop));
    for (const s of segs) {
      expect(s.y, `line "${s.text}" must land on a whole pixel`).toBe(Math.round(s.y));
    }

    // ...and the leading must not compound down the block: every subsequent
    // line is exactly one pitch below its predecessor.
    for (let i = 1; i < segs.length; i++) {
      expect(
        segs[i].y - segs[i - 1].y,
        `line ${i} must be exactly one line-height below line ${i - 1}`,
      ).toBeCloseTo(oracle.linePitch, 1);
    }

    await ctx.close();
  }, 120_000);
});
