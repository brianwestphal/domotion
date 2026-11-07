import { describe, expect, it, vi } from "vitest";
import { getLastCaptureWarnings, resetLastCaptureWarnings } from "../capture/warnings.js";
import {
  inlineImgSvg,
  flattenImgSvg,
  flattenedRootGroupAttributes,
  isSvgSafeToFlatten,
  prefixSvgIds,
  prefixSvgClasses,
  getFlattenNestedSvg,
  setFlattenNestedSvg,
  withFlattenNestedSvg,
  editSvgRootAttributes,
  readSvgOpeningTag,
  svgRootAttribute,
} from "./svg-inline.js";
import { elementTreeToSvg, elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";
import { formatNumberLoose } from "./format.js";
import { imageRootFontMetricUnits } from "./svg-image-root-font.js";

describe("SVG root attribute editor", () => {
  it("handles quoted angle brackets and preserves unrelated attributes and body", () => {
    const source = `<svg data-note='a > b' width='24' height="24" viewBox="0 0 24 24"><path d="M0 0"/></svg>`;
    expect(readSvgOpeningTag(source)?.raw).toBe(`<svg data-note='a > b' width='24' height="24" viewBox="0 0 24 24">`);
    expect(svgRootAttribute(source, "viewBox")).toBe("0 0 24 24");
    expect(editSvgRootAttributes(source, [], { width: "12", height: "12" })).toBe(
      `<svg data-note='a > b' viewBox="0 0 24 24" width="12" height="12"><path d="M0 0"/></svg>`,
    );
  });

  it("leaves malformed attribute syntax unchanged", () => {
    const source = `<svg width="20" broken><path/></svg>`;
    expect(editSvgRootAttributes(source, [], { width: "12" })).toBe(source);
  });

  it("keeps a self-closing root valid when setting attributes", () => {
    expect(editSvgRootAttributes(`<svg width="20"/>`, [], { width: "12" })).toBe(`<svg width="12" />`);
  });
});

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundSize: "auto",
  backgroundPosition: "0% 0%",
  backgroundRepeat: "repeat",
  backgroundClip: "border-box",
  backgroundOrigin: "padding-box",
  backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)",
  borderWidth: "0",
  borderRadius: "0",
  borderTopLeftRadius: "0",
  borderTopRightRadius: "0",
  borderBottomRightRadius: "0",
  borderBottomLeftRadius: "0",
  borderTopWidth: "0",
  borderRightWidth: "0",
  borderBottomWidth: "0",
  borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)",
  borderRightColor: "rgb(0,0,0)",
  borderBottomColor: "rgb(0,0,0)",
  borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  color: "rgb(0,0,0)",
  fontSize: "16px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  fontStyle: "normal",
  lineHeight: "20px",
  letterSpacing: "normal",
  textAlign: "left",
  textTransform: "none",
  whiteSpace: "normal",
  direction: "ltr",
  writingMode: "horizontal-tb",
  overflowX: "visible",
  overflowY: "visible",
  opacity: "1",
  transform: "none",
  transformOrigin: "50% 50%",
  visibility: "visible",
  objectFit: "fill",
  objectPosition: "50% 50%",
  display: "inline",
  paddingTop: "0",
  paddingRight: "0",
  paddingBottom: "0",
  paddingLeft: "0",
  position: "static",
} as unknown as CapturedElement["styles"];

const imgEl = (imageSrc: string, styleOver: Record<string, string> = {}): CapturedElement =>
  ({
    tag: "img",
    text: "",
    x: 10,
    y: 10,
    width: 80,
    height: 80,
    children: [],
    imageSrc,
    styles: { ...BASE_STYLES, ...styleOver } as CapturedElement["styles"],
  }) as unknown as CapturedElement;

