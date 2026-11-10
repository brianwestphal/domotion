import { describe, expect, it } from "vitest";
import { anPlusBMatches, IMAGE_ROOT_ATTR, scopeImageStyleSheets, scopeSelectorList } from "./svg-image-style-scope.js";
import { inlineImgSvg } from "./svg-inline.js";
import { resolveImageNamespace } from "./svg-image-namespace.js";

const R = `[${IMAGE_ROOT_ATTR}="P-"]`;
const W = `:where(${R}, ${R} *)`;

describe("scopeSelectorList", () => {
  it("confines every compound of a complex selector, keeping combinators", () => {
    expect(scopeSelectorList("g rect", "P-")).toBe(`g${W} rect${W}`);
    expect(scopeSelectorList("svg > rect + circle ~ path", "P-")).toBe(`svg${W} > rect${W} + circle${W} ~ path${W}`);
    expect(scopeSelectorList("*", "P-")).toBe(`*${W}`);
  });

  it("scopes each selector of a list and keeps surrounding whitespace", () => {
    expect(scopeSelectorList("rect, circle", "P-")).toBe(`rect${W}, circle${W}`);
  });

  it("maps :root to the image root attribute (outside strings)", () => {
    expect(scopeSelectorList(":root", "P-")).toBe(`${R}${W}`);
    expect(scopeSelectorList("rect:not(:root)", "P-")).toBe(`rect:not(${R}${W})${W}`);
    expect(scopeSelectorList(`[title=":root"]`, "P-")).toBe(`[title=":root"]${W}`);
    expect(scopeSelectorList(":root-ish", "P-")).toBe(`:root-ish${W}`);
  });

  it("puts the filter before a pseudo-element and ignores separators inside brackets", () => {
    expect(scopeSelectorList("text::selection", "P-")).toBe(`text${W}::selection`);
    expect(scopeSelectorList(`rect[data-x="a b"]:not(.q > .r)`, "P-")).toBe(
      `rect[data-x="a b"]:not(.q${W} > .r${W})${W}`,
    );
  });

  it("leaves a compound that already requires a namespaced class or id", () => {
    expect(scopeSelectorList(".P-cls rect", "P-")).toBe(`.P-cls rect${W}`);
    expect(scopeSelectorList("#P-root", "P-")).toBe("#P-root");
    expect(scopeSelectorList("rect:not(.P-cls)", "P-")).toBe(`rect:not(.P-cls)${W}`);
  });

  it("confines relative :has() selectors without changing their combinators", () => {
    expect(scopeSelectorList("svg:has(+ g)", "P-")).toBe(`svg:has(+ g${W})${W}`);
    expect(scopeSelectorList("svg:has(~ .P-x)", "P-")).toBe(`svg:has(~ .P-x${W})${W}`);
    expect(scopeSelectorList("g:has(> rect + circle, path)", "P-")).toBe(
      `g:has(> rect${W} + circle${W}, path${W})${W}`,
    );
  });

  it("confines complex logical selectors nested inside :has()", () => {
    expect(scopeSelectorList("svg:has(:is(body rect, g > path))", "P-")).toBe(
      `svg:has(:is(body${W} rect${W}, g${W} > path${W})${W})${W}`,
    );
    expect(scopeSelectorList("svg:has(:not(body rect))", "P-")).toBe(`svg:has(:not(body${W} rect${W})${W})${W}`);
    expect(scopeSelectorList(`[title=":has(+ g)"]`, "P-")).toBe(`[title=":has(+ g)"]${W}`);
  });

  it("confines top-level logical selector lists and their nested relations", () => {
    expect(scopeSelectorList("rect:is(body rect, g > rect)", "P-")).toBe(
      `rect:is(body${W} rect${W}, g${W} > rect${W})${W}`,
    );
    expect(scopeSelectorList("rect:not(body rect)", "P-")).toBe(`rect:not(body${W} rect${W})${W}`);
    expect(scopeSelectorList("rect:where(:is(body rect))", "P-")).toBe(`rect:where(:is(body${W} rect${W})${W})${W}`);
  });
});

