import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapturedElement } from "../capture/types.js";

// Capture every renderTextAsPath call so we can assert the baseline / ascent
// arguments the vertical renderer passes — without depending on any real
// system font being installed (so the assertions hold on Linux CI too, where
// the macOS FONT_PATHS glyph path isn't available).
const calls: unknown[][] = [];
vi.mock("./text-to-path.js", () => ({
  measureEmphasisMarkMetrics: () => ({
    fontSize: 9, ascent: 7, descent: 2, inkCenterX: 2, inkCenterY: -2,
  }),
  renderTextAsPath: (...args: unknown[]) => {
    calls.push(args);
    // Return non-null so the vertical renderer emits its wrapper markup.
    return `<g data-stub="${String(args[0])}"></g>`;
  },
}));

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is fine).
const {
  renderVerticalSegments,
  renderVerticalEmphasisMarks,
  lineRelativeToPhysicalTransform,
} = await import("./vertical-text.js");

// renderTextAsPath args under test: (text, x, y, options).
const ARG_TEXT = 0;
const ARG_X = 1;
const ARG_Y = 2;
const ARG_OPTIONS = 3;
type StubOptions = { xOffsets?: number[]; ascentOverride?: number; features?: string[] };
const optionsOf = (c: unknown[]): StubOptions => c[ARG_OPTIONS] as StubOptions;

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

  it("paints the rotated glyph at Blink's line-relative origin and ascent", () => {
    renderVerticalSegments(makeElement(), "rgb(0,0,0)");
    // First call is the rotated "E".
    const rotated = calls.find((c) => c[0] === "E");
    expect(rotated).toBeDefined();
    expect(rotated![ARG_X]).toBe(100);
    expect(rotated![ARG_Y]).toBe(50);
    expect(optionsOf(rotated!).ascentOverride).toBe(14);
  });

  it("uses Blink's clockwise line-relative transform for vertical-rl", () => {
    const markup = renderVerticalSegments(makeElement(), "rgb(0,0,0)");
    // e=x+y+physicalWidth=171; f=y-x=-50.
    expect(markup).toContain('transform="matrix(0 1 -1 0 171 -50)"');
  });

  it("keeps the upright glyph baseline at charY + 0.85em (ascent not added again)", () => {
    renderVerticalSegments(makeElement(), "rgb(0,0,0)");
    const upright = calls.find((c) => c[0] === "と");
    expect(upright).toBeDefined();
    // Upright baseline = charY (62) + 0.85 * 18 = 77.3. The ascentOverride
    // must be 0 so renderTextAsPath doesn't add the font ascent a second
    // time (which dropped every upright glyph ~0.85em below its cell).
    expect(upright![ARG_Y]).toBeCloseTo(62 + 0.85 * 18, 5);
    expect(optionsOf(upright!).ascentOverride).toBe(0);
  });
});

describe("lineRelativeToPhysicalTransform", () => {
  it("maps vertical and sideways-rl boxes clockwise", () => {
    expect(lineRelativeToPhysicalTransform(100, 50, 21, 12, "vertical-rl"))
      .toBe("matrix(0 1 -1 0 171 -50)");
    expect(lineRelativeToPhysicalTransform(100, 50, 21, 12, "vertical-lr"))
      .toBe("matrix(0 1 -1 0 171 -50)");
    expect(lineRelativeToPhysicalTransform(100, 50, 21, 12, "sideways-rl"))
      .toBe("matrix(0 1 -1 0 171 -50)");
  });

  it("maps sideways-lr boxes counter-clockwise", () => {
    expect(lineRelativeToPhysicalTransform(100, 50, 21, 12, "sideways-lr"))
      .toBe("matrix(0 -1 1 0 50 162)");
  });

  it("uses physical width as block size and physical height as inline size", () => {
    // These are the dimension swaps in Blink CreateFromLineBox(false).
    expect(lineRelativeToPhysicalTransform(4, 7, 30, 80, "vertical-rl"))
      .toBe("matrix(0 1 -1 0 41 3)");
    expect(lineRelativeToPhysicalTransform(4, 7, 30, 80, "sideways-lr"))
      .toBe("matrix(0 -1 1 0 -3 91)");
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
    expect(optionsOf(c).ascentOverride).toBe(0);
    // Each glyph placed at its captured per-char x (Chrome's painted layout).
    expect(optionsOf(c).xOffsets).toEqual([0, 9.89]);
  });
});

