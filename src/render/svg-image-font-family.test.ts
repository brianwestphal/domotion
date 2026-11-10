import { describe, expect, it } from "vitest";
import { parseImageFontFamilyTail } from "./svg-image-font-family.js";
import { parseImageFontShorthand } from "./svg-image-font-shorthand.js";

describe("authored SVG font family tails", () => {
  it.each([
    "123",
    "Foo 123",
    "serif Foo",
    '"A" B',
    "Foo,",
    ",Foo",
    "Foo,,Bar",
    "Foo(Bar)",
    "initial",
    "default",
    '"A\nB"',
  ])("rejects the invalid tail %s", (tail) => {
    expect(parseImageFontFamilyTail(tail)).toBeNull();
    expect(parseImageFontShorthand(`16px ${tail}`)).toBeNull();
  });
  it("distinguishes literal names, escaped identifiers and generic keywords", () => {
    expect(parseImageFontFamilyTail('"123", \\31 23, SERIF, Foo serif, --')).toEqual([
      { css: '"123"', name: "123", generic: false },
      { css: "\\31 23", name: "123", generic: false },
      { css: "serif", name: "serif", generic: true },
      { css: "Foo serif", name: "Foo serif", generic: false },
      { css: "--", name: "--", generic: false },
    ]);
    expect(parseImageFontFamilyTail("Foo\\,Bar, Foo\\ Bar")?.map((family) => family.name)).toEqual([
      "Foo,Bar",
      "Foo Bar",
    ]);
  });
  it("keeps quoted comment data while treating real comments as token gaps", () => {
    expect(parseImageFontFamilyTail('Foo/**/Bar, "A/*B*/"')?.map((family) => family.name)).toEqual([
      "Foo Bar",
      "A/*B*/",
    ]);
    expect(parseImageFontShorthand("bold/**/16px/**/Foo/**/Bar")).toMatchObject({
      size: "16px",
      family: "Foo Bar",
      weight: "bold",
    });
    expect(parseImageFontFamilyTail('"A\\\nB"')?.[0].name).toBe("AB");
  });
  it("does not replace CSS comment gaps with valid size operator whitespace", () => {
    expect(parseImageFontShorthand("calc(12px/**/+/**/2px) Foo")?.size).toBe("calc(12px/**/+/**/2px)");
    expect(parseImageFontShorthand("16px\u00a0Foo")).toBeNull();
  });
  it.each([
    "normal normal normal normal normal 16px Foo",
    "16px/-1 Foo",
    "16px/1blah Foo",
    "16px/calc(1deg) Foo",
    "oblique 95deg 16px Foo",
  ])("keeps malformed adjacent grammar unresolved: %s", (value) => {
    expect(parseImageFontShorthand(value)).toBeNull();
  });
  it("bounds authored family work and keeps CSSOM-trim-sensitive names unresolved", () => {
    expect(parseImageFontFamilyTail('" Foo "')).toBeNull();
    expect(parseImageFontFamilyTail("A,".repeat(600) + "B")).toBeNull();
    expect(parseImageFontFamilyTail("A".repeat(65537))).toBeNull();
  });
  it("keeps authored internal UA spellings literal across CSSOM metric readers", () => {
    expect(parseImageFontFamilyTail("-WEBKIT-STANDARD")).toEqual([
      { css: '"-WEBKIT-STANDARD"', name: "-WEBKIT-STANDARD", generic: false },
    ]);
  });
});