describe("scopeImageStyleSheets", () => {
  it("scopes qualified rules, recurses into conditional groups and leaves other at-rules alone", () => {
    const css =
      `<style><![CDATA[ /* c */ rect { fill: red } @media (min-width: 1px) { circle { fill: blue } } ` +
      `@keyframes k { from { opacity: 0 } to { opacity: 1 } } @font-face { font-family: X } @import url(a.css); path{} ]]></style>`;
    const out = scopeImageStyleSheets(css, "P-");
    expect(out).toContain(`<![CDATA[ /* c */ rect${W} { fill: red }`);
    expect(out).toContain(`@media (min-width: 1px) { circle${W} { fill: blue } }`);
    expect(out).toContain(`@keyframes k { from { opacity: 0 } to { opacity: 1 } }`);
    expect(out).toContain(`@font-face { font-family: X }`);
    expect(out).toContain(`@import url(a.css); path${W}{} ]]></style>`);
  });

  it("is a no-op without a <style> element", () => {
    expect(scopeImageStyleSheets(`<rect/>`, "P-")).toBe(`<rect/>`);
  });
});

describe("inlineImgSvg scopes its sheets to the image", () => {
  const P = { x: 0, y: 0, w: 100, h: 100, par: "xMidYMid meet", idPrefix: "P-" };
  const prefix = resolveImageNamespace(P.idPrefix).sourcePrefix;
  const W = `:where([${IMAGE_ROOT_ATTR}="${prefix}"], [${IMAGE_ROOT_ATTR}="${prefix}"] *)`;

  it("marks the root and namespaces a #id selector that targets the root's own id", () => {
    const out = inlineImgSvg(
      `<svg id="r" viewBox="0 0 10 10"><style>#r rect { fill: red } g rect { stroke: blue }</style><g><rect/></g></svg>`,
      P,
    )!;
    expect(out).toContain(`id="${prefix}r"`);
    expect(out).toContain(`${IMAGE_ROOT_ATTR}="${prefix}"`);
    expect(out).toContain(`#${prefix}r rect${W} { fill: red }`);
    expect(out).toContain(`g${W} rect${W} { stroke: blue }`);
  });

  it("leaves a sheet-free SVG without the marker", () => {
    expect(inlineImgSvg(`<svg viewBox="0 0 10 10"><rect/></svg>`, P)).not.toContain(IMAGE_ROOT_ATTR);
  });
});

