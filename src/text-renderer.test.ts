import { describe, expect, it } from "vitest";
import { rasterGlyphOverlays, renderSingleLineText } from "./text-renderer.js";
import type { CapturedElement } from "./dom-to-svg.js";

describe("rasterGlyphOverlays — emoji bitmap sizing (DM-381)", () => {
  // The captured per-char rect spans the line-box height (~lineHeight) and
  // the glyph advance — bigger than what Chrome actually paints, which is
  // the em-square (fontSize × fontSize) anchored to the baseline. The
  // overlay emits the bitmap at em-square size centered in the rect so the
  // <image> dims match Chrome's painted region instead of being stretched
  // out to the full line-box.
  const seg: any = {
    text: "😀",
    x: 347.7, y: 695.4, width: 23, height: 25,
    rasterGlyphs: [{
      charIndex: 0,
      rect: { x: 347.7, y: 695.4, width: 23, height: 25 },
      dataUri: "data:image/png;base64,iVBORw0KGgo="
    }]
  };

  it("emits the bitmap at the captured rect coords + dims (DM-401 / DM-411 / DM-414)", () => {
    // The screenshot was captured from Chrome's actual paint at this rect,
    // so re-embedding at the same coords + dims preserves the painted
    // geometry pixel-for-pixel. Avoid the prior em-square-stretch which
    // squished tall line-box rects horizontally and rendered emojis
    // visibly larger than Chrome's actual paint.
    const out = rasterGlyphOverlays(seg, 22, "ct1");
    expect(out).toContain('x="347.7"');
    expect(out).toContain('y="695.4"');
    expect(out).toContain('width="23"');
    expect(out).toContain('height="25"');
    expect(out).toContain('preserveAspectRatio="none"');
  });

  it("ignores fontSize for sizing — the captured rect dims are authoritative", () => {
    const segWithFs: any = { ...seg, fontSize: 32 };
    const out = rasterGlyphOverlays(segWithFs, 16, "ct1");
    expect(out).toContain('width="23"');
    expect(out).toContain('height="25"');
  });

  it("returns empty when there are no resolved dataUris", () => {
    const empty: any = { ...seg, rasterGlyphs: [{ charIndex: 0, rect: seg.rect, dataUri: undefined }] };
    expect(rasterGlyphOverlays(empty, 22, "ct1")).toBe("");
  });

  it("returns empty when the segment has no rasterGlyphs at all", () => {
    expect(rasterGlyphOverlays({ ...seg, rasterGlyphs: undefined }, 22, "ct1")).toBe("");
  });
});

describe("renderSingleLineText — pseudo-only segment positioning (DM-495)", () => {
  // When a host element has no main text and only a positioned ::after / ::before
  // pseudo, the segment carries its own x/y/color/fontSize. Before DM-495 the
  // single-segment path read host-level fields exclusively, so the pseudo's
  // text was emitted at translate(0,0) in the host's color (typically the
  // inherited default black) instead of at the pseudo's anchor in its own
  // CSS-declared color. Capture sets host textLeft/textTop/textWidth from
  // the pseudo seg in this case, and the renderer reads seg.color /
  // seg.fontSize / seg.fontWeight / seg.fontAscent so all per-pseudo
  // overrides flow through.
  const baseStyles = {
    color: "rgb(0,0,0)",
    fontSize: "16px",
    fontFamily: "-apple-system, sans-serif",
    fontWeight: "400",
    fontStyle: "normal",
    direction: "ltr",
    textDecorationLine: "none",
    textDecorationColor: "currentcolor",
    textDecorationStyle: "solid",
  } as any;

  const makeEl = (seg: any): CapturedElement => ({
    tag: "span",
    x: 100, y: 50, width: 200, height: 80,
    textLeft: seg.x, textTop: seg.y, textWidth: seg.width, textHeight: seg.height,
    fontAscent: seg.fontAscent,
    text: seg.text,
    textSegments: [seg],
    styles: baseStyles,
  } as any);

  it("renders the pseudo's own color, not the host's color", () => {
    const seg = {
      text: "TAG",
      x: 108, y: 56, width: 22, height: 11,
      color: "rgb(255, 255, 255)",
      fontSize: 11,
      fontWeight: "400",
      fontAscent: 9,
    };
    const out = renderSingleLineText({
      el: makeEl(seg),
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(0,0,0)",
    });
    expect(out).toContain('fill="rgb(255, 255, 255)"');
    expect(out).not.toContain('fill="rgb(0,0,0)"');
  });

  it("anchors the path at the pseudo's x/y, not at the SVG origin", () => {
    const seg = {
      text: "TAG",
      x: 108, y: 56, width: 22, height: 11,
      color: "rgb(255, 255, 255)",
      fontSize: 11,
      fontWeight: "400",
      fontAscent: 9,
    };
    const out = renderSingleLineText({
      el: makeEl(seg),
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(0,0,0)",
    });
    // baselineY = textTop + fontAscent = 56 + 9 = 65
    expect(out).toMatch(/transform="translate\(108,\s*65\)"/);
    expect(out).not.toContain('translate(0,0)');
  });

  it("uses the pseudo's fontSize when set, not the host's", () => {
    const seg = {
      text: "T",
      x: 108, y: 56, width: 8, height: 11,
      color: "rgb(255, 255, 255)",
      fontSize: 11,
      fontWeight: "400",
      fontAscent: 9,
    };
    // Host fontSize is 16, pseudo is 11 — output should reflect 11px scale.
    const elWithLargerHost = { ...makeEl(seg), styles: { ...baseStyles, fontSize: "16px" } } as any;
    const outAt11 = renderSingleLineText({
      el: elWithLargerHost,
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(0,0,0)",
    });
    // The inner glyph scale = fontSize / unitsPerEm. For typical fonts (UPM
    // ~2048), 11/2048 ≈ 0.00537; 16/2048 ≈ 0.00781. Spot-check the small one.
    expect(outAt11).toMatch(/scale\(0\.00[0-9]+,/);
    // Negative comparison: the host-fontSize scale shouldn't appear.
    expect(outAt11).not.toContain('scale(0.00781,');
  });

  it("falls back to host fillColor when seg.color is absent", () => {
    const seg = {
      text: "TAG",
      x: 108, y: 56, width: 22, height: 11,
      fontAscent: 9,
    };
    const out = renderSingleLineText({
      el: makeEl(seg),
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(34, 139, 34)",
    });
    expect(out).toContain('fill="rgb(34, 139, 34)"');
  });
});
