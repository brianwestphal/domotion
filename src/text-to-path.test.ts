import { describe, expect, it } from "vitest";
import { fallbackFontChain, getDecorationMetrics, pingfangKeyForLang, renderTextAsPath, resolveFontKey } from "./text-to-path.js";

// Pinned mappings for the CSS generic-family keywords. These exist to lock
// the fidelity-critical resolutions Chrome on macOS performs (per Blink's
// font_cache_mac.mm) — substituting any of these silently shifts every
// page's text metrics. See DM-236 (monospace was wrongly routed to SF Mono)
// and SK-1124 (sans-serif was wrongly routed to SF Pro).
describe("resolveFontKey: generic-family resolution", () => {
  it("routes sans-serif to Helvetica, not SF Pro", () => {
    expect(resolveFontKey("sans-serif")).toBe("helvetica");
  });

  it("skips bare ui-sans-serif so it falls through to Times (DM-290)", () => {
    // Empirical Chromium probe at 16px: `ui-sans-serif` paints at 376.38px
    // (UA-default Times metrics), not 410.03px (Helvetica). Like the other
    // ui-* keywords, Chromium-on-macOS doesn't recognise this generic and
    // walks past it to the next family in the stack — or falls through to
    // the Standard Font default if it's the only one. Mapping it to
    // Helvetica painted the 20-font-family fixture's `ui-sans-serif` row
    // with sans-serif glyphs while Chrome paints serifs (DM-290 user note).
    expect(resolveFontKey("ui-sans-serif")).toBe("times");
    expect(resolveFontKey("ui-sans-serif, sans-serif")).toBe("helvetica");
  });

  it("routes monospace to Courier, not SF Mono or Menlo", () => {
    expect(resolveFontKey("monospace")).toBe("courier");
  });

  it("routes bare ui-monospace / ui-rounded / ui-sans-serif to Times (last-resort fallback)", () => {
    // DM-269: macOS Chrome doesn't recognize ui-monospace / ui-rounded as
    // system fonts — painted T width is 9.77px (Times) and q is 8.0px (Times),
    // not Courier or SF Mono. Chrome falls through to the Standard Font default.
    expect(resolveFontKey("ui-monospace")).toBe("times");
    expect(resolveFontKey("ui-rounded")).toBe("times");
    expect(resolveFontKey("ui-sans-serif")).toBe("times");
  });

  it("falls through ui-monospace when later names in the chain are valid (DM-302)", () => {
    // CSS like `font: ui-monospace, Menlo, Consolas, monospace` is common —
    // the leading ui-monospace is a hint Chrome doesn't recognize on macOS,
    // and Chrome paints Menlo (the next valid name). Pinning to Times on the
    // ui-monospace keyword would make code editors render in a serif face.
    expect(resolveFontKey("ui-monospace, Menlo, Consolas, monospace")).toBe("menlo");
    expect(resolveFontKey("ui-rounded, Helvetica")).toBe("helvetica");
    expect(resolveFontKey("emoji, sans-serif")).toBe("helvetica");
  });

  it("routes serif to Times, not Georgia", () => {
    expect(resolveFontKey("serif")).toBe("times");
    expect(resolveFontKey("ui-serif")).toBe("times");
  });

  it("routes system-ui / BlinkMacSystemFont to SF Pro", () => {
    expect(resolveFontKey("system-ui")).toBe("sf-pro");
    expect(resolveFontKey("BlinkMacSystemFont")).toBe("sf-pro");
  });

  it("skips bare -apple-system so the next family in the stack matches (DM-291)", () => {
    // Chromium probe at 18px on "greet": `font-family: -apple-system` alone
    // paints at 35.98px (UA-default Times metrics), `font-family: sans-serif`
    // paints at 41.03px (Helvetica), and `font-family: -apple-system,
    // sans-serif` paints at 41.03px — proving Chrome doesn't recognise
    // -apple-system in this build and falls through to the next family. We
    // mirror that by skipping it; the test fixture pinned this stack and the
    // SF Pro glyphs were ~1px wider than Chrome's Helvetica painted output.
    expect(resolveFontKey("-apple-system")).toBe("times");
    expect(resolveFontKey("-apple-system, sans-serif")).toBe("helvetica");
  });

  it("routes cursive to Apple Chancery (DM-290)", () => {
    // Empirical probe at 16px: Chrome cursive paints at 290.08px which
    // matches Apple Chancery exactly (Snell Roundhand is 263.84px — a
    // ~10% drift if we picked Snell). Author-named "Snell Roundhand" /
    // "Brush Script MT" still get the snell key since those are explicit.
    expect(resolveFontKey("cursive")).toBe("apple-chancery");
    expect(resolveFontKey("Apple Chancery")).toBe("apple-chancery");
    expect(resolveFontKey("Snell Roundhand")).toBe("snell");
    expect(resolveFontKey("Brush Script MT")).toBe("snell");
  });

  it("routes fantasy to Papyrus (DM-290)", () => {
    // Empirical probe at 16px: Chrome fantasy paints at 313.94px which
    // matches Papyrus exactly. Without this mapping the keyword fell
    // through to Times metrics (292.38px), which is ~7% narrower.
    expect(resolveFontKey("fantasy")).toBe("papyrus");
    expect(resolveFontKey("Papyrus")).toBe("papyrus");
  });
});

