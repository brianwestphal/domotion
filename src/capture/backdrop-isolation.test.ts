import { describe, expect, it } from "vitest";
import {
  appendBackdropRasterWarning,
  backdropRasterWarning,
  planBackdropIsolation,
  type SnapshotNode,
} from "./backdrop-isolation.js";
import type { CaptureWarning } from "./types.js";

const n = (backendNodeId: number, parentIndex: number, paintOrder: number, bounds: [number, number, number, number], attributes: string[] = []): SnapshotNode =>
  ({ backendNodeId, parentIndex, paintOrder, layoutOrder: backendNodeId, bounds, attributes });

describe("planBackdropIsolation", () => {
  it("hides vectorized descendants and overlapping later paint while preserving the backdrop", () => {
    const nodes = [
      n(1, -1, 0, [0, 0, 500, 500]),
      n(2, 0, 1, [0, 0, 200, 200]), // earlier backdrop
      n(3, 0, 3, [20, 20, 100, 100], ["data-domotion-backdrop-raster", "bf0"]),
      n(4, 2, 4, [30, 30, 20, 20]), // target descendant
      n(5, 0, 5, [50, 50, 100, 100]), // later overlapping wrapper
      n(6, 4, 6, [60, 60, 10, 10]), // hidden by wrapper
      n(7, 0, 7, [300, 300, 20, 20]), // later non-overlap
    ];
    expect(planBackdropIsolation(nodes, "bf0")).toEqual({ targetBackendNodeId: 3, hideBackendNodeIds: [4, 5] });
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

  it("keeps target descendants for an atomic regular-filter chain", () => {
    const nodes = [
      n(1, -1, 0, [0, 0, 200, 200]),
      n(2, 0, 1, [20, 20, 100, 100], ["data-domotion-backdrop-raster", "bf0"]),
      n(3, 1, 2, [30, 30, 20, 20]),
      n(4, 0, 3, [40, 40, 100, 100]),
    ];
    expect(planBackdropIsolation(nodes, "bf0", { includeTargetDescendants: true })?.hideBackendNodeIds).toEqual([4]);
  });
});

describe("backdrop raster diagnostics", () => {
  it("stays silent when Chromium materialized the isolated source surface", () => {
    expect(backdropRasterWarning("#glass", { status: "exact" })).toBeNull();
    const warnings: CaptureWarning[] = [{
      selector: "#host::before",
      feature: "backdrop-filter",
      detail: "legacy eager warning",
    }];
    appendBackdropRasterWarning(warnings, "#host::before", { status: "exact" });
    expect(warnings).toEqual([]);
  });

  it("reports a planner miss as a partial unisolated Chromium crop", () => {
    expect(backdropRasterWarning("#glass", {
      status: "partial",
      reason: "planner-miss",
      fallback: "unisolated Chromium page crop",
    })).toEqual({
      selector: "#glass",
      feature: "backdrop-filter",
      status: "partial",
      detail: "partial: DOMSnapshot token did not map to one painted layout owner; fallback: unisolated Chromium page crop",
    });
  });

  it("reports unresolved CDP isolation owners and the retained partial crop", () => {
    expect(backdropRasterWarning("#glass", {
      status: "partial",
      reason: "node-resolution-partial",
      fallback: "partially isolated Chromium crop",
      unresolvedNodeCount: 2,
    })).toMatchObject({
      status: "partial",
      detail: "partial: 2 CDP paint owners were not resolved for isolation; fallback: partially isolated Chromium crop",
    });
  });

  it("reports screenshot failure as unavailable and names the vector fallback", () => {
    expect(backdropRasterWarning("#glass", {
      status: "unavailable",
      reason: "screenshot-failure",
      fallback: "captured frosted-background color without a sampled backdrop",
    })).toMatchObject({
      status: "unavailable",
      detail: "unavailable: Chromium backdrop screenshot failed; fallback: captured frosted-background color without a sampled backdrop",
    });
  });

  it("keeps generated-pseudo ownership distinct from the host selector", () => {
    expect(backdropRasterWarning("#host::before", {
      status: "unavailable",
      reason: "missing-token",
      fallback: "captured vector box/background without a sampled backdrop",
    })).toMatchObject({
      selector: "#host::before",
      status: "unavailable",
      detail: expect.stringContaining("capture record had no live-DOM isolation token"),
    });
  });
});
