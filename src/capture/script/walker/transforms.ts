// @ts-nocheck
//
// CSS transform freeze/restore handling.
//
// For elements with a non-`none` CSS transform, `getBoundingClientRect`
// (and per-char Range rects, child rects, etc.) all return *post-transform*
// viewport coordinates. Re-applying our own transform on top would
// double-rotate. So when transform != none, we clear the inline transform
// for the entire capture of this element (children + per-char text rects
// included), then restore at the end. CSS transforms don't participate in
// layout, so this doesn't reflow the document. The renderer applies the
// saved transform back via an SVG group wrapper. See SK-1134.
//
// CSSStyleDeclaration is LIVE — snapshot the original transform value
// BEFORE clearing or the captured tree would record transform: 'none' and
// the renderer would skip emitting the SVG transform.
//
// DM-523: substitute the cleared transform with `translate(0)` rather than
// `none` so the element still establishes a containing block for any
// position:fixed descendants. Setting it to `none` would let those
// descendants escape to the viewport (the .pin in the
// 13-deep-fixed-in-transform fixture pinned to viewport bottom-right
// instead of staying trapped in the .frame). Per CSS Transforms 2, any
// non-none transform value creates a CB; a no-op `translate(0)` preserves
// the CB while ensuring getBoundingClientRect returns un-rotated /
// un-scaled coords identical to what `none` produced.
//
// `threadFrozenTransform` is the captureInner-side counterpart: it returns
// the transform / transformOrigin fields that go into the captured styles
// sub-object. When captureInner was called with a frozen value (i.e. the
// wrapper above stashed one), prefer that over the live `cs.transform`
// (which the wrapper has just rewritten to `translate(0)`).

// DM-587: previously this wrapper cleared `el.style.transform = 'translate(0)'`
// before reading the element's rect, then restored after. The idea was to
// capture rects in a "pre-transform" coord space so the renderer could re-
// apply the original transform via an SVG `<g transform=...>` wrapper and
// recover the live painted position. That assumed `cleared_rect + reapplied_
// transform = live_rect` — true for pure-translation transforms on an
// unscaled chain, but false whenever a scale/rotate/skew appears anywhere in
// the ancestor chain: clearing a scale swaps the element's bbox from scaled
// to layout-box size, and CSS percentage-based or auto-positioning of
// descendants (`top: 80%`, flex space distribution, etc.) snaps to the new
// bbox — producing a captured rect that no longer round-trips through the
// captured transforms. Empirically: stripe.com Payment Element's Affirm row
// rendered at y≈1081 vs Chrome's 1127 = 46 px off per descendant.
//
// New model — closer to how Chrome itself works: layout is independent of
// transforms, and transforms are a paint-time effect applied to laid-out
// boxes. We capture every rect at its LIVE post-transform viewport position
// (which IS Chrome's painted position), and mark every element's captured
// `styles.transform` as `'none'` so the renderer doesn't wrap with a
// duplicate transform `<g>`. The renderer's existing transform composition
// code is a no-op for `transform: none`, so the rect emits at its captured
// (=live) position directly.
//
// Trade-off: text/glyph rendering inside a scaled ancestor uses the
// captured `font-size` (CSS px, unscaled) painted into a captured rect that
// IS scaled. For pure scale-down ancestors (most common case — Stripe's
// 0.69x, framer's 0.8x) text may visibly overflow its captured cell. The
// existing visual-regression suite accepts a 3% diff threshold which absorbs
// modest text overshoot; if a future test fails specifically on scaled-
// container text size, capturing a scaled effective `font-size` is the
// follow-up. Rotations/skews on ancestors are also unhandled — descendants
// paint axis-aligned at the AABB rather than rotated, which would visibly
// break any rotated-container fixture. None exist in the current real-world
// suite or the feature suite (`inline-svg-use-symbol-animated` rotates an
// SVG `<rect>`, not an HTML element).
export const createTransformsHandler = () => {
  const wrapWithFrozenTransform = (el, cs, captureInner) => {
    // DM-587: for elements with a transform, DO NOT clear (no more
    // `translate(0)` substitution). Read the element's rect as Chrome
    // currently paints it. Thread the original transform string through so
    // threadFrozenTransform can flag transform-induced stacking-context
    // creation; the rect itself is already in live viewport coords, so the
    // renderer must not wrap with a duplicate transform `<g>` — we
    // accomplish that by always recording `styles.transform = 'none'` (see
    // threadFrozenTransform below), but the SC bit is preserved via a
    // separate flag.
    const originalTransform = cs.transform;
    const hasTransform = originalTransform && originalTransform !== 'none';
    return captureInner(el, cs, hasTransform ? originalTransform : null, hasTransform ? cs.transformOrigin : null);
  };

  const threadFrozenTransform = (cs, frozenTransform, _frozenTransformOrigin) => ({
    // DM-587: always record `transform: 'none'`. Captured rects are now in
    // live viewport coords (the live transforms were never cleared during
    // capture), so the renderer must not wrap with another transform `<g>`.
    // cssTransformToSvg returns "" for "none", so the renderer skips the
    // wrap.
    transform: 'none',
    transformOrigin: cs.transformOrigin,
    // DM-587: separately flag elements that ORIGINALLY had a non-none
    // transform — even though we discard the value to suppress the wrap,
    // CSS Transforms 2 §4 says any non-none transform creates a stacking
    // context, and `establishesStackingContext` needs to know that for
    // z-index ordering (e.g. a `transform: translate(0)` on a positioned
    // element creates an SC that traps its descendants' z-index resolution).
    // `frozenTransform != null` is true exactly when the live cs.transform
    // was non-none at capture time.
    transformCreatesSc: frozenTransform != null,
  });

  return { wrapWithFrozenTransform, threadFrozenTransform };
};
