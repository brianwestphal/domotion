import { afterEach, describe, expect, it } from "vitest";
import { _resizedDataUriCache, embedResizedDataUri, withActiveHiDPIFactor } from "./embed.js";

const SOURCE = "data:image/png;base64,source";

afterEach(() => {
  _resizedDataUriCache.clear();
});

describe("active embedded-image HiDPI scope", () => {
  it("supports nested and repeated scopes without leaking between renders", () => {
    _resizedDataUriCache.set(
      SOURCE,
      new Map([
        ["20x20", "factor-2"],
        ["30x30", "factor-3"],
        ["40x40", "factor-4"],
      ]),
    );

    expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-2");
    expect(
      withActiveHiDPIFactor(3, () => {
        expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-3");
        expect(withActiveHiDPIFactor(4, () => embedResizedDataUri(SOURCE, 10, 10))).toBe("factor-4");
        return embedResizedDataUri(SOURCE, 10, 10);
      }),
    ).toBe("factor-3");
    expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-2");
    expect(withActiveHiDPIFactor(3, () => embedResizedDataUri(SOURCE, 10, 10))).toBe("factor-3");
    expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-2");
  });

  it("restores the previous factor when rendering throws", () => {
    _resizedDataUriCache.set(
      SOURCE,
      new Map([
        ["20x20", "factor-2"],
        ["30x30", "factor-3"],
      ]),
    );
    expect(() =>
      withActiveHiDPIFactor(3, () => {
        expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-3");
        throw new Error("render failed");
      }),
    ).toThrow("render failed");
    expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-2");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid factor %s", (factor) => {
    expect(() => withActiveHiDPIFactor(factor, () => undefined)).toThrow(/finite positive number/);
  });
});
