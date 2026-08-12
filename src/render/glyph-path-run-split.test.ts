// The glyph-path emitter's run split (`splitTextIntoGlyphPathRuns`) at
// shaped-cluster granularity — the "paths" render mode's port of the
// shape-then-requeue mechanism (docs/113). The embedded splitter's tests live
// in `cluster-fallback.test.ts`; these assert the SAME Chrome ground truth
// through the glyph-path entry point, plus the two contracts that are specific
// to this emitter and absent from the shared splitter's embedded mode:
//
//   1. the raster-emoji terminal — emoji are painted by a captured raster
//      overlay, so an uncovered emoji must keep the calibrated per-codepoint
//      pin (static-chain tail, or the primary when the chain is empty; a
//      trailing variation selector keeps the legacy resolver decision) instead
//      of the resolver's color-font answer;
//   2. per-run `decomposed` flags — the emitter picks its per-char vs run-text
//      branch per run from the flag, so a dotted-circle cluster must still
//      carry it after the port.
//
// Every Chrome expectation below is ground truth measured via CDP
// `CSS.getPlatformFontsForNode` against Playwright Chromium on macOS, and each
// records the legacy per-codepoint answer it replaces — with
// `DOMOTION_CLUSTER_FALLBACK=0` (the legacy walk, i.e. the pre-port behavior of
// `textToPathMarkup`) these tests FAIL, which is the discrimination
// requirement: a test both mechanisms pass grades nothing.
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import * as fs from "node:fs";
import fontkit from "fontkit";
import { splitTextIntoGlyphPathRuns } from "./text-to-path.js";
import {
  resolveFont, resolveFontKey, resolveFontKeyChain, stackPrimaryIsSystemUi,
  registerWebfont, clearWebfonts,
} from "./font-resolution.js";
import { _clusterFallbackCounters } from "./cluster-fallback.js";
import { hbSubsetRetainGids } from "./hb-subset.js";

const MACOS_FONTS = process.platform === "darwin" && fs.existsSync("/System/Library/Fonts/Helvetica.ttc");

const savedFlag = process.env.DOMOTION_CLUSTER_FALLBACK;
afterEach(() => {
  if (savedFlag == null) delete process.env.DOMOTION_CLUSTER_FALLBACK;
  else process.env.DOMOTION_CLUSTER_FALLBACK = savedFlag;
});

function split(fam: string, text: string): Array<{ text: string; key: string }> {
  const key = resolveFontKey(fam);
  const font = resolveFont(fam, 400, 32, 0);
  expect(font).not.toBeNull();
  const chain = resolveFontKeyChain(fam);
  const runs = splitTextIntoGlyphPathRuns(text, font!, key, 400, 32, 0, undefined, undefined, chain, stackPrimaryIsSystemUi(fam), 100, undefined, fam);
  return runs.map((r) => ({ text: r.text, key: r.fontKey }));
}

function splitFull(fam: string, text: string): Array<{ text: string; key: string; decomposed: boolean }> {
  const key = resolveFontKey(fam);
  const font = resolveFont(fam, 400, 32, 0)!;
  const chain = resolveFontKeyChain(fam);
  const runs = splitTextIntoGlyphPathRuns(text, font, key, 400, 32, 0, undefined, undefined, chain, stackPrimaryIsSystemUi(fam), 100, undefined, fam);
  return runs.map((r) => ({ text: r.text, key: r.fontKey, decomposed: r.decomposed === true }));
}

(MACOS_FONTS ? describe : describe.skip)("glyph-path split vs Chrome ground truth (docs/113 §2, paths mode)", () => {
  it("keeps an uncovered mark WITH its covered base: Helvetica x+U+0951 is ONE Helvetica run", () => {
    // Chrome: Helvetica ×2 (the mark is Helvetica's .notdef tofu).
    // Legacy paths walk: "x"→helvetica + U+0951→sysfb:KohinoorDevanagari.
    expect(split("Helvetica", "x॑")).toEqual([{ text: "x॑", key: "helvetica" }]);
  });

  it("moves a covered mark WITH its uncovered base: Helvetica ก+U+0301 is ONE Thonburi run", () => {
    // Chrome: Thonburi ×2. Legacy: ก→sysfb:Thonburi + U+0301→helvetica.
    const runs = split("Helvetica", "ก́");
    expect(runs).toHaveLength(1);
    expect(runs[0].key).toContain("Thonburi");
  });

  it("commits Arial's .notdef for an uncovered Arabic mark: ل+U+08F0 is ONE Arial run", () => {
    // Chrome: ArialMT ×2. Legacy: mark→sysfb:.SFArabic.
    expect(split("Arial", "لࣰ")).toEqual([{ text: "لࣰ", key: "arial" }]);
  });

  it("lets HarfBuzz COMPOSE decomposed input in-font: Menlo α+U+0345 is ONE Menlo run", () => {
    // Chrome: Menlo-Regular ×1 (hb-ot-shape-normalize composes to the
    // precomposed ᾳ glyph). Legacy: α→menlo + U+0345→sysfb:Monaco.
    // Written as escapes: an NFC-normalizing editor would silently turn the
    // decomposed sequence into precomposed U+1FB3, which both mechanisms
    // handle identically — the test would stop discriminating.
    expect(split("Menlo", "\u03B1\u0345")).toEqual([{ text: "\u03B1\u0345", key: "menlo" }]);
  });

  it("itemizes by script BEFORE fallback: Geneva e+U+0E48 splits into two runs", () => {
    const runs = split("Geneva", "e่");
    expect(runs).toHaveLength(2);
    expect(runs[0].text).toBe("e");
    expect(runs[1].text).toBe("่");
    expect(runs[1].key).toContain("Thonburi");
  });

  it("requeues at cluster boundaries in mixed lines: Thai cluster + tail Latin", () => {
    const runs = split("Helvetica", "ก่้x");
    expect(runs).toHaveLength(2);
    expect(runs[0].text).toBe("ก่้");
    expect(runs[0].key).toContain("Thonburi");
    expect(runs[1]).toEqual({ text: "x", key: "helvetica" });
  });

  it("keeps fully-covered clusters on the primary (controls)", () => {
    expect(split("Helvetica", "x́")).toEqual([{ text: "x́", key: "helvetica" }]);
    expect(split("Times New Roman", "שָ")).toEqual([{ text: "שָ", key: "times-new-roman" }]);
  });

  it("commits the whole ◌+mark cluster to the primary's .notdef when the mark's font lacks U+25CC", () => {
    // Chrome (measured via CSS.getPlatformFontsForNode, 2026-08): Helvetica ×2
    // — the cluster requeues off Thonburi (no U+25CC glyph, so the cluster's
    // verdict is .notdef), Times / Lucida Grande cover neither char, and
    // kFirstCandidateForNotdefGlyph re-returns Helvetica. Legacy split ◌ and
    // mark per codepoint (sysfb:HiraginoSans + sysfb:Thonburi) — two glyphs
    // Chrome never paints.
    expect(split("Helvetica", "◌่")).toEqual([{ text: "◌่", key: "helvetica" }]);
  });

  it("DISCRIMINATES: the legacy walk (flag off) gives the per-codepoint split these tests replace", () => {
    process.env.DOMOTION_CLUSTER_FALLBACK = "0";
    const runs = split("Helvetica", "x॑");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ text: "x", key: "helvetica" });
    expect(runs[1].key).not.toBe("helvetica");
  });

  it("bumps the armed-mechanism counters", () => {
    const before = _clusterFallbackCounters();
    split("Helvetica", "abc");
    const after = _clusterFallbackCounters();
    expect(after.invoked).toBeGreaterThan(before.invoked);
    expect(after.accepted).toBeGreaterThan(before.accepted);
  });
});

