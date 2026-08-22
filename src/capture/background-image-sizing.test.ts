import { describe, expect, it } from "vitest";

import {
  isBlinkSupportedImageMimeType,
  parseImageSetCandidates,
  selectBackgroundCandidate,
  splitBackgroundLayers,
} from "./background-image-sizing.js";

describe("Blink URL background candidate selection", () => {
  it("keeps nested image-set/data URL commas in their authored layer", () => {
    expect(splitBackgroundLayers(
      'image-set(url("data:image/svg+xml,<svg viewBox=\\"0 0 3 7\\"></svg>") 1x, url("two.png") 2x), linear-gradient(red, blue), url("tail.png")',
    )).toEqual([
      'image-set(url("data:image/svg+xml,<svg viewBox=\\"0 0 3 7\\"></svg>") 1x, url("two.png") 2x)',
      "linear-gradient(red, blue)",
      'url("tail.png")',
    ]);
  });

  it("parses computed resolution units and type descriptors in either order", () => {
    const candidates = parseImageSetCandidates(
      'image-set(url("one.png") type("image/png") 96dpi, url("two.png") 78.740157dpcm type("image/webp"), url("three.png") 3x)',
    );
    expect(candidates?.map(({ url, type, index }) => ({ url, type, index }))).toEqual([
      { url: "one.png", type: "image/png", index: 0 },
      { url: "two.png", type: "image/webp", index: 1 },
      { url: "three.png", type: null, index: 2 },
    ]);
    expect(candidates![0].resolution).toBe(1);
    expect(candidates![1].resolution).toBeCloseTo(2.08333332, 8);
    expect(candidates![2].resolution).toBe(3);
  });

  it("filters unsupported MIME types, stable-dedupes densities, and chooses first >= DPR", () => {
    const layer = 'image-set(url("unsupported.png") 1x type("image/lolcat"), url("one.png") 1x type("image/png"), url("duplicate.png") 1x, url("two.png") 2x, url("three.png") 3x)';
    expect(selectBackgroundCandidate(layer, 1)).toMatchObject({
      selectedUrl: "one.png", selectedCandidateIndex: 1, selectedResolution: 1, selectedType: "image/png",
    });
    expect(selectBackgroundCandidate(layer, 1.5)).toMatchObject({
      selectedUrl: "two.png", selectedCandidateIndex: 3, selectedResolution: 2,
    });
    expect(selectBackgroundCandidate(layer, 4)).toMatchObject({
      selectedUrl: "three.png", selectedCandidateIndex: 4, selectedResolution: 3,
    });
  });

  it("preserves direct URLs and makes unsupported image-set state explicit", () => {
    expect(selectBackgroundCandidate('url("plain.png")', 2)).toEqual({
      source: "url",
      selectedUrl: "plain.png",
      selectedCandidateIndex: null,
      selectedResolution: 1,
      selectedType: null,
    });
    expect(selectBackgroundCandidate(
      'image-set(url("bad.png") 1x type("image/lolcat"))',
      1,
    )).toMatchObject({
      source: "image-set",
      selectedUrl: null,
      warning: expect.stringContaining("no Blink-supported"),
    });
    expect(isBlinkSupportedImageMimeType("Image/PNG")).toBe(true);
    expect(isBlinkSupportedImageMimeType("image/svg+xml")).toBe(false);
  });

  it("does not skip a Blink-selected non-URL image-set candidate", () => {
    const layer = 'image-set(linear-gradient(red, blue) 1x, url("two.png") 2x)';
    expect(selectBackgroundCandidate(layer, 1)).toMatchObject({
      source: "image-set",
      selectedUrl: null,
      selectedCandidateIndex: 0,
      selectedResolution: 1,
      warning: expect.stringContaining("non-URL"),
    });
    expect(selectBackgroundCandidate(layer, 1.5)).toMatchObject({
      selectedUrl: "two.png",
      selectedCandidateIndex: 1,
      selectedResolution: 2,
    });
    expect(selectBackgroundCandidate("cross-fade(url(\"one.png\"), url(\"two.png\"))", 1)).toBeNull();
  });
});
