import { describe, expect, it } from "vitest";
import { cascadeRootStylesheetTransform } from "./svg-image-root-stylesheet.js";
import { scopeImageStyleSheets, IMAGE_ROOT_ATTR } from "./svg-image-style-scope.js";
import { collectImageSupportsConditions, decideImageSupports, supportsConditionKey } from "./svg-image-supports.js";

const R = `[${IMAGE_ROOT_ATTR}="P-"]`;
const W = `:where(${R}, ${R} *)`;

describe("collectImageSupportsConditions", () => {
  it("collects each prelude once, keyed by its whitespace-collapsed text", () => {
    const svg =
      `<svg><style>@supports  (display:\n grid) { rect {} } @media all { @supports not (foo: bar) { g {} } }</style>` +
      `<style>/* c */ @supports (display: grid) { circle {} } @supports selector(a &amp; b) { path {} }</style>` +
      `<style><![CDATA[ @supports selector(a &amp; c) { text {} } ]]></style></svg>`;
    expect(collectImageSupportsConditions(svg)).toEqual([
      { key: "(display: grid)", condition: "(display: grid)" },
      { key: "not (foo: bar)", condition: "not (foo: bar)" },
      // Outside CDATA the DOM's sheet text has XML references expanded.
      { key: "selector(a &amp; b)", condition: "selector(a & b)" },
      { key: "selector(a &amp; c)", condition: "selector(a &amp; c)" },
    ]);
  });

  it("skips a condition a DTD-defined entity leaves unknown", () => {
    expect(collectImageSupportsConditions(`<svg><style>@supports (x: &e;) {}</style></svg>`)).toEqual([]);
  });

  it("looks up a recorded answer by key", () => {
    expect(supportsConditionKey("  (a:\tb)  ")).toBe("(a: b)");
    expect(decideImageSupports(" (a:  b) ", { "(a: b)": false })).toBe(false);
    expect(decideImageSupports("(c: d)", { "(a: b)": true })).toBeNull();
    expect(decideImageSupports("(a: b)", undefined)).toBeNull();
  });
});

describe("decided @supports in image sheets", () => {
  const css = `<style>@supports (display: grid) { rect { fill: green } } @supports (foo: bar) { circle { fill: red } } @supports (gap: 1px) { path {} }</style>`;
  const supports = { "(display: grid)": true, "(foo: bar)": false };

  it("freezes a decided block in the scoped output sheet and leaves the rest live", () => {
    const out = scopeImageStyleSheets(css, "P-", null, { supports });
    expect(out).toContain(`@media all { rect${W} { fill: green } }`);
    expect(out).toContain(`@media not all { circle${W} { fill: red } }`);
    expect(out).toContain(`@supports (gap: 1px) { path${W} {} }`);
  });

  it("lets the root-transform cascade apply or skip a decided block", () => {
    const svg = `<svg><style>@supports (display: grid) { svg { rotate: 10deg } } @supports (foo: bar) { svg { scale: 2 } }</style><rect/></svg>`;
    const end = svg.indexOf(">") + 1;
    const result = cascadeRootStylesheetTransform(svg, end, { tag: "svg", id: null, className: null }, null, {
      supports,
    });
    if (result == null || result === "unsupported") throw new Error("expected a cascade");
    expect(result.declarations.get("rotate")?.value).toBe("10deg");
    expect(result.declarations.has("scale")).toBe(false);
    // Undecided: the sheet's transform stays unapplied.
    expect(cascadeRootStylesheetTransform(svg, end, { tag: "svg", id: null, className: null })).toBe("unsupported");
  });
});