// DM-1122: CJK punctuation (。 、 brackets …) takes a vertical-form glyph under
// the OpenType `vert` feature in vertical writing modes — its ink moves to the
// cell's top-right corner. The upright path must (a) pass `["vert"]` so fontkit
// substitutes the vertical form and (b) anchor the FULL em box to the column
// rather than ink-centering by the captured horizontal natural width (which
// would shove the corner-set glyph toward the column's middle). Ideographs/kana
// carry no `vert` substitution, so they keep ink-centering and no feature.
function makeVerticalPunctElement(): CapturedElement {
  return {
    tag: "p",
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
        text: "例。",
        x: 100,
        y: 50,
        width: 21,
        height: 36,
        verticalWritingMode: "vertical-rl",
        verticalOrientations: ["upright", "upright"],
        yOffsets: [50, 68],
        verticalAdvances: [18, 18],
        // Ideograph fills the cell (~1em); 。 ink is narrow (~0.5em) — the
        // difference is what surfaces the centering bug if we ink-center it.
        verticalNaturalWidths: [18, 9],
      },
    ],
  } as unknown as CapturedElement;
}

describe("renderVerticalSegments — vertical-form punctuation (DM-1122)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("passes the `vert` feature for CJK punctuation and none for ideographs", () => {
    renderVerticalSegments(makeVerticalPunctElement(), "rgb(0,0,0)");
    const kanji = calls.find((c) => c[0] === "例");
    const period = calls.find((c) => c[0] === "。");
    expect(kanji).toBeDefined();
    expect(period).toBeDefined();
    // 例 has no vertical form — default shaping, no features.
    expect(optionsOf(kanji!).features).toBeUndefined();
    // 。 substitutes its vertical-form glyph via `vert`.
    expect(optionsOf(period!).features).toEqual(["vert"]);
  });

  it("anchors the punctuation em box to the column instead of ink-centering", () => {
    renderVerticalSegments(makeVerticalPunctElement(), "rgb(0,0,0)");
    const kanji = calls.find((c) => c[0] === "例");
    const period = calls.find((c) => c[0] === "。");
    // Ideograph keeps ink-centering by its natural width (18): xLeft = 100 +
    // (21 - 18) / 2 = 101.5.
    expect(kanji![ARG_X]).toBeCloseTo(100 + (21 - 18) / 2, 5);
    // Punctuation anchors the full em box (fontSize 18, NOT its 9px ink width):
    // xLeft = 100 + (21 - 18) / 2 = 101.5. If it ink-centered by 9 it would land
    // at 106 and the corner-set vertical glyph would drift toward the middle.
    expect(period![ARG_X]).toBeCloseTo(100 + (21 - 18) / 2, 5);
  });
});

