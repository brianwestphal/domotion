import { describe, expect, it } from "vitest";
import { inlineImgSvg, prefixSvgIds, prefixSvgClasses } from "./svg-inline.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  whiteSpace: "normal", direction: "ltr", writingMode: "horizontal-tb",
  overflowX: "visible", overflowY: "visible", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  objectFit: "fill", objectPosition: "50% 50%", display: "inline",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0", position: "static",
} as unknown as CapturedElement["styles"];

const imgEl = (imageSrc: string, styleOver: Record<string, string> = {}): CapturedElement => ({
  tag: "img", text: "", x: 10, y: 10, width: 80, height: 80, children: [],
  imageSrc, styles: { ...BASE_STYLES, ...styleOver } as CapturedElement["styles"],
} as unknown as CapturedElement);

const SVG_URI = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("prefixSvgIds — namespace ids / refs to avoid cross-document collisions (DM-1588)", () => {
  it("prefixes id, url(#…), href, and xlink:href (both quote styles)", () => {
    const svg = `<linearGradient id="g1"/><rect fill="url(#g1)"/>` +
      `<use href="#g1"/><use xlink:href="#g1"/><clipPath id='c1'/><path clip-path="url(#c1)"/>`;
    const out = prefixSvgIds(svg, "P-");
    expect(out).toContain(`id="P-g1"`);
    expect(out).toContain(`fill="url(#P-g1)"`);
    expect(out).toContain(`href="#P-g1"`);
    expect(out).toContain(`xlink:href="#P-g1"`);
    expect(out).toContain(`id='P-c1'`);
    expect(out).toContain(`clip-path="url(#P-c1)"`);
  });

  it("leaves non-hash href (external URL) untouched", () => {
    const out = prefixSvgIds(`<image href="logo.png"/>`, "P-");
    expect(out).toBe(`<image href="logo.png"/>`);
  });
});

describe("inlineImgSvg — img src=svg → positioned native <svg> (DM-1588)", () => {
  const P = { x: 10, y: 20, w: 100, h: 80, par: "xMidYMid meet", idPrefix: "P-" };

  it("keeps the source viewBox and re-declares x/y/width/height/preserveAspectRatio", () => {
    const src = `<svg width="50px" height="50px" viewBox="0 0 50 50"><rect width="50" height="50"/></svg>`;
    const out = inlineImgSvg(src, P)!;
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).toContain(`viewBox="0 0 50 50"`);
    expect(out).toContain(`x="10" y="20" width="100" height="80"`);
    expect(out).toContain(`preserveAspectRatio="xMidYMid meet"`);
    // The source width/height="50px" must be stripped, not duplicated.
    expect(out).not.toContain(`50px`);
    expect(out).toContain(`<rect width="50" height="50"/></svg>`);
  });

  it("namespaces internal ids so gradients/clipPaths/filters can't collide", () => {
    const src = `<svg viewBox="0 0 10 10"><defs><linearGradient id="grad"/></defs>` +
      `<rect fill="url(#grad)"/></svg>`;
    const out = inlineImgSvg(src, P)!;
    expect(out).toContain(`id="P-grad"`);
    expect(out).toContain(`fill="url(#P-grad)"`);
    expect(out).not.toMatch(/\bid="grad"/);
  });

  it("synthesizes a viewBox from absolute width/height when the SVG has none", () => {
    const src = `<svg width="40" height="30"><rect/></svg>`;
    const out = inlineImgSvg(src, P)!;
    expect(out).toContain(`viewBox="0 0 40 30"`);
  });

  it("falls back to the intrinsic size when the SVG has neither viewBox nor absolute size", () => {
    const src = `<svg><rect/></svg>`;
    const out = inlineImgSvg(src, { ...P, intrinsic: { w: 64, h: 48 } })!;
    expect(out).toContain(`viewBox="0 0 64 48"`);
  });

  it("returns null (→ raster fallback) with no coordinate system at all", () => {
    expect(inlineImgSvg(`<svg><rect/></svg>`, P)).toBeNull();
    // percentage width is not an absolute coordinate system
    expect(inlineImgSvg(`<svg width="100%" height="100%"><rect/></svg>`, P)).toBeNull();
  });

  it("returns null when there is no <svg> root", () => {
    expect(inlineImgSvg(`<rect width="10" height="10"/>`, P)).toBeNull();
  });

  it("drops an XML declaration / leading content before the root <svg>", () => {
    const src = `<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"><rect/></svg>`;
    const out = inlineImgSvg(src, P)!;
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).not.toContain("<?xml");
  });
});

