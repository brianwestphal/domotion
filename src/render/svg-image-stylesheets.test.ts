import { describe, expect, it } from "vitest";
import {
  imageStyleSheets,
  replaceImageStyleSheets,
  serializeImageStyleText,
  xmlStyleText,
} from "./svg-image-stylesheets.js";
import { parseImageElementTree } from "./svg-image-selector-engine.js";
import { resolveSvgImageCssImports } from "./svg-image-css-import.js";
import { scopeImageStyleSheets } from "./svg-image-style-scope.js";
import { namespaceImageStyleNames } from "./svg-image-style-names.js";
import { collectImageSupportsConditions } from "./svg-image-supports.js";

describe("XML stylesheet spans (DM-5D93J3)", () => {
  it("shares canonical tree boundaries through CDATA, comments, PI, doctype and quoted tag ends", () => {
    const css = '/* </style> */ [data-x="</style>"]{--value:"</style>"}';
    const source =
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY unused "<style>fake</style>">]><svg><!-- <style>fake</style> --><style data-x=">">' +
      serializeImageStyleText(css) +
      "</style><text><![CDATA[<style>fake</style>]]></text></svg>";
    const sheets = imageStyleSheets(source)!;
    expect(sheets).toHaveLength(1);
    expect(sheets[0].open).toBe('<style data-x=">">');
    expect(xmlStyleText(sheets[0].css)).toBe(css);
    const element = parseImageElementTree(source, true)!.children[0];
    expect(element.sourceRange).toMatchObject({ start: sheets[0].start, end: sheets[0].end });
    expect(replaceImageStyleSheets(source, () => "REPLACED")).toBe(
      source.slice(0, sheets[0].start) + "REPLACED" + source.slice(sheets[0].end),
    );
  });
  it("reads child fragments with an unmatched outer close without parsing CSS end-tag data", () => {
    const source = '<rect/><style><![CDATA[rect{--value:"</style>"}]]></style></svg>';
    expect(imageStyleSheets(source)?.map((sheet) => xmlStyleText(sheet.css))).toEqual(['rect{--value:"</style>"}']);
  });
  it("joins XML text/reference/CDATA chunks without changing CSS string values", () => {
    const raw = 'rect{--value:"&lt;/style&gt;<![CDATA[]]]]><![CDATA[>]]>"}<!-- ignored -->';
    const text = xmlStyleText(raw)!;
    expect(text).toBe('rect{--value:"</style>]]>"}');
    expect(xmlStyleText(serializeImageStyleText(text))).toBe(text);
  });
  it.each([
    "<style><![CDATA[broken</style>",
    '<style data-x="broken>',
    "<style>missing close",
    "<!-- missing",
    "<style><style>x</style></style>",
  ])("refuses incomplete or nested stylesheet boundaries %s", (source) => {
    expect(imageStyleSheets(source)).toBeNull();
    expect(resolveSvgImageCssImports(`<svg>${source}</svg>`)).toBeNull();
  });
  it("preserves the UTF-8 XML authority boundary for direct styles", () => {
    const body = '<svg><style><![CDATA[rect{--value:"</style>"}]]></style><rect/></svg>';
    expect(resolveSvgImageCssImports('<?xml version="1.0" encoding="UTF-8"?>' + body)).not.toBeNull();
    for (const encoding of ["windows-1252", "UTF-16", "unknown"]) {
      expect(resolveSvgImageCssImports(`<?xml version="1.0" encoding="${encoding}"?>` + body)).toBeNull();
    }
  });
  it("keeps namespace-qualified collection opt-in and ignores self-closing sheets", () => {
    const source = "<svg><x:style>a{fill:red}</x:style><style/><style>b{fill:blue}</style></svg>";
    expect(imageStyleSheets(source)?.map((sheet) => sheet.name)).toEqual(["style"]);
    expect(imageStyleSheets(source, true)?.map((sheet) => sheet.name)).toEqual(["x:style", "style"]);
  });
  it("keeps later scoped rules and global names after a literal end-tag spelling", () => {
    const source =
      '<svg><style><![CDATA[rect{--value:"</style>"} @keyframes pulse{from{opacity:1}to{opacity:1}} .paint{animation:pulse 1s;fill:red}]]></style><rect class="paint"/></svg>';
    const renamed = namespaceImageStyleNames(source, "owned-")!;
    expect(renamed).toContain("owned-pulse");
    expect(scopeImageStyleSheets(renamed, "owned-")).toContain(
      '.paint:where([data-domotion-image-root="owned-"], [data-domotion-image-root="owned-"] *)',
    );
    expect(xmlStyleText(imageStyleSheets(renamed)![0].css)).toMatch(/--value:"(?:<|\\3c )\/style>"/);
  });
  it("collects real supports after literal comment/string data and ignores fake conditions", () => {
    const source =
      '<svg><style><![CDATA[rect{--value:"</style> /* @supports (fake: yes) {}"} /* </style> */ @supports (display:block){rect{fill:red}}]]></style></svg>';
    expect(collectImageSupportsConditions(source)).toEqual([{ key: "(display:block)", condition: "(display:block)" }]);
  });
});