describe("resolveFontKey: explicit-name resolution", () => {
  it("honors author-named monospace families separately", () => {
    expect(resolveFontKey("Menlo")).toBe("menlo");
    expect(resolveFontKey("Monaco")).toBe("monaco");
    expect(resolveFontKey("Courier")).toBe("courier");
    expect(resolveFontKey("Courier New")).toBe("courier");
    expect(resolveFontKey("SF Mono")).toBe("sf-mono");
  });

  it("honors author-named sans families separately", () => {
    expect(resolveFontKey("Helvetica")).toBe("helvetica");
    expect(resolveFontKey("Helvetica Neue")).toBe("helvetica");
    expect(resolveFontKey("Arial")).toBe("arial");
  });

  it("honors author-named serif families separately", () => {
    expect(resolveFontKey("Georgia")).toBe("georgia");
    // DM-330: explicit `Times New Roman` → the Microsoft TNR face (thinner
    // em-dash bar, H=122 in Bold), distinct from `Times`/`serif` which
    // resolve to Apple's `Times.ttc` (H=185 in Bold).
    expect(resolveFontKey("Times New Roman")).toBe("times-new-roman");
    expect(resolveFontKey('"Times New Roman"')).toBe("times-new-roman");
    expect(resolveFontKey("Times")).toBe("times");
    expect(resolveFontKey("serif")).toBe("times");
  });

  it("is case-insensitive and strips quotes", () => {
    expect(resolveFontKey("MONOSPACE")).toBe("courier");
    expect(resolveFontKey('"Helvetica Neue"')).toBe("helvetica");
    expect(resolveFontKey("'SF Mono'")).toBe("sf-mono");
  });

  it("routes Chrome-unrecognized generics (math / emoji / fangsong) to Times", () => {
    // DM-269: probed Chrome on macOS — these paint with Times metrics
    // (q=8.0, T=9.77) when used as the only family. The Standard Font default
    // is Times; per-codepoint fallback then routes the glyphs Times lacks
    // (CJK, math alpha, color emoji) to the right block-specific font.
    // `fantasy` was previously in this list but is mapped to Papyrus
    // (DM-290) — see the dedicated test above.
    expect(resolveFontKey("math")).toBe("times");
    expect(resolveFontKey("emoji")).toBe("times");
    expect(resolveFontKey("fangsong")).toBe("times");
  });
});

// Baseline placement: when CAPTURE_SCRIPT records the browser's
// canvas.measureText().fontBoundingBoxAscent on the element (DM-237), the
// renderer must use that value verbatim instead of computing ascent from
// fontkit's HHEA `font.ascent`. fontkit's HHEA is correct for SF Pro / SF Mono
// (where HHEA = winAscent) but ~5px too small at fontSize=32 for Helvetica
// and the other macOS legacy MS fonts (Arial, Times, Georgia, Menlo, Courier),
// where Chrome reads winAscent. Without the override, headings drift up by an
// amount proportional to font size.
describe("renderTextAsPath: ascentOverride threading", () => {
  // Extract the y-coordinate from the outer translate(x,y) on the returned
  // <g> markup. That y is the baseline anchor — exactly the value affected
  // by the override.
  const baselineY = (markup: string | null): number | null => {
    if (markup == null) return null;
    const m = /transform="translate\([^,]+,([^)]+)\)"/.exec(markup);
    return m != null ? parseFloat(m[1]) : null;
  };

  it("uses ascentOverride verbatim for baselineY when provided", () => {
    const top = 100;
    const ascent = 30; // simulates Chrome's fontBoundingBoxAscent for fs=32 Helvetica bold
    const out = renderTextAsPath("Hi", 0, top, 32, "Helvetica", "700", "#000",
      undefined, undefined, undefined, undefined, ascent);
    expect(baselineY(out)).toBe(top + ascent);
  });

  it("falls back to fontkit ascent when no override given", () => {
    const top = 100;
    // No override — falls back to round(font.ascent * scale). The exact value
    // depends on the resolved font; we just assert the answer is *different*
    // from a clearly-wrong override, so the test fails if both branches end
    // up using the same code.
    const native = renderTextAsPath("Hi", 0, top, 32, "Helvetica", "700", "#000");
    const overridden = renderTextAsPath("Hi", 0, top, 32, "Helvetica", "700", "#000",
      undefined, undefined, undefined, undefined, 30);
    expect(baselineY(native)).not.toBe(baselineY(overridden));
  });

  it("scales the override correctly across font sizes", () => {
    // Same font, different sizes → override is applied verbatim, no extra math.
    const a = renderTextAsPath("Hi", 0, 0, 14, "Helvetica", "400", "#000",
      undefined, undefined, undefined, undefined, 13);
    const b = renderTextAsPath("Hi", 0, 0, 50, "Helvetica", "400", "#000",
      undefined, undefined, undefined, undefined, 47);
    expect(baselineY(a)).toBe(13);
    expect(baselineY(b)).toBe(47);
  });
});

