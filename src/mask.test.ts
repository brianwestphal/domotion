import { describe, expect, it, vi } from "vitest";
import { buildMaskDef, maskPaintAreas, positionFragmentMaskDef, rewriteFragmentMaskDef } from "./render/element-tree-to-svg.js";
import { positionFragmentClipPathDef, positionObjectBoundingBoxClipPathDef } from "./render/mask.js";

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
    // Element at (680, 240, 180x120). DM-679: single-length mask-size is
    // `width=80, height=auto`. For gradient layers (no intrinsic size)
    // `auto` resolves to the container's corresponding axis per CSS
    // Backgrounds 3 §3.7 + CSS Images 3 §6.2 — so the gradient box is
    // 80×120 (height = container 120), not 80×80. Position 25% 25% then
    // gives gx=680 + 0.25*(180-80)=705 and gy=240 + 0.25*(120-120)=240.
    const r = buildMaskDef("m", "radial-gradient(circle, black 40%, transparent 40%)",
      680, 240, 180, 120, "match-source", "80px", "25% 25%", "no-repeat", "add");
    expect(r.def).toContain('x="705"');
    expect(r.def).toContain('y="240"');
    expect(r.def).toContain('width="80"');
    expect(r.def).toContain('height="120"');
    // Center of the 80x120 mask box: cx=745, cy=300.
    expect(r.def).toMatch(/cx="745"/);
    expect(r.def).toMatch(/cy="300"/);
    // farthest-corner radius = sqrt(40^2 + 60^2) ≈ 72.111.
    expect(r.def).toMatch(/r="72\.111"/);
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

describe("rewriteFragmentMaskDef — DM-493 same-document mask fragment refs", () => {
  it("rewrites the outer mask id to the requested output id", () => {
    const out = rewriteFragmentMaskDef(
      `<mask id="m1"><rect width="50" height="50" fill="white"/></mask>`,
      "f0-mkfrag0",
      "f0-",
    );
    expect(out).toContain('id="f0-mkfrag0"');
    expect(out).not.toContain('id="m1"');
  });

  it("rewrites nested ids with the idPrefix to keep them unique across captures", () => {
    const out = rewriteFragmentMaskDef(
      `<mask id="m1"><linearGradient id="g1"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient><rect fill="url(#g1)" width="50" height="50"/></mask>`,
      "f0-mkfrag0",
      "f0-",
    );
    expect(out).toContain('id="f0-mkfrag0"');
    expect(out).toContain('id="f0-fragid-g1"');
    expect(out).toContain('fill="url(#f0-fragid-g1)"');
    expect(out).not.toContain('id="g1"');
    expect(out).not.toContain("url(#g1)");
  });

  it("rewrites href / xlink:href fragment refs (transitive <use> targets)", () => {
    const out = rewriteFragmentMaskDef(
      `<mask id="m1"><defs><circle id="dot" r="10"/></defs><use href="#dot" x="20" y="20"/></mask>`,
      "f1-mkfrag2",
      "f1-",
    );
    expect(out).toContain('id="f1-mkfrag2"');
    expect(out).toContain('id="f1-fragid-dot"');
    expect(out).toContain('href="#f1-fragid-dot"');
    expect(out).not.toContain("#dot\"");
  });

  it("does not touch fragment refs that point at ids outside the captured subtree", () => {
    // External-to-mask url(#somethingElse) should pass through unchanged so
    // the renderer doesn't accidentally rewrite refs we didn't define.
    const out = rewriteFragmentMaskDef(
      `<mask id="m1"><rect fill="url(#externalGrad)" width="50" height="50"/></mask>`,
      "f0-mkfrag0",
      "f0-",
    );
    expect(out).toContain("url(#externalGrad)");
  });

  it("multiple references to the same captured fragment share a single output id (deduped)", () => {
    // Sanity check the rewrite is stable: invoking twice with the same
    // outputId yields identical markup. Stable mapping is what lets the
    // renderer dedupe when many elements reference the same fragment.
    const a = rewriteFragmentMaskDef(`<mask id="m1"><rect width="10" height="10" fill="white"/></mask>`, "f-mkfrag0", "f-");
    const b = rewriteFragmentMaskDef(`<mask id="m1"><rect width="10" height="10" fill="white"/></mask>`, "f-mkfrag0", "f-");
    expect(a).toBe(b);
  });
});

