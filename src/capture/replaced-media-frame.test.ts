import { describe, expect, it } from "vitest";
import {
  replacedMediaOwnerFactDifferences,
  type ComparableReplacedMediaOwnerFact,
} from "./replaced-media-frame.js";

const exact: ComparableReplacedMediaOwnerFact = {
  rid: "dr0",
  kind: "video",
  connected: true,
  readyState: 4,
  requestedTimeSeconds: 0.25,
  currentTimeSeconds: 0.25,
  dimensions: {
    cssWidth: 120,
    cssHeight: 80,
    intrinsicWidth: 64,
    intrinsicHeight: 48,
  },
  frameEpoch: "video:4:0.25:64:48",
  sourceIdentity: "blob:https://example.test/frame",
  surfaceDigest: null,
};

describe("atomic replaced-media frame facts", () => {
  it("accepts only field-for-field stable owner facts", () => {
    expect(replacedMediaOwnerFactDifferences(exact, structuredClone(exact))).toEqual([]);
  });

  it.each([
    ["readyState", { readyState: 1 }],
    ["currentTimeSeconds", { currentTimeSeconds: 0.251 }],
    ["frameEpoch", { frameEpoch: "video:5:0.25:64:48" }],
    ["sourceIdentity", { sourceIdentity: "blob:https://example.test/other" }],
    ["connected", { connected: false }],
    ["surfaceDigest", { surfaceDigest: "changed" }],
  ] as const)("rejects hostile %s movement without an envelope", (field, mutation) => {
    const changed = { ...structuredClone(exact), ...mutation };
    expect(replacedMediaOwnerFactDifferences(exact, changed)).toContain(field);
  });

  it("rejects every dimension axis independently", () => {
    for (const field of ["cssWidth", "cssHeight", "intrinsicWidth", "intrinsicHeight"] as const) {
      const changed = structuredClone(exact);
      changed.dimensions[field] += 1;
      expect(replacedMediaOwnerFactDifferences(exact, changed)).toContain(field);
    }
  });
});
