import { describe, expect, it } from "vitest";
import { rotationForRevision } from "../tools/font-conformance-rotation.mjs";

describe("font conformance revision rotation", () => {
  it("is deterministic and exposes a representative stack focus", () => {
    expect(rotationForRevision("0011223344556677", 1)).toEqual({
      sampleByte: "01", stackBucket: "weight-style", stackBucketIndex: 1,
      stackBucketTotal: 8, revision: "0011223344556677", ordinal: 1,
    });
  });

  it("maps the 256 leading-byte values bijectively onto 00..FF", () => {
    const buckets = new Set<string>();
    for (let i = 0; i < 256; i++) {
      buckets.add(rotationForRevision("0011223344556677", i).sampleByte);
    }
    expect(buckets.size).toBe(256);
    expect(buckets.has("00")).toBe(true);
    expect(buckets.has("FF")).toBe(true);
  });

  it("rejects values that cannot identify a revision", () => {
    expect(() => rotationForRevision("main", 0)).toThrow(/hexadecimal git object id/);
    expect(() => rotationForRevision("00112233", -1)).toThrow(/non-negative integer/);
  });
});
