// DM-1433: guard the shared `extractCssUrl` against the data:-URL truncation
// regression. The old per-site `/^url\((?:"|')?([^"')]+)/` stopped at the first
// embedded quote, so a `data:image/svg+xml,...` source with escaped HTML
// attribute quotes was silently truncated → the border-image / mask-border
// intrinsic-dimension probes read 0.

import { describe, it, expect } from "vitest";
import { extractCssUrl } from "./utils.js";

describe("extractCssUrl", () => {
  it("extracts a bare url()", () => {
    expect(extractCssUrl("url(foo.png)")).toBe("foo.png");
  });

  it("extracts double- and single-quoted url()", () => {
    expect(extractCssUrl('url("foo.png")')).toBe("foo.png");
    expect(extractCssUrl("url('foo.png')")).toBe("foo.png");
  });

  it("tolerates surrounding whitespace inside url()", () => {
    expect(extractCssUrl('url(  "foo.png"  )')).toBe("foo.png");
  });

  it("does NOT truncate a data: URL with escaped embedded quotes (the bug)", () => {
    // What Chrome's getComputedStyle returns for an inline-SVG data URL: the
    // inner attribute quotes are backslash-escaped.
    const input = 'url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"><rect/></svg>")';
    expect(extractCssUrl(input)).toBe(
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    );
  });

  it("finds the first url() anywhere in the value (image-set candidates)", () => {
    expect(extractCssUrl('-webkit-image-set(url("a.png") 1x, url("b.png") 2x)')).toBe("a.png");
  });

  it("returns null when there is no url()", () => {
    expect(extractCssUrl("none")).toBeNull();
    expect(extractCssUrl("")).toBeNull();
    expect(extractCssUrl(undefined)).toBeNull();
  });

  it("returns null for an empty url() target", () => {
    expect(extractCssUrl('url("")')).toBeNull();
  });
});
