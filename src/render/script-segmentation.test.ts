/**
 * DM-1894: shaping segmentation, mirroring Blink's two nested levels — bidi run
 * (direction) on the outside, script on the inside.
 *
 * The defect these guard is subtle in the worst way. Shaping a mixed-script run
 * as one unit does NOT lose contextual forms — the glyphs come back correct. It
 * loses ORDER: an RTL stretch inside an otherwise-LTR run is returned in logical
 * order, and laying it out left-to-right paints the word mirrored, with its
 * connecting strokes pointing away from their neighbours. That looks like
 * "isolated letterforms" at normal sizes, which is how it was first misread.
 *
 * It was also LATENT on macOS rather than absent: there Arabic resolves to a
 * different face than Latin, so a font boundary split the run for the wrong
 * reason with the right result. Only Windows, where one face covers both,
 * exposed it. So these tests deliberately assert on text, not on platform.
 */
import { describe, it, expect } from "vitest";
import { bidiLevelsFor, needsSegmentation, segmentForShaping } from "./script-segmentation.js";

/** Segment a string the way the renderer does, for readable assertions. */
function seg(text: string): Array<{ text: string; script: string; rtl: boolean }> {
  const levels = bidiLevelsFor(text);
  return segmentForShaping(text, levels).map((s) => ({
    text: text.slice(s.start, s.end), script: s.script, rtl: s.rtl,
  }));
}

