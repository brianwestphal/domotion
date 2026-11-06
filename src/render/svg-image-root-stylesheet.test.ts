import { describe, expect, it } from "vitest";
import { cascadeRootStylesheetTransform } from "./svg-image-root-stylesheet.js";
import { IMAGE_ROOT_ATTR } from "./svg-image-style-scope.js";
import { inlineImgSvg, flattenImgSvg, readSvgOpeningTag } from "./svg-inline.js";

function cascade(svg: string, viewport: { w: number; h: number } | null = null) {
  const tag = readSvgOpeningTag(svg)!;
  const attributes = [...tag.attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m): [string, string] => [m[1], m[2]]);
  const attr = (name: string): string | null => attributes.find(([n]) => n === name)?.[1] ?? null;
  return cascadeRootStylesheetTransform(
    svg,
    tag.end,
    { tag: tag.name, id: attr("id"), className: attr("class"), attributes },
    viewport,
  );
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
    expect(r.source).toContain(`.c {} .c:not([${IMAGE_ROOT_ATTR}]) {scale: 2}`);
    expect(valueOf(r, "scale")).toBe("2");
  });

  it("decides attribute selectors, :not / :is / :where and never-matching dynamic pseudo-classes", () => {
    const svg = (rule: string) => `<svg width="90" data-k="a b" lang="en-US"><style>${rule}</style><rect/></svg>`;
    expect(valueOf(cascade(svg(`svg[width] { transform: rotate(1deg) }`)), "transform")).toBe("rotate(1deg)");
    expect(valueOf(cascade(svg(`[data-k~="b"][lang|=en] { rotate: 2deg }`)), "rotate")).toBe("2deg");
    expect(valueOf(cascade(svg(`[width^="9"][width$="0"][width*="0"] { scale: 3 }`)), "scale")).toBe("3");
    expect(valueOf(cascade(svg(`[lang="EN-us" i] { scale: 4 }`)), "scale")).toBe("4");
    expect(cascade(svg(`svg[height] { transform: rotate(1deg) }`))).toBeNull();
    expect(cascade(svg(`svg:hover { transform: rotate(1deg) }`))).toBeNull();
    expect(valueOf(cascade(svg(`svg:not(:hover, .x) { rotate: 5deg }`)), "rotate")).toBe("5deg");
    expect(cascade(svg(`svg:not([width]) { rotate: 5deg }`))).toBeNull();
    expect(valueOf(cascade(svg(`:is(g svg, svg[data-k]) { rotate: 6deg }`)), "rotate")).toBe("6deg");
    // :where() adds no specificity; :is() takes its argument's.
    const order = svg(
      `:where(svg[width]) { rotate: 1deg } svg { rotate: 2deg } :is([width]) { scale: 1 } svg { scale: 2 }`,
    );
    expect(valueOf(cascade(order), "rotate")).toBe("2deg");
    expect(valueOf(cascade(order), "scale")).toBe("1");
  });

  it("evaluates @media against the image viewport and strips non-matching blocks too", () => {
    const svg = `<svg><style>@media (min-width: 150px) { svg { rotate: 1deg } } @media (max-width: 150px) and (orientation: landscape) { svg { scale: 2 } } @media (100px < width <= 200px), print { svg { translate: 3px } }</style><rect/></svg>`;
    const narrow = cascade(svg, { w: 120, h: 80 });
    if (narrow == null || narrow === "unsupported") throw new Error("expected a cascade");
    expect(narrow.declarations.get("rotate")).toBeUndefined();
    expect(narrow.declarations.get("scale")?.value).toBe("2");
    expect(narrow.declarations.get("translate")?.value).toBe("3px");
    expect(narrow.source).not.toMatch(/rotate|scale|translate/);
    expect(narrow.source).toContain("@media (min-width: 150px) { svg {} }");
    expect(valueOf(cascade(svg, { w: 300, h: 80 }), "rotate")).toBe("1deg");
    // Without a known viewport, or with an unsupported feature, it is undecidable.
    expect(cascade(svg)).toBe("unsupported");
    expect(
      cascade(`<svg><style>@media (prefers-color-scheme: dark) { svg { rotate: 1deg } }</style></svg>`, { w: 1, h: 1 }),
    ).toBe("unsupported");
  });

  it("is unsupported for an undecidable compound or a transform inside another at-rule", () => {
    expect(cascade(`<svg><style>svg:first-child { transform: rotate(1deg) }</style><rect/></svg>`)).toBe("unsupported");
    expect(cascade(`<svg><style>svg:nth-child(1) { transform: rotate(1deg) }</style><rect/></svg>`)).toBe(
      "unsupported",
    );
    expect(
      cascade(`<svg><style>@supports (display: grid) { svg { transform: rotate(1deg) } }</style><rect/></svg>`),
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
    expect(out).toContain(`<style>svg:where([${IMAGE_ROOT_ATTR}="S-"], [${IMAGE_ROOT_ATTR}="S-"] *) {}</style>`);
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
    expect(out).toContain(`${IMAGE_ROOT_ATTR}="S-"`);
    expect(out).toContain(`:not([${IMAGE_ROOT_ATTR}])`);
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
