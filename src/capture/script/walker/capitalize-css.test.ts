import { describe, expect, it } from "vitest";
import { capitalizeCss, transformTextWithSourceSpans } from "./text-segments.js";

// DM-1237: CSS `text-transform: capitalize`, Unicode-aware. Expected values were
// confirmed against Chrome's painted output (pixel-matched).
describe("capitalizeCss (DM-1237)", () => {
  it("capitalizes non-ASCII leading letters (the old ASCII \\b bug)", () => {
    expect(capitalizeCss("élan")).toBe("Élan");
    expect(capitalizeCss("über alles")).toBe("Über Alles");
    expect(capitalizeCss("привет мир")).toBe("Привет Мир");
  });

  it("treats an apostrophe as mid-word (does not start a new word)", () => {
    expect(capitalizeCss("don't")).toBe("Don't");
    expect(capitalizeCss("o’brien")).toBe("O’brien");
  });

  it("does not capitalize a letter that follows a digit (mid-word)", () => {
    expect(capitalizeCss("123abc def")).toBe("123abc Def");
  });

  it("capitalizes each space/punctuation-separated word", () => {
    expect(capitalizeCss("hello world")).toBe("Hello World");
    expect(capitalizeCss("a-b c.d")).toBe("A-B C.D");
  });

  it("matches plain uppercase for the common case and is idempotent", () => {
    expect(capitalizeCss("Already Capitalized")).toBe("Already Capitalized");
    expect(capitalizeCss("")).toBe("");
  });

  it("titlecases Latin digraph code points (ǆ→ǅ, not Ǆ)", () => {
    expect(capitalizeCss("ǆenan")).toBe("ǅenan");
  });
});

describe("transformTextWithSourceSpans (DM-2158)", () => {
  it("keeps length-changing uppercase output attached to its source span", () => {
    expect(transformTextWithSourceSpans("aßb", "uppercase", "de")).toEqual([
      { sourceStart: 0, sourceEnd: 1, sourceText: "a", rendered: "A" },
      { sourceStart: 1, sourceEnd: 2, sourceText: "ß", rendered: "SS" },
      { sourceStart: 2, sourceEnd: 3, sourceText: "b", rendered: "B" },
    ]);
  });

  it("uses the element language for locale-sensitive casing", () => {
    expect(transformTextWithSourceSpans("iı", "uppercase", "tr").map((p) => p.rendered).join(""))
      .toBe("İI");
    expect(transformTextWithSourceSpans("ΟΣ", "lowercase", "el").map((p) => p.rendered).join(""))
      .toBe("ος");
  });

  it("retains UTF-16 source offsets across supplementary codepoints", () => {
    expect(transformTextWithSourceSpans("😀a", "uppercase", "")).toEqual([
      { sourceStart: 0, sourceEnd: 2, sourceText: "😀", rendered: "😀" },
      { sourceStart: 2, sourceEnd: 3, sourceText: "a", rendered: "A" },
    ]);
  });
});
