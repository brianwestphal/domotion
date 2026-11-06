import { describe, expect, it } from "vitest";
import {
  faceRuleFromFontFaceDescriptors,
  localFaceFromFontFaceDescriptors,
  type FontFaceDescriptorText,
} from "./capture/cross-origin-font-face.js";

// DM-545: cross-origin stylesheets throw on `cssRules` access from the page
// context, so we fetch them server-side. Chromium parses the fetched text in
// the page (tests/cross-origin-font-face.e2e.test.ts covers that half, where
// the last valid declaration of each descriptor wins). These cases cover the
// Node-side step from the CSSOM descriptor serialization to a FaceRule.

const BASE = "https://cdn.example.com/css/site.css";

function descriptors(d: Partial<FontFaceDescriptorText>): FontFaceDescriptorText {
  return { family: "", weight: "", style: "", stretch: "", unicodeRange: "", src: "", ...d };
}

describe("faceRuleFromFontFaceDescriptors", () => {
  it("keeps absent weight and style distinct from declared values", () => {
    const out = faceRuleFromFontFaceDescriptors(
      descriptors({ family: '"MyFont"', src: 'url("/fonts/myfont.woff2")' }),
      BASE,
    );
    // Absent descriptor stays "" (auto) — kept distinct from a declared "400",
    // because only a declared value pins a variable face's wght axis (Blink's
    // RangeSetFromAuto vs SetExplicitly split).
    expect(out).toEqual({
      kind: "font-face",
      family: "MyFont",
      weight: "",
      style: "normal",
      styleDesc: "",
      url: "https://cdn.example.com/fonts/myfont.woff2",
      urls: ["https://cdn.example.com/fonts/myfont.woff2"],
      unicodeRange: undefined,
    });
  });

  it("carries font-weight, font-style, font-stretch and unicode-range", () => {
    const out = faceRuleFromFontFaceDescriptors(
      descriptors({
        family: "Geist",
        weight: "400",
        style: "italic",
        stretch: "75%",
        unicodeRange: "U+0-FF, U+131",
        src: 'url("/g.woff2") format("woff2")',
      }),
      BASE,
    );
    expect(out).toEqual(
      expect.objectContaining({
        family: "Geist",
        weight: "400",
        style: "italic",
        styleDesc: "italic",
        stretch: "75%",
        unicodeRange: [
          [0x0000, 0x00ff],
          [0x0131, 0x0131],
        ],
      }),
    );
  });

  it("ranks src urls woff2 > woff > ttf/otf and skips eot/svg suffixes", () => {
    const out = faceRuleFromFontFaceDescriptors(
      descriptors({
        family: "sdicon",
        src: 'url("/sdicon.eot"), url("/sdicon.ttf") format("truetype"), url("/sdicon.woff") format("woff"), url("/sdicon.svg#sdicon") format("svg")',
      }),
      BASE,
    );
    expect(out?.urls).toEqual(["https://cdn.example.com/sdicon.woff", "https://cdn.example.com/sdicon.ttf"]);
  });

  it("resolves relative urls against the stylesheet and keeps reserved characters inside a string url", () => {
    const out = faceRuleFromFontFaceDescriptors(
      descriptors({ family: "MyFont", src: 'url("./fonts/x;}.woff2") format("woff2"), local("MyFont")' }),
      BASE,
    );
    expect(out?.urls).toEqual(["https://cdn.example.com/css/fonts/x;%7D.woff2"]);
  });

  it("returns null without a family, without a url() source, or with only unresolvable urls", () => {
    expect(faceRuleFromFontFaceDescriptors(descriptors({ src: 'url("x.woff2")' }), BASE)).toBeNull();
    expect(faceRuleFromFontFaceDescriptors(descriptors({ family: "X" }), BASE)).toBeNull();
    expect(faceRuleFromFontFaceDescriptors(descriptors({ family: "X", src: 'local("X")' }), BASE)).toBeNull();
    expect(faceRuleFromFontFaceDescriptors(descriptors({ family: "X", src: 'url("x.eot")' }), BASE)).toBeNull();
    expect(faceRuleFromFontFaceDescriptors(descriptors({ family: "X", src: 'url("//[")' }), BASE)).toBeNull();
  });

  it("reads an invalid unicode-range serialization as the initial value", () => {
    const out = faceRuleFromFontFaceDescriptors(
      descriptors({ family: "X", src: 'url("x.woff2")', unicodeRange: "U+41zz" }),
      BASE,
    );
    expect(out?.unicodeRange).toBeUndefined();
  });
});

describe("localFaceFromFontFaceDescriptors", () => {
  it("collects the local() names of a rule with no url() source", () => {
    expect(
      localFaceFromFontFaceDescriptors(
        descriptors({ family: '"Alias"', weight: "700", src: 'local("Menlo"), local(Monaco)' }),
      ),
    ).toEqual({
      kind: "local",
      family: "Alias",
      localNames: ["Menlo", "Monaco"],
      weight: "700",
      style: "normal",
      resolvedLocalName: null,
    });
  });

  it("returns null without a family or without local() entries", () => {
    expect(localFaceFromFontFaceDescriptors(descriptors({ src: 'local("Menlo")' }))).toBeNull();
    expect(localFaceFromFontFaceDescriptors(descriptors({ family: "A", src: "url(a.eot)" }))).toBeNull();
  });
});
