// DM-2716: `system-font` render mode emits authored `<text>` carrying the
// source font-family stack and relies on the CONSUMER's installed fonts to
// paint it — no embedded `@font-face` subset, no glyph outlines. These tests
// pin the emitted markup shape and the run-anchor-only positioning contract.
import { afterEach, describe, expect, it } from "vitest";
import { renderTextAsPath, renderTextAsSystemFont, setRenderTextMode } from "./text-to-path.js";

afterEach(() => setRenderTextMode("embedded-font"));

describe("system-font render mode (renderTextAsPath funnel)", () => {
  it("emits a painted <text> with the authored family stack and no font embedding", () => {
    setRenderTextMode("system-font");
    const m = renderTextAsPath("Hello", 12, 20, {
      fontSize: 16,
      fontFamily: '"Helvetica Neue", Helvetica, sans-serif',
      fontWeight: "400",
      fill: "#111",
      ascentOverride: 8,
    });
    expect(m).toContain("<text ");
    expect(m).toContain('font-family="&quot;Helvetica Neue&quot;, Helvetica, sans-serif"');
    expect(m).toContain('fill="#111"');
    expect(m).toContain(">Hello</text>");
    // The whole point of the mode: no embedded subset, no glyph outlines.
    expect(m).not.toContain("@font-face");
    expect(m).not.toContain("<path");
    expect(m).not.toContain("dmf"); // generated embedded-subset family prefix
  });

  it("anchors at the run origin x and the ascent-derived baseline (run-anchor-only)", () => {
    setRenderTextMode("system-font");
    const m = renderTextAsPath("Ag", 12, 20, {
      fontSize: 16,
      fontFamily: "Arial",
      fontWeight: "400",
      fill: "#000",
      ascentOverride: 13,
    });
    // Single x/y — no per-character position list.
    expect(m).toMatch(/<text x="12" y="33"/); // baseline = y(20) + ascentOverride(13)
    expect(m).not.toMatch(/x="[\d.]+ [\d.]+/); // no space-separated x list
  });

  it("falls back to a size-relative baseline when no ascent was captured", () => {
    setRenderTextMode("system-font");
    const m = renderTextAsSystemFont("x", 0, 10, {
      fontSize: 20,
      fontFamily: "Arial",
      fontWeight: "400",
      fill: "#000",
    });
    expect(m).toContain('y="26"'); // 10 + 20*0.8
  });

  it("emits font-weight / font-style / font-stretch only when non-default", () => {
    setRenderTextMode("system-font");
    const bold = renderTextAsSystemFont("x", 0, 0, {
      fontSize: 16,
      fontFamily: "Arial",
      fontWeight: "700",
      fontStyle: "italic",
      fontStretch: "75%",
      fill: "#000",
      ascentOverride: 0,
    });
    expect(bold).toContain('font-weight="700"');
    expect(bold).toContain('font-style="italic"');
    expect(bold).toContain('font-stretch="75%"');

    const plain = renderTextAsSystemFont("x", 0, 0, {
      fontSize: 16,
      fontFamily: "Arial",
      fontWeight: "400",
      fontStyle: "normal",
      fontStretch: "100%",
      fill: "#000",
      ascentOverride: 0,
    });
    expect(plain).not.toContain("font-weight");
    expect(plain).not.toContain("font-style");
    expect(plain).not.toContain("font-stretch");
  });

  it("maps -webkit-text-stroke to stroke + paint-order", () => {
    setRenderTextMode("system-font");
    const m = renderTextAsSystemFont("x", 0, 0, {
      fontSize: 40,
      fontFamily: "Arial",
      fontWeight: "400",
      fill: "#fff",
      textStrokeWidth: 2,
      textStrokeColor: "#000",
      paintOrder: "stroke fill",
      ascentOverride: 0,
    });
    expect(m).toContain('stroke="#000"');
    expect(m).toContain('stroke-width="2"');
    expect(m).toContain('paint-order="stroke fill"');
  });

  it("emits direction/unicode-bidi so the browser owns bidi reordering", () => {
    setRenderTextMode("system-font");
    const rtl = renderTextAsSystemFont("abc", 0, 0, {
      fontSize: 16,
      fontFamily: "Arial",
      fontWeight: "400",
      fill: "#000",
      ascentOverride: 0,
      bidiOverride: { direction: "rtl", unicodeBidi: "normal" },
    });
    expect(rtl).toContain('direction="rtl"');
    expect(rtl).not.toContain("unicode-bidi");

    const override = renderTextAsSystemFont("abc", 0, 0, {
      fontSize: 16,
      fontFamily: "Arial",
      fontWeight: "400",
      fill: "#000",
      ascentOverride: 0,
      bidiOverride: { direction: "ltr", unicodeBidi: "bidi-override" },
    });
    expect(override).toContain('unicode-bidi="bidi-override"');
  });

  it("escapes text content and returns empty for empty text", () => {
    setRenderTextMode("system-font");
    expect(
      renderTextAsSystemFont("", 0, 0, { fontSize: 16, fontFamily: "Arial", fontWeight: "400", fill: "#000" }),
    ).toBe("");
    const m = renderTextAsSystemFont("a < b & c", 0, 0, {
      fontSize: 16,
      fontFamily: "Arial",
      fontWeight: "400",
      fill: "#000",
      ascentOverride: 0,
    });
    expect(m).toContain(">a &lt; b &amp; c</text>");
  });
});
