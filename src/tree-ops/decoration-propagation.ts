import type { CapturedElement, PropagatedDecoration } from "../capture/types.js";

/**
 * DM-1723/DM-1725: propagate `text-decoration` from decorating boxes to their
 * in-flow descendants.
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
 * DM-1725: decorations ACCUMULATE down the ancestor chain, mirroring Blink's
 * `ComputedStyle::AppliedTextDecorations` — each decorating ancestor
 * contributes an independent entry with its own line/style/color/thickness:
 * `<u><span style="text-decoration: overline">x</span></u>` paints BOTH
 * lines over "x", and a child with its own `line-through` inside an
 * underlined parent paints both. So the annotation is an ARRAY
 * (outermost-first, Blink's applied order), and elements with their own
 * decoration still receive their ancestors' entries (the renderer emits the
 * ancestors' lines plus the element's own from its styles).
 *
 * Propagation stops at boxes that are not in-flow content of the decorating
 * box (CSS Text Decoration 3 §2): out-of-flow descendants (`position:
 * absolute` / `fixed`), floats, and atomic inline-level boxes
 * (`inline-block` / `inline-table` / `inline-flex` / `inline-grid`). Those
 * elements neither receive the ancestors' decorations nor forward them to
 * their own descendants (a decorating blocked element still starts a NEW
 * chain for its own subtree).
 *
 * Each entry carries the decorating box's decoration properties
 * (line/style/color/thickness/offset) AND its font: Blink positions the
 * decoration and derives auto thickness from the DECORATING box's used font
 * (`text_decoration_info.cc`: `decoration.used_font =
 * decorating_box->GetUsedFont()`), not the decorated text's own font.
 * `text-decoration-color: currentcolor` resolves against the decorating
 * element's `color`, so it is resolved here at entry-build time.
 *
 * Wavy phase note: Chrome anchors the wavy pattern at each painted
 * fragment's own origin (`decoration_line_painter.cc` builds the wave from
 * `geometry.line.origin()`, which is the fragment's local origin) — verified
 * empirically on the mixed-weights fixture row by measuring wave-peak x
 * positions: each fragment's peaks restart relative to the fragment's own
 * start, not the decorating box's. The renderer's existing per-segment
 * `segX` anchoring already matches, so this pass carries no phase anchor.
 *
 * Known simplification: a `vertical-align`-shifted child (sub/sup) paints
 * the propagated decorations at its own shifted baseline rather than the
 * decorating box's line position (Blink's `offset_from_decorating_box`);
 * `vertical-align` isn't captured today, so that correction needs a
 * capture-side field first — tracked separately.
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

function walk(el: CapturedElement, ctx: PropagatedDecoration[] | null): void {
  const s = el.styles;
  delete el.propagatedDecorations; // idempotence: clear stale annotations
  let next = ctx;
  if (s != null) {
    // Out-of-flow / floated / atomic-inline boxes neither receive nor
    // forward ancestor decorations.
    const outOfFlow = s.position === "absolute" || s.position === "fixed";
    const floated = s.float != null && s.float !== "none";
    const atomicInline = s.display != null && ATOMIC_INLINE_DISPLAYS.has(s.display);
    if (outOfFlow || floated || atomicInline) next = null;

    // DM-1725: every text-bearing element under one or more decorating
    // ancestors gets the accumulated entry list — including elements that
    // carry their OWN decoration (Blink paints both; the renderer emits the
    // element's own decoration from its styles on top of these).
    if (next != null && next.length > 0 && (el.text !== "" || el.textSegments != null)) {
      el.propagatedDecorations = next;
    }

    if (hasDecoration(s.textDecorationLine)) {
      // This element is a decorating box — append its entry for descendants
      // (outermost-first accumulation, matching Blink's applied order).
      // DM-1732: record the decorating element's OWN text baselines so a
      // vertical-align-shifted child can anchor the inherited line at the
      // ancestor's position (Blink's offset_from_decorating_box) instead of
      // its own shifted baseline.
      const ascent = el.fontAscent ?? (parseFloat(s.fontSize) || 14);
      let baselines: number[] | undefined;
      if (el.textSegments != null && el.textSegments.length > 0) {
        baselines = [...new Set(el.textSegments.map((seg) => Math.round(seg.y + (seg.fontAscent ?? ascent))))];
      } else if (el.textTop != null && el.text !== "") {
        baselines = [Math.round(el.textTop + ascent)];
      }
      next = [...(next ?? []), {
        baselines,
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
      }];
    }
  }
  if (el.children != null) {
    for (const child of el.children) walk(child, next);
  }
}
