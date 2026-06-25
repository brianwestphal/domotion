import { describe, expect, it } from "vitest";
import { containSize, isSharpFormat, isTransparentBg, resolveImageFormat } from "./svg-to-image-core.js";

describe("isSharpFormat", () => {
  it("is true only for the sharp-transcoded formats", () => {
    expect(isSharpFormat("webp")).toBe(true);
    expect(isSharpFormat("avif")).toBe(true);
    expect(isSharpFormat("tiff")).toBe(true);
    expect(isSharpFormat("png")).toBe(false);
    expect(isSharpFormat("jpeg")).toBe(false);
    expect(isSharpFormat("pdf")).toBe(false);
  });
});

describe("resolveImageFormat", () => {
  it("infers the format from the output extension (case-insensitive)", () => {
    expect(resolveImageFormat("out.png")).toBe("png");
    expect(resolveImageFormat("out.PNG")).toBe("png");
    expect(resolveImageFormat("out.jpg")).toBe("jpeg");
    expect(resolveImageFormat("out.jpeg")).toBe("jpeg");
    expect(resolveImageFormat("out.pdf")).toBe("pdf");
    expect(resolveImageFormat("/a/b/c/frame.JPG")).toBe("jpeg");
  });

  it("infers the sharp-transcoded formats from the extension", () => {
    expect(resolveImageFormat("out.webp")).toBe("webp");
    expect(resolveImageFormat("out.avif")).toBe("avif");
    expect(resolveImageFormat("out.tiff")).toBe("tiff");
    expect(resolveImageFormat("out.tif")).toBe("tiff");
    expect(resolveImageFormat("out.WEBP")).toBe("webp");
  });

  it("honors an explicit override (and maps jpg → jpeg, tif → tiff) regardless of extension", () => {
    expect(resolveImageFormat("out.png", "jpeg")).toBe("jpeg");
    expect(resolveImageFormat("out.bin", "jpg")).toBe("jpeg");
    expect(resolveImageFormat("out.bin", "PNG")).toBe("png");
    expect(resolveImageFormat("out.bin", "pdf")).toBe("pdf");
    expect(resolveImageFormat("out.png", "webp")).toBe("webp");
    expect(resolveImageFormat("out.png", "avif")).toBe("avif");
    expect(resolveImageFormat("out.bin", "tif")).toBe("tiff");
  });

  it("throws on an unknown extension, naming the supported set", () => {
    expect(() => resolveImageFormat("out.gif")).toThrow(/\.png/);
    expect(() => resolveImageFormat("out.bmp")).toThrow(/extension "\.bmp"/);
    expect(() => resolveImageFormat("out")).toThrow(/\(none\)/);
  });

  it("throws on an invalid override", () => {
    expect(() => resolveImageFormat("out.png", "gif")).toThrow(/--format expects/);
  });
});

describe("isTransparentBg", () => {
  it("is true for transparent keywords and zero-alpha colors", () => {
    for (const v of ["transparent", "none", "#0000", "#00000000", "rgba(0,0,0,0)", "hsla(0, 0%, 0%, 0)", "  TRANSPARENT  "]) {
      expect(isTransparentBg(v)).toBe(true);
    }
  });

  it("is false for opaque backgrounds", () => {
    for (const v of ["#fff", "white", "#000000", "rgba(0,0,0,1)", "rgba(0,0,0,0.5)", "rgb(255,0,0)"]) {
      expect(isTransparentBg(v)).toBe(false);
    }
  });
});

describe("containSize", () => {
  it("returns the natural size (exact, not forced even) when no bounds are given", () => {
    expect(containSize(800, 500)).toEqual({ width: 800, height: 500 });
    expect(containSize(801, 501)).toEqual({ width: 801, height: 501 });
  });

  it("contains within a single bound, preserving aspect ratio", () => {
    expect(containSize(800, 500, 400, undefined)).toEqual({ width: 400, height: 250 });
    expect(containSize(800, 500, undefined, 250)).toEqual({ width: 400, height: 250 });
  });

  it("picks the smaller scale when both bounds are given", () => {
    expect(containSize(800, 500, 1000, 200)).toEqual({ width: 320, height: 200 });
    expect(containSize(800, 500, 400, 1000)).toEqual({ width: 400, height: 250 });
  });

  it("never collapses a dimension below 1px", () => {
    expect(containSize(1000, 1, 10, undefined)).toEqual({ width: 10, height: 1 });
  });
});
