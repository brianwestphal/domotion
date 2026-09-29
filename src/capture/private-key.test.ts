import { describe, expect, it } from "vitest";
import { privateCaptureKey } from "./private-key.js";

describe("privateCaptureKey", () => {
  it("is a valid identifier carrying the name, and unique across a burst in one millisecond", () => {
    const keys = Array.from({ length: 500 }, () => privateCaptureKey("PseudoFragments"));
    expect(new Set(keys).size).toBe(500);
    for (const key of keys) expect(key).toMatch(/^__domotionPseudoFragments_[0-9a-f]{32}$/);
  });
});
