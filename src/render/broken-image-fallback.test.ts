import { describe, expect, it, vi } from "vitest";
import type { CapturedBrokenImageFallback, CapturedBrokenImageQuad, CapturedElement } from "../capture/types.js";
import { renderBrokenImageFallback } from "./broken-image-fallback.js";

const QUAD: CapturedBrokenImageQuad = [10, 10, 28, 10, 28, 28, 10, 28];
const INNER: CapturedBrokenImageQuad = [11, 11, 27, 11, 27, 27, 11, 27];

function record(overrides: Partial<CapturedBrokenImageFallback> = {}): CapturedBrokenImageFallback {
  return {
    schemaVersion: 1,
    authority: "chromium-ua-shadow-v1",
    disposition: "replaced-flow-root-fallback",
    captureStatus: "exact",
    paintOwnership: "hybrid-icon-raster-vector-text",
    loadState: "failed",
    source: {
      complete: true,
      naturalWidth: 0,
      naturalHeight: 0,
      currentSrc: "broken.png",
      src: { present: true, value: "broken.png" },
      alt: { present: false, value: null },
      title: { present: false, value: null },
      resolvedText: "",
    },
    hostBox: null,
    container: {
      box: { rect: { x: 10, y: 10, width: 18, height: 18 }, content: INNER, padding: INNER, border: QUAD, margin: QUAD },
      display: "flow-root",
      float: "none",
      overflowX: "hidden",
      overflowY: "hidden",
      overflowClip: INNER,
      direction: "ltr",
      writingMode: "horizontal-tb",
      effectiveZoom: 1,
      border: {
        top: 1, right: 1, bottom: 1, left: 1,
        topStyle: "solid", rightStyle: "solid", bottomStyle: "solid", leftStyle: "solid",
        topColor: "rgb(192, 192, 192)", rightColor: "rgb(192, 192, 192)",
        bottomColor: "rgb(192, 192, 192)", leftColor: "rgb(192, 192, 192)",
      },
      padding: { top: 1, right: 1, bottom: 1, left: 1 },
    },
    icon: {
      box: { rect: { x: 12, y: 12, width: 16, height: 16 }, content: QUAD, padding: QUAD, border: QUAD, margin: QUAD },
      display: "flow-root",
      float: "left",
      visible: true,
      cssWidth: 16,
      cssHeight: 16,
      devicePixelRatio: 2,
      resourceScale: 2,
      raster: {
        source: "chromium-isolated-ua-shadow-icon-v1",
        dataUri: "data:image/png;base64,aWNvbg==",
        rect: { x: 12, y: 12, width: 16, height: 16 },
        pixelWidth: 32,
        pixelHeight: 32,
        pngSha256: "a".repeat(64),
        rgbaSha256: "b".repeat(64),
      },
    },
    accessibility: { ignored: false, role: "image", name: "", description: null },
    ...overrides,
  };
}

function element(fallback: CapturedBrokenImageFallback): CapturedElement {
  return {
    tag: "img",
    text: "",
    x: 10,
    y: 10,
    width: 18,
    height: 18,
    styles: {} as CapturedElement["styles"],
    children: [],
    imageBroken: true,
    imageAlt: "legacy must not paint",
    imageSrc: "broken.png",
    brokenImageFallback: fallback,
  };
}

function render(fallback: CapturedBrokenImageFallback) {
  let id = 0;
  return renderBrokenImageFallback(element(fallback), {
    indent: "  ",
    idPrefix: "t-",
    nextId: (prefix) => `${prefix}${id++}`,
  });
}

describe("hybrid broken-image fallback emission (DM-2464)", () => {
  it("emits captured UA border/clip plus only the Chromium icon raster", () => {
    const output = render(record());
    expect(output.handled).toBe(true);
    expect(output.defs.join("")).toContain('<clipPath id="bifc0">');
    const svg = output.svg.join("");
    expect(svg.match(/<path\b/g)).toHaveLength(4);
    expect(svg).toContain('fill="rgb(192, 192, 192)"');
    expect(svg).toContain('href="data:image/png;base64,aWNvbg=="');
    expect(svg).toContain('data-broken-image-icon="2x"');
    expect(svg).toContain('role="img"');
    expect(svg).not.toContain("polyline");
    expect(svg).not.toContain("legacy must not paint");
    expect(svg).not.toMatch(/<text\b/);
  });

  it("keeps decorative/hidden, loading, and successful controls off the fallback raster path", () => {
    const decorative = render(record({
      disposition: "empty-inline",
      paintOwnership: "none",
      container: undefined,
      icon: undefined,
      accessibility: { ignored: true, role: null, name: null, description: null },
    }));
    expect(decorative).toMatchObject({ handled: true, defs: [], svg: [] });

    const loading = render(record({ disposition: "loading", loadState: "loading", paintOwnership: "none", container: undefined, icon: undefined }));
    expect(loading).toMatchObject({ handled: true, defs: [], svg: [] });

    const primary = render(record({ disposition: "primary", loadState: "loaded", paintOwnership: "none", container: undefined, icon: undefined }));
    expect(primary).toMatchObject({ handled: false, defs: [], svg: [] });
  });

  it("fails closed on a terminal record and never revives the legacy mountain", () => {
    const missing = render(record({
      captureStatus: "terminal-raster",
      paintOwnership: "terminal-raster",
      container: undefined,
      icon: undefined,
      terminalRaster: { rect: { x: 10, y: 10, width: 18, height: 18 }, reason: "CDP unavailable" },
      accessibility: { unavailableReason: "CDP unavailable" },
    }));
    expect(missing).toMatchObject({ handled: true, defs: [], svg: [] });

    const materialized = render(record({
      captureStatus: "terminal-raster",
      paintOwnership: "terminal-raster",
      container: undefined,
      icon: undefined,
      terminalRaster: {
        rect: { x: 10, y: 10, width: 18, height: 18 },
        reason: "CDP unavailable",
        dataUri: "data:image/png;base64,dGVybWluYWw=",
      },
      accessibility: { unavailableReason: "CDP unavailable" },
    }));
    expect(materialized.svg.join("")).toContain("data:image/png;base64,dGVybWluYWw=");
    expect(materialized.svg.join("")).not.toContain("polyline");
  });

  it("fails closed when an exact record claims a visible icon without pixels", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const incomplete = record({ icon: { ...record().icon!, raster: undefined } });
      expect(render(incomplete)).toMatchObject({ handled: true, defs: [], svg: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no authoritative raster"));
    } finally {
      warn.mockRestore();
    }
  });
});