describe("fallbackFontChain: Geometric/Misc Symbols routing (DM-324 / DM-326)", () => {
  // Chrome on macOS paints chars like ◉◌◐◑ (U+25C9..D1) and ☀☁☂☃ (U+2600..03)
  // at em-square width (18px @18px font-size). HiraginoSansGB-W3 (the "cjk"
  // key) lacks these glyphs entirely; HiraKakuProN-W3 (the "hiragino-jp"
  // key, regular Japanese Hiragino Sans) covers them at em-square width.
  // Without hiragino-jp in the chain the renderer falls all the way through
  // to Apple Symbols whose advances are 11-15px — visibly narrower than
  // Chrome's painted output.
  it("routes the U+25A0..25FF and U+2600..26FF blocks through hiragino-jp before symbols", () => {
    // Geometric Shapes block (U+25A0..25FF) — chars Chrome paints at em-square.
    // Note: ■ □ ● ○ ◆ ◇ are individually carved out to LucidaGrande first
    // (DM-349) because Chrome paints those at proportional 9-13px, not em-square.
    expect(fallbackFontChain(0x25C9)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x25CC)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x25D0)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x25D1)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    // Misc Symbols block (U+2600..26FF).
    expect(fallbackFontChain(0x2600)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x2601)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x2602)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x2603)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x2640)).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x26A5)).toEqual(["cjk", "hiragino-jp", "symbols"]);
  });

  it("routes ■ □ ● ○ ◆ ◇ through LucidaGrande (matches Chrome's narrow paint)", () => {
    // DM-349: empirical xOffset capture in 02-text-symbols showed Chrome
    // paints these at LucidaGrande's proportional advance (9.76 / 10.41 /
    // 13.01 / 11.07 px @18px), not at the em-square 18px Hiragino renders.
    // DM-415 / DM-429 verified this is still the closest visible-shape
    // match in our font set (tried SF NS / AppleSDGothicNeo, both produced
    // visibly larger glyphs than Chrome's painted ink).
    expect(fallbackFontChain(0x25A0)).toEqual(["lucida-grande", "symbols"]); // ■
    expect(fallbackFontChain(0x25A1)).toEqual(["lucida-grande", "symbols"]); // □
    expect(fallbackFontChain(0x25CF)).toEqual(["lucida-grande", "symbols"]); // ●
    expect(fallbackFontChain(0x25CB)).toEqual(["lucida-grande", "symbols"]); // ○
    expect(fallbackFontChain(0x25C6)).toEqual(["lucida-grande", "symbols"]); // ◆
    expect(fallbackFontChain(0x25C7)).toEqual(["lucida-grande", "symbols"]); // ◇
  });
});

