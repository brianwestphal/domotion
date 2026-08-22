import { describe, expect, it } from "vitest";
import {
  captureBrokenImageFallbackFacts,
  classifyBrokenImageDisposition,
} from "./broken-image-fallback.js";
import type { CapturedElement, CaptureWarning } from "./types.js";

function source(overrides: Partial<{
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  currentSrc: string;
  src: { present: boolean; value: string | null };
  alt: { present: boolean; value: string | null };
  title: { present: boolean; value: string | null };
  resolvedText: string;
}> = {}) {
  return {
    complete: true,
    naturalWidth: 0,
    naturalHeight: 0,
    currentSrc: "https://example.test/broken.png",
    src: { present: true, value: "/broken.png" },
    alt: { present: true, value: "fallback" },
    title: { present: false, value: null },
    resolvedText: "fallback",
    ...overrides,
  };
}

describe("Chromium broken-image fallback disposition (DM-2463)", () => {
  it("separates primary, loading, and collapsed hosts without a UA shadow", () => {
    expect(classifyBrokenImageDisposition({
      source: source({ naturalWidth: 1, naturalHeight: 1 }),
      uaShadowPresent: false,
    })).toBe("primary");
    expect(classifyBrokenImageDisposition({
      source: source({ complete: false }),
      uaShadowPresent: false,
    })).toBe("loading");
    expect(classifyBrokenImageDisposition({
      source: source(),
      uaShadowPresent: false,
    })).toBe("collapsed");
    expect(classifyBrokenImageDisposition({
      source: source({
        currentSrc: "",
        src: { present: false, value: null },
        alt: { present: false, value: null },
        resolvedText: "",
      }),
      uaShadowPresent: false,
    })).toBe("primary");
  });

  it("separates empty-inline, text/icon, and flow-root UA fallback", () => {
    expect(classifyBrokenImageDisposition({
      source: source({ resolvedText: "" }),
      uaShadowPresent: true,
      containerDisplay: "inline",
      iconVisible: false,
    })).toBe("empty-inline");
    expect(classifyBrokenImageDisposition({
      source: source(),
      uaShadowPresent: true,
      containerDisplay: "inline",
      iconVisible: true,
    })).toBe("non-replaced-fallback");
    expect(classifyBrokenImageDisposition({
      source: source(),
      uaShadowPresent: true,
      containerDisplay: "flow-root",
      iconVisible: true,
    })).toBe("replaced-flow-root-fallback");
  });

  it("fails closed to a classified terminal surface when live correlation is absent", async () => {
    const image = {
      tag: "img",
      x: 11,
      y: 13,
      width: 17,
      height: 17,
      children: [],
      brokenImageFallback: {
        schemaVersion: 1,
        authority: "chromium-ua-shadow-v1",
        source: source(),
        hostRect: { x: 11, y: 13, width: 17, height: 17 },
        selector: "#broken",
      },
    } as unknown as CapturedElement;
    const warnings: CaptureWarning[] = [];

    await captureBrokenImageFallbackFacts(
      {} as never,
      [image],
      { x: 0, y: 0, width: 100, height: 100 },
      warnings,
    );

    expect(image.brokenImageFallback).toMatchObject({
      disposition: "collapsed",
      captureStatus: "terminal-raster",
      paintOwnership: "terminal-raster",
      terminalRaster: {
        rect: { x: 11, y: 13, width: 17, height: 17 },
        reason: "live image-node registry unavailable",
      },
    });
    expect(warnings).toEqual([{
      selector: "#broken",
      feature: "broken-image-fallback",
      detail: "live image-node registry unavailable; terminal Chromium raster required",
    }]);
  });
});
