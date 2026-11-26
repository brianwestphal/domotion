/** Structural subset of Chromium's pierced DOM.Node tree used for ownership. */
export interface PiercedNode {
  backendNodeId: number;
  nodeId?: number;
  frameId?: string;
  shadowRootType?: string;
  shadowRoots?: PiercedNode[];
  children?: PiercedNode[];
  pseudoElements?: PiercedNode[];
  contentDocument?: PiercedNode;
}

interface TreePosition {
  node: PiercedNode;
  document: PiercedNode;
  frameId?: string;
  shadow?: PiercedNode;
}

/** Visit each node in source order, preserving its actual document and the
 * nearest shadow tree. A same-process child document starts a new tree scope. */
export function visitPiercedNodes(
  root: PiercedNode,
  visit: (position: TreePosition) => void,
  options: { frameId?: string; includePseudoElements?: boolean } = {},
): void {
  const pending: TreePosition[] = [{ node: root, document: root, frameId: options.frameId }];
  while (pending.length > 0) {
    const position = pending.pop()!;
    const { node, document } = position;
    visit(position);
    if (node.contentDocument)
      pending.push({ node: node.contentDocument, document: node.contentDocument, frameId: node.frameId });
    if (options.includePseudoElements) {
      for (const pseudo of node.pseudoElements ?? [])
        pending.push({ node: pseudo, document, frameId: position.frameId, shadow: position.shadow });
    }
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--)
      pending.push({ node: node.children![i], document, frameId: position.frameId, shadow: position.shadow });
    for (let i = (node.shadowRoots?.length ?? 0) - 1; i >= 0; i--) {
      const shadow = node.shadowRoots![i];
      pending.push({ node: shadow, document, frameId: position.frameId, shadow });
    }
  }
}
