import { describe, expect, it } from "vitest";
import { imageFragmentInventory } from "./svg-image-fragment-ids.js";
import { resolveSvgImageCssImports } from "./svg-image-css-import.js";

const source = (css: string, body = '<defs><linearGradient id="p"/></defs><rect/>'): string =>
  `<svg><style>@import "data:text/css;base64,${Buffer.from(css).toString("base64")}";</style>${body}</svg>`;

describe("image fragment namespace authentication", () => {
  it("uses actual canonical XML attributes, ignoring comments and CDATA data", () => {
    const inventory = imageFragmentInventory(
      '<svg><!-- id="fake" --><style><![CDATA[/* id="also-fake" */]]></style><g id="p"/><g id=\'p:1\'/></svg>',
    );
    expect(inventory!.ids).toEqual(new Set(["p", "p:1"]));
  });
  it.each([
    '<g id = "p"/>',
    '<g id="&#112;"/>',
    '<g id="&#x70;"/>',
    '<g id="p p"/>',
    '<g id="é"/>',
    '<g id="p"/><g id="p"/>',
    '<g id="p" id="q"/>',
    '<g id="&unknown;"/>',
    '<!-- id="p" --><g id = "p"/>',
    '<g id="p"/><g id="&#113;"/>',
  ])("leaves unproven or ambiguous ID spellings raster: %s", (body) => {
    expect(imageFragmentInventory(`<svg>${body}</svg>`)).toBeNull();
    expect(resolveSvgImageCssImports(source("rect{fill:url(#p)}", body))).toBeNull();
  });
  it.each(["fill", "stroke", "filter", "clip-path", "marker-start", "marker-mid", "marker-end", "mask", "mask-image"])(
    "admits owned local resources only for the proved %s consumer",
    (property) => {
      expect(resolveSvgImageCssImports(source(`rect{${property}:URL( '#p' )}`))).toContain("#p");
    },
  );
  it.each(["src", "background-image", "cursor", "content", "--paint"])(
    "keeps the unproved %s URL consumer raster",
    (property) => {
      expect(resolveSvgImageCssImports(source(`rect{${property}:url(#p)}`))).toBeNull();
    },
  );
  it.each(["#missing", "#%70", "#", "relative.svg#p", "https://host.test/image.svg#p", "\\23 p"])(
    "does not authenticate %s from an owned p ID",
    (url) => {
      expect(resolveSvgImageCssImports(source(`rect{fill:url(${url}) lime}`))).toBeNull();
    },
  );
  it("keeps neighboring unresolved references and namespace-sensitive data raster", () => {
    for (const body of [
      '<g id="p"/><rect fill="url(#missing)"/>',
      '<g id="p"/><use href="#missing"/>',
      '<g id="p"/><use href = "#p"/>',
      '<g id="p"/><rect style="fill:url(&quot;#p&quot;)"/>',
      '<g id="p"/><text>url(#p)</text>',
      '<g id="p"/><rect data-label=\'id="p"\'/>',
    ])
      expect(resolveSvgImageCssImports(source("rect{fill:url(#p)}", body))).toBeNull();
    expect(resolveSvgImageCssImports(source('rect{fill:url(#p);--label:"url(#p)"}'))).toBeNull();
  });
  it.each([
    '<rect class = "paint"/>',
    '<rect class="p&#97;int"/>',
    '<rect class="paint\u00a0other"/>',
    '<rect CLASS="paint"/>',
  ])("retains raster for unrewritable class attributes: %s", (shape) => {
    expect(resolveSvgImageCssImports(source(".paint{fill:url(#p)}", `<g id="p"/>${shape}`))).toBeNull();
  });
  it.each([".\\70 aint", 'rect[id="shape.dot"]', '[class~="paint"]'])(
    "retains raster for unrewritable selector data: %s",
    (selector) => {
      expect(resolveSvgImageCssImports(source(`${selector}{fill:url(#p)}`))).toBeNull();
      expect(
        resolveSvgImageCssImports(source("rect{fill:url(#p)}", `<g id="p"/><style>${selector}{fill:red}</style>`)),
      ).toBeNull();
    },
  );
  it("preserves plain string data and canonical neighboring href references", () => {
    const body = '<defs><linearGradient id="g"/><linearGradient id="p" href="#g"/></defs><text>ordinary label</text>';
    const result = resolveSvgImageCssImports(source('rect{fill:url(#p);--label:"ordinary #p"}', body));
    expect(result).toContain('href="#g"');
    expect(result).toContain('--label:"ordinary #p"');
    expect(resolveSvgImageCssImports(source("rect{fill:url(#p)}", '<g id="p" data-label="&lt;plain&gt;"/>'))).toContain(
      'data-label="&lt;plain&gt;"',
    );
  });
  it.each([
    '<!DOCTYPE svg><svg><g id="p"/></svg>',
    '<?xml-stylesheet href="data:text/css,rect{fill:red}"?><svg><g id="p"/></svg>',
    '<svg><g id="p" data-label="&unknown;"/></svg>',
    '<svg><g id="p" data-label="<broken"/></svg>',
  ])("does not infer DOM identity from unproved XML parser state: %s", (svg) => {
    expect(imageFragmentInventory(svg)).toBeNull();
  });
});
