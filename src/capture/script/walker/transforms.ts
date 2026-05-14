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

export const createTransformsHandler = () => {
  const wrapWithFrozenTransform = (el, cs, captureInner) => {
    const originalTransform = cs.transform;
    const originalTransformOrigin = cs.transformOrigin;
    const hasTransform = originalTransform && originalTransform !== 'none';
    const savedInlineTransform = hasTransform ? el.style.transform : null;
    if (hasTransform) el.style.transform = 'translate(0)';
    const result = captureInner(el, cs, hasTransform ? originalTransform : null, hasTransform ? originalTransformOrigin : null);
    if (hasTransform) el.style.transform = savedInlineTransform;
    return result;
  };

  const threadFrozenTransform = (cs, frozenTransform, frozenTransformOrigin) => ({
    transform: frozenTransform != null ? frozenTransform : cs.transform,
    transformOrigin: frozenTransformOrigin != null ? frozenTransformOrigin : cs.transformOrigin,
  });

  return { wrapWithFrozenTransform, threadFrozenTransform };
};
