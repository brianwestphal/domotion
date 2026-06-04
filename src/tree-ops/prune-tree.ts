import type { CapturedElement } from "../capture/types.js";

/**
 * Shallow-copy a captured-element forest with selected subtrees pruned, while
 * preserving referential identity for every untouched branch. `shouldDrop(node,
 * path)` decides per node (path is the index trail from each root); a dropped
 * node — with its whole subtree — is reported to `onDrop` before removal.
 *
 * The identity preservation is the point: a level whose children all come back
 * unchanged returns the SAME array reference, so an unmodified tree round-trips
 * to itself and ancestors can cheaply skip copying. Both scroll hoisters reuse
 * this — `hoist-fixed` drops `position: fixed` nodes (collecting them via
 * `onDrop`), `hoist-sticky` drops a precomputed set of paths.
 */
export function mapTreePruning(
  forest: CapturedElement[],
  shouldDrop: (node: CapturedElement, path: number[]) => boolean,
  onDrop?: (node: CapturedElement, path: number[]) => void,
): CapturedElement[] {
  function recur(list: CapturedElement[], parentPath: number[]): CapturedElement[] {
    const out: CapturedElement[] = [];
    for (let i = 0; i < list.length; i++) {
      const path = parentPath.concat(i);
      const node = list[i];
      if (shouldDrop(node, path)) {
        onDrop?.(node, path);
        continue;
      }
      if (node.children != null && node.children.length > 0) {
        const newKids = recur(node.children, path);
        if (newKids !== node.children) {
          // A descendant was pruned — emit a shallow copy so the caller's
          // tree isn't mutated, keeping the rest of this node intact.
          out.push({ ...node, children: newKids });
          continue;
        }
      }
      out.push(node);
    }
    // Nothing changed at this level → hand back the original array reference.
    if (out.length === list.length && out.every((n, i) => n === list[i])) return list;
    return out;
  }
  return recur(forest, []);
}
