// `font-stretch` reaching the declared-family style matcher.
//
// The property was captured and carried through the stack corpus for a while,
// but nothing downstream read it: `getFontInstance` had no width parameter, so
// a `font-stretch: 50%` run scored the family's candidates as though the author
// had asked for normal width and opened the normal cut. Blink turns the width
// into a symbolic trait — condensed below 100%, expanded above
// (`ComputeDesiredTraits`, `platform/fonts/mac/font_matcher_mac.mm:185-202`;
// `kNormalWidthValue` = 100, `font_selection_types.h:233`) — and `BetterChoiceCT`
// compares condensed FIRST of its three masks (`:234-235`), ahead of the
// directional weight search. Chromium rev 7d859f27.
//
// The face expectations are Chrome-on-macOS's own, read over CDP with
// `CSS.getPlatformFontsForNode` (by `postScriptName`, taking the entry with the
// largest `glyphCount` — the returned array is not ordered by coverage).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { getFontInstance, resolveFont, stretchPercent } from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";

const available = process.platform === "darwin"
  && existsSync("/System/Library/Fonts/Supplemental/Papyrus.ttc")
  && isGlyphHelperAvailable();
const describeMac = available ? describe : describe.skip;

const psName = (key: string, weight: number, stretch: number): string | undefined =>
  (getFontInstance(key, weight, 22, 0, undefined, stretch) as unknown as { postscriptName?: string } | null)
    ?.postscriptName;

describe("stretchPercent", () => {
  it("reads the percentage Chrome computes the property to", () => {
    // Chrome serializes every keyword as a percentage, so these are the forms
    // that actually arrive from capture.
    expect(stretchPercent("100%")).toBe(100);
    expect(stretchPercent("75%")).toBe(75);
    expect(stretchPercent("62.5%")).toBe(62.5);
    expect(stretchPercent("200%")).toBe(200);
  });

  it("reads anything else as normal width rather than as zero", () => {
    // A width of 0 would make every family look condensed, so the failure
    // direction matters more than the parse itself.
    expect(stretchPercent(undefined)).toBe(100);
    expect(stretchPercent("")).toBe(100);
    expect(stretchPercent("normal")).toBe(100);
    expect(stretchPercent("condensed")).toBe(100);
    expect(stretchPercent("0%")).toBe(100);
    expect(stretchPercent("-50%")).toBe(100);
  });
});

describeMac("font-stretch selects the family's condensed cut", () => {
  it("opens Papyrus Condensed below 100% and plain Papyrus at or above it", () => {
    // The rung that discriminates is 87.5%: it is condensed-but-barely, and a
    // fix that only handled the named keywords would miss it. 112.5% and 200%
    // pin the other direction — Papyrus ships no expanded cut, so asking for
    // one must not move the answer.
    expect(psName("papyrus", 400, 50)).toBe("Papyrus-Condensed");
    expect(psName("papyrus", 400, 62.5)).toBe("Papyrus-Condensed");
    expect(psName("papyrus", 400, 75)).toBe("Papyrus-Condensed");
    expect(psName("papyrus", 400, 87.5)).toBe("Papyrus-Condensed");
    expect(psName("papyrus", 400, 100)).toBe("Papyrus");
    expect(psName("papyrus", 400, 112.5)).toBe("Papyrus");
    expect(psName("papyrus", 400, 200)).toBe("Papyrus");
  });

  it("lets width outrank weight, which is the ordering the comparator encodes", () => {
    // Helvetica Neue's condensed cuts are Bold and Black — there is no condensed
    // regular. So a weight-400 condensed request resolves to CondensedBold: the
    // condensed mask decides first, and the weight search then picks among the
    // two faces that carry it. A test that only asserted the normal-width column
    // could not tell this apart from "width is ignored".
    expect(psName("helvetica-neue", 400, 75)).toBe("HelveticaNeue-CondensedBold");
    expect(psName("helvetica-neue", 700, 75)).toBe("HelveticaNeue-CondensedBold");
    expect(psName("helvetica-neue", 900, 75)).toBe("HelveticaNeue-CondensedBlack");
    expect(psName("helvetica-neue", 400, 50)).toBe("HelveticaNeue-CondensedBold");
    expect(psName("helvetica-neue", 900, 50)).toBe("HelveticaNeue-CondensedBlack");
    // …and the normal-width column is untouched by any of it.
    expect(psName("helvetica-neue", 400, 100)).toBe("HelveticaNeue");
    expect(psName("helvetica-neue", 900, 100)).toBe("HelveticaNeue-Bold");
    expect(psName("helvetica-neue", 400, 200)).toBe("HelveticaNeue");
  });

  it("keeps the widths distinct when they interleave through the cache", () => {
    // The answer is a function of (key, weight, italic, WIDTH). A width-blind
    // memo would serve whichever width asked first to every later caller — the
    // same defect this area already paid for on the weight axis.
    const seq: Array<[number, number]> = [
      [400, 100], [400, 75], [400, 100], [900, 75], [400, 75], [900, 100], [400, 100],
    ];
    const want = [
      "HelveticaNeue", "HelveticaNeue-CondensedBold", "HelveticaNeue",
      "HelveticaNeue-CondensedBlack", "HelveticaNeue-CondensedBold",
      "HelveticaNeue-Bold", "HelveticaNeue",
    ];
    expect(seq.map(([w, s]) => psName("helvetica-neue", w, s))).toEqual(want);
  });

  it("survives the public entry point the renderer actually calls", () => {
    // `resolveFont` is what the text path uses; a parameter that stops at
    // `getFontInstance` would leave the shipped renderer exactly as it was.
    const ps = (family: string, stretch: number): string | undefined =>
      (resolveFont(family, 400, 22, 0, undefined, stretch) as unknown as { postscriptName?: string } | null)
        ?.postscriptName;
    expect(ps("fantasy", 75)).toBe("Papyrus-Condensed");
    expect(ps("fantasy", 100)).toBe("Papyrus");
  });

  it("defaults to normal width when no stretch is supplied", () => {
    // Every existing caller omits the argument, so the default IS the
    // compatibility contract.
    expect((getFontInstance("papyrus", 400, 22) as unknown as { postscriptName?: string } | null)?.postscriptName)
      .toBe("Papyrus");
  });
});