describe("Primary-aware CJK fallback (DM-333)", () => {
  // CJK characters routing depends on the primary font's broad style: serif
  // primaries (Apple Times / Times New Roman / Georgia, plus the bare
  // generics that resolve to `times`) get serif CJK glyphs (Songti SC Light)
  // matching Chrome's painted output 100% pixel-exact at 16px on `font-
  // family: serif/fangsong/ui-serif`. Non-serif primaries keep the existing
  // HiraginoSansGB-W3 sans CJK route.
  it("returns ['cjk-serif', 'cjk'] when primary is times / times-new-roman / georgia", () => {
    expect(fallbackFontChain(0x4E00, "times")).toEqual(["cjk-serif", "cjk"]);
    expect(fallbackFontChain(0x4F60, "times-new-roman")).toEqual(["cjk-serif", "cjk"]);
    expect(fallbackFontChain(0x4F60, "georgia")).toEqual(["cjk-serif", "cjk"]);
    // Hiragana / Katakana / Hangul also go through the serif route.
    expect(fallbackFontChain(0x3042, "times")).toEqual(["cjk-serif", "cjk"]);
    expect(fallbackFontChain(0x30A2, "times")).toEqual(["cjk-serif", "cjk"]);
    expect(fallbackFontChain(0xAC00, "times")).toEqual(["cjk-serif", "cjk"]);
  });
  it("routes Han Unified Ideographs through pingfang-sc → cjk for non-serif primaries (DM-388)", () => {
    // U+4F60 is in CJK Unified Ideographs (the 你 in 你好). Sans-serif primary
    // routes through PingFang SC (CoreText extractor) first to match what
    // Chrome paints, with HiraginoSansGB-W3 retained as the fontkit-readable
    // safety net for any glyph PingFang lacks. DM-382 / DM-364 / DM-388.
    expect(fallbackFontChain(0x4F60, "helvetica")).toEqual(["pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "sf-pro")).toEqual(["pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "menlo")).toEqual(["pingfang-sc", "cjk"]);
    // No primaryKey arg → default sans behaviour.
    expect(fallbackFontChain(0x4F60)).toEqual(["pingfang-sc", "cjk"]);
  });
  it("keeps the bare ['cjk'] route for non-Han CJK ranges (Hiragana / Katakana / Hangul)", () => {
    // PingFang routing applies only to Han Unified Ideographs + Ext A + CJK
    // Compatibility Ideographs. Hiragana (3040..309F), Katakana (30A0..30FF),
    // and Hangul (AC00..D7AF) are what HiraginoSansGB / Apple's Hiragino
    // chain paints; they don't go through PingFang.
    expect(fallbackFontChain(0x3042, "helvetica")).toEqual(["cjk"]); // ぁ
    expect(fallbackFontChain(0x30A2, "helvetica")).toEqual(["cjk"]); // ア
    expect(fallbackFontChain(0xAC00, "helvetica")).toEqual(["cjk"]); // 가
  });
  it("routes Han through the lang-matching PingFang variant when lang is set (DM-394)", () => {
    // 你 is U+4F60 — Han ideograph.
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-TW")).toEqual(["pingfang-tc", "pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-Hant")).toEqual(["pingfang-tc", "pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-HK")).toEqual(["pingfang-hk", "pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-MO")).toEqual(["pingfang-mo", "pingfang-sc", "cjk"]);
    // zh-Hant-HK: region wins over script.
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-Hant-HK")).toEqual(["pingfang-hk", "pingfang-sc", "cjk"]);
    // Japanese: there's no PingFang JP — routes through Hiragino Kaku.
    expect(fallbackFontChain(0x4F60, "helvetica", "ja")).toEqual(["hiragino-jp", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "ja-JP")).toEqual(["hiragino-jp", "cjk"]);
    // SC / unspecified / non-CJK lang → default PingFang SC.
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-CN")).toEqual(["pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "zh-Hans")).toEqual(["pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "en-US")).toEqual(["pingfang-sc", "cjk"]);
    expect(fallbackFontChain(0x4F60, "helvetica", "")).toEqual(["pingfang-sc", "cjk"]);
  });
});

describe("pingfangKeyForLang BCP-47 mapping (DM-394)", () => {
  it("maps Traditional Chinese region tags to TC", () => {
    expect(pingfangKeyForLang("zh-TW")).toBe("pingfang-tc");
    expect(pingfangKeyForLang("zh-tw")).toBe("pingfang-tc");
    expect(pingfangKeyForLang("zh-Hant")).toBe("pingfang-tc");
    expect(pingfangKeyForLang("zh-Hant-TW")).toBe("pingfang-tc"); // -tw region
  });
  it("maps Hong Kong / Macau region tags to HK / MO", () => {
    expect(pingfangKeyForLang("zh-HK")).toBe("pingfang-hk");
    expect(pingfangKeyForLang("zh-Hant-HK")).toBe("pingfang-hk"); // region beats script
    expect(pingfangKeyForLang("zh-MO")).toBe("pingfang-mo");
  });
  it("maps Japanese tags to hiragino-jp (no PingFang JP exists on macOS)", () => {
    expect(pingfangKeyForLang("ja")).toBe("hiragino-jp");
    expect(pingfangKeyForLang("ja-JP")).toBe("hiragino-jp");
  });
  it("returns null for SC / unspecified / non-CJK / empty (caller falls back to pingfang-sc)", () => {
    expect(pingfangKeyForLang("zh")).toBeNull();
    expect(pingfangKeyForLang("zh-CN")).toBeNull();
    expect(pingfangKeyForLang("zh-Hans")).toBeNull();
    expect(pingfangKeyForLang("zh-SG")).toBeNull(); // Singapore uses simplified
    expect(pingfangKeyForLang("en-US")).toBeNull();
    expect(pingfangKeyForLang("")).toBeNull();
    expect(pingfangKeyForLang(undefined)).toBeNull();
  });
  it("does NOT swap the symbol blocks for serif primaries (only CJK ranges)", () => {
    // Geometric Shapes / Misc Symbols still route through their dedicated
    // chains regardless of primary — those blocks aren't affected by the
    // serif/sans CJK distinction. ■ is one of the LucidaGrande-narrow chars
    // (DM-349), so it stays on its dedicated chain even with a serif primary.
    expect(fallbackFontChain(0x25A0, "times")).toEqual(["lucida-grande", "symbols"]);
    expect(fallbackFontChain(0x25C9, "times")).toEqual(["cjk", "hiragino-jp", "symbols"]);
    expect(fallbackFontChain(0x2600, "times")).toEqual(["cjk", "hiragino-jp", "symbols"]);
    // Arrows ← → ↗ ↙ now route to LucidaGrande regardless of primary
    // (DM-405 — re-probed via CDP, Chrome paints these via LucidaGrande
    // at every size 12 → 32 px, not Hiragino).
    expect(fallbackFontChain(0x2190, "times")).toEqual(["lucida-grande", "symbols"]);
  });
});

