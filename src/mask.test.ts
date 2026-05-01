import { describe, expect, it } from "vitest";
import { buildMaskDef } from "./dom-to-svg.js";

// Locks the SVG <mask> emission for the cases exercised by the html-test
// suite's 23-mask.html fixture (DM-395).

describe("buildMaskDef — single-layer gradient masks (DM-395)", () => {
  it("linear-gradient mask renders as mask-type=alpha with absolute-coord gradient", () => {
    const r = buildMaskDef("m", "linear-gradient(to right, black, transparent)",
      0, 0, 180, 120, "match-source", "auto", "0% 0%", "repeat", "add");
    expect(r.def).toContain('mask-type="alpha"');
    // userSpaceOnUse so the gradient angle isn't distorted by the box aspect
    // ratio on non-square elements (DM-395).
    expect(r.def).toContain('gradientUnits="userSpaceOnUse"');
    expect(r.def).toContain("<linearGradient");
    expect(r.def).toContain('width="180"');
    expect(r.def).toContain('height="120"');
  });

  it("45deg gradient on a non-square box uses real-px endpoints (DM-395)", () => {
    // CSS spec: gradient line length L = |W·sin α| + |H·cos α| with endpoints
    // at center ± L/2 along the angle. For 45° on a 180×120 box: L ≈ 212.13,
    // start at (15, 135), end at (165, -15) relative to the box's top-left.
    // Element offset elX=elY=0 here, so absolute coords are the same.
    const r = buildMaskDef("m", "linear-gradient(45deg, black, transparent)",
      0, 0, 180, 120, "match-source", "auto", "0% 0%", "repeat", "add");
    expect(r.def).toContain('x1="15"');
    expect(r.def).toContain('y1="135"');
    expect(r.def).toContain('x2="165"');
    expect(r.def).toContain('y2="-15"');
  });

  it("radial-gradient mask centers correctly when sized + positioned", () => {
    // mask-image: radial-gradient(circle, black 40%, transparent 40%);
    // mask-size: 80px; mask-position: 25% 25%
    // Element at (680, 240); mask should be at gx=680+25, gy=240+10, 80x80.
    const r = buildMaskDef("m", "radial-gradient(circle, black 40%, transparent 40%)",
      680, 240, 180, 120, "match-source", "80px", "25% 25%", "no-repeat", "add");
    expect(r.def).toContain('x="705"');
    expect(r.def).toContain('y="250"');
    expect(r.def).toContain('width="80"');
    expect(r.def).toContain('height="80"');
    // Center of the 80x80 mask box: cx=745, cy=290.
    expect(r.def).toMatch(/cx="745"/);
    expect(r.def).toMatch(/cy="290"/);
    // farthest-corner radius = sqrt(40^2 + 40^2) ≈ 56.5685.
    expect(r.def).toMatch(/r="56\.5685"/);
  });

  it("mask-mode: alpha emits mask-type='alpha'", () => {
    const r = buildMaskDef("m", "linear-gradient(45deg, black, transparent)",
      0, 0, 180, 120, "alpha", "auto", "0% 0%", "repeat", "add");
    expect(r.def).toContain('mask-type="alpha"');
  });

  it("mask-mode: luminance emits mask-type='luminance'", () => {
    const r = buildMaskDef("m", "linear-gradient(45deg, white, black)",
      0, 0, 180, 120, "luminance", "auto", "0% 0%", "repeat", "add");
    expect(r.def).toContain('mask-type="luminance"');
  });

  it("match-source resolves to alpha for gradient sources (the common case)", () => {
    // Per the buildMaskDef comment block: 'match-source' is alpha for
    // gradients and bitmap-sourced url() masks. Only explicit 'luminance'
    // opts into luminance interpretation.
    const r = buildMaskDef("m", "radial-gradient(circle, black, transparent)",
      0, 0, 100, 100, "match-source", "auto", "0% 0%", "no-repeat", "add");
    expect(r.def).toContain('mask-type="alpha"');
  });
});

describe("buildMaskDef — composite (DM-395)", () => {
  it("composite=add (default) flattens layers into one <mask>", () => {
    const r = buildMaskDef("m",
      "linear-gradient(to right, black, transparent), radial-gradient(circle, black, transparent)",
      0, 0, 180, 120, "match-source", "auto", "0% 0%", "no-repeat", "add");
    // One <mask> with two gradient defs + two filled rects (additive).
    expect((r.def.match(/<mask\s/g) ?? []).length).toBe(1);
    expect((r.def.match(/<linearGradient/g) ?? []).length).toBe(1);
    expect((r.def.match(/<radialGradient/g) ?? []).length).toBe(1);
  });

  it("composite=intersect chains layers via mask=url(#inner) refs", () => {
    // Mirrors the 'composite: intersect' fixture case:
    // mask-image: linear-gradient(to right, black, transparent), radial-gradient(circle, black 50%, transparent 50%);
    // mask-composite: intersect, intersect;
    // mask-size: auto, 100px;
    // mask-position: 0 0, center;
    const r = buildMaskDef("m",
      "linear-gradient(to right, black, transparent), radial-gradient(circle, black 50%, transparent 50%)",
      0, 0, 180, 120, "match-source", "auto, 100px", "0px 0px, 50% 50%",
      "no-repeat, no-repeat", "intersect, intersect");
    // Two distinct mask elements: outer 'm' + inner 'm i1'.
    expect((r.def.match(/<mask\s/g) ?? []).length).toBe(2);
    expect(r.def).toContain('id="m"');
    expect(r.def).toContain('id="mi1"');
    // The outer mask's painted rect should reference the inner mask.
    expect(r.def).toMatch(/fill="url\(#mg0\)"\s*mask="url\(#mi1\)"/);
  });
});

describe("buildMaskDef — url() sources (DM-395)", () => {
  it("SVG url() mask emits an empty mask (forceHide), matching Chrome's observed behavior", () => {
    // Chrome's SVG mask source resolves to luminance and most icon SVGs
    // compute near-zero luminance over the tile, so the element is hidden.
    // We deliberately emit an empty mask to reproduce that.
    const r = buildMaskDef("m", 'url("assets/img-orange.svg")',
      0, 0, 180, 120, "match-source", "contain", "50% 50%", "no-repeat", "add");
    expect(r.def).toMatch(/<mask[^>]*><\/mask>/);
    // Mask exists (so the element gets force-hidden).
    expect(r.def).not.toBe("");
  });
});
