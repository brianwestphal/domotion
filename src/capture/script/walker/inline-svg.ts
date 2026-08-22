// @ts-nocheck
//
// DM-279 / DM-306 / DM-346 / DM-499 / DM-524 / DM-720 / DM-778: bake an inline
// <svg>'s resolved presentation + geometry attributes onto a clone and inline
// its <use> references, so the captured icon paints correctly when re-embedded
// outside the source page's CSS cascade. Returns the self-contained SVG
// outerHTML. Extracted verbatim from the index.ts orchestrator's
// `tag === 'svg'` branch (DM-1086); runs in-page, closes over nothing but the
// passed-in element (el), its computed style (cs), the warn() sink, and the
// element's short selector (sel) for warnings.

import {
  deriveSvgAffineFreeze,
  invertSvgAffine,
  multiplySvgAffine,
  serializeSvgAffine,
  svgAffineMaxPointError,
} from "../../svg-affine-freeze.js";

export const captureInlineSvg = (el, cs, warn, sel) => {
      // Inline SVG icons styled by external CSS (e.g. '.icon-btn svg { fill:none;
      // stroke: currentColor; stroke-width: 2 }') need their resolved presentation
      // attributes baked into the outerHTML so the icon paints correctly when
      // re-embedded outside the original cascade. Skip when the svg already
      // declared the attribute inline. DM-279.
      const svgFill = cs.fill;
      const svgStroke = cs.stroke;
      const svgStrokeWidth = cs.strokeWidth;
      const svgFontFamily = cs.fontFamily;
      const clone = el.cloneNode(true);
      // DM-2473: Blink resolves an SVG graphics child's complete transform into
      // LocalToSVGParentTransform and deliberately flattens it to affine before
      // paint. CTM correlation observes that used result without reproducing
      // transform-box, stroke bounds, z-origin, zoom, motion, or 3D math here.
      // A nested SVG retains intrinsic x/y + viewBox mapping after transforms
      // are neutralized, so its serialized owner is usedLocal * inverse(base).
      var _affineFreezeFailure = null;
      const _affineFreezeRecords = [];
      const _frozenByClone = new WeakMap();
      const _transformProperties = new Set([
        'transform', 'transform-origin', 'transform-box',
        'translate', 'rotate', 'scale',
        'offset', 'offset-path', 'offset-distance', 'offset-position',
        'offset-anchor', 'offset-rotate',
      ]);
      const _matrixFrom = (matrix) => matrix == null ? null : ({
        a: Number(matrix.a), b: Number(matrix.b),
        c: Number(matrix.c), d: Number(matrix.d),
        e: Number(matrix.e), f: Number(matrix.f),
      });
      const _nearestCtmParent = (node) => {
        var parent = node.parentElement;
        while (parent != null && typeof parent.getCTM !== 'function') parent = parent.parentElement;
        return parent;
      };
      const _hasTransformSignal = (node, style) => {
        if (node.hasAttribute && node.hasAttribute('transform')) return true;
        for (const prop of ['transform', 'translate', 'rotate', 'scale', 'offset-path']) {
          const value = style.getPropertyValue(prop).trim();
          if (value !== '' && value !== 'none') return true;
        }
        for (const child of node.children || []) {
          const name = (child.localName || '').toLowerCase();
          const attribute = (child.getAttribute && child.getAttribute('attributeName') || '').toLowerCase();
          if (name === 'animatemotion' || name === 'animatetransform'
              || (name === 'animate' || name === 'set') && attribute === 'transform') return true;
        }
        return false;
      };
      const _neutralizeProbeTransform = (probe) => {
        if (probe.style == null) return;
        probe.style.setProperty('transform', 'none', 'important');
        probe.style.setProperty('translate', 'none', 'important');
        probe.style.setProperty('rotate', 'none', 'important');
        probe.style.setProperty('scale', 'none', 'important');
        probe.style.setProperty('offset-path', 'none', 'important');
        probe.style.setProperty('animation', 'none', 'important');
        probe.style.setProperty('transition', 'none', 'important');
        probe.style.setProperty('visibility', 'hidden', 'important');
        probe.style.setProperty('opacity', '0', 'important');
        probe.style.setProperty('pointer-events', 'none', 'important');
      };
      const _cleanCloneTransformOwner = (node, serialized) => {
        node.setAttribute('transform', serialized);
        if (node.style != null) {
          for (const prop of _transformProperties) node.style.removeProperty(prop);
        }
      };
      const _freezeUsedAffine = (origNode, cloneNode, ocs) => {
        if (_affineFreezeFailure != null || !_hasTransformSignal(origNode, ocs)) return;
        if (typeof origNode.getCTM !== 'function') {
          _affineFreezeFailure = 'transformed SVG node does not expose getCTM()';
          return;
        }
        const parent = _nearestCtmParent(origNode);
        if (parent == null || typeof parent.getCTM !== 'function') {
          _affineFreezeFailure = 'transformed SVG node has no correlatable SVG parent CTM';
          return;
        }
        var usedCtm = null;
        var parentCtm = null;
        try {
          usedCtm = _matrixFrom(origNode.getCTM());
          parentCtm = _matrixFrom(parent.getCTM());
        } catch (e) {
          _affineFreezeFailure = 'Blink-used parent-relative affine matrix could not be read';
          return;
        }
        var probe = null;
        var neutralCtm = null;
        try {
          // A sibling probe asks Blink for the intrinsic mapping that remains
          // with transform contributors disabled. This is identity for normal
          // graphics and includes x/y + viewBox mapping for nested viewports.
          probe = cloneNode.cloneNode(false);
          _neutralizeProbeTransform(probe);
          if (probe.setAttribute) probe.setAttribute('aria-hidden', 'true');
          origNode.parentElement.appendChild(probe);
          neutralCtm = _matrixFrom(probe.getCTM && probe.getCTM());
        } catch (e) {
          neutralCtm = null;
        } finally {
          if (probe != null && probe.remove) probe.remove();
        }
        const freeze = usedCtm != null && parentCtm != null && neutralCtm != null
          ? deriveSvgAffineFreeze(usedCtm, parentCtm, neutralCtm)
          : null;
        const serialized = freeze == null ? null : serializeSvgAffine(freeze.frozen);
        if (freeze == null || serialized == null) {
          _affineFreezeFailure = 'Blink-used parent-relative affine matrix was unavailable or singular';
          return;
        }
        _cleanCloneTransformOwner(cloneNode, serialized);
        var points = [[0, 0], [1, 0], [0, 1]];
        try {
          const bbox = origNode.getBBox();
          if (bbox != null && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) {
            points = [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x, bbox.y + bbox.height], [bbox.x + bbox.width, bbox.y + bbox.height]];
          }
        } catch (e) { /* Unit-basis validation remains authoritative. */ }
        const record = { cloneNode, expected: freeze.usedLocal, frozen: freeze.frozen, points, serialized, skip: false };
        _affineFreezeRecords.push(record);
        _frozenByClone.set(cloneNode, record);
      };
      // DM-524: an attribute literal like fill="var(--hds-color-text-solid)"
      // (Stripe's nav rects) parses as a presentation-attribute value that
      // resolves only against the source page's custom-property cascade.
      // Outside that cascade — i.e. in our extracted SVG — the var is
      // unresolved and the rect paints with the SVG default black (or
      // currentColor), not the intended HDS palette color. Treat such
      // unresolved CSS-function values as "no concrete attribute" so we bake
      // the resolved computed value over them.
      const _unresolvedCssExprRe = /\b(?:var|calc|env|attr)\s*\(/;
      function _isUnresolvedCssExpr(v) {
        return v != null && _unresolvedCssExprRe.test(v);
      }
      function _hasConcreteAttr(node, attr) {
        return node.hasAttribute(attr) && !_isUnresolvedCssExpr(node.getAttribute(attr));
      }
      if (svgFill && svgFill !== '' && !_hasConcreteAttr(el, 'fill')) clone.setAttribute('fill', svgFill);
      if (svgStroke && svgStroke !== '' && svgStroke !== 'none' && !_hasConcreteAttr(el, 'stroke')) clone.setAttribute('stroke', svgStroke);
      if (svgStrokeWidth && svgStrokeWidth !== '' && !_hasConcreteAttr(el, 'stroke-width')) clone.setAttribute('stroke-width', svgStrokeWidth);
      // Bake the inherited font-family onto the root <svg> so any <text>
      // descendants without their own font-family inherit it when the SVG
      // is re-embedded outside the page's cascade. Without this, SVG <text>
      // defaults to "serif" (Times) and breaks pages whose body sets
      // sans-serif. DM-306.
      if (svgFontFamily && svgFontFamily !== '' && !el.hasAttribute('font-family')) {
        clone.setAttribute('font-family', svgFontFamily);
      }
      // Walk SVG descendants and bake each one's resolved presentation
      // attributes onto the cloned node. Without this, CSS-only styling such
      // as svg|rect { stroke: red } or *|circle { fill: green } (DM-346) is
      // lost when the SVG is re-embedded outside the original cascade —
      // computed style is resolved against the source DOM, not the clone.
      const _bakeSvgAttrs = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'opacity'];
      // DM-720: SVG 2 promotes geometry properties (cx/cy/r/rx/ry/x/y/width/
      // height/d) to CSS — modern Chrome resolves them from the cascade. When
      // a fixture sets them entirely from CSS (no XML attrs on the element),
      // the cloned subtree has no geometry and renders blank. Bake the
      // computed values onto the clone so the emitted SVG stands on its own.
      // We keep these in a separate list because (a) the per-tag applicability
      // varies (circles want cx/cy/r, rects want x/y/width/height + rx/ry,
      // paths want d) and (b) computed values need light normalisation
      // (strip "px"; unwrap path("…") for d) before they're valid as XML
      // presentation attributes.
      const _svgGeomAttrsByTag = {
        circle: ['cx', 'cy', 'r'],
        ellipse: ['cx', 'cy', 'rx', 'ry'],
        rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
        image: ['x', 'y', 'width', 'height'],
        foreignobject: ['x', 'y', 'width', 'height'],
        use: ['x', 'y', 'width', 'height'],
        svg: ['x', 'y', 'width', 'height'],
        path: ['d'],
      };
      // CSS effects are not presentation geometry carried by the cloned XML
      // unless authored inline. Preserve the computed declarations so the
      // output browser resolves SVG fill/stroke/view reference boxes natively.
      const _bakeSvgMaskProps = ['mask-image', 'mask-origin', 'mask-clip', 'mask-position', 'mask-size', 'mask-repeat', 'mask-composite', 'mask-mode'];
      const _walkBake = (origNode, cloneNode) => {
        if (origNode.nodeType !== 1) return;
        const ns = origNode.namespaceURI;
        if (ns === 'http://www.w3.org/2000/svg' && origNode !== el) {
          const ocs = window.getComputedStyle(origNode);
          // DM-778: detect whether the source's `fill` / `stroke` was driven
          // by `currentColor`. When the symbol is defined in a hidden <defs>
          // <svg> and the polygon/polyline's CSS rule is `fill:
          // currentColor` (or `stroke: currentColor`), getComputedStyle on
          // that node resolves the value against the DEFS's cascade —
          // typically the document body's color = black. If we baked that
          // black literal onto the clone, every <use> consumer would paint
          // the icon black regardless of its own host color. Probe by
          // temporarily flipping `style.color` on the source: if `fill` /
          // `stroke` follows, the value was driven by `currentColor` and we
          // should preserve the keyword so `_substCurrentColor` can resolve
          // it against the consumer's color later. Restore the source's
          // inline color so the live page state isn't disturbed.
          const _usesCurrentColor = (camel) => {
            const baseVal = ocs[camel];
            if (baseVal !== ocs.color) return false;
            const savedColor = origNode.style.color;
            origNode.style.color = "rgb(1, 2, 3)";
            const probeCs = window.getComputedStyle(origNode);
            const matches = probeCs[camel] === probeCs.color;
            origNode.style.color = savedColor;
            return matches;
          };
          for (const attr of _bakeSvgAttrs) {
            const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const val = ocs[camel];
            // DM-524: see _hasConcreteAttr comment above. Skip the bake only
            // when the source attr value is a concrete literal — var() /
            // calc() / env() / attr() references resolve against the source
            // cascade and lose their resolution outside it, so we replace
            // them with the resolved computed value.
            if (val != null && val !== '' && !_hasConcreteAttr(origNode, attr)) {
              // DM-778: preserve `currentColor` for `fill` / `stroke` when
              // the source rule uses it, so the consumer's color cascades
              // through the inlined symbol.
              const preserveCurrent = (attr === "fill" || attr === "stroke") && _usesCurrentColor(camel);
              cloneNode.setAttribute(attr, preserveCurrent ? "currentColor" : val);
            }
          }
          // DM-720 / DM-2414: bake CSS-driven geometry. A presentation
          // attribute participates at the bottom of the author cascade, so a
          // matching CSS declaration wins even when a concrete XML attribute
          // is present. Preserve an attribute-only value verbatim (including
          // its authored units), but replace it when the computed winner is
          // different. Restrict the probe to properties that apply to this
          // element; getComputedStyle exposes initial values for several
          // inapplicable SVG geometry properties too.
          const geomAttrs = _svgGeomAttrsByTag[(origNode.localName || '').toLowerCase()] || [];
          for (const gattr of geomAttrs) {
            // A retained SMIL <animate> child owns the animated value. Writing
            // its sampled animVal back as the base attribute changes the
            // animation's underlying value and can alter additive/from-to
            // behavior after re-embedding.
            let smilOwnsValue = false;
            for (const child of origNode.children) {
              if ((child.localName || '').toLowerCase() === 'animate' && child.getAttribute('attributeName') === gattr) {
                smilOwnsValue = true;
                break;
              }
            }
            if (smilOwnsValue) continue;
            let gval = ocs.getPropertyValue(gattr);
            if (gval == null) continue;
            gval = gval.trim();
            if (gval === '' || gval === 'auto' || gval === 'none' || gval === 'normal') continue;
            if (gattr === 'd') {
              // Computed `d` is wrapped as `path("M …")`. Unwrap to bare data.
              const m = /^path\(\s*(?:"([^"]*)"|'([^']*)')\s*\)$/.exec(gval);
              if (m) gval = m[1] != null ? m[1] : m[2];
              else continue; // not a recognized path() form
            } else if (/^-?\d+(?:\.\d+)?px$/.test(gval)) {
              gval = gval.slice(0, -2);
            }
            const sourceVal = origNode.getAttribute(gattr);
            if (sourceVal != null && !_isUnresolvedCssExpr(sourceVal) && sourceVal.trim() === gval) continue;
            cloneNode.setAttribute(gattr, gval);
          }
          const computedClipPath = ocs.getPropertyValue('clip-path').trim();
          if (computedClipPath !== '' && computedClipPath !== 'none') {
            cloneNode.style.setProperty('clip-path', computedClipPath);
          }
          const computedMaskImage = ocs.getPropertyValue('mask-image').trim();
          if (computedMaskImage !== '' && computedMaskImage !== 'none') {
            for (const prop of _bakeSvgMaskProps) {
              const value = ocs.getPropertyValue(prop).trim();
              if (value !== '') cloneNode.style.setProperty(prop, value);
            }
          }
          // DM-815: `<mask mask-type="…">` is a presentation attribute that
          // CSS can override (e.g. `svg .alpha-test { mask-type: alpha }`).
          // Bake the computed value as an attribute on cloned `<mask>` nodes
          // so the emitted standalone SVG renders the mask with the
          // intended semantics — without it, alpha-driven masks (gradient
          // with stop-opacity transitions on solid black) decode as
          // luminance and paint nothing.
          if (origNode.tagName && origNode.tagName.toLowerCase() === 'mask') {
            const mt = ocs.maskType || ocs.getPropertyValue('mask-type');
            if (mt === 'alpha' || mt === 'luminance') {
              if (!origNode.hasAttribute('mask-type') || origNode.getAttribute('mask-type') !== mt) {
                cloneNode.setAttribute('mask-type', mt);
              }
            }
          }
          // DM-2473: freeze Blink's already-resolved, already-flattened local
          // affine. This supersedes the former computed-string + getBBox ±
          // strokeWidth/2 reconstruction and applies equally to static attrs,
          // CSS winners, 3D functions, independent properties, and motion.
          _freezeUsedAffine(origNode, cloneNode, ocs);
        }
        const oChildren = origNode.children;
        const cChildren = cloneNode.children;
        const n = Math.min(oChildren.length, cChildren.length);
        for (let i = 0; i < n; i++) _walkBake(oChildren[i], cChildren[i]);
      };
      _walkBake(el, clone);
      // DM-499: resolve <use href="#id"> fragment refs by inlining the
      // referenced symbol/group/path into the cloned subtree. Without this
      // the cloned outerHTML carries dangling fragment refs whose targets
      // live in a sibling hidden-defs SVG that we never emit (apple.com
      // country dropdown checkmark, search/cart nav icons, footer social).
      // Same-document fragment-only refs handled here; external file refs
      // (./icons.svg#foo) and unresolved targets are left in place — the
      // dangling ref still doesn't paint, but at least we tried.
      const _svgNS = 'http://www.w3.org/2000/svg';
      const _xlinkNS = 'http://www.w3.org/1999/xlink';
      const _resolveUseRefs = (root, depth) => {
        if (depth > 5) return; // cycle / depth guard
        var uses = root.querySelectorAll ? root.querySelectorAll('use') : [];
        for (var ui = 0; ui < uses.length; ui++) {
          var useEl = uses[ui];
          var href = useEl.getAttribute('href');
          if (href == null || href === '') href = useEl.getAttributeNS(_xlinkNS, 'href') || '';
          if (href.charAt(0) !== '#') continue; // external or invalid
          var targetId = href.slice(1);
          var target = document.getElementById(targetId);
          if (target == null) continue;
          if (target.namespaceURI !== _svgNS) continue;
          // DM-508: animated subtrees no longer trigger raster fallback. The
          // _walkBake pass above bakes computed presentation attrs and
          // transforms at the moment of capture, so the t=0 paint state is
          // captured declaratively in the inlined SVG. Animation timing /
          // future frames don't survive — the icon is frozen at t=0 — but the
          // drawing is correct for the captured moment, which is the
          // contract Domotion provides for any other time-varying content.
          // We still warn so consumers know the snapshot is one frame.
          if (typeof target.getAnimations === 'function') {
            try {
              var anims = target.getAnimations({ subtree: true });
              if (anims != null && anims.length > 0) {
                warn(sel, 'inline-svg', '<use href="#' + targetId + '"> resolved to a CSS-animated subtree; the inlined SVG carries the t=0 computed paint state (no animation in the output)');
              }
            } catch (e) { /* getAnimations not supported — fall through, no warning */ }
          }
          var ux = parseFloat(useEl.getAttribute('x') || '0') || 0;
          var uy = parseFloat(useEl.getAttribute('y') || '0') || 0;
          var uw = useEl.getAttribute('width');
          var uh = useEl.getAttribute('height');
          var targetTag = target.tagName.toLowerCase();
          var replacement;
          if (targetTag === 'symbol') {
            // <symbol> => nested <svg> with the consumer's x/y/width/height
            // and the symbol's viewBox. Browsers honor preserveAspectRatio
            // on the nested <svg> the same way they do for <use> against a
            // symbol target — we let SVG do the math.
            var vb = target.getAttribute('viewBox') || '';
            var par = target.getAttribute('preserveAspectRatio') || '';
            var innerSvg = document.createElementNS(_svgNS, 'svg');
            if (ux !== 0) innerSvg.setAttribute('x', String(ux));
            if (uy !== 0) innerSvg.setAttribute('y', String(uy));
            if (uw != null) innerSvg.setAttribute('width', uw);
            if (uh != null) innerSvg.setAttribute('height', uh);
            if (vb !== '') innerSvg.setAttribute('viewBox', vb);
            if (par !== '') innerSvg.setAttribute('preserveAspectRatio', par);
            for (var ci = 0; ci < target.children.length; ci++) {
              var clonedChild = target.children[ci].cloneNode(true);
              innerSvg.appendChild(clonedChild);
              // DM-508: bake t=0 computed styles on the inlined subtree.
              // The hidden-defs symbol's children carry CSS animations whose
              // computed values (transform, fill, opacity, etc.) reflect the
              // animation's current frame at capture time. Walking with the
              // original DOM as source captures those values.
              _walkBake(target.children[ci], clonedChild);
            }
            // DM-778: thread the <use>'s own transform around the inlined
            // nested <svg>. Per SVG 2 §5.6 the use's `transform` attribute
            // applies to the inlined shadow tree; SVG's `<svg>` element does
            // not directly take a `transform` attribute in legacy SVG 1.1
            // renderers, so wrap in a `<g transform>` to be safe. Without
            // this the `<use href="#badge" transform="scale(0.6)">` form in
            // `07-deep-svg-use-href` rendered the badge at full size,
            // duplicating the un-scaled pill on top of the in-place pill.
            var useTransformAttrSym = useEl.getAttribute('transform') || '';
            if (useTransformAttrSym !== '') {
              replacement = document.createElementNS(_svgNS, 'g');
              replacement.setAttribute('transform', useTransformAttrSym);
              replacement.appendChild(innerSvg);
            } else {
              replacement = innerSvg;
            }
          } else {
            // <g>, <path>, <circle>, <svg>, etc. — wrap in <g transform>.
            // Per SVG 2 §5.6 the `<use>` element's own `transform` attribute
            // applies to the inlined shadow tree, with the use's x/y
            // translate happening INSIDE that transform. So compose:
            //   composedTransform = useTransform + translate(x, y)
            // Skip pieces that are no-ops to keep the markup tidy. Without
            // this, `<use transform="scale(1.2)" x="80" y="150">` would
            // inline as plain `translate(80, 150)` and the scale would
            // silently disappear (DM-675).
            replacement = document.createElementNS(_svgNS, 'g');
            var useTransformAttr = useEl.getAttribute('transform') || '';
            var translatePart = (ux !== 0 || uy !== 0) ? ('translate(' + ux + ',' + uy + ')') : '';
            var composedTransform = (useTransformAttr + ' ' + translatePart).trim();
            if (composedTransform !== '') {
              replacement.setAttribute('transform', composedTransform);
            }
            var clonedTarget = target.cloneNode(true);
            // Drop the id on the clone — keeping it would create a duplicate
            // id in the output document (the original lives in the hidden
            // defs SVG which won't be in our output, but safer to remove it
            // either way).
            if (clonedTarget.removeAttribute) clonedTarget.removeAttribute('id');
            replacement.appendChild(clonedTarget);
            // DM-508: bake t=0 computed styles on the inlined target subtree.
            _walkBake(target, clonedTarget);
            // When the target itself is an `<svg>` (the framer.com toolbar
            // pattern: `<use href="#svgID">` → `<svg viewBox="0 0 20 20"
            // id="svgID"><path .../></svg>` living in a hidden defs container
            // with `width: 0; height: 0`), the bake above writes `width="0"
            // height="0"` onto the cloned svg from the source's computed
            // style. That collapses the inlined inner viewport and the icon
            // paints nothing inside its parent — even though Chrome paints
            // it correctly because the live `<use>` consumer's viewport
            // (the outer svg inside the page's regular flow) gives the icon
            // its 14×14 / 20×20 space. Strip baked zero width/height on the
            // cloned target so the nested svg defaults to 100%/100% of its
            // parent viewport, matching Chrome's behavior. Don't touch non-
            // zero baked values — those came from a legitimately-sized source
            // and reflect Chrome's intent.
            if (clonedTarget.tagName && clonedTarget.tagName.toLowerCase() === 'svg' && clonedTarget.removeAttribute) {
              if (!_hasConcreteAttr(target, 'width') && /^0(?:\.0+)?$/.test(clonedTarget.getAttribute('width') || '')) {
                clonedTarget.removeAttribute('width');
              }
              if (!_hasConcreteAttr(target, 'height') && /^0(?:\.0+)?$/.test(clonedTarget.getAttribute('height') || '')) {
                clonedTarget.removeAttribute('height');
              }
            }
          }
          // The source <use> CTM deliberately excludes x/y; those geometry
          // properties position the instantiated shadow content. Preserve the
          // exact frozen transform on the replacement wrapper, then validate
          // the wrapper against A (symbol) or A*translate(x,y) (other targets).
          const useFreeze = _frozenByClone.get(useEl);
          if (useFreeze != null) {
            useFreeze.skip = true;
            var replacementExpected = useFreeze.frozen;
            if (targetTag !== 'symbol' && (ux !== 0 || uy !== 0)) {
              replacementExpected = multiplySvgAffine(replacementExpected, {
                a: 1, b: 0, c: 0, d: 1, e: ux, f: uy,
              });
            }
            const replacementSerialized = serializeSvgAffine(replacementExpected);
            if (replacementSerialized == null) {
              _affineFreezeFailure = _affineFreezeFailure || 'inlined use transform could not be serialized';
            } else {
              replacement.setAttribute('transform', replacementSerialized);
            }
            _affineFreezeRecords.push({
              cloneNode: replacement,
              expected: replacementExpected,
              frozen: replacementExpected,
              points: useFreeze.points,
              serialized: replacement.getAttribute('transform') || '',
              skip: false,
            });
          }
          // Carry over any presentation attrs from the <use> element. CSS
          // spec: attributes on <use> override the same attribute on the
          // referenced subtree's root.
          var _useAttrs = ['fill', 'stroke', 'stroke-width', 'opacity', 'class', 'style'];
          for (var ai = 0; ai < _useAttrs.length; ai++) {
            var av = useEl.getAttribute(_useAttrs[ai]);
            if (av != null && av !== '') replacement.setAttribute(_useAttrs[ai], av);
          }
          useEl.parentNode.replaceChild(replacement, useEl);
          // The replacement may itself contain <use> refs (chain). Recurse
          // with depth guard.
          _resolveUseRefs(replacement, depth + 1);
        }
      };
      _resolveUseRefs(clone, 0);
      // SMIL transform/motion is a separate contribution in Blink. Remove it
      // only after the aligned source/clone walk is complete; deleting a clone
      // child during _walkBake would shift sibling indexes and corrupt node
      // correlation. Geometry/paint animations remain untouched.
      for (const animation of Array.from(clone.querySelectorAll ? clone.querySelectorAll('animateMotion, animateTransform, animate[attributeName], set[attributeName]') : [])) {
        const name = (animation.localName || '').toLowerCase();
        const attribute = (animation.getAttribute('attributeName') || '').toLowerCase();
        if (name === 'animatemotion' || name === 'animatetransform' || attribute === 'transform') animation.remove();
      }
      const _sanitizeClonedTransformCss = () => {
        for (const styleNode of Array.from(clone.querySelectorAll ? clone.querySelectorAll('style') : [])) {
          const cssText = styleNode.textContent || '';
          if (!/(?:transform|translate|rotate|scale|offset(?:-|\s*:))/i.test(cssText)) continue;
          // Constructable stylesheets give us Chromium's parser without ever
          // attaching a rule to the live page. Mutate this private CSSOM copy,
          // then serialize it back to the clone; the source stylesheet and DOM
          // remain byte-for-byte untouched.
          if (/@import\b/i.test(cssText) || typeof CSSStyleSheet !== 'function') {
            _affineFreezeFailure = _affineFreezeFailure || 'transform-bearing cloned stylesheet could not be inspected';
            continue;
          }
          try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(cssText);
            const cleanRules = (rules) => {
              for (const rule of Array.from(rules || [])) {
                if (rule.style != null) {
                  for (const prop of Array.from(rule.style)) {
                    const normalized = prop.toLowerCase().replace(/^-webkit-/, '');
                    if (_transformProperties.has(normalized)) rule.style.removeProperty(prop);
                  }
                }
                if (rule.cssRules != null) cleanRules(rule.cssRules);
              }
            };
            cleanRules(sheet.cssRules);
            styleNode.textContent = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
          } catch (e) {
            _affineFreezeFailure = _affineFreezeFailure || 'transform-bearing cloned stylesheet failed CSSOM normalization';
          }
        }
      };
      _sanitizeClonedTransformCss();

      const _validateFrozenAffines = () => {
        if (_affineFreezeFailure != null || _affineFreezeRecords.length === 0) return;
        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.setProperty('all', 'initial', 'important');
        host.style.setProperty('position', 'fixed', 'important');
        host.style.setProperty('left', '-100000px', 'important');
        host.style.setProperty('top', '-100000px', 'important');
        host.style.setProperty('visibility', 'hidden', 'important');
        var shadow = null;
        try {
          shadow = host.attachShadow({ mode: 'closed' });
          shadow.appendChild(clone);
          (document.body || document.documentElement).appendChild(host);
          for (const record of _affineFreezeRecords) {
            if (record.skip || !record.cloneNode.isConnected) continue;
            const parent = _nearestCtmParent(record.cloneNode);
            const parentCtm = _matrixFrom(parent && parent.getCTM && parent.getCTM());
            const cloneCtm = _matrixFrom(record.cloneNode.getCTM && record.cloneNode.getCTM());
            const parentInverse = parentCtm == null ? null : invertSvgAffine(parentCtm);
            const actual = parentInverse == null || cloneCtm == null
              ? null
              : multiplySvgAffine(parentInverse, cloneCtm);
            // Blink stores SVG layout transforms in float-backed geometry. A
            // 1/256 CSS-pixel mapped-point budget is stricter than LayoutUnit
            // paint quantization while allowing a serialize/parse CTM roundtrip.
            if (actual == null || svgAffineMaxPointError(actual, record.expected, record.points) > 1 / 256) {
              _affineFreezeFailure = 'serialized SVG affine did not correlate with Blink-used local geometry';
              break;
            }
          }
        } catch (e) {
          _affineFreezeFailure = 'serialized SVG affine could not be validated in an isolated clone';
        } finally {
          host.remove();
        }
      };
      _validateFrozenAffines();
      // DM-499: substitute fill="currentColor" / stroke="currentColor" with
      // the consumer's resolved cs.color so the inlined symbol picks up the
      // host's color even when the resolved subtree's own ancestors don't
      // propagate currentColor (e.g. a symbol child with explicit
      // color="red" would otherwise short-circuit the wrapping <g color>
      // injection at render time). Defense in depth — the renderer also
      // emits a wrapping <g color=...> for currentColor propagation.
      var _hostColor = cs.color;
      var _substCurrentColor = (node) => {
        if (node.nodeType !== 1) return;
        var fa = node.getAttribute && node.getAttribute('fill');
        if (fa != null && /^currentcolor$/i.test(fa)) node.setAttribute('fill', _hostColor);
        var sa = node.getAttribute && node.getAttribute('stroke');
        if (sa != null && /^currentcolor$/i.test(sa)) node.setAttribute('stroke', _hostColor);
        for (var ci = 0; ci < node.children.length; ci++) _substCurrentColor(node.children[ci]);
      };
      _substCurrentColor(clone);
      if (_affineFreezeFailure != null) {
        warn(sel, 'inline-svg', _affineFreezeFailure + '; promoted the outer inline SVG to Chromium raster ownership');
      }
      return { content: clone.outerHTML, affineFreezeFailed: _affineFreezeFailure != null };
};
