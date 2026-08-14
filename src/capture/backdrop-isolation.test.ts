import { describe, expect, it } from "vitest";
import { planBackdropIsolation, type SnapshotNode } from "./backdrop-isolation.js";

const n = (backendNodeId: number, parentIndex: number, paintOrder: number, bounds: [number, number, number, number], attributes: string[] = []): SnapshotNode =>
  ({ backendNodeId, parentIndex, paintOrder, layoutOrder: backendNodeId, bounds, attributes });

describe("planBackdropIsolation", () => {
  it("hides only overlapping later paint and preserves target relatives and backdrop", () => {
    const nodes = [
      n(1, -1, 0, [0, 0, 500, 500]),
      n(2, 0, 1, [0, 0, 200, 200]), // earlier backdrop
      n(3, 0, 3, [20, 20, 100, 100], ["data-domotion-backdrop-raster", "bf0"]),
      n(4, 2, 4, [30, 30, 20, 20]), // target descendant
      n(5, 0, 5, [50, 50, 100, 100]), // later overlapping wrapper
      n(6, 4, 6, [60, 60, 10, 10]), // hidden by wrapper
      n(7, 0, 7, [300, 300, 20, 20]), // later non-overlap
    ];
    expect(planBackdropIsolation(nodes, "bf0")).toEqual({ targetBackendNodeId: 3, hideBackendNodeIds: [5] });
  });

  it("falls back when the target cannot be mapped to one painted layout node", () => {
    expect(planBackdropIsolation([n(1, -1, 0, [0, 0, 10, 10])], "missing")).toBeNull();
  });

  it("uses layout traversal to order siblings in the same paint group", () => {
    const nodes = [
      n(1, -1, 0, [0, 0, 200, 200]),
      n(2, 0, 1, [20, 20, 100, 100], ["data-domotion-backdrop-raster", "bf0"]),
      n(3, 0, 1, [40, 40, 100, 100]),
    ];
    expect(planBackdropIsolation(nodes, "bf0")?.hideBackendNodeIds).toEqual([3]);
  });
});