const SVG_URI = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const PNG_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("prefixSvgIds — namespace ids / refs to avoid cross-document collisions (DM-1588)", () => {
  it("prefixes id, url(#…), href, and xlink:href (both quote styles)", () => {
    const svg =
      `<linearGradient id="g1"/><rect fill="url(#g1)"/>` +
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

  it("prefixes URL references whose style-attribute quotes were outerHTML-encoded", () => {
    const svg =
      `<clipPath id="clip" clipPathUnits="objectBoundingBox"/>` +
      `<rect clip-path="url(#clip)" style="clip-path: url(&quot;#clip&quot;);"/>`;
    const out = prefixSvgIds(svg, "P-");
    expect(out).toContain(`id="P-clip"`);
    expect(out).toContain(`clip-path="url(#P-clip)"`);
    expect(out).toContain(`style="clip-path: url(&quot;#P-clip&quot;);"`);
    expect(out).not.toMatch(/url\((?:&quot;)?#clip/);
  });
});

describe("inlineImgSvg — img src=svg → positioned native <svg> (DM-1588)", () => {
  const P = { x: 10, y: 20, w: 100, h: 80, par: "xMidYMid meet", idPrefix: "P-" };

  it("keeps the source viewBox and re-declares x/y/width/height/preserveAspectRatio", () => {
    const src = `<svg width="50px" height="50px" viewBox="0 0 50 50"><rect width="50" height="50"/></svg>`;
    const out = inlineImgSvg(src, P)!;
    // `meet` leaves an 80x80 object rect inside the 100x80 box: Blink clips the
    // image to that rect (svg_image.cc:548), the nested viewport only to the box.
    expect(out.startsWith(`<clipPath id="P-vclip-img"><rect x="20" y="20" width="80" height="80"/></clipPath>`)).toBe(
      true,
    );
    expect(out).toContain(`<g clip-path="url(#P-vclip-img)"><svg`);
    expect(out).toContain(`viewBox="0 0 50 50"`);
    expect(out).toContain(`x="10" y="20" width="100" height="80"`);
    expect(out).toContain(`preserveAspectRatio="xMidYMid meet"`);
    // The source width/height="50px" must be stripped, not duplicated.
    expect(out).not.toContain(`50px`);
    expect(out).toContain(`<rect width="50" height="50"/></svg>`);
  });

  it("namespaces internal ids so gradients/clipPaths/filters can't collide", () => {
    const src = `<svg viewBox="0 0 10 10"><defs><linearGradient id="grad"/></defs>` + `<rect fill="url(#grad)"/></svg>`;
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
    const out = inlineImgSvg(src, { ...P, w: 80 })!;
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
      borderRadius: "12px",
      borderTopLeftRadius: "12px",
      borderTopRightRadius: "12px",
      borderBottomRightRadius: "12px",
      borderBottomLeftRadius: "12px",
    });
    const out = elementTreeToSvgInner([el], 200, 200);
    expect(out).toMatch(/<g clip-path="url\(#[^)]*\)"><svg[^>]*viewBox="0 0 24 24"/);
  });

  it("keeps cover geometry per consumer when one SVG source is reused at different sizes (DM-2292)", () => {
    const svg = `<svg viewBox="0 0 128 128"><circle cx="64" cy="64" r="60"/></svg>`;
    const src = SVG_URI(svg);
    const wide = imgEl(src, { objectFit: "cover" });
    wide.width = 160;
    wide.height = 120;
    const column = imgEl(src, { objectFit: "cover" });
    column.x = 200;
    column.width = 240;
    column.height = 135;
    const out = elementTreeToSvgInner([wide, column], 500, 200);
    expect(out).toMatch(/<svg[^>]*x="10" y="10" width="160" height="120"[^>]*preserveAspectRatio="xMidYMid slice"/);
    expect(out).toMatch(/<svg[^>]*x="200" y="10" width="240" height="135"[^>]*preserveAspectRatio="xMidYMid slice"/);
    expect(out.match(/viewBox="0 0 128 128"/g)).toHaveLength(2);
  });
});

describe("paintImage — object-fit: none SVG img inlines natively at intrinsic size (DM-1592)", () => {
  it("emits a native <svg> at the object-position-derived (ix,iy) + intrinsic size, clipped", () => {
    const svg = `<svg width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#f0a"/></svg>`;
    // content box 80×80 at (10,10); intrinsic 40×40; object-position 100% 0%
    // → ix = 10 + (80-40)*1.0 = 50, iy = 10 + (80-40)*0 = 10.
    const el = imgEl(SVG_URI(svg), { objectFit: "none", objectPosition: "100% 0%" });
    (el as { imageIntrinsic?: { w: number; h: number } }).imageIntrinsic = { w: 40, h: 40 };
    const out = elementTreeToSvgInner([el], 200, 200);
    expect(out).not.toMatch(/<image[^>]*data:image\/svg\+xml/);
    // Native <svg> at intrinsic size, positioned by object-position, clip-wrapped.
    expect(out).toMatch(
      /<g clip-path="url\(#[^)]*\)"><svg[^>]*x="50" y="10" width="40" height="40" viewBox="0 0 40 40"/,
    );
  });

  it("keeps a raster (PNG) object-fit:none img on the <image> path", () => {
    const el = imgEl(PNG_URI, { objectFit: "none" });
    (el as { imageIntrinsic?: { w: number; h: number } }).imageIntrinsic = { w: 40, h: 40 };
    const out = elementTreeToSvgInner([el], 200, 200);
    expect(out).toMatch(/<image\b/);
    expect(out).not.toMatch(/viewBox="0 0 40 40"/);
  });
});

describe("<img> SVG document viewport: the root preserveAspectRatio maps the viewBox into the object rect", () => {
  // Blink lays the SVG image document out at the concrete object rect
  // (SVGImage container size) and maps a valid root viewBox with the root's
  // OWN preserveAspectRatio; without one it synthesizes a viewBox from the
  // root width/height (viewport-relative) and a `none` preserveAspectRatio.
  const D = { x: 10, y: 20, w: 200, h: 80, par: "none", documentViewport: true, idPrefix: "D-" };

  it("letterboxes a square viewBox in a wide box with the default xMidYMid meet", () => {
    const src = `<svg viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100"/></svg>`;
    const out = inlineImgSvg(src, D)!;
    expect(out).toContain(
      `x="10" y="20" width="200" height="80" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"`,
    );
    // The drawn image is the whole viewport: no extra clip to the mapped viewBox.
    expect(out).not.toContain("vclip-img");
    expect(out.startsWith("<svg")).toBe(true);
  });

  it("honors the root's own preserveAspectRatio, ignoring the placement par", () => {
    const src = `<svg viewBox="0 0 100 100" preserveAspectRatio="xMinYMax slice"><rect/></svg>`;
    expect(inlineImgSvg(src, { ...D, par: "xMidYMid meet" })).toContain(`preserveAspectRatio="xMinYMax slice"`);
    const none = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect/></svg>`;
    expect(inlineImgSvg(none, D)).toContain(`preserveAspectRatio="none meet"`);
  });

  it("synthesizes a viewBox from absolute width/height with a none mapping when there is no viewBox", () => {
    const out = inlineImgSvg(`<svg width="80" height="40"><rect/></svg>`, D)!;
    expect(out).toContain(`viewBox="0 0 80 40" preserveAspectRatio="none"`);
  });

  it("resolves a missing or percentage width/height against the viewport (unzoomed)", () => {
    expect(inlineImgSvg(`<svg><rect/></svg>`, D)).toContain(`viewBox="0 0 200 80" preserveAspectRatio="none"`);
    expect(inlineImgSvg(`<svg><rect/></svg>`, { ...D, zoom: 2 })).toContain(`viewBox="0 0 100 40"`);
    expect(inlineImgSvg(`<svg width="50%" height="40"><rect/></svg>`, D)).toContain(`viewBox="0 0 100 40"`);
    // An invalid viewBox is ignored like an absent one.
    expect(inlineImgSvg(`<svg viewBox="0 0 0 10" width="20" height="10"><rect/></svg>`, D)).toContain(
      `viewBox="0 0 20 10" preserveAspectRatio="none"`,
    );
  });

  it("clips an overflow-visible root to the viewport and uses it as the root transform box", () => {
    const vis = inlineImgSvg(`<svg viewBox="0 0 100 100" overflow="visible"><rect/></svg>`, D)!;
    expect(vis).toContain(`<clipPath id="D-vclip-img"><rect x="10" y="20" width="200" height="80"/></clipPath>`);
    const rot = inlineImgSvg(`<svg viewBox="0 0 100 100" transform="rotate(90)"><rect/></svg>`, D)!;
    // Rotation about the viewport center (110, 60), not the letterboxed square's.
    expect(rot).toContain(`translate(110 60) rotate(90) translate(-110 -60)`);
  });

  it("flattenImgSvg maps with the root preserveAspectRatio too", () => {
    const out = flattenImgSvg(`<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`, D)!;
    // meet: scale 0.8, centered → tx = 10 + (200 - 80) / 2 = 70, ty = 20.
    expect(out).toContain(`transform="matrix(0.8 0 0 0.8 70 20)"`);
    expect(out).toContain(`<rect x="10" y="20" width="200" height="80"/>`);
  });

  it("paintImage letterboxes an object-fit: fill SVG <img> whose box aspect differs from the viewBox", () => {
    const svg = `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#00f"/></svg>`;
    const el = imgEl(SVG_URI(svg));
    el.width = 200;
    el.height = 80;
    (el as { imageIntrinsic?: { w: number; h: number } }).imageIntrinsic = { w: 150, h: 150 };
    const out = elementTreeToSvgInner([el], 300, 200);
    expect(out).toMatch(
      /<svg[^>]*x="10" y="10" width="200" height="80" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"/,
    );
  });
});

describe("prefixSvgClasses — namespace CSS class names in <style>-bearing SVGs (DM-1593)", () => {
  it("prefixes class selectors in <style> and matching class= attributes", () => {
    const svg =
      `<style>.cls-1{fill:#f00}.a .cls-2{stroke:#00f}</style>` + `<rect class="cls-1"/><g class="cls-2 extra"/>`;
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
    const mk = (color: string) =>
      `<svg viewBox="0 0 10 10"><style>.cls-1{fill:${color}}</style><rect class="cls-1"/></svg>`;
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
  const svgEl = (svgContent: string, x: number): CapturedElement =>
    ({
      tag: "svg",
      text: "",
      x,
      y: 0,
      width: 40,
      height: 40,
      children: [],
      svgContent,
      styles: { ...BASE_STYLES } as CapturedElement["styles"],
    }) as unknown as CapturedElement;

  it("scopes colliding .cls-1 across two DOM inline SVGs so they render independently", () => {
    const content = (c: string) =>
      `<svg viewBox="0 0 40 40"><style>.cls-1{fill:${c}}</style><rect class="cls-1" width="40" height="40"/></svg>`;
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

describe("prefixSvgIds scope-complete references", () => {
  it("rewrites same-scope fragment, CSS, timing, and IDREF consumers but preserves unresolved refs", () => {
    const source = `<svg><style>#paint{fill:url('#grad');color:#fff}</style><defs><linearGradient id="grad"/><path id="paint"/><clipPath id="clip"/></defs><use href="#paint" clip-path="url(#clip)" aria-labelledby="paint missing"><animate begin="paint.click; missing.end"/></use><use href="#missing"/></svg>`;
    const out = prefixSvgIds(source, "s-");
    for (const id of ["grad", "paint", "clip"]) expect(out).toContain(`id="s-${id}"`);
    expect(out).toContain(`href="#s-paint"`);
    expect(out).toContain(`url('#s-grad')`);
    expect(out).toContain(`url(#s-clip)`);
    expect(out).toContain(`aria-labelledby="s-paint missing"`);
    expect(out).toContain(`begin="s-paint.click; missing.end"`);
    expect(out).toContain(`href="#missing"`);
    expect(out).toContain(`color:#fff`);
  });

  it("uses one namespace for inline SVGs from one captured scope and separates another scope", () => {
    const mk = (scope: number, x: number): CapturedElement =>
      ({
        tag: "svg",
        text: "",
        x,
        y: 0,
        width: 40,
        height: 40,
        children: [],
        svgReferenceScope: scope,
        svgContent: `<svg viewBox="0 0 40 40"><path id="shared" d="M0 0H40"/><use href="#shared"/></svg>`,
        styles: { ...BASE_STYLES },
      }) as unknown as CapturedElement;
    const out = elementTreeToSvgInner([mk(0, 0), mk(0, 50), mk(1, 100)], 150, 50);
    expect(out.match(/id="svgscope0-shared"/g)).toHaveLength(2);
    expect(out).toContain(`id="svgscope1-shared"`);
    expect(out.match(/href="#svgscope0-shared"/g)).toHaveLength(2);
    expect(out).toContain(`href="#svgscope1-shared"`);
  });
});

// DM-K0S6ZS: opt-in nested-SVG flattening (isSvgSafeToFlatten + flattenImgSvg).
describe("isSvgSafeToFlatten — the gate (DM-K0S6ZS)", () => {
  it("accepts a plain presentation-attribute icon", () => {
    expect(isSvgSafeToFlatten(`<path d="M0 0h10v10z" fill="red"/><circle cx="5" cy="5" r="2"/>`)).toBe(true);
  });
  it("accepts a gradient icon with objectBoundingBox (default) % offsets", () => {
    expect(
      isSvgSafeToFlatten(
        `<defs><linearGradient id="g"><stop offset="0%" stop-color="red"/><stop offset="100%" stop-color="blue"/></linearGradient></defs>` +
          `<rect width="10" height="10" fill="url(#g)"/>`,
      ),
    ).toBe(true);
  });
  it("rejects viewport-relative % on painted geometry", () => {
    expect(isSvgSafeToFlatten(`<rect x="0" y="0" width="50%" height="100%" fill="red"/>`)).toBe(false);
  });
  it("rejects a userSpaceOnUse gradient with %", () => {
    expect(
      isSvgSafeToFlatten(
        `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0%" x2="100%"><stop offset="0"/></linearGradient></defs><rect width="10" height="10"/>`,
      ),
    ).toBe(false);
  });
  it("rejects <use>, <symbol>, a nested <svg>, <foreignObject>, and <image>", () => {
    expect(isSvgSafeToFlatten(`<symbol id="s"><path d="M0 0h1v1z"/></symbol><use href="#s"/>`)).toBe(false);
    expect(isSvgSafeToFlatten(`<svg viewBox="0 0 5 5"><rect width="5" height="5"/></svg>`)).toBe(false);
    expect(isSvgSafeToFlatten(`<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>`)).toBe(
      false,
    );
    expect(isSvgSafeToFlatten(`<image href="x.png" width="10" height="10"/>`)).toBe(false);
  });
  it("rejects non-scaling-stroke", () => {
    expect(isSvgSafeToFlatten(`<path d="M0 0h10" stroke="red" vector-effect="non-scaling-stroke"/>`)).toBe(false);
  });
  it("accepts a <style> with only class/id selectors, rejects an element/universal selector", () => {
    expect(isSvgSafeToFlatten(`<style>.a{fill:red}#b{fill:blue}</style><path class="a" d="M0 0h1v1z"/>`)).toBe(true);
    expect(isSvgSafeToFlatten(`<style>path{fill:red}</style><path d="M0 0h1v1z"/>`)).toBe(false);
    expect(isSvgSafeToFlatten(`<style>*{fill:red}</style><path d="M0 0h1v1z"/>`)).toBe(false);
  });
});

describe("flattenedRootGroupAttributes (DM-97E2CN)", () => {
  it("keeps inheritable presentation, class, style and a11y attributes", () => {
    const attrs = ` class="gauge" viewBox="0 0 100 60" fill="red" font-family="Helvetica, sans-serif" style="overflow: hidden;" role="img" width="200" height="120"`;
    expect(flattenedRootGroupAttributes(attrs)).toBe(
      ` class="gauge" fill="red" font-family="Helvetica, sans-serif" role="img"`,
    );
  });

  it("drops transform-family and overflow declarations from the root style (DM-KDGVCN)", () => {
    const attrs = ` aria-hidden="true" style="transform:translate(0);rotate:none;scale:none;translate:none;overflow:visible;opacity:0.5" fill="red"`;
    expect(flattenedRootGroupAttributes(attrs)).toBe(` aria-hidden="true" style="opacity:0.5" fill="red"`);
  });

  it("keeps entity-quoted and url() declarations intact, and drops an emptied style", () => {
    const attrs = ` style="font-family: &quot;Helvetica Neue&quot;, sans-serif; mask-image: url(&quot;data:image/svg+xml;base64,AAAA&quot;); transform: none"`;
    expect(flattenedRootGroupAttributes(attrs)).toBe(
      ` style="font-family: &quot;Helvetica Neue&quot;, sans-serif;mask-image: url(&quot;data:image/svg+xml;base64,AAAA&quot;)"`,
    );
    expect(flattenedRootGroupAttributes(` class="x" style="transform: translate(0)"`)).toBe(` class="x"`);
  });

  it("drops viewport, namespace and transform attributes the group must not carry", () => {
    const attrs = ` xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" x="1" y="2" preserveAspectRatio="none" overflow="visible" transform="scale(2)" `;
    expect(flattenedRootGroupAttributes(attrs)).toBe("");
  });
});

it("flattenImgSvg never emits a duplicate transform attribute from a root transform", () => {
  const out = flattenImgSvg(`<svg viewBox="0 0 24 24" transform="scale(2)" fill="red"><path d="M0 0h1v1z"/></svg>`, {
    x: 0,
    y: 0,
    w: 24,
    h: 24,
    par: "xMidYMid meet",
    idPrefix: "p",
  });
  expect(out).not.toBeNull();
  expect(out!.match(/<g[^>]*>/g)!.some((tag) => (tag.match(/\btransform=/g) ?? []).length > 1)).toBe(false);
  expect(out).toContain('fill="red"');
});

// A root `<svg transform>` is a CSS transform on the outermost svg box, about
// its center (Blink: svg_transformable_element.cc maps the attribute to CSS
// `transform`; svg.css's `transform-origin: 0 0` rule does not match an
// outermost svg). Probed in Chromium: an `<img>` SVG rotates about the image
// center and is clipped to the drawn image; a DOM-inline svg's transform is
// already applied by the capture's element transform.
describe("root <svg transform> (outermost-svg transform parity)", () => {
  const icon = (extra: string): string =>
    `<svg viewBox="0 0 100 100" width="100" height="100"${extra}><rect width="100" height="40" fill="red"/></svg>`;
  const place = { x: 50, y: 50, w: 100, h: 100, par: "none", idPrefix: "p-" };

  it("a flattened group drops the root's transform-origin / transform-box attributes too", () => {
    expect(flattenedRootGroupAttributes(` transform-origin="center" transform-box="view-box" fill="red"`)).toBe(
      ` fill="red"`,
    );
  });

  it("flattenImgSvg composes the root transform about the image center, outside the viewport, clipped to the image", () => {
    const out = flattenImgSvg(icon(` transform="rotate(30)"`), place)!;
    expect(out).toBe(
      `<clipPath id="p-vclip-img"><rect x="50" y="50" width="100" height="100"/></clipPath>` +
        `<g clip-path="url(#p-vclip-img)"><g transform="translate(100 100) rotate(30) translate(-100 -100)">` +
        `<clipPath id="p-vclip"><rect x="50" y="50" width="100" height="100"/></clipPath>` +
        `<g clip-path="url(#p-vclip)"><g transform="matrix(1 0 0 1 50 50)"><rect width="100" height="40" fill="red"/></g></g>` +
        `</g></g>`,
    );
  });

  it("inlineImgSvg moves the root transform off the nested <svg> and applies it about the image center", () => {
    const out = inlineImgSvg(icon(` transform="rotate(30)"`), place)!;
    expect(out.startsWith(`<clipPath id="p-vclip-img">`)).toBe(true);
    expect(out).toContain(`<g transform="translate(100 100) rotate(30) translate(-100 -100)"><svg`);
    expect(readSvgOpeningTag(out)?.raw).not.toMatch(/\btransform=/);
    expect(out.endsWith(`</svg></g></g>`)).toBe(true);
  });

  // A root style transform overrides the attribute; transform-origin (attribute
  // or style) moves the pivot; the individual properties compose before it
  // (ComputedStyle::ApplyTransform, core/style/computed_style.cc:1429, chromium
  // 7d859f27).
  it("inlineImgSvg composes a root style transform about its transform-origin and strips it from the nested <svg>", () => {
    const out = inlineImgSvg(
      icon(` transform="rotate(10)" style="fill: red; transform: rotate(30deg); transform-origin: 0 0; rotate: 5deg"`),
      place,
    )!;
    expect(out).toContain(`<g transform="translate(50 50) rotate(5) rotate(30) translate(-50 -50)"><svg`);
    const nested = readSvgOpeningTag(out.slice(out.indexOf("<svg")))!.raw;
    expect(nested).not.toMatch(/\btransform=|transform:|transform-origin|rotate:/);
    expect(nested).toContain(`style="fill: red"`);
  });

  it("flattenImgSvg honors a root transform-origin attribute", () => {
    const out = flattenImgSvg(icon(` transform="rotate(30)" transform-origin="right bottom"`), place)!;
    expect(out).toContain(`<g transform="translate(150 150) rotate(30) translate(-150 -150)">`);
  });

  it("falls back to the transform attribute about the center, with a warning, for an unresolvable style value", () => {
    resetLastCaptureWarnings([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `line-height: normal` needs the platform line spacing, which is not resolved.
    const out = inlineImgSvg(icon(` transform="rotate(30)" style="transform-origin: 2lh"`), place)!;
    warn.mockRestore();
    expect(out).toContain(`<g transform="translate(100 100) rotate(30) translate(-100 -100)"><svg`);
    expect(getLastCaptureWarnings()).toEqual([expect.objectContaining({ feature: "svg-image-root-transform" })]);
  });

  // Font-metric units read the root's primary font from the text engine.
  it("resolves font-metric units in the root transform-origin against the root's primary font", () => {
    const ex = imageRootFontMetricUnits({ get: (n) => (n === "font-family" ? "serif" : null) }, 16, null)?.("ex");
    expect(ex).toBeGreaterThan(0);
    const out = inlineImgSvg(
      icon(` font-family="serif" transform="rotate(30)" style="transform-origin: 2ex 3lh; line-height: 1.5"`),
      place,
    )!;
    expect(out).toContain(`translate(${formatNumberLoose(50 + 2 * (ex ?? 0), 6)} 122) rotate(30)`);
  });

  // SVG transforms are affine; a root transform whose perspective reaches the
  // z = 0 plane leaves the image to the `<image href="data:image/svg+xml">`
  // path, whose own SVG document applies it.
  it("returns null for a projective root transform so the <img> takes the <image> fallback", () => {
    const projective = icon(` style="transform: perspective(200px) rotateY(30deg)"`);
    expect(inlineImgSvg(projective, place)).toBeNull();
    expect(flattenImgSvg(projective, place)).toBeNull();
    const sheet = `<svg viewBox="0 0 100 100"><style>svg { transform: perspective(200px) rotateX(20deg) }</style><rect width="10" height="10"/></svg>`;
    expect(inlineImgSvg(sheet, place)).toBeNull();
    // perspective() alone never reaches the plane: still inlined.
    expect(inlineImgSvg(icon(` style="transform: perspective(200px)"`), place)).not.toBeNull();
  });

  it("uses the concrete object rect (object-fit: contain) for the origin and the image clip", () => {
    // 100x100 viewBox contained in a 160x100 box, left-aligned → object rect x=50..150, not the box center 130.
    const contain = { x: 50, y: 50, w: 160, h: 100, par: "xMinYMid meet", idPrefix: "c-" };
    const out = flattenImgSvg(icon(` transform="scale(0.5)"`), contain)!;
    expect(out).toContain(`<rect x="50" y="50" width="100" height="100"/></clipPath><g clip-path="url(#c-vclip-img)">`);
    expect(out).toContain(`translate(100 100) scale(0.5) translate(-100 -100)`);
  });

  it("overflow: visible still clips to the drawn image when a root transform applies", () => {
    const out = flattenImgSvg(icon(` overflow="visible" transform="rotate(10)"`), place)!;
    expect(out).toContain(`id="p-vclip-img"`);
    expect(out).not.toContain(`id="p-vclip"`);
  });

  it("an icon without a root transform is unchanged", () => {
    expect(inlineImgSvg(icon(""), place)).not.toContain("vclip-img");
    expect(flattenImgSvg(icon(""), place)).not.toContain("vclip-img");
  });

  it("a flattened DOM-inline svg keeps its viewport matrix: the capture's neutralizing style no longer overrides it", () => {
    const el = {
      tag: "svg",
      text: "",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [],
      svgContent: `<svg viewBox="0 0 100 100" transform="rotate(30)" style="transform: translate(0px); overflow: hidden;" width="100" height="100"><rect width="100" height="40" fill="red"/></svg>`,
      styles: { ...BASE_STYLES } as CapturedElement["styles"],
    } as unknown as CapturedElement;
    const out = elementTreeToSvg([el], 120, 120, { flattenNestedSvg: true });
    const group = out.match(/<g[^>]*transform="matrix\([^"]*\)"[^>]*>/)?.[0];
    expect(group).toBeDefined();
    expect(group).not.toMatch(/style="[^"]*transform/);
    expect(group).not.toMatch(/rotate\(30\)/);
  });
});

describe("flattenImgSvg — nested <svg> → <g transform> (DM-K0S6ZS)", () => {
  const place = { x: 4, y: 8, w: 16, h: 16, par: "xMidYMid meet", idPrefix: "svgimg0" };

  it("emits a matrix-transformed group with a viewport clip for a safe icon", () => {
    const out = flattenImgSvg(`<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="red"/></svg>`, place);
    expect(out).not.toBeNull();
    expect(out).not.toContain("<svg"); // the nested <svg> wrapper is gone
    expect(out).toMatch(/<g[^>]* transform="matrix\(0\.666667 0 0 0\.666667 4 8\)"/); // 16/24 scale, placed at (4,8)
    expect(out).toContain(`<clipPath id="svgimg0vclip">`); // overflow-hidden default → rect clip
    expect(out).toContain(`d="M2 2h20v20H2z"`);
  });

  // SVGImage::DrawInternal clips every frame to its destination rect
  // (core/svg/graphics/svg_image.cc:548, chromium 7d859f27), whatever the
  // root's overflow; a Chromium probe confirms content outside the viewBox of
  // an overflow="visible" image is not painted outside the image box.
  it("clips an overflow:visible source to the drawn image instead of omitting the clip", () => {
    for (const root of [` overflow="visible"`, ` style="overflow: visible"`]) {
      const out = flattenImgSvg(`<svg viewBox="0 0 24 24"${root}><path d="M0 0h1v1z"/></svg>`, place)!;
      expect(
        out.startsWith(`<clipPath id="svgimg0vclip-img"><rect x="4" y="8" width="16" height="16"/></clipPath>`),
      ).toBe(true);
      expect(out).toContain(`<g clip-path="url(#svgimg0vclip-img)"><g`);
      expect(out).not.toContain(`id="svgimg0vclip"`);
    }
  });

  it("clips an overflow:visible nested <svg> to the drawn image", () => {
    const out = inlineImgSvg(`<svg viewBox="0 0 24 24" overflow="visible"><path d="M0 0h1v1z"/></svg>`, place)!;
    expect(
      out.startsWith(`<clipPath id="svgimg0vclip-img"><rect x="4" y="8" width="16" height="16"/></clipPath>`),
    ).toBe(true);
    expect(out).toContain(`<g clip-path="url(#svgimg0vclip-img)"><svg overflow="visible"`);
  });

  it("clips a contain-fitted image to its object rect, not the wider placement box", () => {
    const wide = { ...place, w: 32 };
    const nested = inlineImgSvg(`<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>`, wide)!;
    expect(nested).toContain(`<rect x="12" y="8" width="16" height="16"/>`);
    const flat = flattenImgSvg(`<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>`, wide)!;
    expect(flat).toContain(`<clipPath id="svgimg0vclip-img"><rect x="12" y="8" width="16" height="16"/></clipPath>`);
  });

  it("adds no image clip when the object rect fills the placement box", () => {
    const out = inlineImgSvg(`<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>`, place)!;
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).not.toContain("clipPath");
  });

  it("returns null (→ caller keeps the nested <svg>) for an unsafe source", () => {
    expect(flattenImgSvg(`<svg viewBox="0 0 24 24"><rect width="50%" height="50%"/></svg>`, place)).toBeNull();
    expect(flattenImgSvg(`<svg viewBox="0 0 24 24"><use href="#x"/></svg>`, place)).toBeNull();
  });

  it("returns null when there is no usable coordinate system", () => {
    expect(flattenImgSvg(`<svg><path d="M0 0h1v1z"/></svg>`, place)).toBeNull();
  });
});

describe("nested-SVG flattening is a scoped, restorable setting (DM-K0S6ZS transitions)", () => {
  const svg = `<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#f00"/></svg>`;
  const tree = (): CapturedElement[] => [imgEl(SVG_URI(svg))];
  const nested = /<svg[^>]*viewBox="0 0 24 24"/;

  it("defaults off, and the scope restores the previous value on return and on throw", () => {
    expect(getFlattenNestedSvg()).toBe(false);
    expect(withFlattenNestedSvg(true, () => getFlattenNestedSvg())).toBe(true);
    expect(getFlattenNestedSvg()).toBe(false);
    expect(() =>
      withFlattenNestedSvg(true, () => {
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(getFlattenNestedSvg()).toBe(false);
  });

  it("nested scopes unwind one level at a time", () => {
    withFlattenNestedSvg(true, () => {
      withFlattenNestedSvg(false, () => expect(getFlattenNestedSvg()).toBe(false));
      expect(getFlattenNestedSvg()).toBe(true);
    });
    expect(getFlattenNestedSvg()).toBe(false);
  });

  it("the render option flips the output for one call only: off → on → off on the same tree", () => {
    const t = tree();
    const off = elementTreeToSvg(t, 200, 200, {});
    const on = elementTreeToSvg(t, 200, 200, { flattenNestedSvg: true });
    const offAgain = elementTreeToSvg(t, 200, 200, {});
    expect(off).toMatch(nested);
    expect(on).not.toMatch(nested);
    expect(on).toContain("matrix(");
    expect(offAgain).toBe(off);
    expect(getFlattenNestedSvg()).toBe(false);
  });

  it("an explicit false overrides a process-wide true, and the process setting survives the call", () => {
    setFlattenNestedSvg(true);
    try {
      expect(elementTreeToSvg(tree(), 200, 200, { flattenNestedSvg: false })).toMatch(nested);
      expect(getFlattenNestedSvg()).toBe(true);
    } finally {
      setFlattenNestedSvg(false);
    }
  });

  it("a render that throws under the option leaves the setting restored", () => {
    const bad = [{ ...imgEl(SVG_URI(svg)), styles: undefined }] as unknown as CapturedElement[];
    expect(() => elementTreeToSvg(bad, 200, 200, { flattenNestedSvg: true })).toThrow();
    expect(getFlattenNestedSvg()).toBe(false);
  });
});

describe("editSvgRootAttributes escapes set values for XML", () => {
  it("escapes < and drops XML-illegal code points (they used to pass through)", () => {
    const out = editSvgRootAttributes('<svg viewBox="0 0 1 1"></svg>', [], { "aria-label": 'a<b & "c"\u0001' });
    expect(out).toBe('<svg viewBox="0 0 1 1" aria-label="a&lt;b &amp; &quot;c&quot;"></svg>');
  });
});

// DM-NEV5JJ: the `<style>` selector scans used `/([^{}]*)(\{[^{}]*\})/g` and
// `/([^{}]+)\{[^{}]*\}/g`, which backtrack quadratically through a long
// brace-free run that is not a flat block's body (here a data-URI `@import`
// after the last rule): 40 KB took 5-6 s per scan.
describe("SVG <style> selector scans stay linear on long brace-free runs (DM-NEV5JJ)", () => {
  const css = `.cls-1{fill:#a}#g{stroke:url(#a)} @import url("data:text/css;base64,${"QUJD".repeat(100_000)}");`;
  const svg = `<style>${css}</style><g id="g" class="cls-1"/>`;

  it("prefixSvgIds, prefixSvgClasses and isSvgSafeToFlatten finish quickly with the same rewrite", () => {
    const started = performance.now();
    const ids = prefixSvgIds(svg, "P-");
    const classes = prefixSvgClasses(svg, "P-");
    const safe = isSvgSafeToFlatten(svg);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(ids.includes(".cls-1{fill:#a}#P-g{stroke:url(#a)}")).toBe(true);
    expect(classes.includes(".P-cls-1{fill:#a}#g{")).toBe(true);
    expect(safe).toBe(true);
  });
});

describe("<img> SVG document Settings in its sheets", () => {
  // The image page copies prefersReducedMotion / inForcedColors from the
  // first ordinary page's Settings (isolated_svg_document_host.cc:192-199);
  // capture records them on the <img>, and the scoped sheet freezes the answer.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>` +
    `@media (prefers-reduced-motion: reduce) { rect { fill: blue } } @media (forced-colors) { circle { fill: red } }` +
    `</style><rect width="10" height="5"/><circle cx="5" cy="8" r="2"/></svg>`;
  it("freezes prefers-reduced-motion and forced-colors from the recorded Settings", () => {
    const el = {
      ...imgEl(SVG_URI(svg)),
      imageDocumentPrefersReducedMotion: true,
      imageDocumentForcedColors: false,
    } as CapturedElement;
    const out = elementTreeToSvg([el], 100, 100);
    expect(out).not.toMatch(/prefers-reduced-motion|forced-colors/);
    expect(out).toMatch(/@media all \{ rect/);
    expect(out).toMatch(/@media not all \{ circle/);
  });
  it("leaves both live without a recording", () => {
    const out = elementTreeToSvg([imgEl(SVG_URI(svg))], 100, 100);
    expect(out).toContain("@media (prefers-reduced-motion: reduce)");
    expect(out).toContain("@media (forced-colors)");
  });
});
