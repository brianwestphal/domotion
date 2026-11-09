import { describe, expect, it } from "vitest";
import { resolveSvgImageCssImports } from "./svg-image-css-import.js";

describe("resolveSvgImageCssImports", () => {
  it("leaves a data-imported external resource for image raster fallback", () => {
    const css = `rect { fill: url(https://example.test/paint.svg) }`;
    const svg = `<svg><style>@import url("data:text/css,${encodeURIComponent(css)}");</style><rect/></svg>`;
    expect(resolveSvgImageCssImports(svg)).toBeNull();
  });

  it("drops a late import that Blink ignores in the SVG image", () => {
    const svg = `<svg><style>rect { fill: green } @import url("data:text/css,rect%7Bfill%3Ared%7D");</style><rect/></svg>`;
    expect(resolveSvgImageCssImports(svg)).toBe(`<svg><style>rect { fill: green }</style><rect/></svg>`);
  });

  it("raster-falls back when an escaped import scheme cannot be classified from source text", () => {
    const svg = `<svg><style>@import url("data\\3a text/css,rect%7Bfill%3Ared%7D");</style><rect/></svg>`;
    expect(resolveSvgImageCssImports(svg)).toBeNull();
  });
});
