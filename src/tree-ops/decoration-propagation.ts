import type { CapturedElement, PropagatedDecoration } from "../capture/types.js";

/**
 * DM-1723: propagate `text-decoration` from decorating boxes to their in-flow
 * descendants.
 *
 * CSS Text Decoration 3 §2: text decorations are NOT inherited properties —
 * they PROPAGATE from the element that specifies them (the "decorating box")
 * to all in-flow descendants. A `<strong>` inside `<span style="text-
 * decoration: underline wavy">` computes `text-decoration-line: none`, yet
 * Chrome paints the span's wavy line beneath the bold text. Because the
 * renderer emits decoration per captured element from that element's OWN
 * computed styles, the bold child previously dropped the line entirely
 * (visible in the 20-deep-wavy-underline-descenders fixture's mixed-weights
 * row: wave under the leading/trailing regular runs, nothing under the bold
 * middle).
 *
 * Propagation stops at boxes that are not in-flow content of the decorating
 * box (CSS Text Decoration 3 §2): out-of-flow descendants (`position:
 * absolute` / `fixed`), floats, and atomic inline-level boxes
 * (`inline-block` / `inline-table` / `inline-flex` / `inline-grid`). Those
 * elements neither receive the ancestor's decoration nor forward it to their
 * own descendants.
 *
 * The propagated record carries the decorating box's decoration properties
 * (line/style/color/thickness/offset) AND its font: Blink positions the
 * decoration and derives auto thickness from the DECORATING box's used font
 * (`text_decoration_info.cc`: `decoration.used_font =
 * decorating_box->GetUsedFont()`), not the decorated text's own font.
 * `text-decoration-color: currentcolor` resolves against the decorating
 * element's `color`, so it is resolved here at context-build time.
 *
 * Wavy phase note: Chrome anchors the wavy pattern at each painted
 * fragment's own origin (`decoration_line_painter.cc` builds the wave from
 * `geometry.line.origin()`, which is the fragment's local origin) — verified
 * empirically on the mixed-weights fixture row by measuring wave-peak x
 * positions: each fragment's peaks restart relative to the fragment's own
 * start, not the decorating box's. The renderer's existing per-segment
 * `segX` anchoring already matches, so this pass carries no phase anchor.
 *
 * Known simplifications (matching current single-decoration data model):
 * - Blink ACCUMULATES applied decorations across the ancestor chain (parent
 *   underline + grandparent overline both paint). This pass records only the
 *   NEAREST decorating ancestor, and elements with their own decoration keep
 *   just their own.
 * - A `vertical-align`-shifted child (sub/sup) keeps the decoration at its
 *   own shifted baseline rather than the decorating box's line position.
 *
 * Idempotent: re-running clears and recomputes the annotations, so callers
 * may run it on every render of a shared tree.
 */
export function propagateTextDecorations(elements: CapturedElement[]): void {
  for (const el of elements) walk(el, null);
}

/** Atomic inline-level display values that block decoration propagation.
 *  Chrome's computed `display` uses the legacy single-keyword serialization
 *  for these (e.g. `inline-block`, never `inline flow-root`). */
const ATOMIC_INLINE_DISPLAYS = new Set([
  "inline-block",
  "inline-table",
  "inline-flex",
  "inline-grid",
]);

function hasDecoration(line: string | undefined): line is string {
  return line != null && line !== "" && line !== "none";
}

function walk(el: CapturedElement, ctx: PropagatedDecoration | null): void {
  const s = el.styles;
  delete el.propagatedDecoration; // idempotence: clear stale annotations
  let next = ctx;
  if (s != null) {
    // Out-of-flow / floated / atomic-inline boxes neither receive nor
    // forward ancestor decorations.
    const outOfFlow = s.position === "absolute" || s.position === "fixed";
    const floated = s.float != null && s.float !== "none";
    const atomicInline = s.display != null && ATOMIC_INLINE_DISPLAYS.has(s.display);
    if (outOfFlow || floated || atomicInline) next = null;

    if (hasDecoration(s.textDecorationLine)) {
      // This element is a decorating box — its decoration propagates to
      // in-flow descendants. (Nearest-ancestor-wins; see header note on the
      // unmodeled accumulation case.)
      next = {
        line: s.textDecorationLine,
        style: s.textDecorationStyle,
        color: (s.textDecorationColor != null && s.textDecorationColor !== "" && s.textDecorationColor !== "currentcolor")
          ? s.textDecorationColor
          : s.color,
        thickness: s.textDecorationThickness,
        underlineOffset: s.textUnderlineOffset,
        fontFamily: s.fontFamily,
        fontSize: parseFloat(s.fontSize) || 14,
        fontWeight: s.fontWeight,
        fontStyle: s.fontStyle,
      };
    } else if (next != null && (el.text !== "" || el.textSegments != null)) {
      el.propagatedDecoration = next;
    }
  }
  if (el.children != null) {
    for (const child of el.children) walk(child, next);
  }
}
