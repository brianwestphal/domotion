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
// That live-rect model is now limited to transforms a running animation or
// transition owns, and to projective planes owned by transformSubtreeRaster.
// Every other static planar transform (rotation, skew, translate, scale, an
// affine matrix3d) is frozen again: DM-WTSX24 measured that Blink paints box
// decorations at ToPixelSnappedRect(local paint rect) and only then applies
// the transform (Chromium 7d859f27, core/paint/box_painter_base.cc:1058), so a
// box at layout x=20.5 under translate(-0.5px) paints at 20.5 with
// anti-aliased edges, and a scale(1.5) scales its border and outline widths.
// Neither survives a post-transform viewport rect. Freezing records the local
// box and the renderer's <g transform> reproduces both. Transforms do not feed
// layout and the freeze writes `translate(0)`, which keeps the containing
// block, so descendants keep their used positions; the stripe.com
// measurement above has not been re-run under this model. Node-side raster
// producers that run after the walk must work in the same space: see
// src/capture/raster-viewport-space.ts and
// src/capture/frozen-transform-neutralizer.ts.
//
// Detect whether a CSS computed `transform` matrix string contains rotation or
// skew components. Pure-translate / pure-scale matrices have b=c=0 in the 2D
// form `matrix(a, b, c, d, e, f)`; rotation/skew produces non-zero b or c.
// matrix3d (12 values for the 4×4 matrix major-column layout) carries the
// 2D submatrix in positions 0, 1, 4, 5 (= a, b, c, d in 2D form).
export const transformHasRotationOrSkew = (transformStr: string | null | undefined): boolean => {
  if (!transformStr || transformStr === "none") return false;
  const m2 = /^matrix\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(transformStr);
  if (m2) {
    const b = parseFloat(m2[2]);
    const c = parseFloat(m2[3]);
    return Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6;
  }
  const m3 =
    /^matrix3d\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*[-\d.eE]+\s*,\s*[-\d.eE]+\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(
      transformStr,
    );
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

// DM-WTSX24: every planar affine transform is captured untransformed and
// re-applied by the renderer's SVG wrapper. Blink snaps box paint in the
// box's local transform space before applying the transform
// (ToPixelSnappedRect on the local paint offset), so a live post-transform
// rect, snapped in viewport space, loses fractional translation and stroke
// scaling. matrix() is always planar affine. A matrix3d is when its z column
// and row are identity: no perspective, no rotateX/Y and no translateZ. Under
// an ancestor's perspective a translateZ projects and resizes the box. Anything
// else stays on the live or projective owner path.
export const transformWrapsAsAffine2D = (transformStr: string | null | undefined): boolean => {
  if (!transformStr || transformStr === "none") return false;
  if (transformHasRotationOrSkew(transformStr)) return true;
  if (/^matrix\(/.test(transformStr)) return true;
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(transformStr);
  if (m3 == null) return false;
  const v = m3[1].split(",").map((part) => parseFloat(part));
  if (v.length !== 16 || v.some((n) => !Number.isFinite(n))) return false;
  const near = (n: number, target: number) => Math.abs(n - target) < 1e-6;
  return (
    near(v[2], 0) &&
    near(v[3], 0) &&
    near(v[6], 0) &&
    near(v[7], 0) &&
    near(v[8], 0) &&
    near(v[9], 0) &&
    near(v[10], 1) &&
    near(v[11], 0) &&
    near(v[14], 0) &&
    near(v[15], 1)
  );
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
//
// The computed `translate` keeps percentages (CSS Transforms 2 §5.1: they
// resolve against the reference box, the border box for HTML), so a
// `translate: -50% 8px` cannot be read with parseFloat. `refBox` is that box;
// without it a percentage resolves against zero.
export const transformReferenceBox = (cs: CSSStyleDeclaration): { width: number; height: number } => {
  const px = (value: string) => parseFloat(value) || 0;
  let width = px(cs.width);
  let height = px(cs.height);
  if (cs.boxSizing !== "border-box") {
    width += px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    height += px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  }
  return { width, height };
};

// Resolve one computed `translate` component: a length, a percentage of
// `reference`, or a calc() sum of the two.
export const resolveTranslateComponent = (token: string, reference: number): number => {
  const calc = /^calc\((.*)\)$/.exec(token.trim());
  const terms = calc == null ? token.trim() : calc[1].replace(/\s+/g, "");
  let total = 0;
  let matched = false;
  const termPattern = /([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|%)?/gi;
  for (let term = termPattern.exec(terms); term != null; term = termPattern.exec(terms)) {
    if (term[0] === "") break;
    matched = true;
    const value = parseFloat(term[1]);
    total += term[2] === "%" ? (value * reference) / 100 : value;
  }
  return matched && isFinite(total) ? total : 0;
};

export const composeEffectiveTransform = (
  cs: CSSStyleDeclaration,
  refBox: { width: number; height: number } = { width: 0, height: 0 },
): string => {
  const t = cs.translate;
  const r = cs.rotate;
  const s = cs.scale;
  const tr = cs.transform;
  const hasT = t && t !== "none";
  const hasR = r && r !== "none";
  const hasS = s && s !== "none";
  const hasTr = tr && tr !== "none";
  if (!hasT && !hasR && !hasS && !hasTr) return "none";
  if (!hasT && !hasR && !hasS) return tr;
  // Build the composed matrix via DOMMatrix in spec order. DOMMatrix
  // multiplications are LEFT to RIGHT post-multiply (each multiplySelf
  // applies AFTER prior ops in the local coord system), so we apply
  // translate first, then rotate, scale, transform — matching CSS T2 §3.
  let m = new DOMMatrix();
  if (hasT) {
    // cs.translate is "<x> [<y>] [<z>]": lengths, percentages of the
    // reference box, or calc() of both. Split on spaces outside parentheses.
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of t.trim()) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) {
        if (current !== "") parts.push(current);
        current = "";
      } else current += ch;
    }
    if (current !== "") parts.push(current);
    const tx = parts.length > 0 ? resolveTranslateComponent(parts[0], refBox.width) : 0;
    const ty = parts.length > 1 ? resolveTranslateComponent(parts[1], refBox.height) : 0;
    const tz = parts.length > 2 ? resolveTranslateComponent(parts[2], 0) : 0;
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
    const ts = s
      .trim()
      .split(/\s+/)
      .map((v: string) => parseFloat(v));
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

export const parseAngleToDeg = (a: string): number => {
  const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)(deg|rad|grad|turn)?$/.exec(a);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2] || "deg";
  if (u === "deg") return n;
  if (u === "rad") return (n * 180) / Math.PI;
  if (u === "grad") return (n * 360) / 400;
  if (u === "turn") return n * 360;
  return n;
};

// A running CSS animation or transition on the element's own transform
// outranks the inline freeze in the cascade, and overriding it would mean
// cancelling it. Such an element keeps the live-rect model, which reads the
// animated rect exactly. Element.getAnimations() lists both CSS animations and
// CSS transitions; their keyframes name the animated longhands.
//
// A declared transition covering a transform property is equally disqualifying.
// The freeze's own inline write would start a transition, so the box would not
// reach its untransformed position and transition events would fire on the
// page. A transition starts when its combined duration, duration + max(delay,
// 0), is positive (CSS Transitions §3).
export const TRANSFORM_PROPERTIES = ["transform", "translate", "rotate", "scale"];
export const transitionCoversTransform = (cs: CSSStyleDeclaration): boolean => {
  const properties = (cs.transitionProperty || "").split(",").map((part) => part.trim());
  const durations = (cs.transitionDuration || "0s").split(",").map((part) => parseFloat(part) || 0);
  const delays = (cs.transitionDelay || "0s").split(",").map((part) => parseFloat(part) || 0);
  return properties.some((property, index) => {
    if (property !== "all" && TRANSFORM_PROPERTIES.indexOf(property) < 0) return false;
    const duration = durations[index % durations.length];
    const delay = delays[index % delays.length];
    return duration + Math.max(delay, 0) > 0;
  });
};
export const transformIsAnimated = (el: Element, cs: CSSStyleDeclaration): boolean => {
  if (transitionCoversTransform(cs)) return true;
  if (typeof el.getAnimations !== "function") return false;
  for (const animation of el.getAnimations()) {
    if (animation.playState === "finished" || animation.playState === "idle") continue;
    const effect = animation.effect as KeyframeEffect | null;
    if (effect == null || typeof effect.getKeyframes !== "function") continue;
    for (const frame of effect.getKeyframes()) {
      for (const property of TRANSFORM_PROPERTIES) if (property in frame) return true;
    }
  }
  return false;
};

// The single freeze decision, shared by the walk and by the Node-side passes
// that must neutralize exactly the transforms the renderer re-applies
// (`src/capture/frozen-transform-neutralizer.ts` ships these functions' source
// into the page). Rotation and skew always freeze. Every other planar affine
// transform (translate, scale, an affine matrix3d without translateZ) freezes
// unless a running animation or transition owns it: Blink snaps box paint in
// local space before applying the transform (`ToPixelSnappedRect` on the local
// paint rect, Chromium 7d859f27 core/paint/box_painter_base.cc:1058), which only
// the untransformed box plus the renderer's wrapper reproduces. A projective
// matrix3d stays live; transformSubtreeRaster owns it (DM-2380).
export const transformFreezes = (el: Element, cs: CSSStyleDeclaration): boolean => {
  const effective = composeEffectiveTransform(cs);
  if (!effective || effective === "none") return false;
  return (
    transformHasRotationOrSkew(effective) ||
    (transformWrapsAsAffine2D(effective) && !transformIsAnimated(el, cs)) ||
    /\brotate\b/.test(effective) ||
    /\bskew/.test(effective)
  );
};

// Elements whose transform is frozen for the duration of their subtree's
// capture, mapped to the original effective transform. While frozen, their
// computed transform reads as identity, so readers that must know what the
// renderer re-applies (the border paint snap authority) consult this map.
export const frozenTransformOwners = new WeakMap<Element, string>();

export const createTransformsHandler = () => {
  // Computed styles of elements whose planar transform stayed live (animated),
  // so threadFrozenTransform records `none` for them.
  const liveTransformStyles = new WeakSet<CSSStyleDeclaration>();
  const wrapWithFrozenTransform = <T>(
    el: HTMLElement,
    cs: CSSStyleDeclaration,
    captureInner: (
      el: HTMLElement,
      cs: CSSStyleDeclaration,
      frozenTransform: string | null,
      frozenTransformOrigin: string | null,
    ) => T,
  ): T => {
    // transformFreezes decides between the freeze-then-restore model (the
    // captured rect is the untransformed layout box and the renderer
    // re-applies the transform via an SVG `<g transform=...>` wrapper) and
    // the live-rect model (animated or projective transforms only).
    //
    // DM-943: compose the effective transform from `transform` PLUS the
    // CSS Transforms Level 2 standalone `translate` / `rotate` / `scale`
    // properties — Chrome keeps them separate in computed style and our
    // capture used to only read `cs.transform`, so a `rotate: 20deg` (no
    // `transform:` prefix) produced cs.transform === 'none' and rendered
    // the box axis-aligned. The composed string flows through the same
    // freeze logic as a plain `transform:` of the same shape.
    const originalTransform = composeEffectiveTransform(cs, transformReferenceBox(cs));
    const hasTransform = originalTransform && originalTransform !== "none";
    if (!hasTransform) {
      return captureInner(el, cs, null, null);
    }
    const needsFreeze = transformFreezes(el, cs);
    if (needsFreeze) {
      // Clear so getBoundingClientRect returns the untransformed layout box;
      // the renderer re-applies the original transform.
      const inlineTransform = el.style.transform;
      const inlineRotate = el.style.rotate;
      const inlineScale = el.style.scale;
      const inlineTranslate = el.style.translate;
      el.style.transform = "translate(0)";
      el.style.rotate = "none";
      el.style.scale = "none";
      el.style.translate = "none";
      frozenTransformOwners.set(el, originalTransform);
      try {
        return captureInner(el, cs, originalTransform, cs.transformOrigin);
      } finally {
        frozenTransformOwners.delete(el);
        el.style.transform = inlineTransform;
        el.style.rotate = inlineRotate;
        el.style.scale = inlineScale;
        el.style.translate = inlineTranslate;
      }
    }
    // An animated planar transform, or a projective one owned by the
    // transform-subtree raster: keep the live-rect model (no clear, no wrap).
    liveTransformStyles.add(cs);
    return captureInner(el, cs, originalTransform, cs.transformOrigin);
  };

  const threadFrozenTransform = (
    cs: CSSStyleDeclaration,
    frozenTransform: string | null | undefined,
    _frozenTransformOrigin: string | null | undefined,
  ) => ({
    // For elements with rotation/skew, record the ORIGINAL transform so the
    // renderer wraps a `<g transform=...>` around the (un-rotated) captured
    // rect. For pure translate/scale (or no transform), record `'none'` so
    // the renderer skips the wrap and paints the rect at its captured (=live)
    // position directly. frozenTransform is non-null whenever the element
    // originally had a non-none transform; we only stash the rotation/skew
    // string back into styles.transform.
    transform:
      frozenTransform != null && !liveTransformStyles.has(cs) && transformWrapsAsAffine2D(frozenTransform)
        ? frozenTransform
        : "none",
    transformOrigin: cs.transformOrigin,
    // DM-751: extract `matrix3d` translateZ so the paint-order sort can
    // honor 3D Z position when the parent element has
    // `transform-style: preserve-3d` (which sorts children by Z in 3D
    // space, not by z-index per CSS Transforms 2 §6). We can't represent
    // perspective / actual 3D rendering in SVG; this is paint-order only.
    translateZ: (function () {
      const tt = cs.transform;
      if (tt == null || tt === "none" || tt === "") return undefined;
      const m3 = /^matrix3d\(([^)]+)\)/.exec(tt);
      if (m3 == null) return undefined;
      const parts = m3[1].split(",").map((s) => parseFloat(s.trim()));
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
