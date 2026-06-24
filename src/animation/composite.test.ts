import { describe, it, expect } from "vitest";
import { composeAnimatedLayers, dedupeCompositeFonts } from "./composite.js";

/** A minimal animated-SVG document with its own period and global names. */
function animatedDoc(periodS: number, idTag = "a"): string {
  const d = periodS.toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><style>.bar{animation:grow ${d}s linear infinite}@keyframes grow{0%{opacity:0}100%{opacity:1}}</style><rect id="r-${idTag}" class="bar" width="200" height="100"/></svg>`;
}
const staticDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#222"/></svg>`;

describe("composeAnimatedLayers (DM-1323)", () => {
  it("stacks layers z-ordered into one outer svg sized to the canvas", () => {
    const r = composeAnimatedLayers(
      [{ svg: staticDoc, x: 0, y: 0, width: 400, height: 300 }, { svg: animatedDoc(4), periodMs: 4000, x: 50, y: 40 }],
      { width: 400, height: 300 },
    );
    expect(r.width).toBe(400);
    expect(r.height).toBe(300);
    expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"')).toBe(true);
    // Two layer groups, bottom first.
    expect(r.svg.indexOf("c0_layer")).toBeLessThan(r.svg.indexOf("c1_layer"));
    // Each layer nested at its placement as a child <svg>.
    expect(r.svg).toContain('<svg x="50" y="40"');
  });

  it("namespaces each layer's global names so identical content can't collide", () => {
    const r = composeAnimatedLayers(
      [{ svg: animatedDoc(4, "x"), periodMs: 4000 }, { svg: animatedDoc(4, "x"), periodMs: 4000, x: 10 }],
      { width: 200, height: 100 },
    );
    // The reused id `r-x` and keyframe `grow` are prefixed per layer.
    expect(r.svg).toContain('id="c0_r-x"');
    expect(r.svg).toContain('id="c1_r-x"');
    expect(r.svg).toContain("@keyframes c0_grow");
    expect(r.svg).toContain("@keyframes c1_grow");
  });

  it("re-anchors a layer's internal timeline to its start within the master loop", () => {
    // Layer starts at 2000ms; master forced to 10000ms. Its 4s animation retimes
    // to the master period and its keyframes offset off the origin.
    const r = composeAnimatedLayers(
      [{ svg: animatedDoc(4), periodMs: 4000, start: 2000 }],
      { width: 200, height: 100, durationMs: 10000 },
    );
    expect(r.svg).toContain("animation:c0_grow 10s linear infinite");
    // leading 0% hold + the original 0% stop pushed to 20%.
    expect(r.svg).toMatch(/@keyframes c0_grow \{ 0% \{ opacity:0 \} 20% \{ opacity:0 \}/);
  });

  it("emits a layer-level animation on the layer group (move/scale)", () => {
    const r = composeAnimatedLayers(
      [{ svg: staticDoc, animations: [{ property: "scale", from: 1, to: 1.3, start: 6000, duration: 800, transformOrigin: "0 0" }] }],
      { width: 400, height: 300, durationMs: 10000 },
    );
    expect(r.svg).toContain("@keyframes c0_a0");
    expect(r.svg).toContain("transform:scale(1)");
    expect(r.svg).toContain("transform:scale(1.3)");
    expect(r.svg).toContain("transform-origin:0 0");
    // start 6000 / master 10000 → 60%; end 6800 → 68%.
    expect(r.svg).toMatch(/0%,\s*60%\{transform:scale\(1\)\}68%,\s*100%\{transform:scale\(1\.3\)\}/);
  });

  it("clipScaleX emits a clip-path with a scaleX-animated clip rect (resize the box, not the contents)", () => {
    const r = composeAnimatedLayers(
      [{ svg: staticDoc, x: 20, y: 30, width: 400, height: 300, clipRadius: 11,
         animations: [{ property: "clipScaleX", from: 1, to: 0.64, start: 6000, duration: 800, transformOrigin: "left" }] }],
      { width: 500, height: 400, durationMs: 10000 },
    );
    // A clipPath whose rect covers the layer box, referenced by the layer group.
    expect(r.svg).toContain('<clipPath id="c0_rclip" clipPathUnits="userSpaceOnUse">');
    expect(r.svg).toContain('<rect class="c0_clipper" x="20" y="30" width="400" height="300" rx="11"/>');
    expect(r.svg).toContain('clip-path="url(#c0_rclip)"');
    // The clip rect is transform-scaled (NOT the contents); origin at the left edge.
    expect(r.svg).toContain("transform:scale(1,1)");
    expect(r.svg).toContain("transform:scale(0.64,1)");
    expect(r.svg).toContain("transform-origin:left top");
  });

  it("computes the master from the longest layer end when duration is omitted", () => {
    const r = composeAnimatedLayers(
      [
        { svg: animatedDoc(3), periodMs: 3000 },
        { svg: staticDoc, animations: [{ property: "opacity", from: 0, to: 1, start: 5000, duration: 2000 }] },
      ],
      { width: 400, height: 300 },
    );
    // max(0+3000, 5000+2000) = 7000.
    expect(r.durationMs).toBe(7000);
  });

  it("leaves a static layer (no periodMs) untouched and just places it", () => {
    const r = composeAnimatedLayers([{ svg: staticDoc, x: 5, y: 6, width: 100, height: 75 }], { width: 400, height: 300 });
    expect(r.svg).toContain('<svg x="5" y="6" width="100" height="75"');
    expect(r.svg).toContain('fill="#222"');
  });

  it("dedupes byte-identical embedded fonts across layers (DM-1329)", () => {
    // Two layers (tokens c0_/c1_) carry the same font payload under namespaced
    // family names — the renderer emits identical base64 for identical glyph sets.
    const face = (fam: string) => `@font-face { font-family: "${fam}"; font-style: normal; font-weight: 400; src: url("data:font/ttf;base64,AAAABBBBCCCCDDDD"); }`;
    const svg =
      `<svg><style>${face("c0_dmf0")}</style><style>${face("c1_dmf0")}</style>` +
      `<text font-family="c0_dmf0">a</text><text font-family="c1_dmf0">b</text>` +
      `<g style="font-family:&quot;c1_dmf0&quot;"></g></svg>`;
    const out = dedupeCompositeFonts(svg);
    // One @font-face survives; the duplicate is removed.
    expect((out.match(/@font-face/g) ?? []).length).toBe(1);
    // The removed family's references are repointed at the survivor.
    expect(out).not.toContain('font-family="c1_dmf0"');
    expect(out.match(/font-family="c0_dmf0"/g)?.length).toBe(2);
  });

  it("leaves distinct font payloads untouched", () => {
    const svg = `<svg><style>@font-face { font-family: "c0_dmf0"; src: url("data:font/ttf;base64,AAAA"); }@font-face { font-family: "c1_dmf0"; src: url("data:font/ttf;base64,BBBB"); }</style></svg>`;
    expect(dedupeCompositeFonts(svg)).toBe(svg);
  });

  it("deferFonts keeps a layer's dmfN families un-prefixed and emits fontFaceCss once (DM-1331)", () => {
    const fontDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><text font-family="dmf0">hi</text></svg>`;
    const r = composeAnimatedLayers(
      [{ svg: fontDoc, deferFonts: true, x: 0, y: 0 }],
      { width: 200, height: 100, fontFaceCss: '@font-face { font-family: "dmf0"; src: url("data:font/ttf;base64,AAAA"); }' },
    );
    // The shared family stays un-prefixed (resolves against the shared block)…
    expect(r.svg).toContain('font-family="dmf0"');
    expect(r.svg).not.toContain('font-family="c0_dmf0"');
    // …and the shared @font-face appears exactly once.
    expect((r.svg.match(/@font-face/g) ?? []).length).toBe(1);
  });

  it("namespaces a non-deferFonts layer's dmfN families per-layer", () => {
    const fontDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><style>@font-face { font-family: "dmf0"; src: url("data:font/ttf;base64,AAAA"); }</style><text font-family="dmf0">hi</text></svg>`;
    const r = composeAnimatedLayers([{ svg: fontDoc, x: 0, y: 0 }], { width: 200, height: 100 });
    expect(r.svg).toContain('font-family="c0_dmf0"');
    expect(r.svg).not.toContain('font-family="dmf0"');
  });

  it("paints a background rect only when an opaque background is given", () => {
    const transparent = composeAnimatedLayers([{ svg: staticDoc }], { width: 10, height: 10 });
    expect(transparent.svg).not.toMatch(/<rect width="10" height="10" fill=/);
    const opaque = composeAnimatedLayers([{ svg: staticDoc }], { width: 10, height: 10, background: "#000" });
    expect(opaque.svg).toContain('<rect width="10" height="10" fill="#000"/>');
  });
});
