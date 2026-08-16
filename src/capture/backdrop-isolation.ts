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
export function planBackdropIsolation(nodes: SnapshotNode[], token: string): IsolationPlan | null {
  const target = nodes.findIndex((node) => hasToken(node, token));
  if (target < 0) return null;
  const targetNode = nodes[target];
  if (targetNode.bounds == null || targetNode.paintOrder == null) return null;
  const hide: number[] = [];
  // The renderer keeps descendants as vector content above the captured
  // filtered surface. Hide each top-level descendant subtree while taking the
  // crop so its pixels are not baked into the backdrop image as well.
  for (let i = 0; i < nodes.length; i++) {
    if (i === target || !isAncestor(nodes, target, i)) continue;
    const parent = nodes[i]?.parentIndex ?? -1;
    if (parent === target) hide.push(nodes[i].backendNodeId);
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
