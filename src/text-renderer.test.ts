import { describe, expect, it } from "vitest";
import { rasterGlyphOverlays } from "./text-renderer.js";

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
