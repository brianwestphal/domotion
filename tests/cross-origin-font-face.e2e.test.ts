import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { parseCrossOriginFontFaceRules } from "../src/capture/cross-origin-font-face.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-687YPX: cross-origin `@font-face` text is parsed by Chromium, so each
// descriptor takes Blink's value — the LAST valid declaration
// (CSSParserImpl::ConsumeFontFaceRule → FilterProperties, css_parser_impl.cc
// :263-307 and :1519-1555 at Chromium 7d859f27; invalid values are dropped by
// AtRuleDescriptorParser::ParseFontFaceDescriptor, at_rule_descriptor_parser.cc
// :346-430). The previous regex scanner took the FIRST declaration.

const BASE = "https://cdn.example.com/css/site.css";
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchChromium({ headless: true });
  page = await browser.newPage();
  await page.setContent("<!doctype html><p>host</p>");
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

const parse = (css: string, base = BASE) => parseCrossOriginFontFaceRules(page, css, base);

describe("cross-origin @font-face parsing through Chromium", () => {
  it("takes the last valid declaration of each descriptor", async () => {
    const out = await parse(`@font-face {
      font-family: "Old"; font-family: "New";
      font-weight: 300; font-weight: 700; font-weight: bogus;
      font-style: italic; font-style: normal;
      font-stretch: 75%; font-stretch: wide-ish;
      unicode-range: U+0-FF; unicode-range: U+41zz;
      src: url("old.woff") format("woff");
      src: url("new.woff2") format("woff2");
    }`);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(
      expect.objectContaining({
        family: "New",
        weight: "700",
        style: "normal",
        styleDesc: "normal",
        stretch: "75%",
        unicodeRange: [[0, 0xff]],
        urls: ["https://cdn.example.com/css/new.woff2"],
      }),
    );
  });

  it("keeps an earlier valid src when a later one is entirely invalid, and drops invalid components", async () => {
    const out = await parse(`@font-face {
      font-family: A;
      src: url("a.woff2") format("woff2");
      src: url("a.eot") format("embedded-opentype");
    }
    @font-face {
      font-family: B;
      src: url("b.eot") format("embedded-opentype"), url("b;}.woff") format("woff"), url("b.svg#b") format("svg");
    }`);
    expect(out.map((r) => [r.family, r.urls])).toEqual([
      ["A", ["https://cdn.example.com/css/a.woff2"]],
      ["B", ["https://cdn.example.com/css/b;%7D.woff"]],
    ]);
  });

  it("drops !important declarations and generic family names, as Blink does", async () => {
    const out = await parse(`
      @font-face { font-family: E; src: url(e.woff2) !important; }
      @font-face { font-family: serif; src: url(f.woff2); }
      @font-face { font-family: G; font-weight: 700 !important; src: url(g.woff2); }`);
    expect(out.map((r) => [r.family, r.weight])).toEqual([["G", ""]]);
  });

  it("finds rules nested in grouping rules and ignores commented-out ones", async () => {
    const out = await parse(`
      /* @font-face { font-family: "ShouldNotMatch"; src: url("nope.woff2"); } */
      @media (min-width: 600px) {
        @font-face { font-family: sohne-var; src: url(/sohne.woff2) format("woff2-variations"); font-weight: 1 1000; }
      }
      @supports (display: grid) { @layer brand { @font-face { font-family: Nested; src: url(n.woff2); } } }
      @font-face { font-family: MyFont; src: url(./fonts/x.woff2); }`);
    expect(out.map((r) => [r.family, r.weight, r.url])).toEqual([
      ["sohne-var", "1 1000", "https://cdn.example.com/sohne.woff2"],
      ["Nested", "", "https://cdn.example.com/css/n.woff2"],
      ["MyFont", "", "https://cdn.example.com/css/fonts/x.woff2"],
    ]);
  });

  it("evaluates @media and @supports conditions as Blink's RuleSet::AddChildRules does", async () => {
    const out = await parse(`
      @media print { @font-face { font-family: PrintOnly; src: url(p.woff2); } }
      @media screen and (min-width: 1px) { @font-face { font-family: Screen; src: url(s.woff2); } }
      @supports (not-a-property: 1) { @font-face { font-family: Unsupported; src: url(u.woff2); } }
      @supports (display: grid) { @media print { @font-face { font-family: NestedPrint; src: url(np.woff2); } } }
      @container (min-width: 1px) { @font-face { font-family: InContainer; src: url(c.woff2); } }`);
    expect(out.map((r) => r.family)).toEqual(["Screen", "InContainer"]);
  });

  it("returns nothing for CSS without usable @font-face rules", async () => {
    expect(await parse("body { color: red; }")).toEqual([]);
    expect(await parse(`@font-face { src: url(x.woff2); }`)).toEqual([]);
    expect(await parse(`@font-face { font-family: X; src: url(x.eot), url(x.svg#x) format("svg"); }`)).toEqual([]);
    expect(await parse(`@font-face { font-family: "Unclosed"; src: url(u.woff2)`)).toEqual([
      expect.objectContaining({ family: "Unclosed", url: "https://cdn.example.com/css/u.woff2" }),
    ]);
  });
});
