import { controlBoxMayPaintViewport } from "./effective-appearance-cdp.js";

export interface ControlPseudoViewportSnapshot {
  strings: readonly string[];
  documents: readonly {
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    nodes: {
      backendNodeId?: readonly number[];
      nodeType?: readonly number[];
      parentIndex?: readonly number[];
      attributes?: readonly (readonly number[])[];
    };
    layout: {
      nodeIndex: readonly number[];
      bounds: readonly (readonly number[])[];
      /** The single requested computed style is `transform`. */
      styles: readonly (readonly number[])[];
    };
  }[];
}

/**
 * Prove which top-frame hosts can lose their UA-shadow probes. A current
 * offscreen rect is insufficient for the subtrees the capture walker keeps
 * for transforms or post-capture animations (document-prepass.ts).
 */
export function offscreenControlPseudoHostIds(
  snapshot: ControlPseudoViewportSnapshot,
  viewport: { x: number; y: number; width: number; height: number },
  mainDocumentBackendId: number,
): ReadonlySet<number> {
  const result = new Set<number>();
  // Bind to the DOM agent's root instead of assuming document-array order.
  const main = snapshot.documents.find(
    (document) => document.nodes.backendNodeId?.[0] === mainDocumentBackendId && document.nodes.nodeType?.[0] === 9,
  );
  const backendIds = main?.nodes.backendNodeId;
  const parents = main?.nodes.parentIndex;
  const attributes = main?.nodes.attributes;
  if (
    main == null ||
    backendIds == null ||
    parents == null ||
    attributes == null ||
    !Number.isFinite(main.scrollOffsetX) ||
    !Number.isFinite(main.scrollOffsetY) ||
    ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return result;

  const layoutByNode = new Map(main.layout.nodeIndex.map((node, index) => [node, index]));
  const protectedNodes = new Map<number, boolean>();
  const retainedByAncestor = (node: number): boolean => {
    const path: number[] = [];
    const seen = new Set<number>();
    let retained = false;
    while (node !== -1) {
      if (!Number.isInteger(node) || node < 0 || node >= backendIds.length || seen.has(node)) {
        retained = true;
        break;
      }
      const known = protectedNodes.get(node);
      if (known != null) {
        retained = known;
        break;
      }
      path.push(node);
      seen.add(node);
      const attrs = attributes[node] ?? [];
      for (let index = 0; index + 1 < attrs.length; index += 2) {
        if (snapshot.strings[attrs[index]] === "data-domotion-anim" && snapshot.strings[attrs[index + 1]] !== "") {
          retained = true;
          break;
        }
      }
      if (retained) break;
      const layout = layoutByNode.get(node);
      // Chromium includes a LayoutView row for #document with no computed
      // styles. It is not an Element and cannot own a CSS transform.
      if (layout != null && main.nodes.nodeType?.[node] !== 9) {
        const transformIndex = main.layout.styles[layout]?.[0];
        const transform = transformIndex == null ? undefined : snapshot.strings[transformIndex];
        if (transform == null || (transform !== "none" && transform !== "")) {
          retained = true;
          break;
        }
      }
      const parent = parents[node];
      if (parent == null) {
        retained = true;
        break;
      }
      node = parent;
    }
    for (const entry of path) protectedNodes.set(entry, retained);
    return retained;
  };

  main.layout.nodeIndex.forEach((node, index) => {
    const backendId = backendIds[node];
    const bounds = main.layout.bounds[index];
    if (
      backendId != null &&
      bounds != null &&
      !retainedByAncestor(node) &&
      !controlBoxMayPaintViewport(bounds, main.scrollOffsetX!, main.scrollOffsetY!, viewport)
    )
      result.add(backendId);
  });
  return result;
}