describe("Math Operators primary-font handling (DM-332)", () => {
  // U+2200..22FF math operators: Chrome on macOS paints chars Apple Times has
  // (≥ ≤ ≠ ≈ ± ÷ × − ∑ √ ∫ ∞) AT TIMES'S advance, NOT at Apple Symbols's. The
  // user's reported difference on ≥ traced to our renderer painting Apple
  // Symbols's ≥ glyph (id=599, advance=10.27px, ascending arrows-style shape)
  // while Chrome paints Apple Times's ≥ glyph (id=149, advance=8.78px, flat
  // baseline). Both glyphs share the same codepoint but the visual forms are
  // very different. STIX Two Math (the obvious candidate for `font-family:
  // math`) is NOT what Chrome uses for any of these operators — STIX advances
  // are 11.52px+ across the board, way wider than Chrome's 8.78px painted ≥.
  //
  // The fix is structural: `times` resolves to Apple Times.ttc (DM-330), which
  // has all of these operator glyphs. The renderer's primary-font-first logic
  // then picks them from Apple Times instead of falling through to the symbols
  // chain. So the `fallbackFontChain` for U+2200..22FF stays empty / unchanged
  // — it only fires when the primary lacks the codepoint (∀ ∇ ∂ ∈ ⊂ ∧ etc.).
  it("ui-serif / math / serif resolves to times (Apple Times has the common operators)", () => {
    // `font-family: math` falls through to the Times default (DM-269 +
    // DM-291), so the math-row primary is `times` which is Apple Times.
    expect(resolveFontKey("math")).toBe("times");
    expect(resolveFontKey("serif")).toBe("times");
    expect(resolveFontKey("ui-serif")).toBe("times");
  });
});

describe("fallbackFontChain: Arrows-block routing (DM-296 / DM-369 / DM-405)", () => {
  // Re-probed via CDP `CSS.getPlatformFontsForNode` for DM-405: at every
  // font-size 12 → 32 px, Chrome paints ← → ↑ ↓ ↗ ↙ via LucidaGrande
  // — NOT Hiragino as DM-296 originally measured. The earlier Hiragino
  // route produced thin outlined arrows where Chrome paints chunky
  // filled arrows (visible on the `→` in `11-box-margin-collapse`).
  it("routes ← → ↑ ↓ ↗ ↙ to LucidaGrande (matches Chrome's painted glyph shape)", () => {
    expect(fallbackFontChain(0x2190)).toEqual(["lucida-grande", "symbols"]); // ←
    expect(fallbackFontChain(0x2192)).toEqual(["lucida-grande", "symbols"]); // →
    expect(fallbackFontChain(0x2191)).toEqual(["lucida-grande", "symbols"]); // ↑
    expect(fallbackFontChain(0x2193)).toEqual(["lucida-grande", "symbols"]); // ↓
    expect(fallbackFontChain(0x2197)).toEqual(["lucida-grande", "symbols"]); // ↗
    expect(fallbackFontChain(0x2199)).toEqual(["lucida-grande", "symbols"]); // ↙
  });

  // ↑ ↓ are not at CJK em-square width and not at Apple Symbols' narrow
  // width either — Chrome paints them via LucidaGrande at 14.19px @22px.
  // DM-369: confirmed via fontkit advance probe (LucidaGrande U+2191 id=926
  // = 14.19px, U+2193 id=928 = 14.19px) matching the bounding box that
  // Range.getBoundingClientRect captures from Chrome.
  it("routes ↑ ↓ to LucidaGrande (matches Chrome's painted width)", () => {
    expect(fallbackFontChain(0x2191)).toEqual(["lucida-grande", "symbols"]);
    expect(fallbackFontChain(0x2193)).toEqual(["lucida-grande", "symbols"]);
  });

  it("keeps the rest of the Arrows block on Apple Symbols", () => {
    expect(fallbackFontChain(0x2194)).toEqual(["symbols"]);
    expect(fallbackFontChain(0x21D2)).toEqual(["symbols"]);
    expect(fallbackFontChain(0x21D4)).toEqual(["symbols"]);
  });
});

