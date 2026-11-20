import { describe, expect, it } from "vitest";
import { snapshotPseudoStackingContext } from "./pseudo-fragment-cdp.js";

// DM-SC2P4R: only the pseudo's first layout row (its own box) is authoritative;
// anonymous content children can disagree (contain:paint flags the box only).
const snapshot = (nodeIndex: number[], flags?: number[]) => ({
  documents: [
    {
      nodes: { backendNodeId: [10, 20, 30] },
      layout: { nodeIndex, ...(flags == null ? {} : { stackingContexts: { index: flags } }) },
    },
  ],
});

describe("snapshotPseudoStackingContext", () => {
  it("reads the first layout row of the pseudo node", () => {
    expect(snapshotPseudoStackingContext(snapshot([0, 1, 1], [1]), 20)).toBe(true);
    expect(snapshotPseudoStackingContext(snapshot([0, 1, 1], [2]), 20)).toBe(false);
  });

  it("is unknown without a box or without the flag table", () => {
    expect(snapshotPseudoStackingContext(snapshot([0, 1]), 20)).toBeUndefined();
    expect(snapshotPseudoStackingContext(snapshot([0, 1], [0]), 30)).toBeUndefined();
    expect(snapshotPseudoStackingContext(snapshot([0], [0]), 99)).toBeUndefined();
  });
});