describe("shaping segmentation (DM-1894)", () => {
  it("splits a Latin+Arabic line and marks the Arabic RTL", () => {
    // The exact case that shipped broken.
    expect(seg("Hello مرحبا ")).toEqual([
      { text: "Hello ", script: "Latin", rtl: false },
      { text: "مرحبا", script: "Arabic", rtl: true },
      { text: " ", script: "Common", rtl: false },
    ]);
  });

  it("splits Arabic embedded mid-sentence, restoring the Latin after it", () => {
    expect(seg("greet السلام and ")).toEqual([
      { text: "greet ", script: "Latin", rtl: false },
      { text: "السلام", script: "Arabic", rtl: true },
      { text: " and ", script: "Latin", rtl: false },
    ]);
  });

  it("leaves single-script text as ONE segment", () => {
    // The property that keeps this change from disturbing the corpus: a run with
    // no script or direction boundary must shape exactly as it did before.
    for (const t of ["Hello, world!", "abc", "नमस्ते", "你好", "مرحبا"]) {
      expect(seg(t), t).toHaveLength(1);
    }
  });

  it("does NOT split on punctuation, digits or spaces inside one script", () => {
    // Common/Inherited characters must extend the current segment. Splitting on
    // them would shred ordinary text into a segment per word — and shaping
    // word-by-word breaks cross-space kerning and any ligature spanning them.
    const s = seg("Hello, world! 42 (ok) — fine…");
    expect(s).toHaveLength(1);
    expect(s[0].script).toBe("Latin");
  });

  it("treats combining marks as part of their base's script", () => {
    // Marks are Inherited. A mark that split off from its base would be shaped
    // alone, losing exactly the mark-to-base GPOS positioning that shaping is
    // for. (Decomposed forms, so real combining marks are present rather than
    // precomposed letters.)
    expect(seg("é ñ ü")).toHaveLength(1);
  });

  it("DOES split Latin from Greek — they are different scripts", () => {
    // Guards the opposite error from the case above: "looks like Latin" is not
    // the test, the Script property is. Greek and Cyrillic share letterforms
    // with Latin and are separate scripts to the shaper.
    expect(seg("abc Ω").map((s) => s.script)).toEqual(["Latin", "Greek"]);
  });

  it("splits between two different non-Latin scripts", () => {
    const s = seg("你好 नमस्ते");
    expect(s.map((x) => x.script)).toEqual(["Han", "Devanagari"]);
  });

  it("attaches leading neutrals to the script that follows them", () => {
    // A leading space has no script of its own; making it a segment would shape
    // it separately from the word it belongs to.
    const s = seg("  hello");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ script: "Latin", rtl: false });
  });

  it("still splits leading neutrals off an RTL word — they are a separate bidi run", () => {
    // Deliberately NOT folded into the case above, because the difference is
    // meaningful rather than an inconsistency. Leading spaces before an Arabic
    // word sit at embedding level 0 while the word sits at level 1, so they are
    // genuinely two bidi runs and Blink shapes them separately too. The neutral
    // rule operates WITHIN a bidi run; it does not override run boundaries.
    const s = seg("  مرحبا");
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ text: "  ", rtl: false });
    expect(s[1]).toMatchObject({ text: "مرحبا", script: "Arabic", rtl: true });
  });

  it("reports needsSegmentation only when a boundary exists", () => {
    // The fast path, and it must not be optimistic: a false negative here means
    // a mixed run silently keeps the old broken behavior.
    expect(needsSegmentation("Hello, world!", bidiLevelsFor("Hello, world!"))).toBe(false);
    expect(needsSegmentation("abc 123", bidiLevelsFor("abc 123"))).toBe(false);
    expect(needsSegmentation("Hello مرحبا", bidiLevelsFor("Hello مرحبا"))).toBe(true);
    expect(needsSegmentation("你好 world", bidiLevelsFor("你好 world"))).toBe(true);
  });

  it("computes bidi levels only for text that can have a direction boundary", () => {
    // Pure-LTR text skips bidi resolution entirely; that is the whole reason the
    // common case stays cheap.
    expect(bidiLevelsFor("Hello, world!")).toBeUndefined();
    expect(bidiLevelsFor("")).toBeUndefined();
    expect(bidiLevelsFor("مرحبا")).toBeDefined();
  });

  it("marks a pure-Arabic run RTL even with no Latin to contrast against", () => {
    // Direction must come from the text's own bidi level, not from the presence
    // of a boundary — otherwise a wholly-RTL line would shape LTR.
    const s = seg("مرحبا");
    expect(s[0].rtl).toBe(true);
  });

  it("returns no segments for empty text, and covers every code unit otherwise", () => {
    expect(segmentForShaping("")).toEqual([]);
    // Coverage is load-bearing: a gap would silently drop characters from the
    // paint, and an overlap would double-draw them.
    for (const t of ["Hello مرحبا ", "你好 नमस्ते abc", "a", "مرحبا 123 ok"]) {
      const segs = segmentForShaping(t, bidiLevelsFor(t));
      expect(segs[0].start, t).toBe(0);
      expect(segs[segs.length - 1].end, t).toBe(t.length);
      for (let i = 1; i < segs.length; i++) expect(segs[i].start, t).toBe(segs[i - 1].end);
    }
  });

  it("scores a run against RUN-RELATIVE levels, so the caller must slice them", () => {
    // The contract both `needsSegmentation` and `segmentForShaping` are written
    // to: `levels[i]` is the level of `text[i]`. The renderer segments a FONT
    // RUN, which is a slice of the line starting at `run.startIdx`, so it has to
    // hand over `levels.subarray(startIdx, endIdx)` and not the whole-line
    // array. Passing the unsliced array reads the level of whatever character
    // sits that far from the start of the LINE.
    //
    // This is pinned rather than left implicit because the failure is silent and
    // was shipped: a run scored left-to-right reaches the shaper as an explicit
    // `direction: "ltr"`, the macOS CoreText helper's shape query takes no
    // direction at all and infers RTL from the content, and the wrong score
    // therefore painted correctly — until a script was routed to HarfBuzz, which
    // obeys the direction it is given and reverses the buffer before shaping.
    const line = "Hello שלום world";
    const levels = bidiLevelsFor(line)!;
    const startIdx = line.indexOf("שלום");
    const endIdx = startIdx + "שלום".length;
    const runText = line.slice(startIdx, endIdx);

    // Sliced: the run's own embedding level, which is what it must shape with.
    expect(segmentForShaping(runText, levels.subarray(startIdx, endIdx))[0].rtl).toBe(true);
    // Unsliced: reads levels 0..3, i.e. `Hell` — strong LTR, and wrong.
    expect(segmentForShaping(runText, levels)[0].rtl).toBe(false);
  });

  it("handles astral characters without splitting a surrogate pair", () => {
    // Indexing is in code UNITS; advancing by one unit through an astral
    // character would put a boundary inside a surrogate pair and emit garbage.
    const t = "a𝄞b"; // U+1D11E, Common
    const segs = segmentForShaping(t, bidiLevelsFor(t));
    for (const s of segs) {
      expect(s.start % 1).toBe(0);
      // A boundary must never land between the two halves of the pair (idx 1,2).
      expect(s.start === 2 || s.end === 2).toBe(false);
    }
  });
});
