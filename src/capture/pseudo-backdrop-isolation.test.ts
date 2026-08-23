import { describe, expect, it } from "vitest";

import {
  planPseudoBackdropIsolation,
  type PseudoBackdropSnapshotNode,
} from "./pseudo-backdrop-isolation.js";

const node = (
  backendNodeId: number,
  parentIndex: number,
  paintOrder: number,
  layoutOrder: number,
  bounds: [number, number, number, number] = [0, 0, 40, 30],
  nodeType = 1,
): PseudoBackdropSnapshotNode => ({
  backendNodeId,
  parentIndex,
  nodeType,
  bounds,
  paintOrder,
  layoutOrder,
});

describe("DM-2488 pseudo backdrop paint-slot isolation", () => {
  it("keeps prior paint and hides only later overlapping owners", () => {
    const nodes = [
      node(10, -1, 1, 0, [0, 0, 100, 100]),
      node(11, 0, 2, 1),
      node(12, 0, 3, 2), // target pseudo
      node(13, 0, 4, 3),
      node(14, 0, 5, 4, [70, 70, 10, 10]),
    ];
    expect(planPseudoBackdropIsolation(nodes, 12)).toEqual({
      targetBackendNodeId: 12,
      hideBackendNodeIds: [13],
    });
  });

  it("never converts the generated-pseudo boundary into a host-wide crop", () => {
    const nodes = [
      node(20, -1, 9, 0, [0, 0, 100, 100]), // host/ancestor, later order
      node(21, 0, 3, 1), // target pseudo
      node(22, 1, 7, 2), // anonymous descendant
      node(23, 0, 8, 3),
      node(24, 3, 9, 4),
    ];
    expect(planPseudoBackdropIsolation(nodes, 21)?.hideBackendNodeIds).toEqual([23]);
  });

  it("prunes later descendant owners and ignores anonymous text rows", () => {
    const nodes = [
      node(30, -1, 1, 0, [0, 0, 100, 100]),
      node(31, 0, 2, 1),
      node(32, 0, 3, 2), // target
      node(33, 0, 4, 3),
      node(34, 3, 5, 4),
      node(35, 0, 6, 5, [0, 0, 40, 30], 3),
    ];
    expect(planPseudoBackdropIsolation(nodes, 32)?.hideBackendNodeIds).toEqual([33]);
  });

  it("fails closed when the pseudo has no independent painted snapshot row", () => {
    expect(planPseudoBackdropIsolation([], 99)).toBeNull();
    expect(planPseudoBackdropIsolation([
      { backendNodeId: 99, parentIndex: -1, nodeType: 1 },
    ], 99)).toBeNull();
  });
});
