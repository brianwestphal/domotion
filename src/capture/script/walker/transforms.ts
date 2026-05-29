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
// Detect whether a CSS computed `transform` matrix string contains rotation or
// skew components. Pure-translate / pure-scale matrices have b=c=0 in the 2D
// form `matrix(a, b, c, d, e, f)`; rotation/skew produces non-zero b or c.
// matrix3d (12 values for the 4×4 matrix major-column layout) carries the
// 2D submatrix in positions 0, 1, 4, 5 (= a, b, c, d in 2D form).
const transformHasRotationOrSkew = (transformStr) => {
  if (!transformStr || transformStr === 'none') return false;
  const m2 = /^matrix\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(transformStr);
  if (m2) {
    const b = parseFloat(m2[2]);
    const c = parseFloat(m2[3]);
    return Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6;
  }
  const m3 = /^matrix3d\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*[-\d.eE]+\s*,\s*[-\d.eE]+\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(transformStr);
  if (m3) {
    const b = parseFloat(m3[2]);
    const c = parseFloat(m3[3]);
    return Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6;
  }
  // DM-943: composed-effective-transform strings from CSS Transforms 2
  // standalone properties may carry plain function forms like
  // `rotate(20deg)` or `skewX(30deg)` instead of a resolved matrix(). The
  // freeze path passes the un-resolved transform list through verbatim;
  // detect the function names so threadFrozenTransform stashes them too.
  if (/\brotate(?:[XYZ])?\(/.test(transformStr)) return true;
  if (/\bskew(?:[XY])?\(/.test(transformStr)) return true;
  return false;
};

// DM-943: CSS Transforms Level 2 introduced standalone `translate`,
// `rotate`, `scale` properties that compose with `transform` per spec
// order: translate → rotate → scale → transform. Chrome keeps them on
// SEPARATE computed-style entries (cs.rotate / cs.scale / cs.translate)
// — they do NOT merge into cs.transform. Compose them into a single
// CSS matrix() string in the page context via DOMMatrix so the existing
// renderer (which only parses matrix() / matrix3d()) picks them up
// unchanged. Returns 'none' when all four properties are absent /
// 'none', otherwise a `matrix(a, b, c, d, e, f)` string.
const composeEffectiveTransform = (cs) => {
  const t = cs.translate;
  const r = cs.rotate;
  const s = cs.scale;
  const tr = cs.transform;
  const hasT = t && t !== 'none';
  const hasR = r && r !== 'none';
  const hasS = s && s !== 'none';
  const hasTr = tr && tr !== 'none';
  if (!hasT && !hasR && !hasS && !hasTr) return 'none';
  if (!hasT && !hasR && !hasS) return tr;
  // Build the composed matrix via DOMMatrix in spec order. DOMMatrix
  // multiplications are LEFT to RIGHT post-multiply (each multiplySelf
  // applies AFTER prior ops in the local coord system), so we apply
  // translate first, then rotate, scale, transform — matching CSS T2 §3.
  let m = new DOMMatrix();
  if (hasT) {
    // cs.translate is "<x> [<y>] [<z>]" in px / computed length.
    const ts = t.split(/\s+/).map((v) => parseFloat(v));
    const tx = isFinite(ts[0]) ? ts[0] : 0;
    const ty = ts.length > 1 && isFinite(ts[1]) ? ts[1] : 0;
    const tz = ts.length > 2 && isFinite(ts[2]) ? ts[2] : 0;
    m = m.translate(tx, ty, tz);
  }
  if (hasR) {
    // cs.rotate is "<angle>" or "<x> <y> <z> <angle>" (3D axis form).
    // Parse all numeric tokens; the angle is the last one (with deg/rad/grad/turn unit).
    const tokens = r.trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    const angleDeg = parseAngleToDeg(last);
    if (tokens.length === 4) {
      const ax = parseFloat(tokens[0]);
      const ay = parseFloat(tokens[1]);
      const az = parseFloat(tokens[2]);
      m = m.rotateAxisAngle(ax, ay, az, angleDeg);
    } else {
      m = m.rotate(angleDeg);
    }
  }
  if (hasS) {
    const ts = s.trim().split(/\s+/).map((v) => parseFloat(v));
    const sx = isFinite(ts[0]) ? ts[0] : 1;
    const sy = ts.length > 1 && isFinite(ts[1]) ? ts[1] : sx;
    const sz = ts.length > 2 && isFinite(ts[2]) ? ts[2] : 1;
    m = m.scale(sx, sy, sz);
  }
  if (hasTr) {
    // tr is already a CSS matrix() / matrix3d() string (or rarely the
    // un-resolved form when inline style is read; getComputedStyle always
    // resolves to a matrix). DOMMatrix accepts both.
    try {
      m = m.multiply(new DOMMatrix(tr));
    } catch {
      // Unparseable — leave m as the standalone-property-only product.
    }
  }
  // Emit as 2D matrix() when the 3D parts are identity; else matrix3d().
  if (m.is2D) {
    return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
  }
  return `matrix3d(${m.m11}, ${m.m12}, ${m.m13}, ${m.m14}, ${m.m21}, ${m.m22}, ${m.m23}, ${m.m24}, ${m.m31}, ${m.m32}, ${m.m33}, ${m.m34}, ${m.m41}, ${m.m42}, ${m.m43}, ${m.m44})`;
};

const parseAngleToDeg = (a) => {
  const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)(deg|rad|grad|turn)?$/.exec(a);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2] || 'deg';
  if (u === 'deg') return n;
  if (u === 'rad') return (n * 180) / Math.PI;
  if (u === 'grad') return (n * 360) / 400;
  if (u === 'turn') return n * 360;
  return n;
};

