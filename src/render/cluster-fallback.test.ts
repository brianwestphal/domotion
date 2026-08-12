// Shaped-cluster fallback (docs/113): unit tests for the default run splitter.
//
// Every expectation in the "Chrome-verified" block below is ground truth
// measured via CDP `CSS.getPlatformFontsForNode` against Playwright Chromium on
// macOS (the probe corpus in docs/113 §2), and every one of them DIFFERS from
// what the legacy per-codepoint cmap walk produces — the legacy answers are
// recorded in each test so a regression to per-codepoint granularity (or a
// silent decline into the legacy path) fails these tests rather than passing
// them. That is the discrimination requirement: a test that both mechanisms
// pass grades nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import {
  chooseHintIndex, collectHintChars, clusterFallbackEnabled,
  splitTextIntoFontRunsShaped, _clusterFallbackCounters, _isBlinkVariationSequenceForTest,
} from "./cluster-fallback.js";
import {
  resolveFont, resolveFontKey, resolveFontKeyChain, registerWebfont, clearWebfonts,
} from "./font-resolution.js";
import { hbSubsetRetainGids } from "./hb-subset.js";
import fontkit from "fontkit";

const MACOS_FONTS = process.platform === "darwin" && fs.existsSync("/System/Library/Fonts/Helvetica.ttc");

function split(fam: string, text: string): Array<{ text: string; key: string }> | null {
  const key = resolveFontKey(fam);
  const font = resolveFont(fam, 400, 32, 0);
  expect(font).not.toBeNull();
  const chain = resolveFontKeyChain(fam);
  const runs = splitTextIntoFontRunsShaped(text, font!, key, 400, 32, 0, undefined, undefined, chain);
  return runs == null ? null : runs.map((r) => ({ text: r.text, key: r.fontKey }));
}

describe("chooseHintIndex (FontFallbackIterator::ChooseHintIndex port)", () => {
  it("picks the first index >= 1 with a likely script, else 0", () => {
    // Single hint → 0.
    expect(chooseHintIndex([0x0E48])).toBe(0);
    // Leading Common punctuation, then Thai: the Thai char is the hint —
    // crbug.com/618178's Myanmar-run case, the reason the rule exists.
    expect(chooseHintIndex([0x0028, 0x1000])).toBe(1);
    // All Common/Inherited → 0.
    expect(chooseHintIndex([0x0028, 0x0301, 0x0020])).toBe(0);
    // The loop starts at index 1, so a likely-script char there wins even when
    // index 0 has one too (U+094D is Script=Devanagari, not Inherited).
    expect(chooseHintIndex([0x0915, 0x094D])).toBe(1);
    expect(chooseHintIndex([0x094D, 0x0915])).toBe(1);
    // A truly Inherited mark at index 1 (combining acute) falls back to 0.
    expect(chooseHintIndex([0x0915, 0x0301])).toBe(0);
  });
});

describe("collectHintChars (CollectFallbackHintChars port)", () => {
  it("stops at the first likely-script codepoint by default", () => {
    // "(ก x" queued whole: pushes '(' (Common), then ก (Thai, likely) → stop.
    const hints = collectHintChars("(ก x", [{ start: 0, end: 4 }]);
    expect(hints).toEqual([0x28, 0x0E01]);
  });
  it("collects the full list when a segmented face needs it", () => {
    const hints = collectHintChars("(ก", [{ start: 0, end: 2 }], true);
    expect(hints).toEqual([0x28, 0x0E01]);
  });
  it("walks queued ranges in order and handles astral codepoints", () => {
    const text = "a\u{1D400}b";
    const hints = collectHintChars(text, [{ start: 0, end: text.length }], true);
    expect(hints).toEqual([0x61, 0x1D400, 0x62]);
  });
});

describe("Character::IsVariationSequence transcription", () => {
  it("accepts emoji, standardized, and undecomposed ideographic sequences", () => {
    expect(_isBlinkVariationSequenceForTest(0x2764, 0xfe0f)).toBe(true); // emoji VS16
    expect(_isBlinkVariationSequenceForTest(0x0030, 0xfe00)).toBe(true); // standardized short zero
    expect(_isBlinkVariationSequenceForTest(0x845B, 0xe0100)).toBe(true); // ideographic IVS
  });

  it("rejects selectors that Blink leaves as ordinary default-ignorables", () => {
    expect(_isBlinkVariationSequenceForTest(0x0061, 0xfe0f)).toBe(false); // non-Emoji + VS16
    expect(_isBlinkVariationSequenceForTest(0x0061, 0xfe00)).toBe(false); // pair absent from standardized table
    expect(_isBlinkVariationSequenceForTest(0xfa10, 0xe0100)).toBe(false); // compatibility-decomposable ideograph
  });
});

