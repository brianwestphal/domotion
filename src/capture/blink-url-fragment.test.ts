import { describe, expect, it } from "vitest";
import {
  decodeUrlEscapeSequencesUtf8OrIsomorphic as decode,
  externalCssSvgFragmentId,
  externalCssSvgReferences,
  tokenizeCssUrls,
} from "./blink-url-fragment.js";

describe("DecodeUrlEscapeSequences(kUtf8OrIsomorphic) port", () => {
  it.each([
    ["plain", "plain"],
    ["a%20b", "a b"],
    ["%C3%A9", "é"],
    ["é", "é"],
    ["%41", "A"],
    ["%2541", "%41"],
    ["%zz", "%zz"],
    ["%4", "%4"],
    ["%", "%"],
    ["%%41", "%A"],
    ["%FF", "ÿ"],
    // Any invalid sequence reverts the whole output, valid prefix included.
    ["%C3%A9%FF", "Ã©ÿ"],
    // Overlong and surrogate encodings are invalid UTF-8.
    ["%C0%AF", "À¯"],
    ["%ED%A0%80", "í \u0080"],
    // A leading byte-order mark is a code point, not a signature.
    ["%EF%BB%BFx", "﻿x"],
    ["%F0%9F%98%80", "\u{1f600}"],
    ["", ""],
  ])("%s -> %j", (input, expected) => {
    expect(decode(input)).toBe(expected);
  });
  it("UTF-8 encodes non-ASCII input before re-decoding it", () => {
    // Literal é next to an invalid escape: bytes C3 A9 FF revert as a whole.
    expect(decode("é%FF")).toBe("Ã©ÿ");
  });
});

describe("externalCssSvgFragmentId", () => {
  it("decodes clip-path once and mask-image twice", () => {
    expect(externalCssSvgFragmentId("clip-path", "%2541")).toBe("%41");
    expect(externalCssSvgFragmentId("mask-image", "%2541")).toBe("A");
    expect(externalCssSvgFragmentId("clip-path", "%C3%A9%25FF")).toBe("é%FF");
    expect(externalCssSvgFragmentId("mask-image", "%C3%A9%25FF")).toBe("Ã©ÿ");
  });
});

describe("tokenizeCssUrls", () => {
  it("reads quoted URLs containing ) and ' with exact token offsets", () => {
    const value = `url("http://x/s.svg#a)b"), linear-gradient(red, blue), url('http://x/t.svg#c\\'d')`;
    const tokens = tokenizeCssUrls(value);
    expect(tokens.map((token) => token.url)).toEqual(["http://x/s.svg#a)b", "http://x/t.svg#c'd"]);
    for (const token of tokens) expect(value.slice(token.start, token.start + token.length)).toMatch(/^url\(.*\)$/);
    expect(value.slice(tokens[1].start, tokens[1].start + tokens[1].length)).toBe(`url('http://x/t.svg#c\\'d')`);
  });
  it("handles unquoted URLs, hex escapes and whitespace", () => {
    expect(tokenizeCssUrls("URL( a\\20 b.svg#x )").map((token) => token.url)).toEqual(["a b.svg#x"]);
    expect(tokenizeCssUrls('url( "\\0 x" )').map((token) => token.url)).toEqual(["�x"]);
  });
  it("ignores url( inside strings and identifiers, and stops at an unclosed token", () => {
    expect(tokenizeCssUrls(`"url(a)" myurl(b) url(c`)).toEqual([]);
  });
});

describe("externalCssSvgReferences", () => {
  const base = "http://host/dir/page.html";
  it("excludes local references and references without a fragment", () => {
    expect(
      externalCssSvgReferences(
        "clip-path",
        `url("#a") url("http://host/dir/page.html#b") url("http://host/s.svg") url("http://host/s.svg#")`,
        base,
        `${base}#top`,
      ),
    ).toEqual([]);
  });
  it("resolves relative URLs and returns the Blink element ID for each property", () => {
    const value = `url("s.svg?q=1#%2541")`;
    expect(externalCssSvgReferences("clip-path", value, base, base)).toEqual([
      { href: "http://host/dir/s.svg?q=1", fragment: "%2541", id: "%41", start: 0, length: value.length },
    ]);
    expect(externalCssSvgReferences("mask-image", value, base, base)[0].id).toBe("A");
  });
  it("uses the canonical fragment spelling for a literal non-ASCII fragment", () => {
    expect(externalCssSvgReferences("clip-path", `url("http://h/s.svg#é")`, base, base)[0]).toMatchObject({
      fragment: "%C3%A9",
      id: "é",
    });
  });
});