export const createTransformsHandler = () => {
  const wrapWithFrozenTransform = (el, cs, captureInner) => {
    // DM-587: for pure translate/scale transforms, do NOT clear — read the
    // rect as Chrome currently paints it (the new live-rect model). For
    // transforms that include rotation or skew, fall back to the older
    // freeze-then-restore model so the captured rect represents the
    // un-rotated layout box and the renderer can re-apply the rotation via
    // an SVG `<g transform=...>` wrapper. Without this fallback, rotated
    // HTML elements would paint as their axis-aligned bounding boxes (and
    // overlap their neighbors) since `getBoundingClientRect` post-rotation
    // returns the rotated AABB, not the original 160×160 layout box.
    //
    // DM-943: compose the effective transform from `transform` PLUS the
    // CSS Transforms Level 2 standalone `translate` / `rotate` / `scale`
    // properties — Chrome keeps them separate in computed style and our
    // capture used to only read `cs.transform`, so a `rotate: 20deg` (no
    // `transform:` prefix) produced cs.transform === 'none' and rendered
    // the box axis-aligned. The composed string flows through the same
    // freeze logic as a plain `transform:` of the same shape.
    const originalTransform = composeEffectiveTransform(cs);
    const hasTransform = originalTransform && originalTransform !== 'none';
    if (!hasTransform) {
      return captureInner(el, cs, null, null);
    }
    // Heuristic: do we need to clear inlines to capture an un-rotated layout
    // box? Pure translate/scale leaves the layout box axis-aligned so we
    // keep the live-rect model. Anything containing a rotate(...) or skew
    // function — including the freshly composed string — needs the freeze.
    const needsFreeze =
      transformHasRotationOrSkew(originalTransform) ||
      /\brotate\b/.test(originalTransform) ||
      /\bskew/.test(originalTransform);
    if (needsFreeze) {
      // Old model: clear so getBoundingClientRect returns the un-rotated
      // layout box; renderer re-applies the original transform.
      const inlineTransform = el.style.transform;
      const inlineRotate = el.style.rotate;
      const inlineScale = el.style.scale;
      const inlineTranslate = el.style.translate;
      el.style.transform = 'translate(0)';
      el.style.rotate = 'none';
      el.style.scale = 'none';
      el.style.translate = 'none';
      try {
        return captureInner(el, cs, originalTransform, cs.transformOrigin);
      } finally {
        el.style.transform = inlineTransform;
        el.style.rotate = inlineRotate;
        el.style.scale = inlineScale;
        el.style.translate = inlineTranslate;
      }
    }
    // Pure translate/scale: keep new live-rect model (no clear, no wrap).
    return captureInner(el, cs, originalTransform, cs.transformOrigin);
  };

  const threadFrozenTransform = (cs, frozenTransform, _frozenTransformOrigin) => ({
    // For elements with rotation/skew, record the ORIGINAL transform so the
    // renderer wraps a `<g transform=...>` around the (un-rotated) captured
    // rect. For pure translate/scale (or no transform), record `'none'` so
    // the renderer skips the wrap and paints the rect at its captured (=live)
    // position directly. frozenTransform is non-null whenever the element
    // originally had a non-none transform; we only stash the rotation/skew
    // string back into styles.transform.
    transform: frozenTransform != null && transformHasRotationOrSkew(frozenTransform)
      ? frozenTransform
      : 'none',
    transformOrigin: cs.transformOrigin,
    // DM-751: extract `matrix3d` translateZ so the paint-order sort can
    // honor 3D Z position when the parent element has
    // `transform-style: preserve-3d` (which sorts children by Z in 3D
    // space, not by z-index per CSS Transforms 2 §6). We can't represent
    // perspective / actual 3D rendering in SVG; this is paint-order only.
    translateZ: (function () {
      const tt = cs.transform;
      if (tt == null || tt === 'none' || tt === '') return undefined;
      const m3 = /^matrix3d\(([^)]+)\)/.exec(tt);
      if (m3 == null) return undefined;
      const parts = m3[1].split(',').map((s) => parseFloat(s.trim()));
      const tz = parts[14];
      return Number.isFinite(tz) && tz !== 0 ? tz : undefined;
    })(),
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