describe("objectBoundingBox clip-path materialization (DM-2362)", () => {
  it("maps normalized geometry through the HTML consumer border box", () => {
    const out = positionObjectBoundingBoxClipPathDef(
      `<clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath>`,
      20, 30, 200, 100,
    );
    expect(out).toContain(`clipPathUnits="userSpaceOnUse"`);
    expect(out).toContain(`transform="translate(20, 30) scale(200, 100)"`);
    expect(out).not.toContain(`clipPathUnits="objectBoundingBox"`);
  });

  it("keeps the source clipPath transform outermost, matching Blink's matrix product", () => {
    const out = positionObjectBoundingBoxClipPathDef(
      `<clipPath id='c' clipPathUnits='objectBoundingBox' transform='rotate(8)'><path d='M0 0H1V1Z'/></clipPath>`,
      5, 7, 40, 60,
    );
    expect(out).toContain(`transform="rotate(8) translate(5, 7) scale(40, 60)"`);
    expect(out).toContain(`clipPathUnits="userSpaceOnUse"`);
  });

  it("scales HTML userSpaceOnUse coordinates by the consumer's effective zoom", () => {
    const out = positionFragmentClipPathDef(
      `<clipPath id="c" clipPathUnits="userSpaceOnUse"><rect x="10" width="20" height="30"/></clipPath>`,
      40, 55, 2,
    );
    expect(out).toContain(`transform="translate(40, 55) scale(2)"`);
  });
});