describe("image-document answers frozen for the inlined root", () => {
  it("gives the root its sibling-less answer for structural pseudo-classes, keeping specificity", () => {
    expect(scopeSelectorList("svg:first-child", "P-")).toBe(`svg:is(:first-child, ${R})${W}`);
    expect(scopeSelectorList(":scope > rect", "P-")).toBe(`${R}${W} > rect${W}`);
    expect(scopeSelectorList("rect:nth-child(odd)", "P-")).toBe(`rect:is(:nth-child(odd), ${R})${W}`);
    expect(scopeSelectorList("svg:nth-child(2n)", "P-")).toBe(`svg:nth-child(2n):not(:where(${R}))${W}`);
    expect(scopeSelectorList("svg:nth-child(1 of :root)", "P-")).toBe(
      `svg:is(:nth-child(1 of ${R}${W}), ${R}:is(${R}${W}))${W}`,
    );
    expect(scopeSelectorList("rect:not(:last-of-type)", "P-")).toBe(`rect:not(:is(:last-of-type, ${R})${W})${W}`);
    expect(scopeSelectorList(`[title=":first-child"]`, "P-")).toBe(`[title=":first-child"]${W}`);
    expect(scopeSelectorList("text::first-line", "P-")).toBe(`text${W}::first-line`);
  });

  it("evaluates An+B for index 1", () => {
    expect(anPlusBMatches("odd", 1)).toBe(true);
    expect(anPlusBMatches("even", 1)).toBe(false);
    expect(anPlusBMatches("-n + 3", 1)).toBe(true);
    expect(anPlusBMatches("3n-2", 1)).toBe(true);
    expect(anPlusBMatches("n+2", 1)).toBe(false);
    expect(anPlusBMatches("1", 1)).toBe(true);
    expect(anPlusBMatches("foo", 1)).toBeNull();
  });

  it("freezes @media against the image viewport and warns when it cannot", () => {
    const css = `<style>@media (max-width: 100px) { rect { fill: green } } @media (min-width: 30em) { circle { fill: red } } @media (prefers-reduced-motion: reduce) { path { fill: blue } }</style>`;
    const out = scopeImageStyleSheets(css, "P-", { w: 90, h: 90 });
    expect(out).toContain(`@media all { rect${W} { fill: green } }`);
    expect(out).toContain(`@media not all { circle${W} { fill: red } }`);
    expect(out).toContain(`@media (prefers-reduced-motion: reduce) { path${W} { fill: blue } }`);
    // Without a known viewport the query is left to the output document.
    expect(scopeImageStyleSheets(css, "P-")).toContain(`@media (max-width: 100px) { rect${W}`);
  });

  // The image page has no hover / pointer and sees the embedder's color scheme
  // (ResolveColorSchemeForEmbedding), whatever the output document's are.
  it("keeps a hex escape's terminating space inside its compound", () => {
    expect(scopeSelectorList(`#\\31 a rect`, "P-")).toBe(`#\\31 a${W} rect${W}`);
  });

  it("freezes environment media features with the image document's answers", () => {
    const css = `<style>@media (hover: hover) { path { fill: blue } } @media (prefers-color-scheme: dark) { rect { fill: white } }</style>`;
    const dark = scopeImageStyleSheets(css, "P-", null, { preferredColorScheme: "dark" });
    expect(dark).toContain(`@media not all { path${W} { fill: blue } }`);
    expect(dark).toContain(`@media all { rect${W} { fill: white } }`);
    const light = scopeImageStyleSheets(css, "P-", null, { preferredColorScheme: "light" });
    expect(light).toContain(`@media not all { rect${W} { fill: white } }`);
    // An unknown embedding scheme stays live.
    expect(scopeImageStyleSheets(css, "P-")).toContain(`@media (prefers-color-scheme: dark) { rect${W}`);
  });
});

describe("cascade layer names stay per image", () => {
  it("namespaces top-level layer blocks and statements, keeping sublayers and anonymous layers", () => {
    const css =
      `<style>@layer a, b.c; @layer b { @layer c, d; rect { fill: red } } @layer { circle { fill: blue } } ` +
      `@media (hover: hover) { @layer e { path {} } } @layer a { @layer f { g {} } } @layer z;</style>`;
    const out = scopeImageStyleSheets(css, "P-");
    expect(out).toContain(`@layer P-a, P-b.c;`);
    expect(out).toContain(`@layer P-b { @layer c, d; rect${W} { fill: red } }`);
    expect(out).toContain(`@layer { circle${W} { fill: blue } }`);
    expect(out).toContain(`@media not all { @layer P-e { path${W} {} } }`);
    expect(out).toContain(`@layer P-a { @layer f { g${W} {} } }`);
    expect(out).toContain(`@layer P-z;</style>`);
  });

  it("namespaces an @import layer() name", () => {
    const out = scopeImageStyleSheets(
      `<style>@import url(a.css) layer(base); @import url(b.css) layer; rect {}</style>`,
      "P-",
    );
    expect(out).toContain(`@import url(a.css) layer(P-base);`);
    expect(out).toContain(`@import url(b.css) layer;`);
  });

  it("gives two inlined images with opposite layer orders distinct layers", () => {
    const P = { x: 0, y: 0, w: 100, h: 100, par: "xMidYMid meet" };
    const a = inlineImgSvg(`<svg viewBox="0 0 10 10"><style>@layer a, b;</style><rect/></svg>`, {
      ...P,
      idPrefix: "A-",
    })!;
    const b = inlineImgSvg(`<svg viewBox="0 0 10 10"><style>@layer b, a;</style><rect/></svg>`, {
      ...P,
      idPrefix: "B-",
    })!;
    const first = resolveImageNamespace("A-").sourcePrefix;
    const second = resolveImageNamespace("B-").sourcePrefix;
    expect(a).toContain(`@layer ${first}a, ${first}b;`);
    expect(b).toContain(`@layer ${second}b, ${second}a;`);
  });
});
