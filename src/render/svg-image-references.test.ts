import { describe, expect, it } from "vitest";
import { namespaceImageReferences } from "./svg-image-references.js";
import { referenceLocalFragment } from "./svg-image-reference-syntax.js";
import { parseImageElementTree } from "./svg-image-selector-engine.js";
import { prefixSvgIds } from "./svg-inline.js";

const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
const rewrite = (body: string): string | null => namespaceImageReferences(svg(body), "im_");

describe("image-document reference identities", () => {
  it.each([
    ['id = "p"', "p"],
    ['id="&#112;"', "p"],
    ["id='&#x70;'", "p"],
    ['id="é"', "é"],
    ['id="a&#x9;b"', "a\tb"],
  ])("reads XML DOM identity: %s", (attribute, id) => {
    const out = rewrite(`<g ${attribute}/>`)!;
    expect(out).not.toBeNull();
    expect(parseImageElementTree(out)!.children[0].attributes.get("id")).toBe("im_" + id);
    expect(parseImageElementTree(out)!.children[0].attributes.get("data-domotion-source-0-0")).toBe(id);
  });
  it.each([
    ["#%70", "p"],
    ["#%C3%A9", "é"],
    ["#%E9", "é"],
    ["#%C3%A9%E9", "Ã©é"],
    ["#%2570", "%70"],
    ["#%xx", "%xx"],
    ["#a\tb\nc\rd", "abcd"],
    ["#%EF%BB%BFp", "\uFEFFp"],
  ])("uses Chromium UTF8-or-isomorphic normalization: %s", (input, expected) => {
    expect(referenceLocalFragment(input)).toBe(expected);
  });
  it("rewrites actual references, preserving unrelated text/data and selector comparisons", () => {
    const out = rewrite(
      '<style><![CDATA[#p\\.q, [id="p.q"], .a\\.b { fill: u\\72l("#p%2Eq"); --literal:"url(#p.q) .a.b #p.q";content:attr(id) }]]></style><linearGradient id="p.q"/><g class = "a.b" data-example="url(#p.q)"/>',
    )!;
    expect(out).not.toBeNull();
    expect(out).toContain('#im_p\\.q, [data-domotion-source-0-0="p.q"], .im_a\\.b');
    expect(out).toContain('url("#im_p.q")');
    expect(out).toContain('--literal:"url(#p.q) .a.b #p.q"');
    expect(out).toContain('data-example="url(#p.q)"');
    expect(out).toContain("content:attr(data-domotion-source-0-0)");
    expect(out).toContain('class="im_a.b"');
  });
  it("keeps original href/style/class values available to selectors and attr()", () => {
    const out = rewrite(
      '<style>[href="#p"],[style*="url(#p)"],[class~="a"]{fill:red}g{--original:attr(href)}</style><g id="p"/><use href="&#35;%70" class="a" style="fill:url(#p)"/>',
    )!;
    expect(out).not.toBeNull();
    const tree = parseImageElementTree(out)!;
    const use = tree.children[2];
    expect(use.attributes.get("href")).toBe("#im_p");
    expect([...use.attributes.values()]).toContain("#%70");
    expect([...use.attributes.values()]).toContain("fill:url(#p)");
    expect(out).toContain('data-domotion-source-0-3="#p"');
  });
  it("chooses a private name absent from decoded authored attributes and strings", () => {
    const out = rewrite('<g id="p" data-example="data-domotion-source-&#48;-"/>')!;
    expect(out).toContain('data-domotion-source-1-0="p"');
  });
  it("preserves keyframes, nested condition groups, strings, comments and data URLs", () => {
    const out = rewrite(
      '<style><![CDATA[@media all {#p{fill:url(#p)}} @keyframes x {0%{opacity:.5}100%{opacity:1}} g {--text:"#p"; /*url(#p)*/fill:url("data:image/svg+xml,%3Csvg/%3E")}]]></style><g id="p"/>',
    )!;
    expect(out).toContain("0%{opacity:.5}");
    expect(out).toContain("/*url(#p)*/");
    expect(out).toContain('url("data:image/svg+xml,%3Csvg/%3E")');
  });
  it("rewrites decoded ARIA and escaped SMIL syncbase identities", () => {
    const out = rewrite(
      '<g id="p.q"/><g aria-labelledby="p.q"/><animate id="a" attributeName="opacity" begin="p\\.q.end+1s;1.5s;indefinite"/>',
    )!;
    expect(out).toContain('aria-labelledby="im_p.q"');
    expect(out).toContain('begin="im_p\\.q.end+1s;1.5s;indefinite"');
  });
  it.each([
    '<g id="p"/><g id="&#112;"/>',
    '<g id="p" id="q"/>',
    '<g id="&unknown;"/>',
    '<g id="p&"/>',
    '<g id=""/>',
    '<g fill="url(#missing) red"/>',
    '<use href="#missing"/>',
    '<g aria-labelledby="missing"/>',
    "<style>g{fill:url(#missing) red}</style>",
    '<style>g{--x:url(#p);fill:var(--x)}</style><g id="p"/>',
    '<style>g{cursor:url(#p),auto}</style><g id="p"/>',
    '<style>@scope (#p){g{fill:red}}</style><g id="p"/>',
    '<style>[xlink|href="#p"]{fill:red}</style><g id="p"/>',
    '<g xml:base="http://example.test/"/>',
    '<animate attributeName="id" to="p"/>',
    '<g id="p"/><animate begin="missing.end"/>',
    '<image href="relative.png"/>',
    '<g id="p"/><g cursor="url(#p),auto"/>',
    '<!DOCTYPE svg><g id="p"/>',
  ])("retains source fallback for ambiguous ownership: %s", (body) => expect(rewrite(body)).toBeNull());
  it("does not alter shared DOM-inline behavior for intentional host references", () => {
    expect(prefixSvgIds('<use href="#host"/><g fill="url(#host)"/>', "im_")).toBe(
      '<use href="#host"/><g fill="url(#host)"/>',
    );
  });
  it("retains source timing if the namespace prefix would alter SMIL offset parsing", () => {
    expect(namespaceImageReferences(svg('<g id="p"/><animate begin="p.end"/>'), "image-")).toBeNull();
  });
});
