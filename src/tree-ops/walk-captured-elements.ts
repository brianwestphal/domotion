import type { CapturedElement } from "../capture/types.js";

/** Visit captured elements in document preorder, including every nested child. */
export function walkCapturedElements(
  tree: readonly CapturedElement[],
  visit: (element: CapturedElement) => void,
): void {
  for (const element of tree) {
    visit(element);
    if (element.children.length > 0) walkCapturedElements(element.children, visit);
  }
}
