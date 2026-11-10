import { describe, expect, it } from "vitest";
import { cssImportBlock, cssImportUrl, imageImportKeywords } from "./svg-image-css-import-tokens.js";
import { resolveSvgImageCssImports } from "./svg-image-css-import.js";
const cssImage = (css: string, body = "<rect/>") => `<svg><style><![CDATA[${css}]]></style>${body}</svg>`;
const importCss = (css: string, body?: string) =>
  cssImage(`@import "data:text/css;base64,${Buffer.from(css).toString("base64")}";`, body);
const red = "data:text/css,rect%7Bfill:red%7D";
describe("escaped image import token authority (DM-Y3H2EV)", () => {
  it.each([
    String.raw`@\69mport`,
    String.raw`@\69 mport`,
    String.raw`@\000069mport`,
    String.raw`@im\port`,
    "@\\69\r\nmport",
    String.raw`@\49 MPORT`,
  ])("canonicalizes the complete %s at-keyword before PostCSS", (keyword) => {
    const css = `${keyword} "${red}";`;
    expect(imageImportKeywords(css)).toMatchObject({ hasImport: true, changed: true, text: `@import "${red}";` });
    expect(resolveSvgImageCssImports(cssImage(css))).toContain("rect{fill:red}");
  });
  it("does not interpret quoted/comment/URL payload @ spellings as active imports", () => {
    for (const css of [
      String.raw`/* @\69 mport "https://host.test" */ rect{fill:red}`,
      String.raw`rect{--label:"@\69 mport";fill:red}`,
      String.raw`rect{fill:url("data:image/svg+xml,%3Csvg%3E@\69mport%3C/svg%3E")}`,
    ]) {
      expect(imageImportKeywords(css)).toMatchObject({ hasImport: false, changed: false, text: css });
    }
  });
  it("removes CDO/CDC only at stylesheet rule boundaries", () => {
    expect(imageImportKeywords(`<!-- @\\69 mport "${red}"; -->`)?.text).toBe(` @import "${red}"; `);
    const params = `@import "${red}" -->;`;
    expect(imageImportKeywords(params)?.text).toBe(params);
    expect(imageImportKeywords('rect{--literal:"<!-- -->"}')?.text).toBe('rect{--literal:"<!-- -->"}');
  });
  it.each([
    String.raw`"d\61 ta:text/css,rect%7Bfill:red%7D"`,
    String.raw`\75 rl(d\61 ta:text/css,rect%7Bfill:red%7D)`,
    String.raw`URL("data:text/css,rect%7Bfill:red%7D"/**/)`,
  ])("decodes the actual %s URL token once", (token) => {
    expect(cssImportUrl(token, 0)).toEqual({ value: red, end: token.length });
  });
  it("retains escaped quote and parenthesis data within a complete string URL", () => {
    const token = String.raw`url("data:text/css,rect{--label:\"(quote)\";fill:red}")`;
    expect(cssImportUrl(token, 0)).toEqual({
      value: 'data:text/css,rect{--label:"(quote)";fill:red}',
      end: token.length,
    });
    expect(cssImportBlock('(selector([x=")"]) /* ) */)', 0)?.content).toBe('selector([x=")"]) /* ) */');
  });
  it.each([
    String.raw`url(data:test("bad"))`,
    "url(data:test\\\n)",
    'url("unterminated)',
    "url(data:test rest)",
    'url(/**/"data:text/css,")',
  ])("refuses bad or unproved URL syntax %s", (token) => {
    expect(cssImportUrl(token, 0)).toBeNull();
  });
  it.each([
    String.raw`@\69 mport "\68 ttps://host.test/side.css";`,
    String.raw`@\69mport "blob:https://host.test/id";`,
    String.raw`@import \75 rl(relative.css);`,
  ])("removes the actual blocked image import %s", (css) => {
    expect(resolveSvgImageCssImports(cssImage(css))).toBe("<svg><style><![CDATA[]]></style><rect/></svg>");
  });
  it("keeps the URL fragment out of selected data CSS bytes", () => {
    const source = cssImage(
      String.raw`@import "d\61 ta:text/css,rect{fill:red}#sample{fill:blue}";`,
      '<rect id="sample"/>',
    );
    const result = resolveSvgImageCssImports(source);
    expect(result).toContain("fill:red");
    expect(result).not.toContain("fill:blue");
  });
  it("retains blocked import layer reservation after escaped keywords", () => {
    const result = resolveSvgImageCssImports(
      cssImage(String.raw`@\69mport "\68 ttps://host.test/side.css" l\61 yer(first) supports(display:block) screen;`),
    );
    expect(result).toContain("@layer first");
    expect(result).not.toContain("host.test");
  });
  it.each([
    String.raw`filter:\75 rl("\68 ttps://host.test/filter.svg#p")`,
    String.raw`filter:url(blob:https://host.test/id)`,
    String.raw`filter:\75 rl("relative.svg#p")`,
    String.raw`fill:im\61 ge-set("https://host.test/image.png" 1x)`,
  ])("refuses an external/dynamic escaped declaration %s", (declaration) => {
    expect(resolveSvgImageCssImports(importCss(`rect{${declaration}}`))).toBeNull();
  });
  it("authenticates exact local identity without percent aliases or host-owned IDs", () => {
    expect(
      resolveSvgImageCssImports(importCss(String.raw`rect{filter:\75 rl(\23 p)}`, '<filter id="p"/><rect/>')),
    ).toContain('url("#p")');
    expect(resolveSvgImageCssImports(importCss(String.raw`rect{filter:\75 rl(\23 p)}`))).toBeNull();
    expect(
      resolveSvgImageCssImports(importCss(String.raw`rect{filter:\75 rl(\23 %70)}`, '<filter id="p"/><rect/>')),
    ).toBeNull();
  });
  it.each([
    '<rect onload="foreign()"/>',
    "<script>foreign()</script><rect/>",
    "<foreignObject><div/></foreignObject><rect/>",
    '<g xml:base="https://host.test/"><rect/></g>',
    '<g xmlns="https://foreign.test/"><rect/></g>',
    '<rect style="filter:url(https://host.test/filter.svg#p)"/>',
    '<rect style="filter:url(\\23 missing)"/>',
    '<g id="p"/><g id="p"/><rect/>',
  ])("preserves neighboring source/active-context refusal %s", (body) => {
    expect(resolveSvgImageCssImports(cssImage(String.raw`@\69 mport "${red}";`, body))).toBeNull();
  });
  it("refuses source reference/style attribute case aliases without activating them", () => {
    for (const body of [
      '<image HREF="data:image/svg+xml,%3Csvg/%3E"/>',
      '<image hReF="data:image/svg+xml,%3Csvg/%3E"/>',
      '<rect STYLE="fill:blue"/>',
      '<rect FILTER="url(#host)"/>',
      "<SCRIPT>foreign()</SCRIPT>",
    ]) {
      expect(resolveSvgImageCssImports(cssImage(String.raw`@\69mport "${red}";`, body))).toBeNull();
    }
  });
  it("retains unproved source stylesheet activation boundaries", () => {
    for (const attributes of ['media="not all"', 'title="alternate"', 'disabled=""', 'type="text/plain"']) {
      const source = cssImage(String.raw`@\69mport "${red}";`).replace("<style>", `<style ${attributes}>`);
      expect(resolveSvgImageCssImports(source)).toBeNull();
    }
  });
  it("keeps unknown escaped at-rules and nested imports conservative when expansion would need them", () => {
    expect(resolveSvgImageCssImports(importCss(String.raw`@m\65 dia all{rect{fill:red}}`))).toBeNull();
    expect(resolveSvgImageCssImports(importCss(String.raw`@media all{@\69mport "${red}";}`))).toBeNull();
  });
});