describe("paintImage — <img src=svg> inlines natively; raster stays <image> (DM-1588)", () => {
  it("emits a native nested <svg> for an SVG source, not <image data:image/svg+xml>", () => {
    const svg = `<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#f00"/></svg>`;
    const out = elementTreeToSvgInner([imgEl(SVG_URI(svg))], 200, 200);
    expect(out).toContain(`viewBox="0 0 24 24"`);
    expect(out).not.toMatch(/<image[^>]*data:image\/svg\+xml/);
    // Positioned at the content-box top-left (no border/padding here → el.x/y).
    expect(out).toMatch(/<svg[^>]*x="10" y="10" width="80" height="80"/);
  });

  it("keeps a raster (PNG) <img> on the <image> path", () => {
    const out = elementTreeToSvgInner([imgEl(PNG_URI)], 200, 200);
    expect(out).toMatch(/<image\b/);
    expect(out).not.toMatch(/viewBox="0 0/);
  });

  it("wraps a border-radius SVG img in a rounded clip group", () => {
    const svg = `<svg viewBox="0 0 24 24"><rect width="24" height="24"/></svg>`;
    const el = imgEl(SVG_URI(svg), {
      borderRadius: "12px", borderTopLeftRadius: "12px", borderTopRightRadius: "12px",
      borderBottomRightRadius: "12px", borderBottomLeftRadius: "12px",
    });
    const out = elementTreeToSvgInner([el], 200, 200);
    expect(out).toMatch(/<g clip-path="url\(#[^)]*\)"><svg[^>]*viewBox="0 0 24 24"/);
  });
});

describe("paintImage — object-fit: none SVG img inlines natively at intrinsic size (DM-1592)", () => {
  it("emits a native <svg> at the object-position-derived (ix,iy) + intrinsic size, clipped", () => {
    const svg = `<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#f0a"/></svg>`;
    // content box 80×80 at (10,10); intrinsic 40×40; object-position 100% 0%
    // → ix = 10 + (80-40)*1.0 = 50, iy = 10 + (80-40)*0 = 10.
    const el = imgEl(SVG_URI(svg), { objectFit: "none", objectPosition: "100% 0%" });
    (el as { imageIntrinsic?: { w: number; h: number } }).imageIntrinsic = { w: 40, h: 40 };
    const out = elementTreeToSvgInner([el], 200, 200);
    expect(out).not.toMatch(/<image[^>]*data:image\/svg\+xml/);
    // Native <svg> at intrinsic size, positioned by object-position, clip-wrapped.
    expect(out).toMatch(/<g clip-path="url\(#[^)]*\)"><svg[^>]*x="50" y="10" width="40" height="40" viewBox="0 0 40 40"/);
  });

  it("keeps a raster (PNG) object-fit:none img on the <image> path", () => {
    const el = imgEl(PNG_URI, { objectFit: "none" });
    (el as { imageIntrinsic?: { w: number; h: number } }).imageIntrinsic = { w: 40, h: 40 };
    const out = elementTreeToSvgInner([el], 200, 200);
    expect(out).toMatch(/<image\b/);
    expect(out).not.toMatch(/viewBox="0 0 40 40"/);
  });
});

describe("prefixSvgClasses — namespace CSS class names in <style>-bearing SVGs (DM-1593)", () => {
  it("prefixes class selectors in <style> and matching class= attributes", () => {
    const svg = `<style>.cls-1{fill:#f00}.a .cls-2{stroke:#00f}</style>` +
      `<rect class="cls-1"/><g class="cls-2 extra"/>`;
    const out = prefixSvgClasses(svg, "P-");
    expect(out).toContain(`.P-cls-1{fill:#f00}`);
    expect(out).toContain(`.P-a .P-cls-2{stroke:#00f}`);
    expect(out).toContain(`class="P-cls-1"`);
    expect(out).toContain(`class="P-cls-2 P-extra"`);
  });

  it("does NOT touch a `.` inside a declaration value (only the selector portion)", () => {
    const svg = `<style>.b{stroke-width:1.5;stroke-dasharray:.5}</style><rect class="b"/>`;
    const out = prefixSvgClasses(svg, "P-");
    expect(out).toContain(`.P-b{stroke-width:1.5;stroke-dasharray:.5}`);
    expect(out).not.toContain(`.P-5`);
  });
});

describe("inlineImgSvg — class namespacing (DM-1593)", () => {
  it("scopes classes only when a <style> block is present; presentation-attr SVGs stay untouched", () => {
    const styled = `<svg viewBox="0 0 10 10"><style>.c{fill:#f00}</style><rect class="c"/></svg>`;
    const plain = `<svg viewBox="0 0 10 10"><rect class="c" fill="#f00"/></svg>`;
    const P = { x: 0, y: 0, w: 10, h: 10, par: "none", idPrefix: "Q-" };
    // Styled → class rewritten.
    expect(inlineImgSvg(styled, P)!).toContain(`class="Q-c"`);
    // No <style> → class attr left as-is (no stylesheet → no collision risk).
    expect(inlineImgSvg(plain, P)!).toContain(`class="c"`);
  });

  it("two inlined SVGs with colliding .cls-1 get distinct scoped classes", () => {
    const mk = (color: string) => `<svg viewBox="0 0 10 10"><style>.cls-1{fill:${color}}</style><rect class="cls-1"/></svg>`;
    const a = inlineImgSvg(mk("#f00"), { x: 0, y: 0, w: 10, h: 10, par: "none", idPrefix: "A-" })!;
    const b = inlineImgSvg(mk("#00f"), { x: 0, y: 0, w: 10, h: 10, par: "none", idPrefix: "B-" })!;
    // Each SVG's rule + usage carry its OWN prefix, so A's rule can't style B's rect.
    expect(a).toContain(`.A-cls-1{fill:#f00}`);
    expect(a).toContain(`class="A-cls-1"`);
    expect(b).toContain(`.B-cls-1{fill:#00f}`);
    expect(b).toContain(`class="B-cls-1"`);
    expect(a).not.toContain("B-cls-1");
    expect(b).not.toContain("A-cls-1");
  });
});

describe("paintInlineSvg — DOM inline <svg> class namespacing (DM-1595)", () => {
  const svgEl = (svgContent: string, x: number): CapturedElement => ({
    tag: "svg", text: "", x, y: 0, width: 40, height: 40, children: [],
    svgContent, styles: { ...BASE_STYLES } as CapturedElement["styles"],
  } as unknown as CapturedElement);

  it("scopes colliding .cls-1 across two DOM inline SVGs so they render independently", () => {
    const content = (c: string) => `<svg viewBox="0 0 40 40"><style>.cls-1{fill:${c}}</style><rect class="cls-1" width="40" height="40"/></svg>`;
    const out = elementTreeToSvgInner([svgEl(content("#e00000"), 0), svgEl(content("#0000e0"), 60)], 120, 60);
    // Each inline SVG's rule + usage carries its own unique prefix.
    expect(out).toMatch(/\.[\w-]*svgic0[\w-]*cls-1\{fill:#e00000\}/);
    expect(out).toMatch(/\.[\w-]*svgic1[\w-]*cls-1\{fill:#0000e0\}/);
  });

  it("leaves a <style>-free inline SVG byte-identical (no prefix, no counter shift)", () => {
    // A presentation-attribute icon — the common case — must be untouched.
    const plain = `<svg viewBox="0 0 40 40"><rect class="icon" width="40" height="40" fill="#123456"/></svg>`;
    const out = elementTreeToSvgInner([svgEl(plain, 0)], 60, 60);
    expect(out).toContain(`class="icon"`);
    expect(out).not.toMatch(/svgic/);
  });
});
