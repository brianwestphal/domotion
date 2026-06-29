import type { CapturedElement } from "../capture/types.js";

/**
 * Pre-order depth-first walk over a captured forest, visiting every element
 * (each node before its descendants). DM-1434 — replaces the several hand-rolled
 * `const walk = (els) => { for (const el of els) { …; if (el.children.length) walk(el.children); } }`
 * closures across the capture passes with one helper and one consistent child
 * guard (`children` is always an array, so no `!= null` check is needed).
 *
 * Visits nodes only — for a walk that must thread a derived per-node context
 * (e.g. a CSS-selector path) down to children, keep a bespoke recursion.
 */
export function forEachElement(
  forest: CapturedElement[],
  visit: (el: CapturedElement) => void,
): void {
  for (const el of forest) {
    visit(el);
    if (el.children.length > 0) forEachElement(el.children, visit);
  }
}
