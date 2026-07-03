import { describe, expect, it } from "vitest";
import { resolveSvgSource } from "../capture/embed.js";

/**
 * DM-1588: `resolveSvgSource` returns the raw SVG text for an `<img>`'s source
 * only when the source is an SVG, so the renderer can inline it as a native
 * `<svg>` (crisp at any zoom) instead of a rasterized `<image>`.
 */
describe("resolveSvgSource — DM-1588", () => {
  it("decodes a base64 image/svg+xml data URI", () => {
    const svg = `<svg viewBox="0 0 10 10"><rect/></svg>`;
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    expect(resolveSvgSource(uri)).toBe(svg);
  });

  it("decodes a URL-encoded (non-base64) image/svg+xml data URI", () => {
    const svg = `<svg viewBox="0 0 10 10"><rect fill="#fff"/></svg>`;
    const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    expect(resolveSvgSource(uri)).toBe(svg);
  });

  it("returns null for a raster (PNG) data URI — stays on the <image> path", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    expect(resolveSvgSource(png)).toBeNull();
  });

  it("returns null for a remote URL we could not embed", () => {
    expect(resolveSvgSource("https://example.com/logo.svg")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(resolveSvgSource("")).toBeNull();
    expect(resolveSvgSource(null)).toBeNull();
    expect(resolveSvgSource(undefined)).toBeNull();
  });
});