(MACOS_FONTS ? describe : describe.skip)("partial webfont primary at cluster granularity (docs/113 §2 case 6, paths mode)", () => {
  // Same fixture as the embedded suite: क + ् retained, ष subset away. Chrome
  // shapes क्ष with the webfont, keeps the unligated ष in its own cluster, and
  // re-queues exactly that cluster (webfont ×2 + Kohinoor ×1).
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

  it("requeues exactly the uncovered cluster through the glyph-path entry point", () => {
    if (subset == null) return; // Kohinoor not present on this host
    registerWebfont("DM2038 Partial Deva", 400, "normal", subset);
    const runs = split('"DM2038 Partial Deva"', "क्ष");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ text: "क्", key: "webfont:dm2038 partial deva" });
    expect(runs[1].text).toBe("ष");
    expect(runs[1].key).toContain("Kohinoor");
  });
});

(MACOS_FONTS ? describe : describe.skip)("raster-emoji terminal preserved (paths-mode pin)", () => {
  // The pin is a Domotion overlay calibration, not a Blink behavior: Chrome
  // paints these from Apple Color Emoji; the glyph-path emitter covers them
  // with a captured raster and needs the underlying run's advance stable. The
  // Bare emoji keep that legacy pin. Explicit variation sequences are the
  // exception: they stay in Blink's sequence-aware walk as one cluster.
  const emojiTexts: Array<[string, string]> = [
    ["Helvetica", "a\u{1F600}b"],   // empty chain → grouped with the primary run
    ["Helvetica", "x⭐y"],           // chain tail (last-resort)
    ["Helvetica", "\u{1F44D}\u{1F3FB}"], // modifier sequence
  ];

  it("splits emoji text exactly as the legacy walk does", () => {
    for (const [fam, text] of emojiTexts) {
      delete process.env.DOMOTION_CLUSTER_FALLBACK;
      const shaped = splitFull(fam, text);
      process.env.DOMOTION_CLUSTER_FALLBACK = "0";
      const legacy = splitFull(fam, text);
      expect(shaped, `${fam} ${text}`).toEqual(legacy);
    }
  });

  it("keeps an explicit emoji variation sequence together on Chromium's selected face", () => {
    delete process.env.DOMOTION_CLUSTER_FALLBACK;
    expect(split("Helvetica", "a❤️b")).toEqual([
      { text: "a", key: "helvetica" },
      { text: "❤️", key: "sysfb:AppleColorEmoji" },
      { text: "b", key: "helvetica" },
    ]);
  });

  it("keeps an uncovered empty-chain emoji grouped with the surrounding primary run", () => {
    delete process.env.DOMOTION_CLUSTER_FALLBACK;
    // A resolver-placed color font would split this into three runs and break
    // the overlay's advance pinning.
    expect(split("Helvetica", "a\u{1F600}b")).toEqual([{ text: "a\u{1F600}b", key: "helvetica" }]);
  });
});

(MACOS_FONTS ? describe : describe.skip)("decomposed flags survive the port", () => {
  it("marks a dotted-circle cluster run decomposed (run-text branch)", () => {
    // Orphaned Brahmi vowel sign U+11038 → the DM-1215 hb cluster run (the ◌
    // is inserted and GPOS-positioned by real HarfBuzz in the mark's font).
    // Identical under both mechanisms; the flag is what routes the run through
    // the emitter's run-text branch, so dropping it in the port would move the
    // mark off its circle.
    const runs = splitFull("Helvetica", "\u{11038}");
    expect(runs).toHaveLength(1);
    expect(runs[0].decomposed).toBe(true);
  });
});
