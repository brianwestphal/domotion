import { describe, expect, it } from "vitest";
import { stableDigest, stableValue } from "./stable-digest.js";

describe("stableDigest", () => {
  it("ignores object key order at every depth but respects array order", () => {
    expect(stableDigest({ a: 1, b: { c: 2, d: [1, { y: 1, x: 2 }] } })).toBe(
      stableDigest({ b: { d: [1, { x: 2, y: 1 }], c: 2 }, a: 1 }),
    );
    expect(stableDigest([1, 2])).not.toBe(stableDigest([2, 1]));
  });

  it("distinguishes different values and handles primitives and null", () => {
    expect(stableDigest({ a: 1 })).not.toBe(stableDigest({ a: 2 }));
    expect(stableDigest(null)).toBe(stableDigest(null));
    expect(stableDigest("x")).not.toBe(stableDigest("y"));
    expect(stableValue(undefined)).toBeUndefined();
  });

  it("is a 64-character hex SHA-256", () => {
    expect(stableDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