describe("positionFragmentMaskDef — DM-493 per-element mask placement", () => {
  it("translates the mask content into the masked element's user-space", () => {
    // CSS mask-image positions the mask source at the masked element's
    // content-box origin. The captured <mask> has its content in its own
    // local coordinates; we wrap the children in a translate(elX, elY) and
    // rewrite the mask's own bounds to match the masked element's box.
    const out = positionFragmentMaskDef(
      `<mask id="mkfrag0" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="white"/></mask>`,
      236, 20, 200, 120,
    );
    expect(out).toContain('x="236"');
    expect(out).toContain('y="20"');
    expect(out).toContain('width="200"');
    expect(out).toContain('height="120"');
    expect(out).toContain("transform=\"translate(236, 20)\"");
    // Original captured bounds (x=0/y=0/width=100/height=100) should not
    // remain on the outer mask — those were the source-mask bounds, not the
    // target element's.
    expect(out).not.toMatch(/<mask[^>]*\sx="0"/);
  });

  it("forces maskUnits=userSpaceOnUse so the rewritten coords are interpreted absolutely", () => {
    const out = positionFragmentMaskDef(
      `<mask id="m" maskUnits="objectBoundingBox" x="0" y="0" width="1" height="1"><rect x="0.1" y="0.1" width="0.8" height="0.8" fill="white"/></mask>`,
      0, 0, 200, 120,
    );
    expect(out).toContain('maskUnits="userSpaceOnUse"');
    expect(out).not.toContain('maskUnits="objectBoundingBox"');
  });

  it("materializes objectBoundingBox region and content units against the exact consumer box", () => {
    const out = positionFragmentMaskDef(
      `<mask id="m" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox"><rect x="0" y="0" width=".5" height="1" fill="white"/></mask>`,
      70, 45, 120, 80,
      {
        maskUnits: "objectBoundingBox",
        maskContentUnits: "objectBoundingBox",
        maskType: "luminance",
        region: { x: "-10%", y: "0", width: "1.2", height: "100%" },
      },
    );
    expect(out).toContain('x="58"');
    expect(out).toContain('y="45"');
    expect(out).toContain('width="144"');
    expect(out).toContain('height="80"');
    expect(out).toContain('transform="translate(70, 45) scale(120, 80)"');
    expect(out).toContain('style="mask-type:luminance"');
    expect(out).not.toContain('maskContentUnits="objectBoundingBox"');
  });

  it("uses source-viewport-resolved userSpaceOnUse bounds and bakes an alpha override", () => {
    const out = positionFragmentMaskDef(
      `<mask id="m" maskUnits="userSpaceOnUse" style="color-interpolation:sRGB;mask-type:luminance"><rect width="80" height="60" fill="black"/></mask>`,
      31, 47, 80, 60,
      {
        maskUnits: "userSpaceOnUse",
        maskContentUnits: "userSpaceOnUse",
        maskType: "alpha",
        region: { x: "10%", y: "5", width: "50%", height: "40" },
        userSpaceRegion: { x: 16, y: 5, width: 80, height: 40 },
      },
    );
    expect(out).toContain('x="47"');
    expect(out).toContain('y="52"');
    expect(out).toContain('width="80"');
    expect(out).toContain('height="40"');
    expect(out).toContain('transform="translate(31, 47)"');
    expect(out).toContain('style="color-interpolation:sRGB;mask-type:alpha"');
    expect(out).not.toContain('mask-type:luminance');
  });

  it("scales user-space mask region and content by effective zoom exactly once", () => {
    const out = positionFragmentMaskDef(
      `<mask id="m"><rect width="40" height="30" fill="black"/></mask>`,
      30, 40, 80, 60,
      {
        maskUnits: "userSpaceOnUse",
        maskContentUnits: "userSpaceOnUse",
        maskType: "alpha",
        effectiveZoom: 2,
        region: { x: "10", y: "0", width: "20", height: "30" },
        userSpaceRegion: { x: 10, y: 0, width: 20, height: 30 },
      },
    );
    expect(out).toContain('x="50"');
    expect(out).toContain('y="40"');
    expect(out).toContain('width="40"');
    expect(out).toContain('height="60"');
    expect(out).toContain('transform="translate(30, 40) scale(2)"');
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

describe("buildMaskDef — element() paint refs (DM-494)", () => {
  function makeRaster(id: string, w = 64, h = 64) {
    return new Map([[id, {
      id, rid: "mr0", width: w, height: h,
      dataUri: "data:image/png;base64,iVBORw0KGgo=",
      rect: { x: 0, y: 0, width: w, height: h },
    }]]);
  }

  it("element() ref emits an <image> inside the <mask> with mask-type=luminance under match-source", () => {
    // CSS Masking spec: mask-mode: match-source resolves to luminance for
    // element() paint references — the painted RGB drives mask alpha.
    const rasters = makeRaster("src", 200, 100);
    const r = buildMaskDef("m", "element(#src)",
      0, 0, 200, 100, "match-source", "auto", "0% 0%", "no-repeat", "add", rasters);
    expect(r.def).toContain('mask-type="luminance"');
    expect(r.def).toContain('<image href="data:image/png;base64,iVBORw0KGgo="');
    expect(r.def).toContain('width="200"');
    expect(r.def).toContain('height="100"');
  });

  it("element() with explicit mask-mode: alpha respects the author override", () => {
    const rasters = makeRaster("src", 200, 100);
    const r = buildMaskDef("m", "element(#src)",
      0, 0, 200, 100, "alpha", "auto", "0% 0%", "no-repeat", "add", rasters);
    expect(r.def).toContain('mask-type="alpha"');
  });

  it("element() with mask-size: contain emits Blink's concrete fitted rect", () => {
    // raster intrinsic 200x100; consumer 100x100. contain → fits = 100x50.
    const rasters = makeRaster("src", 200, 100);
    const r = buildMaskDef("m", "element(#src)",
      0, 0, 100, 100, "match-source", "contain", "0% 0%", "no-repeat", "add", rasters);
    expect(r.def).toContain('width="100"');
    expect(r.def).toContain('height="50"');
    expect(r.def).toContain('preserveAspectRatio="none"');
  });

  it("element() with mask-size: cover emits Blink's concrete fitted rect", () => {
    // raster 100x200; consumer 100x100. cover → 100x200 (height fills).
    const rasters = makeRaster("src", 100, 200);
    const r = buildMaskDef("m", "element(#src)",
      0, 0, 100, 100, "match-source", "cover", "0% 0%", "no-repeat", "add", rasters);
    expect(r.def).toContain('width="100"');
    expect(r.def).toContain('height="200"');
    expect(r.def).toContain('preserveAspectRatio="none"');
  });

  it("element() with no resolved raster (no dataUri) skips emission", () => {
    const empty = new Map<string, import("./capture/types.js").MaskRasterRef>();
    const r = buildMaskDef("m", "element(#src)",
      0, 0, 200, 100, "match-source", "auto", "0% 0%", "no-repeat", "add", empty);
    expect(r.def).toBe("");
  });

  it("element() ref with elementRasters undefined skips emission (legacy callers)", () => {
    const r = buildMaskDef("m", "element(#src)",
      0, 0, 200, 100, "match-source", "auto", "0% 0%", "no-repeat", "add");
    expect(r.def).toBe("");
  });

  it("mixed gradient + element() layers — luminance wins under match-source", () => {
    const rasters = makeRaster("src", 64, 64);
    const r = buildMaskDef("m",
      "linear-gradient(black, transparent), element(#src)",
      0, 0, 200, 100, "match-source", "auto, auto", "0% 0%, 0% 0%", "no-repeat, no-repeat", "add",
      rasters);
    // Any element() layer in match-source mode → mask-type=luminance.
    expect(r.def).toContain('mask-type="luminance"');
    // Both layers contribute content.
    expect(r.def).toContain("<linearGradient");
    expect(r.def).toContain('<image href="data:image/png');
  });
});

describe("buildMaskDef — exact contain/cover positioning (DM-2379)", () => {
  const png = 'url("data:image/png;base64,iVBORw0KGgo=")';

  it("does not bucket an interior percentage into SVG midpoint alignment", () => {
    const out = buildMaskDef(
      "m", png, 10, 20, 180, 120,
      "alpha", "contain", "23% 73%", "no-repeat", "add",
      undefined, [{ w: 200, h: 100 }],
    ).def;
    expect(out).toContain('x="10"');
    expect(out).toContain('y="41.8906"');
    expect(out).toContain('width="180"');
    expect(out).toContain('height="90"');
    expect(out).toContain('preserveAspectRatio="none"');
    expect(out).not.toMatch(/preserveAspectRatio="x(?:Min|Mid|Max)Y/);
  });

  it("keeps length and calc offsets exact on a cover tile", () => {
    const out = buildMaskDef(
      "m", png, 10, 20, 180, 120,
      "alpha", "cover", "17px calc(25% + 7px)", "no-repeat", "add",
      undefined, [{ w: 100, h: 200 }],
    ).def;
    expect(out).toContain('x="27"');
    expect(out).toContain('y="-33"');
    expect(out).toContain('width="180"');
    expect(out).toContain('height="360"');
  });

  it("cycles per-layer positions without sharing aspect or offset state", () => {
    const out = buildMaskDef(
      "m", `${png}, ${png}`, 0, 0, 180, 120,
      "alpha", "contain, cover", "23% 73%, calc(100% - 11px) 25%",
      "no-repeat, no-repeat", "add",
      undefined, [{ w: 200, h: 100 }, { w: 100, h: 200 }],
    ).def;
    expect(out).toContain('x="-11" y="-60" width="180" height="360"');
    expect(out).toContain('x="0" y="21.8906" width="180" height="90"');
  });

  it("reconstructs sliced horizontal and vertical fragment strips", () => {
    expect(maskPaintAreas(
      { x: 10, y: 20, width: 80, height: 40 },
      {
        fragments: [
          { x: 10, y: 20, width: 60, height: 20 },
          { x: 10, y: 40, width: 20, height: 20 },
        ],
        writingMode: "horizontal-tb",
        direction: "ltr",
        boxDecorationBreak: "slice",
        fragmentAxis: "inline",
      },
    )).toEqual([
      { x: 10, y: 20, width: 80, height: 20, clip: { x: 10, y: 20, width: 60, height: 20 } },
      { x: -50, y: 40, width: 80, height: 20, clip: { x: 10, y: 40, width: 20, height: 20 } },
    ]);
    expect(maskPaintAreas(
      { x: 10, y: 20, width: 40, height: 80 },
      {
        fragments: [
          { x: 30, y: 20, width: 20, height: 55 },
          { x: 10, y: 20, width: 20, height: 25 },
        ],
        writingMode: "vertical-rl",
        direction: "ltr",
        boxDecorationBreak: "slice",
        fragmentAxis: "inline",
      },
    )[1]).toEqual({
      x: 10, y: -35, width: 20, height: 80,
      clip: { x: 10, y: 20, width: 20, height: 25 },
    });
  });

  it("restarts contain geometry for cloned fragments", () => {
    expect(maskPaintAreas(
      { x: 0, y: 0, width: 100, height: 40 },
      {
        fragments: [
          { x: 0, y: 0, width: 60, height: 20 },
          { x: 0, y: 20, width: 40, height: 20 },
        ],
        boxDecorationBreak: "clone",
      },
    ).map(({ width, height }) => [width, height])).toEqual([[60, 20], [40, 20]]);
  });

  it("does not activate intrinsic fitting for an explicit mask-size", () => {
    const out = buildMaskDef(
      "m", png, 0, 0, 120, 90,
      "alpha", "40px 30px", "17px 9px", "no-repeat", "add",
    ).def;
    expect(out).toContain('x="17" y="9" width="40" height="30"');
  });

  it("uses a transparent layer instead of the retired alignment guess when intrinsic facts are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = buildMaskDef(
        "m", png, 0, 0, 120, 90,
        "alpha", "contain", "23% 73%", "no-repeat", "add",
      ).def;
      expect(out).toContain('fill="transparent"');
      expect(out).not.toContain("<image");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("requires captured mask intrinsic dimensions"));
    } finally {
      warn.mockRestore();
    }
  });
});
