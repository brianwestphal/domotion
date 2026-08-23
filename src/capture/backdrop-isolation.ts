import type { CaptureWarning } from "./types.js";

export interface SnapshotNode {
  backendNodeId: number;
  parentIndex: number;
  attributes: string[];
  bounds?: [number, number, number, number];
  paintOrder?: number;
  layoutOrder?: number;
}

export interface IsolationPlan {
  targetBackendNodeId: number;
  hideBackendNodeIds: number[];
}

export type BackdropRasterOutcome =
  | { status: "exact" }
  | {
    status: "partial";
    reason: "planner-miss" | "snapshot-unavailable" | "node-resolution-partial" | "effect-space-unavailable";
    fallback: "unisolated Chromium page crop" | "partially isolated Chromium crop" | "isolated final-effect-space Chromium crop";
    unresolvedNodeCount?: number;
  }
  | {
    status: "unavailable";
    reason: "missing-token" | "screenshot-failure";
    fallback: string;
  };

/**
 * Convert the Node-owned materialization outcome into the public warning
 * contract. Blink's effect node samples the previously painted surface and
 * Skia's backdrop saveLayer reads the prior device, so a completed isolated
 * Chromium crop is exact for this boundary and must remain silent. Source:
 * Chromium 7d859f27 paint_property_tree_builder.cc / paint_layer.cc and its
 * pinned Skia 62efacd3 src/core/SkCanvas.cpp.
 */
export function backdropRasterWarning(
  selector: string,
  outcome: BackdropRasterOutcome,
): CaptureWarning | null {
  if (outcome.status === "exact") return null;
  let reason: string;
  if (outcome.reason === "planner-miss") {
    reason = "DOMSnapshot token did not map to one painted layout owner";
  } else if (outcome.reason === "snapshot-unavailable") {
    reason = "Chromium DOMSnapshot isolation was unavailable";
  } else if (outcome.reason === "node-resolution-partial") {
    const count = outcome.unresolvedNodeCount ?? 1;
    reason = `${count} CDP paint ${count === 1 ? "owner was" : "owners were"} not resolved for isolation`;
  } else if (outcome.reason === "effect-space-unavailable") {
    reason = "captured Blink Backdrop Root/effect-space correlation was unavailable";
  } else if (outcome.reason === "missing-token") {
    reason = "capture record had no live-DOM isolation token";
  } else {
    reason = "Chromium backdrop screenshot failed";
  }
  return {
    selector,
    feature: "backdrop-filter",
    status: outcome.status,
    detail: `${outcome.status}: ${reason}; fallback: ${outcome.fallback}`,
  };
}

export function appendBackdropRasterWarning(
  warnings: CaptureWarning[],
  selector: string,
  outcome: BackdropRasterOutcome,
): void {
  const warning = backdropRasterWarning(selector, outcome);
  const matches = (entry: CaptureWarning) => entry.feature === "backdrop-filter"
    && entry.selector === selector;
  // The Node post-pass is authoritative even for a tree produced by an older
  // bundled walk: exact materialization removes the retired eager warning.
  for (let index = warnings.length - 1; index >= 0; index--) {
    if (matches(warnings[index])) warnings.splice(index, 1);
  }
  if (warning != null) warnings.push(warning);
}

function overlaps(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[0] + b[2] && a[0] + a[2] > b[0]
    && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
}

function hasToken(node: SnapshotNode, token: string): boolean {
  for (let i = 0; i + 1 < node.attributes.length; i += 2) {
    if (node.attributes[i] === "data-domotion-backdrop-raster" && node.attributes[i + 1] === token) return true;
  }
  return false;
}

function isAncestor(nodes: SnapshotNode[], ancestor: number, child: number): boolean {
  for (let i = child; i >= 0; i = nodes[i]?.parentIndex ?? -1) if (i === ancestor) return true;
  return false;
}

/** Pure CDP snapshot planner; DOM mutation and restoration stay in emoji.ts. */
export function planBackdropIsolation(
  nodes: SnapshotNode[],
  token: string,
  options: { includeTargetDescendants?: boolean } = {},
): IsolationPlan | null {
  const target = nodes.findIndex((node) => hasToken(node, token));
  if (target < 0) return null;
  const targetNode = nodes[target];
  if (targetNode.bounds == null || targetNode.paintOrder == null) return null;
  const hide: number[] = [];
  // The renderer keeps descendants as vector content above the captured
  // filtered surface. Hide each top-level descendant subtree while taking the
  // crop so its pixels are not baked into the backdrop image as well.
  if (options.includeTargetDescendants !== true) {
    for (let i = 0; i < nodes.length; i++) {
      if (i === target || !isAncestor(nodes, target, i)) continue;
      const parent = nodes[i]?.parentIndex ?? -1;
      if (parent === target) hide.push(nodes[i].backendNodeId);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (i === target || node.bounds == null || node.paintOrder == null) continue;
    const paintsLater = node.paintOrder > targetNode.paintOrder
      || (node.paintOrder === targetNode.paintOrder
        && node.layoutOrder != null && targetNode.layoutOrder != null
        && node.layoutOrder > targetNode.layoutOrder);
    if (!paintsLater || !overlaps(node.bounds, targetNode.bounds)) continue;
    if (isAncestor(nodes, i, target) || isAncestor(nodes, target, i)) continue;
    // If an already-selected later ancestor hides this node, do not resolve and
    // mutate the descendant too. Snapshot order is parent-before-child.
    if (hide.some((id) => {
      const ancestor = nodes.findIndex((n) => n.backendNodeId === id);
      return ancestor >= 0 && isAncestor(nodes, ancestor, i);
    })) continue;
    hide.push(node.backendNodeId);
  }
  return { targetBackendNodeId: targetNode.backendNodeId, hideBackendNodeIds: hide };
}
