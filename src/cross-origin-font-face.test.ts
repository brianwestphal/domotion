import { describe, expect, it } from "vitest";
import { parseFontFaceRulesFromCssText } from "./capture.js";

// DM-545: cross-origin stylesheets throw on `cssRules` access from the page
// context, so we fetch them server-side and parse `@font-face` rules with
// this helper. Sites affected (verified): Stripe (b.stripecdn.com), and
// likely most marketing sites whose CSS is served from a different host
// than the page.

describe("parseFontFaceRulesFromCssText", () => {
  const BASE = "https://cdn.example.com/css/site.css";

  it("returns empty list for CSS with no @font-face rules", () => {
    expect(parseFontFaceRulesFromCssText("body { color: red; }", BASE)).toEqual([]);
  });

  it("parses a single top-level @font-face rule with a single src url()", () => {
    const css = `@font-face { font-family: "MyFont"; src: url("/fonts/myfont.woff2"); }`;
    const out = parseFontFaceRulesFromCssText(css, BASE);
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe("MyFont");
    expect(out[0].weight).toBe("400"); // default
    expect(out[0].style).toBe("normal"); // default
    expect(out[0].url).toBe("https://cdn.example.com/fonts/myfont.woff2");
    expect(out[0].urls).toEqual(["https://cdn.example.com/fonts/myfont.woff2"]);
  });

  it("parses font-weight, font-style, and unicode-range descriptors", () => {
    const css = `
      @font-face {
        font-family: "Geist";
        font-weight: 400;
        font-style: italic;
        src: url("/g.woff2") format("woff2");
        unicode-range: U+0000-00FF, U+0131;
      }`;
    const out = parseFontFaceRulesFromCssText(css, BASE);
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe("Geist");
    expect(out[0].weight).toBe("400");
    expect(out[0].style).toBe("italic");
    expect(out[0].unicodeRange).toEqual([[0x0000, 0x00ff], [0x0131, 0x0131]]);
  });

  it("ranks src urls woff2 > woff > ttf/otf, skipping eot/svg", () => {
    const css = `@font-face {
      font-family: "sdicon";
      src: url("/sdicon.eot"),
           url("/sdicon.eot?#iefix") format("embedded-opentype"),
           url("/sdicon.woff") format("woff"),
           url("/sdicon.ttf") format("truetype"),
           url("/sdicon.svg#sdicon") format("svg");
    }`;
    const out = parseFontFaceRulesFromCssText(css, BASE);
    expect(out).toHaveLength(1);
    // woff first (woff2 not present), then ttf. eot/svg dropped.
    expect(out[0].urls).toEqual([
      "https://cdn.example.com/sdicon.woff",
      "https://cdn.example.com/sdicon.ttf",
    ]);
  });

  it("recurses into @media-nested @font-face (Stripe pattern)", () => {
    const css = `
      @media (min-width: 600px) {
        @font-face {
          font-family: sohne-var;
          src: url(/sohne.woff2) format("woff2-variations");
          font-weight: 1 1000;
        }
      }`;
    const out = parseFontFaceRulesFromCssText(css, BASE);
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe("sohne-var");
    expect(out[0].weight).toBe("1 1000");
    expect(out[0].url).toBe("https://cdn.example.com/sohne.woff2");
  });

  it("strips CSS comments before parsing (no false positives in /* @font-face */ comment)", () => {
    const css = `
      /* @font-face { font-family: "ShouldNotMatch"; src: url("nope.woff2"); } */
      @font-face { font-family: "Real"; src: url("real.woff2"); }
    `;
    const out = parseFontFaceRulesFromCssText(css, BASE);
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe("Real");
  });

  it("handles unquoted family names and resolves relative urls against the base", () => {
    const css = `@font-face { font-family: MyFont; src: url(./fonts/x.woff2); }`;
    const out = parseFontFaceRulesFromCssText(css, "https://cdn.example.com/css/site.css");
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe("MyFont");
    expect(out[0].url).toBe("https://cdn.example.com/css/fonts/x.woff2");
  });

  it("returns multiple rules when the CSS declares many @font-face entries", () => {
    const css = `
      @font-face { font-family: A; src: url(a.woff2); }
      @font-face { font-family: B; src: url(b.woff2); font-weight: 700; }
      @font-face { font-family: C; src: url(c.woff2); font-style: italic; }
    `;
    const out = parseFontFaceRulesFromCssText(css, BASE);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.family)).toEqual(["A", "B", "C"]);
    expect(out[1].weight).toBe("700");
    expect(out[2].style).toBe("italic");
  });

  it("skips a rule with no parseable src (all eot/svg)", () => {
    const css = `@font-face { font-family: X; src: url(x.eot), url(x.svg#x) format("svg"); }`;
    expect(parseFontFaceRulesFromCssText(css, BASE)).toEqual([]);
  });

  it("skips a rule missing font-family", () => {
    const css = `@font-face { src: url(x.woff2); }`;
    expect(parseFontFaceRulesFromCssText(css, BASE)).toEqual([]);
  });
});