describe("flag gate", () => {
  const saved = process.env.DOMOTION_CLUSTER_FALLBACK;
  afterAll(() => {
    if (saved == null) delete process.env.DOMOTION_CLUSTER_FALLBACK;
    else process.env.DOMOTION_CLUSTER_FALLBACK = saved;
  });
  it("is ON by default and OFF only at =0", () => {
    delete process.env.DOMOTION_CLUSTER_FALLBACK;
    expect(clusterFallbackEnabled()).toBe(true);
    process.env.DOMOTION_CLUSTER_FALLBACK = "0";
    expect(clusterFallbackEnabled()).toBe(false);
    process.env.DOMOTION_CLUSTER_FALLBACK = "1";
    expect(clusterFallbackEnabled()).toBe(true);
  });
});

(MACOS_FONTS ? describe : describe.skip)("shape-then-requeue vs Chrome ground truth (docs/113 §2)", () => {
  it("requeues valid variation sequences but ignores invalid base+selector pairs", () => {
    const before = _clusterFallbackCounters();
    split("Helvetica", "0\uFE00"); // standardized short-zero sequence
    const afterValid = _clusterFallbackCounters();
    expect(afterValid.vsRequeued).toBeGreaterThan(before.vsRequeued);
    expect(afterValid.vsResets).toBeGreaterThan(before.vsResets);

    split("Helvetica", "a\uFE00"); // not a Character::IsVariationSequence pair
    const afterInvalid = _clusterFallbackCounters();
    expect(afterInvalid.vsRequeued).toBe(afterValid.vsRequeued);
  });

  it("uses the one-shot emoji fallback-priority stage before ordinary system fallback", () => {
    const before = _clusterFallbackCounters();
    const runs = split("Helvetica", "😀");
    const after = _clusterFallbackCounters();
    expect(runs?.[0].key.toLowerCase()).toContain("applecoloremoji");
    expect(after.priorityAsked).toBeGreaterThan(before.priorityAsked);
    expect(after.priorityAnswered).toBeGreaterThan(before.priorityAnswered);
  });

  it("keeps an uncovered mark WITH its covered base: Helvetica x+U+0951 is ONE Helvetica run", () => {
    // Chrome: Helvetica x2 — the cluster's hint char is `x` (U+0951 is
    // Inherited), CoreText answers Helvetica, the iterator refuses the
    // duplicate, and the terminal commits `.notdef`.
    // Legacy per-codepoint walk: "x"->helvetica + U+0951->sysfb:Kohinoor —
    // a mark Chrome never paints, split off its base.
    expect(split("Helvetica", "x॑")).toEqual([{ text: "x॑", key: "helvetica" }]);
  });

  it("moves a covered mark WITH its uncovered base: Helvetica ก+U+0301 is ONE Thonburi run", () => {
    // Chrome: Thonburi x2 (the mark keeps its GPOS anchor).
    // Legacy: ก->sysfb:Thonburi + U+0301->helvetica — mid-cluster split.
    const runs = split("Helvetica", "ก́");
    expect(runs).toHaveLength(1);
    expect(runs![0].key).toContain("Thonburi");
  });

  it("commits Arial's .notdef for an uncovered Arabic mark: ل+U+08F0 is ONE Arial run", () => {
    // Chrome: ArialMT x2. Legacy: mark->sysfb:.SFArabic.
    expect(split("Arial", "لࣰ")).toEqual([{ text: "لࣰ", key: "arial" }]);
  });

  it("lets HarfBuzz COMPOSE decomposed input in-font: Menlo α+U+0345 is ONE Menlo run", () => {
    // Chrome: Menlo-Regular x1 (hb-ot-shape-normalize composes to ᾳ).
    // Legacy: α->menlo + U+0345->sysfb:Monaco.
    expect(split("Menlo", "ᾳ")).toEqual([{ text: "ᾳ", key: "menlo" }]);
  });

  it("itemizes by script BEFORE fallback: Geneva e+U+0E48 splits into two runs", () => {
    // U+0E48 is Script=Thai (not Inherited), so Blink's RunSegmenter splits
    // base and mark into separate script runs before shaping — Chrome paints
    // Geneva + Thonburi. The pre-itemization prototype merged them into one
    // Geneva run (its single probe miss, docs/113 §2 case 5).
    const runs = split("Geneva", "e่");
    expect(runs).toHaveLength(2);
    expect(runs![0].text).toBe("e");
    expect(runs![1].text).toBe("่");
    expect(runs![1].key).toContain("Thonburi");
  });

  it("requeues at cluster boundaries in mixed lines: Thai cluster + tail Latin", () => {
    // Chrome: Thonburi x1 (the 3-codepoint cluster) + Helvetica x1.
    const runs = split("Helvetica", "ก่้x");
    expect(runs).toHaveLength(2);
    expect(runs![0].text).toBe("ก่้");
    expect(runs![0].key).toContain("Thonburi");
    expect(runs![1]).toEqual({ text: "x", key: "helvetica" });
  });

  it("keeps fully-covered clusters on the primary (controls)", () => {
    expect(split("Helvetica", "x́")).toEqual([{ text: "x́", key: "helvetica" }]);
    expect(split("Times New Roman", "שָ")).toEqual([{ text: "שָ", key: "times-new-roman" }]);
  });

  it("tiles mixed lines exactly (contract check)", () => {
    const text = "Hello ก่ world";
    const key = resolveFontKey("Helvetica");
    const font = resolveFont("Helvetica", 400, 32, 0)!;
    const runs = splitTextIntoFontRunsShaped(text, font, key, 400, 32, 0, undefined, undefined, ["helvetica"]);
    expect(runs).not.toBeNull();
    let cursor = 0;
    for (const r of runs!) {
      expect(r.startIdx).toBe(cursor);
      cursor = r.endIdx;
    }
    expect(cursor).toBe(text.length);
    expect(runs!.map((r) => r.text).join("")).toBe(text);
  });

  it("bumps the armed-mechanism counters", () => {
    const before = _clusterFallbackCounters();
    split("Helvetica", "abc");
    const after = _clusterFallbackCounters();
    expect(after.invoked).toBeGreaterThan(before.invoked);
    expect(after.accepted).toBeGreaterThan(before.accepted);
  });
});