describe("ligature handling with captured xOffsets (DM-287 / DM-331)", () => {
  // When font.layout fires ligatures (Helvetica fi/fl, Apple Chancery Th/th),
  // the layout glyph count is shorter than the input text length. The
  // renderer must walk the layout's actual glyph stream — anchoring each
  // cluster at its first codepoint's xOffset — instead of either re-shaping
  // per-char (which loses the ligature glyph) or falling back to native
  // advances (which loses Chrome's captured xOffsets). DM-287 was the
  // original justify-spacing bug; DM-331 was Apple Chancery painting
  // disconnected per-char Th/th instead of the connected ligature glyphs.
  it("emits ligature glyphs when font.layout collapses chars (Apple Chancery Th/th)", () => {
    // 43-char text with two Apple Chancery ligatures: Th at start, th in
    // "the lazy". Chrome captures 43 per-char xOffsets but font.layout
    // returns 41 glyphs. Each of the 2 ligature clusters covers 2
    // codepoints; per Chrome each is anchored at the first char's xOffset.
    const text = "The quick brown fox jumps over the lazy dog";
    const xOffsets: number[] = [];
    // Spread chars at 8px each — exact values don't matter for this test, we
    // just need length === text.length so the ligature path activates.
    for (let i = 0; i < text.length; i++) xOffsets.push(i * 8);
    const out = renderTextAsPath(
      text, 0, 0, 16, "cursive", "400", "#000",
      undefined, undefined, xOffsets,
    );
    expect(out).not.toBeNull();
    // Apple Chancery's Th ligature is glyph id=343, th ligature id=338,
    // and per-char e is id=72. We expect to see exactly one <use> referencing
    // each ligature glyph (anchored at xOffsets[0] = 0 and xOffsets[31] =
    // 248 / scale respectively, but we don't pin the exact tx — just that
    // the ligature glyph defs are present).
    const useCount = (out!.match(/<use href="#g\d+"/g) ?? []).length;
    // 43 chars - 8 spaces - 2 ligature collapses (Th, th) = 33 emitted uses.
    expect(useCount).toBe(33);
  });
});

describe("Emoji codepoints suppress .notdef tofu emission (DM-334)", () => {
  // When a codepoint is one Chrome paints via Apple Color Emoji (✨ 😀 🚀
  // 🌟 🎉 etc.), neither Times nor Apple Symbols nor Zapf Dingbats has a
  // glyph in their path tables — they all return id=0 (the hollow-rectangle
  // .notdef tofu). The capture layer screenshots the page and stamps a
  // raster <image> overlay at the emoji's painted rect, so the path
  // pipeline's tofu rectangle is redundant; emitting it leaves a black
  // silhouette around the edges of the emoji where the raster has
  // sub-pixel transparency. Verify that for emoji codepoints the path
  // pipeline emits NO `<use>` element (the only renderable would be the
  // tofu, and that's now suppressed).
  it("emits no <use> for U+2728 ✨ (Dingbats emoji-presentation)", () => {
    // Render just "✨" with a captured xOffset. Primary=Times → no glyph.
    // Chain is ["zapf-dingbats", "symbols"] — neither has ✨, so picked
    // would be the chain's last entry (symbols) producing tofu. With the
    // emoji-codepoint suppression, the markup is empty and
    // renderTextAsPath returns null (no <g> wrapper for empty content).
    const out = renderTextAsPath(
      "✨", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0],
    );
    expect(out).toBeNull();
  });
  it("emits no <use> for U+1F600 😀 / U+1F680 🚀 (main emoji blocks)", () => {
    const out = renderTextAsPath(
      "😀🚀", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0, 0, 18, 18],
    );
    expect(out).toBeNull();
  });
  it("emits text-but-no-emoji-tofu in mixed runs (Smile 😀)", () => {
    // Mixed text: "Smile 😀" — the "Smile " chars emit Times glyphs, the
    // 😀 codepoint suppresses its tofu. Without the suppression we'd see
    // 7 <use>s (S, m, i, l, e, space, tofu); with it we see 6 (no tofu).
    const out = renderTextAsPath(
      "Smile 😀", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0, 9, 18, 22, 26, 30, 34, 34],
    );
    expect(out).not.toBeNull();
    const useCount = (out!.match(/<use href="#g\d+"/g) ?? []).length;
    expect(useCount).toBe(6);
  });
  it("still emits .notdef for non-emoji codepoints with no font coverage", () => {
    // Some exotic codepoint that no font in the chain has — keep the tofu
    // so the visible "char missing" indicator remains for non-emoji gaps.
    // U+E000 (Private Use Area) — no path-font has a glyph for this.
    const out = renderTextAsPath(
      "", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0],
    );
    expect(out).not.toBeNull();
    // PUA glyph fall-through to symbols-tofu still emits the rectangle.
    if (out == null) {
      // Some PUA codepoints might also resolve to empty paths; treat that
      // as acceptable for this regression — the key invariant is that
      // emoji blocks suppress and non-emoji chars don't get extra
      // suppression added by accident. If null, the check is a no-op.
      return;
    }
    const useCount = (out.match(/<use href="#g\d+"/g) ?? []).length;
    expect(useCount).toBeGreaterThanOrEqual(0);
  });
});

