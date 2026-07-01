import { describe, expect, it } from "vitest";

import { rootSvgA11y } from "./format.js";
import { wrapSvg } from "./element-tree-to-svg.js";

// DM-1488: opt-in accessible name/description on the root <svg>.

describe("rootSvgA11y (DM-1488)", () => {
  it("emits nothing when no accessible name is given (output stays unchanged)", () => {
    expect(rootSvgA11y()).toEqual({ roleAttr: "", markup: "" });
    expect(rootSvgA11y("")).toEqual({ roleAttr: "", markup: "" });
    // a description without a name is dropped — role="img" with no name is an
    // a11y anti-pattern, so we never emit role/desc without a title.
    expect(rootSvgA11y(undefined, "desc only")).toEqual({ roleAttr: "", markup: "" });
  });

  it("emits role=img + <title> for a name, and <desc> when described", () => {
    expect(rootSvgA11y("My demo")).toEqual({ roleAttr: ` role="img"`, markup: "<title>My demo</title>" });
    expect(rootSvgA11y("Name", "Longer description")).toEqual({
      roleAttr: ` role="img"`,
      markup: "<title>Name</title><desc>Longer description</desc>",
    });
  });

  it("escapes XML-special characters in title/desc", () => {
    const { markup } = rootSvgA11y('A & B <c> "d"', "x < y & z");
    expect(markup).toContain("<title>A &amp; B &lt;c&gt; &quot;d&quot;</title>");
    expect(markup).toContain("<desc>x &lt; y &amp; z</desc>");
  });
});

describe("wrapSvg accessible name (DM-1488)", () => {
  const inner = `<rect width="10" height="10"/>`;

  it("adds role=img + <title>/<desc> as the first children when a title is given", () => {
    const svg = wrapSvg(inner, 100, 50, { title: "Dashboard demo", desc: "A chart animating in" });
    expect(svg).toMatch(/<svg [^>]*\brole="img"/);
    expect(svg).toContain("<title>Dashboard demo</title><desc>A chart animating in</desc>");
    // title must precede the painted content so AT uses it as the accessible name
    expect(svg.indexOf("<title>")).toBeLessThan(svg.indexOf("<rect"));
  });

  it("leaves the SVG unchanged (no role/title) when no accessible name is given", () => {
    const svg = wrapSvg(inner, 100, 50);
    expect(svg).not.toContain('role="img"');
    expect(svg).not.toContain("<title>");
  });
});
