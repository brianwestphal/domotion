import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileUrlToLocalPath, resolveSvgSource } from "../capture/embed.js";

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

  it("reads a URL-encoded local file URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion svg source "));
    try {
      const path = join(dir, "orange asset.svg");
      const svg = `<svg viewBox="0 0 8 4"><rect width="8" height="4"/></svg>`;
      writeFileSync(path, svg);
      expect(resolveSvgSource(pathToFileURL(path).href)).toBe(svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts Windows drive and UNC file URLs with Windows semantics (DM-2292)", () => {
    expect(fileUrlToLocalPath("file:///C:/fixtures/orange%20asset.svg", "win32"))
      .toBe("C:\\fixtures\\orange asset.svg");
    expect(fileUrlToLocalPath("file://server/share/orange.svg", "win32"))
      .toBe("\\\\server\\share\\orange.svg");
  });
});