describe("renderVerticalEmphasisMarks — vertical text-emphasis (DM-1054)", () => {
  beforeEach(() => { calls.length = 0; });

  function makeEmphasisEl(style: string, position?: string): CapturedElement {
    return {
      tag: "em",
      styles: {
        fontSize: "18px", fontFamily: "sans-serif", fontWeight: "400", color: "rgb(0,0,0)",
        textEmphasisStyle: style, ...(position != null ? { textEmphasisPosition: position } : {}),
      },
      fontAscent: 14,
      fontDescent: 4,
      textSegments: [{
        text: "右側", x: 100, y: 50, width: 18, height: 36,
        verticalWritingMode: "vertical-rl", yOffsets: [50, 68], verticalAdvances: [18, 18],
      }],
    } as unknown as CapturedElement;
  }

  it("emits one mark per char in a column to the RIGHT for the default over-right", () => {
    const out = renderVerticalEmphasisMarks(makeEmphasisEl("open sesame"), "rgb(0,0,0)");
    expect([...out.matchAll(/<text /g)]).toHaveLength(2); // one per CJK grapheme
    expect(out).toContain(">﹆</text>");
    // over offset = floor(-14 - 2) = -16; clockwise rotation maps the
    // line-relative over side to physical right.
    expect(out).toContain('y="48"');
    expect(out).toContain('transform="matrix(0 1 -1 0 168 -50)"');
  });

  it("places marks on the LEFT for over-left", () => {
    const out = renderVerticalEmphasisMarks(makeEmphasisEl("filled dot", "over left"), "rgb(0,0,0)");
    // Explicit left resolves to line-under for clockwise vertical modes:
    // ceil((18 - 14) + 7) = +11.
    expect(out).toContain('y="75"');
    expect(out).toContain('transform="matrix(0 1 -1 0 168 -50)"');
  });

  it("emits one mark for a combining grapheme rather than UTF-16 slots", () => {
    const el = makeEmphasisEl("filled dot");
    el.textSegments![0].text = "A\u0301";
    el.textSegments![0].yOffsets = [50, 50];
    el.textSegments![0].verticalAdvances = [18, 18];
    expect([...renderVerticalEmphasisMarks(el, "rgb(0,0,0)").matchAll(/<text /g)])
      .toHaveLength(1);
  });

  it("returns empty markup when the element has no text-emphasis", () => {
    expect(renderVerticalEmphasisMarks(makeEmphasisEl("none"), "rgb(0,0,0)")).toBe("");
  });
});

// DM-1159: the `text-underline-position: auto` default side for vertical text.
// Verified against Chrome's painted output: the underline lands on the LEFT of
// the column for vertical-rl / vertical-lr / sideways-rl, and on the RIGHT only
// for sideways-lr. (The prior code defaulted vertical-rl to the right, painting
// the underline on the wrong side.)
describe("renderVerticalSegments — text-underline-position auto side (DM-1159)", () => {
  function makeUnderlineEl(wm: string, tup: string): CapturedElement {
    return {
      tag: "div",
      styles: {
        fontSize: "20px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
        textDecorationLine: "underline", textUnderlinePosition: tup,
      },
      fontAscent: 16,
      textSegments: [{
        text: "あ", x: 100, y: 50, width: 20, height: 40,
        verticalWritingMode: wm, verticalOrientations: ["upright"],
        yOffsets: [50], verticalAdvances: [20], verticalNaturalWidths: [20],
      }],
    } as unknown as CapturedElement;
  }
  // The decoration `<line>` is vertical (x1===x2); pull its x. seg.x=100,
  // width=20 → left side x < 100, right side x > 120.
  const lineX = (markup: string): number => {
    const m = markup.match(/<line x1="([\d.]+)"/);
    return m ? parseFloat(m[1]) : NaN;
  };

  it("auto → LEFT side for vertical-rl", () => {
    expect(lineX(renderVerticalSegments(makeUnderlineEl("vertical-rl", "auto"), "rgb(0,0,0)"))).toBeLessThan(100);
  });
  it("auto → LEFT side for vertical-lr and sideways-rl", () => {
    expect(lineX(renderVerticalSegments(makeUnderlineEl("vertical-lr", "auto"), "rgb(0,0,0)"))).toBeLessThan(100);
    expect(lineX(renderVerticalSegments(makeUnderlineEl("sideways-rl", "auto"), "rgb(0,0,0)"))).toBeLessThan(100);
  });
  it("auto → RIGHT side only for sideways-lr", () => {
    expect(lineX(renderVerticalSegments(makeUnderlineEl("sideways-lr", "auto"), "rgb(0,0,0)"))).toBeGreaterThan(120);
  });
  it("explicit left / right keywords still pick their literal side (vertical-rl)", () => {
    expect(lineX(renderVerticalSegments(makeUnderlineEl("vertical-rl", "left"), "rgb(0,0,0)"))).toBeLessThan(100);
    expect(lineX(renderVerticalSegments(makeUnderlineEl("vertical-rl", "right"), "rgb(0,0,0)"))).toBeGreaterThan(120);
  });
});
