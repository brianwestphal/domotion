import type { CapturedElement } from "../capture/types.js";

/**
 * Capture-contract predicate for the checkbox/radio indicator tests (doc 11).
 *
 * Modern capture explicitly records the generated-pseudo ownership decision,
 * including an empty array when no indicator paints. For a structural
 * `appearance: none` / `base` checkable that fact is authoritative: the
 * `::checkmark`, `::before` or `::after` record paints through the pseudo
 * pipeline. The renderer never branches on this (it synthesizes no indicator
 * for any structural checkable), so it lives with the tests that pin the
 * capture contract rather than in shipped code. `pseudoFragments ===
 * undefined` alone marks a tree serialized before that contract.
 */
export function checkablePseudoFactsOwnIndicator(el: CapturedElement): boolean {
  const appearance = el.styles.effectiveAppearance ?? el.styles.inputAppearance;
  return (appearance === "none" || appearance === "base") && Array.isArray(el.pseudoFragments);
}
