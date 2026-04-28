import { describe, expect, it } from "vitest";
import { renderTextAsPath, resolveFontKey } from "./text-to-path.js";

// Pinned mappings for the CSS generic-family keywords. These exist to lock
// the fidelity-critical resolutions Chrome on macOS performs (per Blink's
// font_cache_mac.mm) — substituting any of these silently shifts every
// page's text metrics. See DM-236 (monospace was wrongly routed to SF Mono)
// and SK-1124 (sans-serif was wrongly routed to SF Pro).
describe("resolveFontKey: generic-family resolution", () => {
  it("routes sans-serif to Helvetica, not SF Pro", () => {
    expect(resolveFontKey("sans-serif")).toBe("helvetica");
    expect(resolveFontKey("ui-sans-serif")).toBe("helvetica");
  });

  it("routes monospace to Courier, not SF Mono or Menlo", () => {
    expect(resolveFontKey("monospace")).toBe("courier");
    expect(resolveFontKey("ui-monospace")).toBe("courier");
  });

  it("routes serif to Times, not Georgia", () => {
    expect(resolveFontKey("serif")).toBe("times");
    expect(resolveFontKey("ui-serif")).toBe("times");
  });

  it("routes system-ui / -apple-system / BlinkMacSystemFont to SF Pro", () => {
    expect(resolveFontKey("system-ui")).toBe("sf-pro");
    expect(resolveFontKey("-apple-system")).toBe("sf-pro");
    expect(resolveFontKey("BlinkMacSystemFont")).toBe("sf-pro");
  });

  it("routes cursive to Snell Roundhand", () => {
    expect(resolveFontKey("cursive")).toBe("snell");
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

describe("resolveFontKey: chain walking", () => {
  it("picks the first recognized name in the stack", () => {
    expect(resolveFontKey('"DoesNotExist", monospace')).toBe("courier");
    expect(resolveFontKey("DoesNotExist, Helvetica, sans-serif")).toBe("helvetica");
    expect(resolveFontKey("Menlo, Consolas, monospace")).toBe("menlo");
  });

  it("falls through to Helvetica when nothing matches (Chrome's macOS fallback)", () => {
    expect(resolveFontKey("Nothing-Installed-1, Nothing-Installed-2")).toBe("helvetica");
    expect(resolveFontKey("")).toBe("helvetica");
  });
});
