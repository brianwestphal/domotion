import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapturedElement } from "../capture/types.js";

// Capture every renderTextAsPath call so we can assert the baseline / ascent
// arguments the vertical renderer passes — without depending on any real
// system font being installed (so the assertions hold on Linux CI too, where
// the macOS FONT_PATHS glyph path isn't available).
const calls: unknown[][] = [];
vi.mock("./text-to-path.js", () => ({
  renderTextAsPath: (...args: unknown[]) => {
    calls.push(args);
    // Return non-null so the vertical renderer emits its wrapper markup.
    return `<g data-stub="${String(args[0])}"></g>`;
  },
}));

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is fine).
const { renderVerticalSegments, renderVerticalEmphasisMarks } = await import("./vertical-text.js");

// renderTextAsPath positional arg indices under test.
const ARG_TEXT = 0;
const ARG_X = 1;
const ARG_Y = 2;
const ARG_XOFFSETS = 9;
const ARG_ASCENT_OVERRIDE = 11;

function makeElement(): CapturedElement {
  // One rotated Latin char ("E") followed by one upright kana ("と") in a
  // single vertical-rl column. Mirrors the fixture's mixed-orientation column.
  return {
    tag: "div",
    styles: {
      fontSize: "18px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      textDecorationLine: "none",
    },
    fontAscent: 14,
    textSegments: [
      {
        text: "Eと",
        x: 100,
        y: 50,
        width: 21,
        height: 30,
        verticalWritingMode: "vertical-rl",
        verticalOrientations: ["rotated", "upright"],
        yOffsets: [50, 62],
        verticalAdvances: [12, 18],
        verticalNaturalWidths: [12, 18],
      },
    ],
  } as unknown as CapturedElement;
}

describe("renderVerticalSegments — baseline / ascent handling (DM-1024)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("pins the rotated glyph baseline to fontSize (ascent not double-counted)", () => {
    renderVerticalSegments(makeElement(), "rgb(0,0,0)");
    // First call is the rotated "E".
    const rotated = calls.find((c) => c[0] === "E");
    expect(rotated).toBeDefined();
    // `renderTextAsPath` adds the ascent to its `y` arg to derive the
    // baseline, so the rotated path must pass y=0 + an explicit
    // ascentOverride=fontSize → baseline lands at exactly fontSize (18),
    // which is what the rotation math assumes. Before DM-1024 it passed
    // y=fontSize with no override, so the font ascent was added on top and
    // the post-rotation glyph drifted ~14 px horizontally.
    expect(rotated![ARG_Y]).toBe(0);
    expect(rotated![ARG_ASCENT_OVERRIDE]).toBe(18);
  });

  it("keeps the upright glyph baseline at charY + 0.85em (ascent not added again)", () => {
    renderVerticalSegments(makeElement(), "rgb(0,0,0)");
    const upright = calls.find((c) => c[0] === "と");
    expect(upright).toBeDefined();
    // Upright baseline = charY (62) + 0.85 * 18 = 77.3. The ascentOverride
    // must be 0 so renderTextAsPath doesn't add the font ascent a second
    // time (which dropped every upright glyph ~0.85em below its cell).
    expect(upright![ARG_Y]).toBeCloseTo(62 + 0.85 * 18, 5);
    expect(upright![ARG_ASCENT_OVERRIDE]).toBe(0);
  });
});

// DM-1032: tate-chu-yoko. A `verticalCombineUpright` segment is emitted as ONE
// renderTextAsPath call for the whole combined run (e.g. "31"), anchored at the
// captured cell left with each glyph at its captured per-char xOffset — NOT the
// per-char upright/rotated column walk. Font-independent (asserts the args the
// renderer passes), so it holds on Linux CI where no macOS glyph path exists.
function makeCombineElement(): CapturedElement {
  return {
    tag: "span",
    styles: {
      fontSize: "18px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      textDecorationLine: "none",
    },
    fontAscent: 14,
    textSegments: [
      {
        text: "31",
        x: 91.08,
        y: 50,
        width: 19.8,
        height: 18,
        verticalWritingMode: "vertical-rl",
        verticalCombineUpright: true,
        verticalCombineXOffsets: [0, 9.89],
      },
    ],
  } as unknown as CapturedElement;
}

describe("renderVerticalSegments — tate-chu-yoko combine (DM-1032)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("emits ONE upright run for the whole combined cell at the captured positions", () => {
    const markup = renderVerticalSegments(makeCombineElement(), "rgb(0,0,0)");
    expect(markup).not.toBe("");
    // Exactly one renderTextAsPath call (the combined run) — not one per digit.
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c[ARG_TEXT]).toBe("31");
    // Anchored at the captured cell left, NOT centered or column-split.
    expect(c[ARG_X]).toBeCloseTo(91.08, 5);
    // Upright baseline = cell top (50) + 0.85em, with ascentOverride=0 so the
    // font ascent isn't added a second time (same invariant as the per-char
    // upright path).
    expect(c[ARG_Y]).toBeCloseTo(50 + 0.85 * 18, 5);
    expect(c[ARG_ASCENT_OVERRIDE]).toBe(0);
    // Each glyph placed at its captured per-char x (Chrome's painted layout).
    expect(c[ARG_XOFFSETS]).toEqual([0, 9.89]);
  });
});

describe("renderVerticalEmphasisMarks — vertical text-emphasis (DM-1054)", () => {
  function makeEmphasisEl(style: string, position?: string): CapturedElement {
    return {
      tag: "em",
      styles: {
        fontSize: "18px", fontFamily: "sans-serif", fontWeight: "400", color: "rgb(0,0,0)",
        textEmphasisStyle: style, ...(position != null ? { textEmphasisPosition: position } : {}),
      },
      textSegments: [{
        text: "右側", x: 100, y: 50, width: 18, height: 36,
        verticalWritingMode: "vertical-rl", yOffsets: [50, 68], verticalAdvances: [18, 18],
      }],
    } as unknown as CapturedElement;
  }

  it("emits one mark per char in a column to the RIGHT for the default over-right", () => {
    const out = renderVerticalEmphasisMarks(makeEmphasisEl("open sesame"), "rgb(0,0,0)");
    const marks = [...out.matchAll(/<text[^>]*>([^<]*)<\/text>/g)];
    expect(marks).toHaveLength(2); // one per CJK char
    expect(marks[0][1]).toBe("﹆"); // open-sesame glyph ﹆
    const x0 = Number(/x="([\d.]+)"/.exec(marks[0][0])![1]);
    expect(x0).toBeGreaterThan(118); // right of the column (x 100 + width 18)
  });

  it("places marks on the LEFT for over-left", () => {
    const out = renderVerticalEmphasisMarks(makeEmphasisEl("filled dot", "over left"), "rgb(0,0,0)");
    const x0 = Number(/x="([\d.]+)"/.exec(out)![1]);
    expect(x0).toBeLessThan(100); // left of the column
  });

  it("returns empty markup when the element has no text-emphasis", () => {
    expect(renderVerticalEmphasisMarks(makeEmphasisEl("none"), "rgb(0,0,0)")).toBe("");
  });
});
