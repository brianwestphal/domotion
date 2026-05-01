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

  it("emits the bitmap at em-square size (fontSize × fontSize) centered in the rect", () => {
    const out = rasterGlyphOverlays(seg, 22, "ct1");
    // Center: x = 347.7 + (23 - 22) / 2 = 348.2, y = 695.4 + (25 - 22) / 2 = 696.9.
    expect(out).toContain('width="22"');
    expect(out).toContain('height="22"');
    expect(out).toContain('x="348.2"');
    expect(out).toContain('y="696.9"');
    // Stretches at exactly em-square — avoid `xMidYMid meet`'s implicit
    // letterboxing which over-shoots Chrome's painted bbox by ~1px on the
    // longer rect axis (the persistent diff DM-381 reported).
    expect(out).toContain('preserveAspectRatio="none"');
  });

  it("uses the segment's own fontSize when set, else the fallback", () => {
    const segWithFs: any = { ...seg, fontSize: 32 };
    const out = rasterGlyphOverlays(segWithFs, 16, "ct1");
    expect(out).toContain('width="32"');
  });

  it("returns empty when there are no resolved dataUris", () => {
    const empty: any = { ...seg, rasterGlyphs: [{ charIndex: 0, rect: seg.rect, dataUri: undefined }] };
    expect(rasterGlyphOverlays(empty, 22, "ct1")).toBe("");
  });

  it("returns empty when the segment has no rasterGlyphs at all", () => {
    expect(rasterGlyphOverlays({ ...seg, rasterGlyphs: undefined }, 22, "ct1")).toBe("");
  });
});
