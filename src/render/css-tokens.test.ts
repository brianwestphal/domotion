import { describe, it, expect } from "vitest";
import { parseCssUrl, splitTopLevelCommas } from "./css-tokens.js";

describe("parseCssUrl", () => {
  it("extracts double-, single-, and unquoted url() contents", () => {
    expect(parseCssUrl('url("a.png")')).toBe("a.png");
    expect(parseCssUrl("url('b.png')")).toBe("b.png");
    expect(parseCssUrl("url(c.png)")).toBe("c.png");
  });

  it("tolerates surrounding whitespace and inner spacing", () => {
    expect(parseCssUrl('  url(  "x.svg"  )  ')).toBe("x.svg");
  });

  it("handles data: URLs that embed quotes/commas (the old [^\"')]+ regex tripped on these)", () => {
    const data = "data:image/svg+xml,<svg viewBox='0 0 1 1'></svg>";
    expect(parseCssUrl(`url("${data}")`)).toBe(data);
  });

  it("unescapes CSS escape sequences", () => {
    expect(parseCssUrl('url("a\\"b")')).toBe('a"b');
    expect(parseCssUrl('url("a\\\\b")')).toBe("a\\b");
  });

  it("returns null for non-url() tokens", () => {
    expect(parseCssUrl("linear-gradient(red, blue)")).toBeNull();
    expect(parseCssUrl("none")).toBeNull();
  });
});

describe("splitTopLevelCommas", () => {
  it("splits a flat comma list", () => {
    expect(splitTopLevelCommas("red,blue,green")).toEqual(["red", "blue", "green"]);
  });

  it("does not split commas nested inside parentheses", () => {
    expect(splitTopLevelCommas("linear-gradient(red, blue), url(x.png)")).toEqual([
      "linear-gradient(red, blue)",
      " url(x.png)",
    ]);
  });

  it("handles nested parentheses to arbitrary depth", () => {
    expect(splitTopLevelCommas("a(b(c, d), e), f")).toEqual(["a(b(c, d), e)", " f"]);
  });

  it("returns the whole string as one element when there is no top-level comma", () => {
    expect(splitTopLevelCommas("solid")).toEqual(["solid"]);
    expect(splitTopLevelCommas("")).toEqual([""]);
  });
});
