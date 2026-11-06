import { describe, expect, it } from "vitest";
import { IMAGE_ROOT_ATTR, scopeImageStyleSheets, scopeSelectorList } from "./svg-image-style-scope.js";
import { inlineImgSvg } from "./svg-inline.js";

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
    expect(scopeSelectorList("rect:not(:root)", "P-")).toBe(`rect:not(${R})${W}`);
    expect(scopeSelectorList(`[title=":root"]`, "P-")).toBe(`[title=":root"]${W}`);
    expect(scopeSelectorList(":root-ish", "P-")).toBe(`:root-ish${W}`);
  });

  it("puts the filter before a pseudo-element and ignores separators inside brackets", () => {
    expect(scopeSelectorList("text::selection", "P-")).toBe(`text${W}::selection`);
    expect(scopeSelectorList(`rect[data-x="a b"]:not(.q > .r)`, "P-")).toBe(`rect[data-x="a b"]:not(.q > .r)${W}`);
  });

  it("leaves a compound that already requires a namespaced class or id", () => {
    expect(scopeSelectorList(".P-cls rect", "P-")).toBe(`.P-cls rect${W}`);
    expect(scopeSelectorList("#P-root", "P-")).toBe("#P-root");
    expect(scopeSelectorList("rect:not(.P-cls)", "P-")).toBe(`rect:not(.P-cls)${W}`);
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

  it("marks the root and namespaces a #id selector that targets the root's own id", () => {
    const out = inlineImgSvg(
      `<svg id="r" viewBox="0 0 10 10"><style>#r rect { fill: red } g rect { stroke: blue }</style><g><rect/></g></svg>`,
      P,
    )!;
    expect(out).toContain(`id="P-r"`);
    expect(out).toContain(`${IMAGE_ROOT_ATTR}="P-"`);
    expect(out).toContain(`#P-r rect${W} { fill: red }`);
    expect(out).toContain(`g${W} rect${W} { stroke: blue }`);
  });

  it("leaves a sheet-free SVG without the marker", () => {
    expect(inlineImgSvg(`<svg viewBox="0 0 10 10"><rect/></svg>`, P)).not.toContain(IMAGE_ROOT_ATTR);
  });
});
