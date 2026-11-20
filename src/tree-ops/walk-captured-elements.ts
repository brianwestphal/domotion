import type { CapturedElement } from "../capture/types.js";

/**
 * Visit captured elements in document preorder, including every nested child.
 * The document canvas background record (`documentCanvasBackground`, a
 * child-less record on the tree's first element) is visited right after its
 * host so resource passes — URL embedding, conic / advanced-gradient rasters —
 * also resolve the canvas layers.
 */
export function walkCapturedElements(
  tree: readonly CapturedElement[],
  visit: (element: CapturedElement) => void,
): void {
  for (const element of tree) {
    visit(element);
    if (element.documentCanvasBackground != null) visit(element.documentCanvasBackground);
    if (element.children.length > 0) walkCapturedElements(element.children, visit);
  }
}
