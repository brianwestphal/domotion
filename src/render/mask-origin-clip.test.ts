import { describe, expect, it } from "vitest";
import { buildMaskDef } from "./mask.js";
import {
  normalizeHtmlMaskBox,
  resolveHtmlMaskReferenceBox,
  resolveMaskOriginClipLayer,
  type MaskOriginClipContext,
} from "./mask-origin-clip.js";

const context: MaskOriginClipContext = {
  originCss: "content-box, border-box",
  clipCss: "padding-box, no-clip, content-box",
  border: { top: 3, right: 5, bottom: 7, left: 11 },
  padding: { top: 13, right: 17, bottom: 19, left: 23 },
  noClipPaintingArea: { x: 0, y: 0, width: 400, height: 300 },
};
const borderBox = { x: 10, y: 20, width: 120, height: 90 };

describe("Blink HTML mask-origin/mask-clip geometry (DM-2472)", () => {
  it("contracts positioning and painting areas independently", () => {
    expect(resolveMaskOriginClipLayer(borderBox, 0, context)).toEqual({
      positioningArea: { x: 44, y: 36, width: 64, height: 48 },
      paintingArea: { x: 21, y: 23, width: 104, height: 80 },
      origin: "content-box",
      clip: "padding-box",
    });
  });

  it("cycles origin and clip lists independently and preserves no-clip", () => {
    expect(resolveMaskOriginClipLayer(borderBox, 1, context)).toEqual({
      positioningArea: borderBox,
      paintingArea: null,
      origin: "border-box",
      clip: "no-clip",
    });
    expect(resolveMaskOriginClipLayer(borderBox, 2, context)).toEqual({
      positioningArea: { x: 44, y: 36, width: 64, height: 48 },
      paintingArea: { x: 44, y: 36, width: 64, height: 48 },
      origin: "content-box",
      clip: "content-box",
    });
  });

  it("maps HTML fill/stroke/view aliases like Blink", () => {
    expect(normalizeHtmlMaskBox("fill-box", false)).toBe("content-box");
    expect(normalizeHtmlMaskBox("stroke-box", false)).toBe("border-box");
    expect(normalizeHtmlMaskBox("view-box", true)).toBe("border-box");
    expect(resolveHtmlMaskReferenceBox(borderBox, "fill-box", context.border, context.padding))
      .toEqual({ x: 44, y: 36, width: 64, height: 48 });
  });

  it("same-box negative control is invariant while the collapsed-box mutation moves ink", () => {
    const same = { ...context, originCss: "padding-box", clipCss: "padding-box" };
    const distinct = { ...context, originCss: "content-box", clipCss: "padding-box" };
    const sameResolved = resolveMaskOriginClipLayer(borderBox, 0, same);
    expect(sameResolved.positioningArea).toEqual(sameResolved.paintingArea);
    const distinctResolved = resolveMaskOriginClipLayer(borderBox, 0, distinct);
    // Retired mutation: resolve origin from clip. This must be observably wrong.
    const collapsedMutation = resolveMaskOriginClipLayer(borderBox, 0, same);
    expect(distinctResolved.positioningArea).not.toEqual(collapsedMutation.positioningArea);
    expect(distinctResolved.paintingArea).toEqual(collapsedMutation.paintingArea);
  });

  it("emits contain geometry from origin and clips it to a different box", () => {
    const png = 'url("data:image/png;base64,iVBORw0KGgo=")';
    const built = buildMaskDef(
      "m", png,
      borderBox.x, borderBox.y, borderBox.width, borderBox.height,
      "alpha", "contain", "100% 50%", "no-repeat", "add",
      undefined, [{ w: 2, h: 1 }], undefined,
      { ...context, originCss: "content-box", clipCss: "padding-box" },
    );
    // Content positioning area is 64x48. contain => 64x32, right aligned,
    // vertically centered at y=44. The independent padding-box clip survives.
    expect(built.def).toContain('x="44" y="44" width="64" height="32"');
    expect(built.def).toContain('<rect x="21" y="23" width="104" height="80"');
    expect(built.def).toContain('clip-path="url(#mfc0-0)"');
  });

  it("paints repeating layers across clip while anchoring their pattern to origin", () => {
    const png = 'url("data:image/png;base64,iVBORw0KGgo=")';
    const built = buildMaskDef(
      "m", png,
      borderBox.x, borderBox.y, borderBox.width, borderBox.height,
      "alpha", "16px 12px", "0% 0%", "repeat", "add",
      undefined, [{ w: 2, h: 1 }], undefined,
      { ...context, originCss: "content-box", clipCss: "border-box" },
    );
    expect(built.def).toMatch(/<pattern id="mp0"[^>]* x="44" y="36"/);
    expect(built.def).toContain('<rect x="10" y="20" width="120" height="90" fill="url(#mp0)"');
  });
});
