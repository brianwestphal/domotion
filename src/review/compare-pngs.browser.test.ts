import { afterEach, describe, expect, it, vi } from "vitest";
import { compareImages, type BrowserComparisonConfig } from "./compare-pngs.browser.js";
import { perceptualDigest } from "./side-digest.js";

const width = 16;
const height = 16;
const config: BrowserComparisonConfig = {
  regionDilatePx: 1,
  minRegionArea: 4,
  shiftMatchRadius: 0,
  shiftMatchDist: 35,
  highSevPct: 50,
  minHighSevFraction: 0.15,
  maxReportedRegions: 32,
};

type FakeImage = { width: number; height: number; pixels: Uint8ClampedArray; onload: (() => void) | null };

function pixels(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return data;
}

function paint(data: Uint8ClampedArray, x: number, y: number, w: number, h: number, shade: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = data[i + 1] = data[i + 2] = shade;
    }
  }
}

function installCanvas(expected: Uint8ClampedArray, actual: Uint8ClampedArray): void {
  class ImageStub implements FakeImage {
    width = width;
    height = height;
    pixels = expected;
    onload: (() => void) | null = null;
    set src(value: string) {
      this.pixels = value.endsWith("actual") ? actual : expected;
      this.onload?.();
    }
  }
  class CanvasStub {
    width = 0;
    height = 0;
    pixels = pixels();
    getContext() {
      return {
        drawImage: (image: FakeImage) => {
          this.pixels = image.pixels;
        },
        getImageData: () => ({ data: this.pixels }),
        createImageData: () => ({ data: pixels() }),
        putImageData: () => {},
      };
    }
    toDataURL() {
      return "data:image/png;base64,AA==";
    }
  }
  vi.stubGlobal("Image", ImageStub);
  vi.stubGlobal("document", { createElement: () => new CanvasStub() });
}

afterEach(() => vi.unstubAllGlobals());

describe("typed browser comparison algorithm", () => {
  it("scores a dense color replacement and reuses the shared side digest", async () => {
    const a = pixels();
    const b = pixels();
    paint(b, 4, 4, 8, 8, 0);
    installCanvas(a, b);
    const result = await compareImages("expected", "actual", 8, 40, config);
    expect(result.nonAaPixels).toBe(64);
    expect(result.regionCount).toBe(1);
    expect(result.totalChangedArea).toBe(64);
    expect(result.strictRegionCount).toBe(1);
    expect(result.regions[0].area).toBe(64);
    expect(result.expectedDigest).toBe(perceptualDigest(a, width, height));
    expect(result.actualDigest).toBe(perceptualDigest(b, width, height));
  });

  it("culls isolated scatter without losing its diagnostic count", async () => {
    const a = pixels();
    const b = pixels();
    paint(b, 8, 8, 1, 1, 0);
    installCanvas(a, b);
    const result = await compareImages("expected", "actual", 8, 40, config);
    expect(result.nonAaPixels).toBe(1);
    expect(result.regionCount).toBe(0);
    expect(result.scatteredPixels).toBe(1);
  });
});
