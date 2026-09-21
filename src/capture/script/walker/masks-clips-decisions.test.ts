import { describe, expect, it } from "vitest";
import {
  classifyFragmentReference,
  fragmentCycles,
  replaceCssUrls,
  scopedFragmentKey,
  splitCssLayers,
  svgLengthString,
  svgLengthValue,
  svgUnit,
} from "./masks-clips-decisions.js";

describe("mask and clip capture decisions", () => {
  it("keeps fragment identities isolated by originating tree scope", () => {
    expect(scopedFragmentKey("document:0", "m")).not.toBe(scopedFragmentKey("iframe:0", "m"));
    expect(scopedFragmentKey("document:0", "m")).toBe("document:0\u0000m");
  });

  it("preserves nested commas while splitting CSS image layers", () => {
    expect(splitCssLayers("url(#a), linear-gradient(red, blue), element(#source)")).toEqual([
      "url(#a)",
      " linear-gradient(red, blue)",
      " element(#source)",
    ]);
  });

  it("classifies local, same-document, safe data, and external fragment references", () => {
    const base = "https://example.test/page/index.html";
    expect(classifyFragmentReference("#clip%20one", base, base)).toEqual({ status: "local", target: "clip one" });
    expect(classifyFragmentReference("./index.html#mask", base, base)).toEqual({ status: "local", target: "mask" });
    expect(classifyFragmentReference("data:image/svg+xml,%3Csvg/%3E", base, base)).toEqual({ status: "safe" });
    expect(classifyFragmentReference("./other.svg#mask", base, base)).toEqual({
      status: "external",
      target: "./other.svg#mask",
    });
  });

  it("rewrites only URL references accepted by the caller", () => {
    expect(
      replaceCssUrls('url("#a") url(https://example.test/x.svg#b)', (raw: string) => (raw === "#a" ? "token" : null)),
    ).toBe("url(#token) url(https://example.test/x.svg#b)");
  });

  it("normalizes SVG units and length fallbacks", () => {
    expect(svgUnit({ baseVal: 2 }, "userSpaceOnUse")).toBe("objectBoundingBox");
    expect(svgUnit({ baseVal: 1 }, "userSpaceOnUse")).toBe("userSpaceOnUse");
    expect(svgLengthString({ baseVal: { valueAsString: "25%" } }, "0")).toBe("25%");
    expect(svgLengthString(null, "120%")).toBe("120%");
    expect(svgLengthValue({ baseVal: { value: 12.5 } })).toBe(12.5);
    expect(svgLengthValue({ baseVal: { value: Number.NaN } })).toBe(0);
  });

  it("reports resolved dependency cycles without treating missing edges as cycles", () => {
    expect(
      fragmentCycles(0, 3, [
        { from: 0, to: 1, status: "resolved" },
        { from: 1, to: 2, status: "resolved" },
        { from: 2, to: 0, status: "resolved" },
        { from: 2, to: 1, status: "missing" },
      ]),
    ).toEqual([[0, 1, 2, 0]]);
  });
});
