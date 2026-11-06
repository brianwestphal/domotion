import { describe, expect, it } from "vitest";

import { formatNumber, stopFmt } from "./format.js";

describe("formatNumber", () => {
  it("trims trailing zeros and the bare decimal point", () => {
    expect(formatNumber(1.5, 4)).toBe("1.5");
    expect(formatNumber(2, 4)).toBe("2");
    expect(formatNumber(100.00001, 4)).toBe("100");
    expect(formatNumber(0.1 + 0.2, 4)).toBe("0.3");
  });

  it("rounds with toFixed at each precision", () => {
    expect(formatNumber(1.23456, 2)).toBe("1.23");
    expect(formatNumber(1.23556, 3)).toBe("1.236");
    expect(formatNumber(1.23456789, 4)).toBe("1.2346");
    // toFixed works on the exact binary value: 1.005 is stored just below
    // 1.005, so it rounds down, and 2.5 rounds half away from zero.
    expect(formatNumber(1.005, 2)).toBe("1");
    expect(formatNumber(2.5, 0)).toBe("3");
    expect(formatNumber(-2.5, 0)).toBe("-3");
    expect(formatNumber(0.00005, 4)).toBe("0.0001");
    expect(formatNumber(0.00004, 4)).toBe("0");
  });

  it("writes negative zero, and negatives that round to zero, as 0", () => {
    expect(formatNumber(-0, 4)).toBe("0");
    expect(formatNumber(-0.00001, 4)).toBe("0");
    expect(formatNumber(-0.004, 2)).toBe("0");
    expect(formatNumber(-0.25, 4)).toBe("-0.25");
  });

  it("keeps toFixed's exponent form at 1e21 and above, and never emits one below", () => {
    expect(formatNumber(1e21, 4)).toBe("1e+21");
    expect(formatNumber(123456789012345680000, 2)).toBe("123456789012345680000");
    expect(formatNumber(1e-7, 4)).toBe("0");
    expect(formatNumber(0.0001, 4)).toBe("0.0001");
  });

  it("throws on a non-finite value instead of writing it into markup", () => {
    expect(() => formatNumber(Number.NaN, 4)).toThrow(RangeError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY, 2)).toThrow(/non-finite value Infinity/);
    expect(() => formatNumber(Number.NEGATIVE_INFINITY, 3)).toThrow(/non-finite value -Infinity/);
  });

  it("is what stopFmt formats with at four decimals", () => {
    expect(stopFmt(0.123456)).toBe("0.1235");
    expect(stopFmt(-0.00001)).toBe("0");
    expect(() => stopFmt(Number.NaN)).toThrow(RangeError);
  });
});