(MACOS_FONTS ? describe : describe.skip)("U+3000 synthesized space (harfbuzz_shaper.cc:684-691)", () => {
  it("treats a space-glyph-synthesized U+3000 as .notdef and requeues it", () => {
    // Times has no real U+3000 glyph; HarfBuzz synthesizes it from the SPACE
    // glyph, which Blink refuses (crbug.com/1193282) so a font with a real
    // ideographic-space glyph is found. Without the rule the whole line stays
    // one Times run.
    const runs = split("Times New Roman", "a　b");
    expect(runs).toHaveLength(3);
    expect(runs![1].text).toBe("　");
    expect(runs![1].key).not.toBe("times-new-roman");
  });
  it("leaves a REAL ideographic-space glyph alone", () => {
    const runs = split("Hiragino Sans", "あ　あ");
    expect(runs).toHaveLength(1);
  });
  it("never touches ordinary spaces", () => {
    expect(split("Helvetica", "a b")).toEqual([{ text: "a b", key: "helvetica" }]);
  });
});

(MACOS_FONTS ? describe : describe.skip)("webfont primary at cluster granularity (docs/113 §2, partial-conjunct case)", () => {
  // A partially-covered webfont: क (U+0915) and ् (U+094D) retained, ष
  // (U+0937) subset away — the realistic subsetted-webfont shape. Chrome
  // shapes क्ष with it, keeps the unligated ष in its own cluster, and
  // re-queues EXACTLY that cluster to fallback (webfont x2 + Kohinoor x1).
  let subset: Buffer | null = null;
  beforeAll(() => {
    const path = "/System/Library/Fonts/Supplemental/Kohinoor.ttc";
    if (!fs.existsSync(path)) return;
    const f0 = fontkit.openSync(path);
    const face = ("fonts" in f0 ? (f0 as unknown as { fonts: Array<typeof f0> }).fonts[0] : f0) as {
      glyphForCodePoint(cp: number): { id: number };
    };
    const gidK = face.glyphForCodePoint(0x915).id;
    const gidVirama = face.glyphForCodePoint(0x94D).id;
    if (gidK === 0 || gidVirama === 0) return;
    subset = hbSubsetRetainGids(fs.readFileSync(path), [0, gidK, gidVirama], 0, true, null);
  });
  afterAll(() => clearWebfonts());

  it("shapes with the webfont face and requeues exactly the uncovered cluster", () => {
    if (subset == null) return; // Kohinoor not present on this host
    registerWebfont("DM2029 Partial Deva", 400, "normal", subset);
    const runs = split('"DM2029 Partial Deva"', "क्ष");
    expect(runs).not.toBeNull();
    expect(runs).toHaveLength(2);
    expect(runs![0]).toMatchObject({ text: "क्", key: "webfont:dm2029 partial deva" });
    expect(runs![1].text).toBe("ष");
    expect(runs![1].key).toContain("Kohinoor");
  });
});