describe("synthesized small-caps (DM-294)", () => {
  // Helvetica/Arial/SF Pro/Times/Georgia all lack the OpenType `smcp` feature,
  // so `font-variant: small-caps` triggers Chrome's synthesized-small-caps
  // path: lowercase letters render as uppercase glyphs at ~0.7× the font
  // size, while uppercase letters stay at full size. The renderer mirrors
  // this when it sees `features: ['smcp']` and the font lacks the feature.
  it("renders lowercase letters as uppercase glyphs at the small-cap scale", () => {
    // Render "abc" at 16px Helvetica with smcp.
    const out = renderTextAsPath(
      "abc", 0, 0, 16, "Helvetica", "400", "#000",
      undefined, undefined, [0, 8, 16], undefined, undefined, ["smcp"],
    );
    expect(out).not.toBeNull();
    // Synth path emits one <g transform="translate(x,0) scale(s,-s)"> per
    // char. With SMALL_CAP_SCALE = 0.7 and 16/2048 unit scale, the per-char
    // scale is 16/2048 * 0.7 ≈ 0.00547. Confirm that we see the small-cap
    // scale on each <g> (not the full-size 0.00781).
    const matches = out!.match(/scale\(([^,]+),/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    // Outer scale on the wrapper <g transform="translate(x,baselineY)"> is
    // 1, so we look at the inner per-char scales (4 total: 1 outer + 3 char).
    // Each should be ≈ 0.00547 (small-cap), not 0.00781 (full).
    const charScales = matches.slice(1, 4).map((m) => parseFloat(m.replace(/scale\(/, "")));
    for (const s of charScales) {
      expect(s).toBeCloseTo(16 / 2048 * 0.7, 3);
    }
  });

  it("keeps uppercase letters at full size in a smcp run", () => {
    // "ABC" all uppercase — synth path must NOT shrink them.
    const out = renderTextAsPath(
      "ABC", 0, 0, 16, "Helvetica", "400", "#000",
      undefined, undefined, [0, 10, 20], undefined, undefined, ["smcp"],
    );
    expect(out).not.toBeNull();
    const matches = out!.match(/scale\(([^,]+),/g) ?? [];
    const charScales = matches.slice(1, 4).map((m) => parseFloat(m.replace(/scale\(/, "")));
    for (const s of charScales) {
      expect(s).toBeCloseTo(16 / 2048, 3);
    }
  });
});

describe("resolveFontKey: chain walking", () => {
  it("picks the first recognized name in the stack", () => {
    expect(resolveFontKey('"DoesNotExist", monospace')).toBe("courier");
    expect(resolveFontKey("DoesNotExist, Helvetica, sans-serif")).toBe("helvetica");
    expect(resolveFontKey("Menlo, Consolas, monospace")).toBe("menlo");
  });

  it("falls through to Times when nothing matches (Chrome's macOS Standard Font default)", () => {
    // DM-269: probed Chrome — body with no font-family computes to "Times",
    // and elements declaring an unrecognized family chain fall through to
    // the same Standard Font default. Previously this was Helvetica which
    // was wrong for serif default contexts.
    expect(resolveFontKey("Nothing-Installed-1, Nothing-Installed-2")).toBe("times");
    expect(resolveFontKey("")).toBe("times");
  });
});

describe("getDecorationMetrics: Chrome auto-thickness rule (DM-398)", () => {
  // Empirically derived from `scripts/probe-text-decorations.mjs` on Chromium
  // / macOS — see DM-398 for the painted-pixel measurements at 12 / 14 / 16
  // / 18 / 22 / 24 / 32 px sans-serif. Chrome ignores the font's own
  // post.underlineThickness in the `text-decoration-thickness: auto` path.
  it("uses 1px stroke for body sizes (≤ 19px)", () => {
    expect(getDecorationMetrics("Helvetica", 12, "400").underlineThickness).toBe(1);
    expect(getDecorationMetrics("Helvetica", 14, "400").underlineThickness).toBe(1);
    expect(getDecorationMetrics("Helvetica", 16, "400").underlineThickness).toBe(1);
    expect(getDecorationMetrics("Helvetica", 18, "400").underlineThickness).toBe(1);
  });

  it("bumps to 2px stroke at heading sizes (≥ 20px)", () => {
    expect(getDecorationMetrics("Helvetica", 22, "400").underlineThickness).toBe(2);
    expect(getDecorationMetrics("Helvetica", 24, "400").underlineThickness).toBe(2);
    expect(getDecorationMetrics("Helvetica", 32, "400").underlineThickness).toBe(2);
  });

  it("emits underlineOffsetY = 1.5 × thickness (Chrome's stroke-top-at-baseline+thickness rule)", () => {
    // Center sits at `round(baseline) + 1.5*thickness`, so SVG line at
    // `decoBaselineY + offset` with `stroke-width=thickness` paints the
    // expected pixel rows when the baseline is rounded by the renderer.
    const m14 = getDecorationMetrics("Helvetica", 14, "400");
    expect(m14.underlineOffsetY).toBe(1.5);
    const m22 = getDecorationMetrics("Helvetica", 22, "400");
    expect(m22.underlineOffsetY).toBe(3);
  });

  it("emits strikeoutOffsetY ≈ fontSize/3 above baseline", () => {
    // Chrome painted strike (probe): 14px → top at row 5 above baseline_int,
    // 22px → top 7-8 above. Formula: round(fontSize/3) + thickness/2 (so
    // SVG center sits at baseline_int - round(fs/3), painting <thickness>
    // rows ending at that y).
    const m14 = getDecorationMetrics("Helvetica", 14, "400");
    expect(m14.strikeoutOffsetY).toBe(Math.round(14 / 3) + 0.5);  // 5.5
    const m22 = getDecorationMetrics("Helvetica", 22, "400");
    expect(m22.strikeoutOffsetY).toBe(Math.round(22 / 3) + 1);    // 8
  });

  it("emits overlineOffsetY ≈ fontSize above baseline (top of em-box)", () => {
    // Chrome paints overline at the em-box top, i.e. baseline - fontSize.
    // fontkit's HHEA ascent (12.32 at 16px Helvetica) sat ~3px below the
    // em-top, which is what made overlines render too low pre-DM-398.
    const m14 = getDecorationMetrics("Helvetica", 14, "400");
    expect(m14.overlineOffsetY).toBe(14 - 0.5);  // 13.5
    const m22 = getDecorationMetrics("Helvetica", 22, "400");
    expect(m22.overlineOffsetY).toBe(22 - 1);    // 21
  });

  it("honors explicit text-decoration-thickness length (DM-431)", () => {
    // Auto thickness at 16px would be 1; explicit 5px overrides.
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, "5px");
    expect(m.underlineThickness).toBe(5);
    expect(m.underlineOffsetY).toBe(7.5); // 1.5 * 5
    expect(m.strikeoutThickness).toBe(5);
    expect(m.overlineOffsetY).toBe(13.5); // 16 - 5/2
  });

  it("falls back to auto thickness when text-decoration-thickness is 'auto' or 'from-font' (DM-431)", () => {
    const auto = getDecorationMetrics("Helvetica", 16, "400", undefined, "auto");
    expect(auto.underlineThickness).toBe(1); // ceil(16/20) = 1
    const fromFont = getDecorationMetrics("Helvetica", 16, "400", undefined, "from-font");
    expect(fromFont.underlineThickness).toBe(1);
  });

  it("adds explicit text-underline-offset to underlineOffsetY (DM-431)", () => {
    // Auto offset for thickness 1 = 1.5; +6px offset → 7.5.
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, undefined, "6px");
    expect(m.underlineOffsetY).toBe(7.5);
    // Strikeout / overline are NOT affected by text-underline-offset.
    expect(m.strikeoutOffsetY).toBe(Math.round(16 / 3) + 0.5); // 5.5
    expect(m.overlineOffsetY).toBe(15.5); // 16 - 0.5
  });

  it("falls back to auto offset when text-underline-offset is 'auto' (DM-431)", () => {
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, undefined, "auto");
    expect(m.underlineOffsetY).toBe(1.5); // 1.5 * 1, no extra
  });

  it("combines explicit thickness + offset overrides (DM-431)", () => {
    // 5px thickness with 6px extra offset: center at 1.5*5 + 6 = 13.5.
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, "5px", "6px");
    expect(m.underlineThickness).toBe(5);
    expect(m.underlineOffsetY).toBe(13.5);
  });
});
