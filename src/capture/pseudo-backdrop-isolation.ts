/**
 * Source-paint-order planner for generated-pseudo backdrop capture (DM-2488).
 *
 * Blink gives ::before/::after/::checkmark their own layout node and effect
 * node. DOMSnapshot therefore supplies an independent paint position for the
 * pseudo. Keep every prior overlapping owner visible (Skia samples the prior
 * parent device) and hide only later, unrelated paint while the pseudo surface
 * is materialized. Host ancestors are never hidden: doing so would remove the
 * anonymous pseudo itself and silently turn a pseudo boundary into a host crop.
 */

export interface PseudoBackdropSnapshotNode {
  backendNodeId: number;
  parentIndex: number;
  nodeType: number;
  bounds?: [number, number, number, number];
  paintOrder?: number;
  layoutOrder?: number;
}
export interface PseudoBackdropIsolationPlan {
  targetBackendNodeId: number;
  hideBackendNodeIds: number[];
}

function overlaps(
  left: [number, number, number, number],
  right: [number, number, number, number],
): boolean {
  return left[0] < right[0] + right[2] && left[0] + left[2] > right[0]
    && left[1] < right[1] + right[3] && left[1] + left[3] > right[1];
}

function isAncestor(
  nodes: readonly PseudoBackdropSnapshotNode[],
  ancestor: number,
  child: number,
): boolean {
  for (let cursor = child; cursor >= 0; cursor = nodes[cursor]?.parentIndex ?? -1) {
    if (cursor === ancestor) return true;
  }
  return false;
}

function paintsLater(
  candidate: PseudoBackdropSnapshotNode,
  target: PseudoBackdropSnapshotNode,
): boolean {
  if (candidate.paintOrder == null || target.paintOrder == null) return false;
  if (candidate.paintOrder !== target.paintOrder) return candidate.paintOrder > target.paintOrder;
  return candidate.layoutOrder != null && target.layoutOrder != null
    && candidate.layoutOrder > target.layoutOrder;
}

/**
 * Plan one pseudo-local isolation from immutable DOMSnapshot facts.
 *
 * Only element/pseudo nodes are returned. Text rows are suppressed through
 * their later element owner or through the target pseudo's temporary
 * transparent paint rule, never by mutating anonymous text protocol nodes.
 */
export function planPseudoBackdropIsolation(
  nodes: readonly PseudoBackdropSnapshotNode[],
  targetBackendNodeId: number,
): PseudoBackdropIsolationPlan | null {
  const targetIndex = nodes.findIndex((node) => node.backendNodeId === targetBackendNodeId);
  if (targetIndex < 0) return null;
  const target = nodes[targetIndex];
  if (target.bounds == null || target.paintOrder == null) return null;

  const hideIndexes: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (index === targetIndex || node.nodeType !== 1 || node.bounds == null) continue;
    if (!paintsLater(node, target) || !overlaps(node.bounds, target.bounds)) continue;
    if (isAncestor(nodes, index, targetIndex) || isAncestor(nodes, targetIndex, index)) continue;

    // Snapshot order is parent-before-child. Once a later ancestor is hidden,
    // resolving its descendants only creates restoration risk and no new
    // isolation value.
    if (hideIndexes.some((ancestor) => isAncestor(nodes, ancestor, index))) continue;
    hideIndexes.push(index);
  }

  return {
    targetBackendNodeId,
    hideBackendNodeIds: hideIndexes.map((index) => nodes[index].backendNodeId),
  };
}
