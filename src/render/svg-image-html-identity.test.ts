import { describe, expect, it } from "vitest";
import {
  imageHtmlNameUnchanged,
  imageHtmlSourceNamesUnchanged,
  imageHtmlSelectorNamesUnchanged,
} from "./svg-image-html-identity.js";
import { namespaceImageReferences, preserveImageStyleAttributeIdentity } from "./svg-image-references.js";
import { rewriteImageInlineStyle } from "./svg-image-reference-css.js";
import { inlineImgSvg, flattenImgSvg } from "./svg-inline.js";
const svg = (body: string, attributes = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" ${attributes}>${body}</svg>`;
describe("XML names at HTML SVG admission (DM-SC5Y23)", () => {
  it.each([
    "href",
    "style",
    "id",
    "class",
    "data-unknown",
    "data-é",
    "viewBox",
    "preserveAspectRatio",
    "gradientUnits",
    "stdDeviation",
    "xlink:href",
    "xml:lang",
  ])("keeps canonical attribute %s", (name) => expect(imageHtmlNameUnchanged(name, true)).toBe(true));
  it.each([
    "HREF",
    "hReF",
    "STYLE",
    "Style",
    "FILL",
    "ID",
    "CLASS",
    "data-Unknown",
    "viewbox",
    "VIEWBOX",
    "preserveaspectratio",
    "gradientunits",
    "XLINK:href",
    "xml:LANG",
  ])("refuses attribute spelling %s", (name) => expect(imageHtmlNameUnchanged(name, true)).toBe(false));
  it.each(["svg", "rect", "linearGradient", "clipPath", "feDropShadow", "altGlyph", "glyphRef", "custom-tag"])(
    "keeps canonical tag %s",
    (name) => expect(imageHtmlNameUnchanged(name, false)).toBe(true),
  );
  it.each(["SVG", "RECT", "STYLE", "lineargradient", "LINEARGRADIENT", "clippath", "feDropshadow", "Custom-tag"])(
    "refuses tag spelling %s",
    (name) => expect(imageHtmlNameUnchanged(name, false)).toBe(false),
  );
  it.each([
    '<image HREF="data:image/svg+xml,blue"/>',
    '<g STYLE="fill:blue"/>',
    '<rect fill="red" FILL="blue"/>',
    '<RECT width="40" height="40"/>',
    "<lineargradient/>",
    '<g data-Unknown="red"/>',
  ])("retains original source fallback in all image paths: %s", (body) => {
    const source = svg(body);
    expect(imageHtmlSourceNamesUnchanged(source)).toBe(false);
    expect(namespaceImageReferences(source, "im_")).toBeNull();
    // The XML-only style identity helper may preserve inert names internally;
    // both actual image admission paths reject them before any style rewrite.
    expect(typeof preserveImageStyleAttributeIdentity(source)?.markup).toBe("string");
    for (const documentViewport of [false, true])
      for (const render of [inlineImgSvg, flattenImgSvg])
        expect(render(source, { x: 0, y: 0, w: 40, h: 40, par: "none", idPrefix: "im_", documentViewport })).toBeNull();
  });
  it("keeps unknown canonical lowercase attribute identity and real SVG mixed-case names", () => {
    const source = svg(
      '<defs><linearGradient id="p" gradientUnits="userSpaceOnUse"><stop stop-color="red"/></linearGradient></defs><rect data-unknown="red" fill="url(#p)"/>',
      'viewBox="0 0 40 40" preserveAspectRatio="none"',
    );
    expect(imageHtmlSourceNamesUnchanged(source)).toBe(true);
    expect(namespaceImageReferences(source, "im_")).toContain('data-unknown="red"');
  });
  it("ignores name-shaped strings/comments/CDATA and refuses unparseable source", () => {
    expect(
      imageHtmlSourceNamesUnchanged(
        svg(
          '<style><![CDATA[g{--literal:"HREF STYLE <RECT/>"}]]></style><!-- <image HREF="blue"/> --><g data-label="HREF STYLE"/>',
        ),
      ),
    ).toBe(true);
    expect(imageHtmlSourceNamesUnchanged("<svg><g></svg>")).toBe(false);
  });
});

it.each([
  "RECT",
  "[DATA-MARK]",
  "[viewbox]",
  ":is(rect,[HREF])",
  ":has(> RECT)",
  ":nth-child(2 of [STYLE])",
  "r\\45 ct",
  "[data-\\4d ARK]",
])("refuses selector-name aliases recursively: %s", (selector) =>
  expect(imageHtmlSelectorNamesUnchanged(selector)).toBe(false),
);
it.each([
  "rect",
  "linearGradient",
  "[viewBox]",
  "[data-mark='UPPER']",
  ":is(rect,.UPPER)",
  ":has(> [data-mark])",
  ":nth-child(2 of rect)",
])("keeps canonical selector data: %s", (selector) => expect(imageHtmlSelectorNamesUnchanged(selector)).toBe(true));

it("authenticates attr() names without changing strings or canonical unknown reads", () => {
  for (const identityOnly of [false, true]) {
    const context = { prefix: "im_", ids: new Set<string>(), originals: new Map<string, string>(), identityOnly };
    expect(rewriteImageInlineStyle("fill:attr(DATA-COLOR type(<color>),red)", context)).toBeNull();
    expect(
      rewriteImageInlineStyle("fill:attr(data-color type(<color>),red);--literal:'attr(DATA-COLOR)'", context),
    ).toBe("fill:attr(data-color type(<color>),red);--literal:'attr(DATA-COLOR)'");
  }
});
