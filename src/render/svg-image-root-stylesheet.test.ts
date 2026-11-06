import { describe, expect, it } from "vitest";
import { cascadeRootStylesheetTransform, IMAGE_ROOT_MARKER } from "./svg-image-root-stylesheet.js";
import { inlineImgSvg, flattenImgSvg, readSvgOpeningTag } from "./svg-inline.js";

function cascade(svg: string) {
  const tag = readSvgOpeningTag(svg)!;
  const attr = (name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(tag.attributes)?.[1] ?? null;
  return cascadeRootStylesheetTransform(svg, tag.end, { tag: tag.name, id: attr("id"), className: attr("class") });
}

const valueOf = (r: ReturnType<typeof cascade>, prop: string): string | undefined =>
  r != null && r !== "unsupported" ? r.declarations.get(prop)?.value : undefined;

describe("cascadeRootStylesheetTransform", () => {
  it("returns null without a sheet or without a transform-family declaration reaching the root", () => {
    expect(cascade(`<svg><rect/></svg>`)).toBeNull();
    expect(cascade(`<svg><style>rect { transform: rotate(1deg) } svg { fill: red }</style><rect/></svg>`)).toBeNull();
    // A combinator can never match the parentless root.
    expect(cascade(`<svg><style>g svg { transform: rotate(1deg) }</style><g/></svg>`)).toBeNull();
  });

  it("matches type, :root, #id and .class compounds and strips the applied declarations", () => {
    const r = cascade(
      `<svg id="r" class="a b"><style>svg { transform: rotate(10deg); fill: red } :root { transform-origin: 0 0 } #r.a { scale: 2 } .b { rotate: 5deg }</style><rect/></svg>`,
    );
    expect(r).not.toBeNull();
    expect(r).not.toBe("unsupported");
    expect(valueOf(r, "transform")).toBe("rotate(10deg)");
    expect(valueOf(r, "transform-origin")).toBe("0 0");
    expect(valueOf(r, "scale")).toBe("2");
    expect(valueOf(r, "rotate")).toBe("5deg");
    if (r == null || r === "unsupported") return;
    expect(r.source).toContain("fill: red");
    expect(r.source).not.toMatch(/transform|scale:|rotate:/);
    expect(r.markRoot).toBe(false);
  });

  it("ranks by importance, then specificity, then order", () => {
    const sheet = `svg { transform: rotate(1deg) } #r { transform: rotate(2deg) } svg { transform: rotate(3deg) }`;
    expect(valueOf(cascade(`<svg id="r"><style>${sheet}</style><rect/></svg>`), "transform")).toBe("rotate(2deg)");
    const later = `svg { transform: rotate(1deg) } svg { transform: rotate(3deg) }`;
    expect(valueOf(cascade(`<svg><style>${later}</style><rect/></svg>`), "transform")).toBe("rotate(3deg)");
    const imp = `svg { transform: rotate(1deg) !important } #r { transform: rotate(2deg) }`;
    expect(valueOf(cascade(`<svg id="r"><style>${imp}</style><rect/></svg>`), "transform")).toBe("rotate(1deg)");
  });

  it("keeps the transform for other selectors in the same rule, and for other elements of a shared selector", () => {
    const r = cascade(
      `<svg class="c"><style>svg, rect { transform: rotate(4deg) } .c { scale: 2 }</style><rect class="c"/></svg>`,
    );
    if (r == null || r === "unsupported") throw new Error("expected a cascade");
    expect(r.source).toContain(`svg, rect {} rect {transform: rotate(4deg)}`);
    expect(r.source).toContain(`.c {} .c:not([${IMAGE_ROOT_MARKER}]) {scale: 2}`);
    expect(r.markRoot).toBe(true);
    expect(valueOf(r, "scale")).toBe("2");
  });

  it("is unsupported for an undecidable compound or a transform inside an at-rule", () => {
    expect(cascade(`<svg><style>svg[width] { transform: rotate(1deg) }</style><rect/></svg>`)).toBe("unsupported");
    expect(cascade(`<svg><style>svg:hover { transform: rotate(1deg) }</style><rect/></svg>`)).toBe("unsupported");
    expect(
      cascade(`<svg><style>@media (min-width: 1px) { svg { transform: rotate(1deg) } }</style><rect/></svg>`),
    ).toBe("unsupported");
  });

  it("preserves a CDATA wrapper and comments outside the rewritten rule", () => {
    const r = cascade(`<svg><style><![CDATA[ /* x */ svg { transform: rotate(1deg) } ]]></style><rect/></svg>`);
    if (r == null || r === "unsupported") throw new Error("expected a cascade");
    expect(r.source).toContain("<![CDATA[ /* x */ svg {}");
    expect(r.source).toContain("]]></style>");
  });
});

describe("<img> SVG root transform from the document's own <style>", () => {
  const P = { x: 0, y: 0, w: 100, h: 100, par: "none", documentViewport: true, idPrefix: "S-" };

  it("composes the sheet transform around the root and removes it from the inlined sheet", () => {
    const out = inlineImgSvg(
      `<svg viewBox="0 0 100 100"><style>svg { transform: rotate(20deg) }</style><rect width="100" height="40"/></svg>`,
      P,
    )!;
    expect(out).toContain(`translate(50 50) rotate(20) translate(-50 -50)`);
    expect(out).toContain(`<style>svg {}</style>`);
  });

  it("lets the style attribute beat a normal sheet rule, and an important sheet rule beat it", () => {
    const inline = inlineImgSvg(
      `<svg id="r" viewBox="0 0 100 100" style="transform: rotate(30deg)"><style>#r { transform: scale(0.6) }</style><rect/></svg>`,
      P,
    )!;
    expect(inline).toContain("rotate(30)");
    expect(inline).not.toContain("scale(0.6)");
    const important = inlineImgSvg(
      `<svg id="r" viewBox="0 0 100 100" style="transform: rotate(30deg)"><style>#r { transform: scale(0.6) !important }</style><rect/></svg>`,
      P,
    )!;
    expect(important).toContain("scale(0.6 0.6)");
  });

  it("applies a sheet transform-origin to the transform attribute", () => {
    const out = inlineImgSvg(
      `<svg viewBox="0 0 100 100" transform="rotate(15)"><style>:root { transform-origin: 0 0 }</style><rect/></svg>`,
      P,
    )!;
    expect(out).toContain(`translate(0 0) rotate(15) translate(0 0)`);
  });

  it("marks the root when a shared selector keeps its transform for other elements", () => {
    const out = inlineImgSvg(
      `<svg class="c" viewBox="0 0 100 100"><style>.c { transform: rotate(-25deg) }</style><rect class="c"/></svg>`,
      P,
    )!;
    expect(out).toContain(`${IMAGE_ROOT_MARKER}=""`);
    expect(out).toContain(`:not([${IMAGE_ROOT_MARKER}])`);
    expect(out).toContain("rotate(-25)");
  });

  it("flattenImgSvg applies a .class sheet transform once (the group does not re-apply it)", () => {
    const out = flattenImgSvg(
      `<svg class="k" viewBox="0 0 100 100"><style>.k { transform: rotate(10deg) }</style><rect/></svg>`,
      P,
    )!;
    expect(out).toContain("rotate(10)");
    expect(out).toContain(`.S-k {}`);
  });
});
