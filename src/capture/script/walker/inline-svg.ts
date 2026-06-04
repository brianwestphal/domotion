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
      const _bakeSvgGeomAttrs = ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'd'];
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
          // DM-720: bake CSS-driven geometry. Skip when the source has a
          // concrete XML attr — Chrome's per-property precedence is "CSS wins
          // over the presentation attribute" since SVG 2, but the computed
          // value reflects that already, so writing it to the clone preserves
          // the same painted geometry. Strip "px" suffixes and unwrap d's
          // path() wrapper so the values parse as XML presentation attrs.
          for (const gattr of _bakeSvgGeomAttrs) {
            if (_hasConcreteAttr(origNode, gattr)) continue;
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
            cloneNode.setAttribute(gattr, gval);
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
          // DM-508: bake CSS-animated transforms at t=0. CSS animation /
          // transition declarations mean the computed transform reflects the
          // animation's current frame at capture time — getComputedStyle
          // returns e.g. matrix(0.707, 0.707, -0.707, 0.707, 0, 0) for a 45-
          // deg rotated rect. The SVG transform attribute applies around
          // (0,0) by default, so a CSS transform-origin: center has to be
          // composed into the matrix manually:
          //   final = translate(ox, oy) * css_transform * translate(-ox, -oy)
          // For transform-box: fill-box (and the new CSS default for SVG),
          // origin px values are relative to the element's bounding box. We
          // read those from getComputedStyle().transformOrigin and compose.
          var transformVal = ocs.transform;
          // DM-676: only bake when the SOURCE node has no static `transform=`
          // attribute. The bake exists to capture CSS-animated transforms at
          // t=0 (DM-508). When the node already has a literal `transform=`
          // attribute, the existing attribute IS the source of truth — Chrome
          // resolves it through transform-origin/transform-box at paint time,
          // and the consumer browser will apply the same resolution. Baking
          // a composed origin-anchored matrix on top double-applies the
          // origin and shifts the rect.
          var hasStaticTransformAttr = origNode.hasAttribute('transform') && !_isUnresolvedCssExpr(origNode.getAttribute('transform'));
          if (!hasStaticTransformAttr && transformVal != null && transformVal !== '' && transformVal !== 'none') {
            var transformOriginVal = ocs.transformOrigin || '0 0';
            var originParts = transformOriginVal.trim().split(/\s+/);
            var ox = parseFloat(originParts[0] || '0') || 0;
            var oy = parseFloat(originParts[1] || '0') || 0;
            // DM-752: route through `transform-box` to convert origin px values
            // from the reference box's local coord space into SVG user space.
            // Chrome's `getComputedStyle().transformOrigin` returns px values
            // relative to the resolved transform-box:
            //   - `fill-box` (SVG default): bbox-local → add `bbox.x / bbox.y`.
            //   - `stroke-box`: stroke-bbox-local. Stroke-bbox is the geometry
            //     bbox extended by `stroke-width / 2` on each side, so
            //     stroke-bbox.x = bbox.x - sw/2, stroke-bbox.y = bbox.y - sw/2.
            //   - `view-box`: already in viewBox / user space coords; no shift.
            //   - `content-box` / `border-box`: HTML-only; SVG-side bake doesn't
            //     hit these (the HTML transform path applies them separately).
            // Without this, `transform-box: view-box` rotated around the wrong
            // anchor (the rect's bbox top-left instead of the viewBox center)
            // and `transform-box: stroke-box` was off by `stroke-width / 2`.
            var transformBoxVal = ocs.transformBox || 'fill-box';
            try {
              if (typeof origNode.getBBox === 'function' && transformBoxVal !== 'view-box') {
                var bbox = origNode.getBBox();
                ox += bbox.x;
                oy += bbox.y;
                if (transformBoxVal === 'stroke-box') {
                  var swPx = parseFloat(ocs.strokeWidth || '0') || 0;
                  ox -= swPx / 2;
                  oy -= swPx / 2;
                }
              }
            } catch (e) { /* element not yet in render tree, fall through */ }
            var composed;
            if (ox === 0 && oy === 0) {
              composed = transformVal;
            } else {
              composed = 'translate(' + ox + ',' + oy + ') ' + transformVal + ' translate(' + (-ox) + ',' + (-oy) + ')';
            }
            cloneNode.setAttribute('transform', composed);
          }
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
      return clone.outerHTML;
};
