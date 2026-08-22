import { describe, expect, it } from "vitest";

import {
  BROKEN_IMAGE_GATE_CASES,
  BROKEN_IMAGE_GATE_DPRS,
  BROKEN_IMAGE_GATE_PLATFORMS,
  BROKEN_IMAGE_GATE_SCHEMES,
  BROKEN_IMAGE_GATE_SOURCE_REVISIONS,
  BROKEN_IMAGE_GATE_THRESHOLDS,
  REQUIRED_BROKEN_IMAGE_MUTATIONS,
  validateBrokenImageGateCorpus,
} from "../tools/broken-image-fallback-oracle.js";

describe("DM-2465 broken-image fallback hard-gate contract", () => {
  it("keeps the independently specified corpus complete and internally valid", () => {
    expect(validateBrokenImageGateCorpus()).toEqual([]);
    expect(BROKEN_IMAGE_GATE_CASES).toHaveLength(27);
    expect(new Set(BROKEN_IMAGE_GATE_CASES.map(({ family }) => family))).toEqual(new Set([
      "source-state", "alt-title", "threshold", "direction", "writing-mode",
      "sizing-mode", "author-box", "clipping", "mixed-text", "zoom",
      "transform", "raster-negative", "icon-content",
    ]));
  });

  it("contains positive icon ownership plus all required negative controls", () => {
    const byId = new Map(BROKEN_IMAGE_GATE_CASES.map((test) => [test.id, test]));
    expect(byId.get("src-error")?.expectedIcon).toBe(true);
    expect(byId.get("icon-content")?.expectedIcon).toBe(true);
    for (const id of ["src-loading", "src-success", "alt-empty-auto", "threshold-17", "ordinary-author-raster"]) {
      expect(byId.get(id)?.expectedIcon, id).toBe(false);
    }
    expect(byId.get("threshold-18")?.expectedIcon).toBe(true);
    expect(byId.get("mixed-astral-bidi")?.alt).toContain("😀");
  });

  it("pins the full native matrix and separates CSS, crop-envelope, and device-pixel tolerances", () => {
    expect(BROKEN_IMAGE_GATE_PLATFORMS).toEqual(["darwin", "linux", "win32"]);
    expect(BROKEN_IMAGE_GATE_DPRS).toEqual([1, 2]);
    expect(BROKEN_IMAGE_GATE_SCHEMES).toEqual(["light", "dark"]);
    expect(BROKEN_IMAGE_GATE_THRESHOLDS.geometryCssPx).toBe(1 / 64);
    expect(BROKEN_IMAGE_GATE_THRESHOLDS.cropEnvelopeCssPx).toBe(1);
    expect(BROKEN_IMAGE_GATE_THRESHOLDS.iconBoundDevicePx).toBe(1);
    expect(BROKEN_IMAGE_GATE_THRESHOLDS.iconRgbaMeanError).toBeLessThanOrEqual(0.01);
    expect(BROKEN_IMAGE_GATE_THRESHOLDS.iconPixelMismatchFraction).toBeLessThanOrEqual(0.04);
  });

  it("pins Chromium authority and every required fault-injection discriminator", () => {
    expect(BROKEN_IMAGE_GATE_SOURCE_REVISIONS.chromium).toMatch(/^[0-9a-f]{40}$/);
    expect(BROKEN_IMAGE_GATE_SOURCE_REVISIONS.skiaPinnedByChromium).toMatch(/^[0-9a-f]{40}$/);
    expect(BROKEN_IMAGE_GATE_SOURCE_REVISIONS.harfbuzz).toMatch(/^[0-9a-f]{40}$/);
    expect(REQUIRED_BROKEN_IMAGE_MUTATIONS).toEqual([
      "load-error-success", "alt-missing-empty-text-title", "threshold-17-18",
      "ltr-rtl", "horizontal-vertical", "standards-quirks",
      "one-both-aspect-ratio", "author-box-offset", "long-container-clipping",
      "astral-utf16", "zoom-icon-size", "dpr-resource-switch",
      "light-dark-text-only", "gray-mountain-substitution", "reuse-1x-at-2x",
    ]);
  });
});
