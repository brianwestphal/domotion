import { describe, expect, it } from "vitest";
import { fallbackFontChain, renderTextAsPath, resolveFontKey } from "./text-to-path.js";

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
    expect(resolveFontKey("Times New Roman")).toBe("times");
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
    // Geometric Shapes block (U+25A0..25FF).
    expect(fallbackFontChain(0x25A0)).toEqual(["cjk", "hiragino-jp", "symbols"]);
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
});

describe("fallbackFontChain: Arrows-block routing (DM-296)", () => {
  // Chrome on macOS paints ← → ↗ ↙ at 24px @24px font-size (matching
  // Hiragino W6's CJK em-square glyph). Apple Symbols paints them at
  // 15-17px which renders visibly thinner. Lock the cjk-first routing
  // for these four codepoints. Other arrows (↑↓↔↦⇒…) stay on Apple
  // Symbols because Hiragino either lacks the glyph or paints it at a
  // different width than Chrome.
  it("routes ← → ↗ ↙ to cjk-first (matches Chrome's painted width)", () => {
    expect(fallbackFontChain(0x2190)).toEqual(["cjk", "symbols"]);
    expect(fallbackFontChain(0x2192)).toEqual(["cjk", "symbols"]);
    expect(fallbackFontChain(0x2197)).toEqual(["cjk", "symbols"]);
    expect(fallbackFontChain(0x2199)).toEqual(["cjk", "symbols"]);
  });

  it("keeps the rest of the Arrows block on Apple Symbols", () => {
    expect(fallbackFontChain(0x2191)).toEqual(["symbols"]);
    expect(fallbackFontChain(0x2193)).toEqual(["symbols"]);
    expect(fallbackFontChain(0x2194)).toEqual(["symbols"]);
    expect(fallbackFontChain(0x21D2)).toEqual(["symbols"]);
    expect(fallbackFontChain(0x21D4)).toEqual(["symbols"]);
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
