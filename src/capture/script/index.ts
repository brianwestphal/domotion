// @ts-nocheck
//
// Source for the in-page capture script. The orchestrator of the per-concern
// factory modules under `src/capture/script/`. The build step at
// `scripts/build-capture-script.mjs` bundles this entry + its imports (esbuild
// with bundle:true) into a single self-contained function expression that
// becomes the `CAPTURE_SCRIPT` string in `src/capture/script.generated.ts`,
// which `src/capture/index.ts` injects via page.evaluate(). The function runs
// in the captured page's context — at runtime there are no imports left, just
// one IIFE that takes `args` and returns `{ tree, warnings }`.
//
// Helpers that are self-contained pre-walk / per-call utilities live in
// sibling files (`color-norm.ts`, `emoji-detect.ts`, `font-metrics.ts`,
// `placeholder-shown.ts`, `pseudo-rules.ts`, `warnings.ts`); per-concern
// walker handlers live under `./walker/`. This file owns the remaining
// `captureInner` walker body and the top-level orchestration (fixed-ancestor
// pre-pass, counter pre-walk, root-element capture, mask-def + dark-mode
// attachment to the result tree).

import { createColorNorm } from "./color-norm.js";
import { createEmojiDetect } from "./emoji-detect.js";
import { createFontMetrics } from "./font-metrics.js";
import { createPlaceholderShown } from "./placeholder-shown.js";
import { createPseudoRules } from "./pseudo-rules.js";
import { createWarnings } from "./warnings.js";
import { createListsCountersHandler } from "./walker/lists-counters.js";
import { createReplacedElementsHandler } from "./walker/replaced-elements.js";
import { createMasksClipsHandler } from "./walker/masks-clips.js";
import { createFormControlsHandler } from "./walker/form-controls.js";
import { createTransformsHandler } from "./walker/transforms.js";
import { createBordersBackgroundsHandler } from "./walker/borders-backgrounds.js";
import { createPseudoContentHandler } from "./walker/pseudo-content.js";
import { createInputValueHandler } from "./walker/input-value.js";
import { createTextSegmentsHandler, computeElementRaster } from "./walker/text-segments.js";
import { createPseudoInjectHandler } from "./walker/pseudo-inject.js";

export const captureScript =
(args) => {
  const sel = args.sel;
  const vp = args.vp;

  // Wire up per-concern helpers. Each factory closes over its own state and
  // returns the handles captureInner / the orchestration tail call. Renamed
  // (e.g. `warnings: _warnings`) to keep captureInner's existing references
  // unchanged.
  const { normColor } = createColorNorm();
  const { needsRaster, textNeedsRaster } = createEmojiDetect();
  const { measureFontMetrics: _measureFontMetrics, substituteAliasedFamilies: _substituteAliasedFamilies } = createFontMetrics();
  const { resolvePlaceholderShownBg: _resolvePlaceholderShownBg } = createPlaceholderShown();
  const { resolvePseudo: _resolvePseudo, resolveCornerRadius: _resolveCornerRadius } = createPseudoRules();
  const { warn, shortSelector, warnings: _warnings } = createWarnings();
  const { captureListsCounters } = createListsCountersHandler({ normColor });
  const { handleReplacedElement } = createReplacedElementsHandler({ vp });
  const { discoverMasks, maskDefs: _maskDefs, maskRasters: _maskRasters } = createMasksClipsHandler({ vp, warn });
  const { captureFormControls } = createFormControlsHandler({ normColor, resolvePseudo: _resolvePseudo });
  const { wrapWithFrozenTransform, threadFrozenTransform } = createTransformsHandler();
  const { captureBordersBackgrounds } = createBordersBackgroundsHandler({
    normColor,
    resolvePlaceholderShownBg: _resolvePlaceholderShownBg,
    resolveCornerRadius: _resolveCornerRadius,
  });
  const { capturePseudoContent } = createPseudoContentHandler({
    vp,
    normColor,
    measureFontMetrics: _measureFontMetrics,
    textNeedsRaster,
  });
  const { captureInputValue } = createInputValueHandler({ vp, normColor, measureFontMetrics: _measureFontMetrics });
  const { captureTextSegments } = createTextSegmentsHandler({ vp, measureFontMetrics: _measureFontMetrics, needsRaster });
  const { injectPseudoSegments } = createPseudoInjectHandler();

  const capture = (el) => {
    // Freeze the element's CSS transform for the duration of the capture
    // so getBoundingClientRect returns un-transformed coords; the renderer
    // re-applies the saved transform via an SVG group wrapper. See
    // walker/transforms.ts for the rationale.
    const cs = window.getComputedStyle(el);
    return wrapWithFrozenTransform(el, cs, captureInner);
  };
  const captureInner = (el, cs, frozenTransform, frozenTransformOrigin) => {
    const rect = el.getBoundingClientRect();
    // DM-513: when an element's rect is outside the viewport, normally skip the
    // whole subtree. But position:fixed / position:sticky descendants escape
    // their containing-block flow and can paint INSIDE the viewport even when
    // their DOM-tree parent is offscreen (e.g. slashdot's #mongo-stick-it ad
    // bar is position:fixed at top:710px but its parent <footer id="ft"> is
    // at y=7140 in the document flow). Don't return null for an ancestor that
    // has at least one position:fixed/sticky descendant in-viewport — instead
    // capture the element as a transparent container (no own paint, but walk
    // children) so the in-viewport descendants are reached. _fixedAncestors
    // is precomputed in the pre-pass below.
    const outsideViewport = rect.right < vp.x || rect.bottom < vp.y || rect.left > vp.x + vp.width || rect.top > vp.y + vp.height;
    if (outsideViewport && !_fixedAncestors.has(el) && !_transformInfluenced.has(el)) return null;

    // visibility: collapse on table-row/column/group collapses that section
    // (Chrome zero-sizes the row/col, so the zeroSized check below handles it).
    // On any other element, the spec says it behaves as visibility: hidden — the
    // text + children are hidden but adjacent layout / shared borders remain.
    // DM-375.
    //
    // For <td>/<th> with visibility:hidden|collapse inside a border-collapse:collapse
    // table, Chrome still paints the cell's borders (they're part of the shared
    // table grid). The TOP edge of a hidden header cell is owned by the cell
    // itself (no neighbor above to draw it), so dropping the cell loses that line.
    // Fall through with bordersOnlyCell = true and clear text/children/bg
    // before the final return. DM-450.
    const _earlyTag = el.tagName.toLowerCase();
    const bordersOnlyCell = (_earlyTag === 'td' || _earlyTag === 'th')
      && (cs.visibility === 'hidden' || cs.visibility === 'collapse')
      && cs.borderCollapse === 'collapse';
    if (cs.display === 'none') return null;
    if ((cs.visibility === 'hidden' || cs.visibility === 'collapse') && !bordersOnlyCell) return null;

    // DM-580: standard accessibility "visually-hidden" / "sr-only" idioms.
    // Chrome paints nothing for these (clipped to zero), but the DOM text is
    // still present for screen readers. Without this filter the captured tree
    // emits stray text (skip-to-content links, country/section abbreviations,
    // hidden tooltip labels) that the real page never paints. Three patterns:
    //   1. Legacy: clip: rect(0,0,0,0) (still used across major news/CMS sites)
    //   2. Modern: clip-path: inset(50%) or inset(100%) — collapses to 0 box
    //   3. 1x1 sr-only: tiny absolutely-positioned box with overflow:hidden
    const _clip = cs.clip || '';
    if (_clip !== 'auto' && _clip !== '' && _clip !== 'normal') {
      const _cm = _clip.match(/rect\(\s*([^,\s]+)[ ,]+([^,\s]+)[ ,]+([^,\s]+)[ ,]+([^)\s]+)\s*\)/);
      if (_cm != null
          && parseFloat(_cm[1]) === 0 && parseFloat(_cm[2]) === 0
          && parseFloat(_cm[3]) === 0 && parseFloat(_cm[4]) === 0) {
        return null;
      }
    }
    const _cp = cs.clipPath || '';
    if (_cp.indexOf('inset(') === 0) {
      const _ipm = _cp.match(/inset\(\s*([0-9.]+)\s*%/);
      if (_ipm != null && parseFloat(_ipm[1]) >= 50) return null;
    }
    if (rect.width <= 1 && rect.height <= 1
        && (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden')
        && (cs.position === 'absolute' || cs.position === 'fixed')) {
      return null;
    }

    // Zero-sized elements — skip visual rendering of the element itself but
    // still walk children. Elements with all position:absolute children
    // collapse to 0 height (absolutes don't contribute to layout) — those
    // children still need to be captured and painted.
    const zeroSized = rect.width === 0 || rect.height === 0;
    // Skip empty zero-sized elements UNLESS they're tagged for an intra-frame
    // animation — an animated element starting at width: 0 should still be
    // captured so the renderer can emit its anim-class wrapper. (DM-209.)
    const _hasAnim = el.dataset != null && el.dataset.domotionAnim != null && el.dataset.domotionAnim !== '';
    if (zeroSized && el.children.length === 0 && !_hasAnim) return null;

    const tag = el.tagName.toLowerCase();

    // Emit warnings for features domotion can't fully round-trip. Keep
    // these short and actionable — consumers (CLI, tests, demo scripts) log
    // them so the fidelity gaps are self-documenting.
    const sel = shortSelector(el);
    if (cs.transform && cs.transform.startsWith('matrix3d')) {
      warn(sel, 'transform-3d', 'matrix3d/translate3d/rotate3d/perspective downgraded to 2D submatrix; z component + perspective dropped (SK-1135)');
    }
    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      warn(sel, 'backdrop-filter', 'captured but not emitted — no SVG equivalent');
    }
    // writing-mode != horizontal-tb is handled via elementRaster (SK-1128)
    // — the text region is screenshot-rasterized so vertical text and
    // sideways glyph rotation come from Chromes own paint. No warning.
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      warn(sel, 'position:' + cs.position, 'rendered as a static snapshot at t=0; scroll-following behavior is not animated');
    }
    // Mask discovery — same-document fragment refs (`url("#id")`), element
    // refs (`element(#id)`), and warnings for unsupported mask sources.
    // Handler owns the maskDefs / maskRasters Maps that the orchestration
    // tail consumes. See walker/masks-clips.ts.
    discoverMasks(el, cs, sel);
    if (cs.borderImageSource && cs.borderImageSource !== 'none') {
      warn(sel, 'border-image', '9-slice composition pending (SK-466); border-image-source ignored');
    }
    if (tag === 'iframe' || tag === 'canvas' || tag === 'video' || tag === 'object' || tag === 'embed') {
      warn(sel, '<' + tag + '>', 'element type is not rendered by domotion');
    }
    // Scrollbars appear when content overflows a non-visible overflow container.
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowY === 'auto' || cs.overflowY === 'scroll')
        && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      warn(sel, 'scrollbar', 'native scrollbar chrome not emulated yet (SK-468); content is clipped but no scroll indicator');
    }
    // DM-547/549/550: conic-gradient layers are rasterized into PNG tiles by
    // the capture pre-pass (rasterizeConicGradients) and emitted as
    // <pattern><image> via buildConicGradientDef. The previous unconditional
    // warning fired even when the layer rendered correctly — moved to
    // rasterizeConicGradients (DM-549) which warns only on parse failure.
    // text-align: justify combined with wrapping — renderer doesn't space-stretch.
    if (cs.textAlign === 'justify') {
      warn(sel, 'text-align:justify', 'path-mode renderer does not space-stretch justified text');
    }
    let text = '';
    let imageSrc = undefined;
    let svgContent = undefined;

    let textTop = 0;
    let textLeft = 0;
    let textHeight = 0;
    let textWidth = 0;
    let fontAscent = 0;
    let fontDescent = 0;
    let inputXOffsets;
    let placeholderColor;
    let placeholderFontStyle;
    let placeholderFontWeight;
    const textSegments = [];
    // ::before / ::after generated content — capture each matched pseudo as
    // a TextSegment (or image pseudo) positioned relative to the host's
    // padding box. The downstream text-segments assembler re-anchors
    // seg.x/y against the captured text once shaping completes. See
    // walker/pseudo-content.ts.
    const _pcResult = capturePseudoContent(el, cs, rect, _counterSnapshot);
    const pseudoSegments = _pcResult.pseudoSegments;
    const pseudoBoxes = _pcResult.pseudoBoxes;

    // Skip text capture for elements where the child text is fallback content
    // hidden by the browser's shadow-DOM rendering (meter, progress, datalist,
    // option). These fall back to their text only when the element fails to
    // render; on a healthy browser the text is invisible but Range.getClientRects
    // still reports a rect at (0, 0) which would place a stray label at the top
    // of the page.
    // option/optgroup text is hidden by Chrome's UA shadow DOM at every level
    // we can probe — neither closed dropdowns nor listbox-mode selects expose
    // a usable getBoundingClientRect on the option children. Closed dropdowns
    // synthesize the selected option text via styles.selectDisplayText
    // (DM-246); listbox-mode selects synthesize all rows via
    // styles.selectListboxOptions (DM-282).
    const textIsHiddenFallback = tag === 'meter' || tag === 'progress' || tag === 'datalist' || tag === 'option' || tag === 'optgroup';
    if (tag !== 'svg' && tag !== 'img' && !textIsHiddenFallback) {
      // Input / textarea value capture (incl. placeholder fallback, password
      // masking, sub-pixel inputXOffsets probe, text-align shift). See
      // walker/input-value.ts. When the handler `applied`, copy its locals
      // out and skip the text-node walker for this element.
      const _iv = captureInputValue(el, cs, tag, rect);
      var isPlaceholderCapture = false;
      if (_iv.applied) {
        text = _iv.text;
        textLeft = _iv.textLeft;
        textTop = _iv.textTop;
        textHeight = _iv.textHeight;
        textWidth = _iv.textWidth;
        fontAscent = _iv.fontAscent;
        fontDescent = _iv.fontDescent;
        inputXOffsets = _iv.inputXOffsets;
        isPlaceholderCapture = _iv.isPlaceholderCapture;
        placeholderColor = _iv.placeholderColor;
        placeholderFontStyle = _iv.placeholderFontStyle;
        placeholderFontWeight = _iv.placeholderFontWeight;
      } else {
        // Text-node walker — per-line textSegments via per-character
        // getClientRects, BiDi visual-fragment splitting, rasterGlyph
        // detection, ::first-letter / ::first-line overrides. See
        // walker/text-segments.ts.
        const _ts = captureTextSegments(el, cs);
        text = _ts.text;
        for (const seg of _ts.textSegments) textSegments.push(seg);
        if (_ts.textLeft != null) {
          textLeft = _ts.textLeft;
          textTop = _ts.textTop;
          textWidth = _ts.textWidth;
          textHeight = _ts.textHeight;
          fontAscent = _ts.fontAscent;
          fontDescent = _ts.fontDescent;
        }
      }
    }
    // Inject pseudo-element segments now that the main text boundaries
    // are known. See walker/pseudo-inject.ts. Mutates textSegments in
    // place; returns the new pseudoImages + updated text-shaping locals
    // (pseudos can override the host's textLeft/Top/Width/Height when
    // they're the only segment — DM-495).
    const _pi = injectPseudoSegments(el, pseudoSegments, textSegments, {
      text, textLeft, textTop, textWidth, textHeight, fontAscent,
    });
    const pseudoImages = _pi.pseudoImages;
    text = _pi.text;
    textLeft = _pi.textLeft;
    textTop = _pi.textTop;
    textWidth = _pi.textWidth;
    textHeight = _pi.textHeight;
    fontAscent = _pi.fontAscent;

    let textImageUri = undefined;
    const textImageScale = 2;

    if (tag === 'img') {
      // currentSrc is the URL the browser actually resolved + loaded (from
      // srcset / <picture> <source>). Fall back to src when currentSrc is empty.
      imageSrc = el.currentSrc || el.src;
      // Intrinsic <img> dims — used by the renderer for object-fit: none.
      if (el.naturalWidth > 0 && el.naturalHeight > 0) {
        var imageIntrinsic = { w: el.naturalWidth, h: el.naturalHeight };
      }
      // Broken-image fallback (DM-372): el.complete && naturalWidth===0 means
      // the browser tried to load and failed (or src was empty). Chrome paints
      // a small broken-image icon plus the alt text inline. Capture both so
      // the renderer can synthesize the same fallback.
      var imageBroken = el.complete && el.naturalWidth === 0;
      var imageAlt = el.alt || '';
    } else if (tag === 'input' && el.type === 'image') {
      // <input type="image"> renders the src as a clickable button-image.
      // No currentSrc / naturalWidth on HTMLInputElement; the bounding rect
      // already reflects width/height attributes or the image's natural size.
      imageSrc = el.src;
    }
    const _listsCounters = captureListsCounters(el, cs, tag);
    if (tag === 'svg') {
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
          for (const attr of _bakeSvgAttrs) {
            const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const val = ocs[camel];
            // DM-524: see _hasConcreteAttr comment above. Skip the bake only
            // when the source attr value is a concrete literal — var() /
            // calc() / env() / attr() references resolve against the source
            // cascade and lose their resolution outside it, so we replace
            // them with the resolved computed value.
            if (val != null && val !== '' && !_hasConcreteAttr(origNode, attr)) {
              cloneNode.setAttribute(attr, val);
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
            // For transform-box: fill-box (Chrome default for SVG since CSS
            // Transforms 2), origin coords are relative to the element's bbox.
            // We need them in the parent's user space — add the bbox origin.
            // getBBox() works on rendered SVG nodes.
            try {
              if (typeof origNode.getBBox === 'function') {
                var bbox = origNode.getBBox();
                ox += bbox.x;
                oy += bbox.y;
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
            replacement = document.createElementNS(_svgNS, 'svg');
            if (ux !== 0) replacement.setAttribute('x', String(ux));
            if (uy !== 0) replacement.setAttribute('y', String(uy));
            if (uw != null) replacement.setAttribute('width', uw);
            if (uh != null) replacement.setAttribute('height', uh);
            if (vb !== '') replacement.setAttribute('viewBox', vb);
            if (par !== '') replacement.setAttribute('preserveAspectRatio', par);
            for (var ci = 0; ci < target.children.length; ci++) {
              var clonedChild = target.children[ci].cloneNode(true);
              replacement.appendChild(clonedChild);
              // DM-508: bake t=0 computed styles on the inlined subtree.
              // The hidden-defs symbol's children carry CSS animations whose
              // computed values (transform, fill, opacity, etc.) reflect the
              // animation's current frame at capture time. Walking with the
              // original DOM as source captures those values.
              _walkBake(target.children[ci], clonedChild);
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
      svgContent = clone.outerHTML;
    }

    const children = [];
    for (const child of el.children) {
      // Closed <details> hides non-<summary> children visually. getBoundingClientRect
      // still returns their rects and cs.display isn't 'none', so we explicitly
      // skip non-summary children when the parent details is closed.
      if (tag === 'details' && !el.open && child.tagName.toLowerCase() !== 'summary') continue;
      // <select> renders its own listbox/dropdown via the form-control
      // synth; recursively capturing <option>/<optgroup> children would
      // emit their own background rects and stack them on top of the
      // synth output, hiding the option text. Skip them. (DM-355)
      if (tag === 'select' && (child.tagName.toLowerCase() === 'option' || child.tagName.toLowerCase() === 'optgroup')) continue;
      const c = capture(child);
      if (c) children.push(c);
    }

    const _animId = el.dataset != null ? el.dataset.domotionAnim : undefined;

    // <fieldset> with a top-aligned <legend>: Chrome's UA fieldset paints its
    // top border at the legend's vertical center, with a notch cut in the
    // border across the legend's x range. fieldset.getBoundingClientRect()
    // returns the OUTER box that includes the legend's full height — so the
    // visible box top sits legend.height/2 below rect.top. Inset the captured
    // y/height to match Chrome's painted box, and capture the legend's x
    // range for the renderer to notch the top border behind it. DM-342/DM-343.
    let fieldsetLegendNotch;
    let fsX = rect.left - vp.x;
    let fsY = rect.top - vp.y;
    let fsW = rect.width;
    let fsH = rect.height;
    if (tag === 'fieldset') {
      for (let i = 0; i < el.children.length; i++) {
        const ch = el.children[i];
        if (ch.tagName.toLowerCase() !== 'legend') continue;
        const lr = ch.getBoundingClientRect();
        // Top-aligned legend (legend.top === fieldset.top, with sub-px slack).
        if (lr.height > 0 && lr.width > 0 && Math.abs(lr.top - rect.top) < 2) {
          const inset = lr.height / 2;
          fsY = (rect.top - vp.y) + inset;
          fsH = rect.height - inset;
          fieldsetLegendNotch = { x: lr.left - vp.x, y: lr.top - vp.y, w: lr.width, h: lr.height };
        }
        break;
      }
    }

    const _captured = {
      tag, text,
      x: fsX, y: fsY,
      width: fsW, height: fsH,
      fieldsetLegendNotch,
      animId: _animId,
      styles: {
        // Border + background + outline + box-shadow fields — see
        // walker/borders-backgrounds.ts. Includes the
        // backgroundColor placeholder-shown fallback (DM-283), %-resolved
        // corner radii (SK-1093), per-side color-input border tint
        // workaround (DM-434), frosted-bg fallback (DM-476), per-layer
        // background-image intrinsic dims (DM-308), and border-image
        // intrinsic dims.
        ...captureBordersBackgrounds(el, cs, tag, rect, isPlaceholderCapture),
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        scrollbarGutter: cs.scrollbarGutter || 'auto',
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        objectFit: cs.objectFit,
        objectPosition: cs.objectPosition,
        filter: cs.filter,
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || '',
        mixBlendMode: cs.mixBlendMode,
        clipPath: cs.clipPath,
        mask: cs.mask || cs.webkitMask || '',
        maskImage: cs.maskImage || cs.webkitMaskImage || '',
        maskMode: cs.maskMode || 'match-source',
        maskSize: cs.maskSize || cs.webkitMaskSize || 'auto',
        maskPosition: cs.maskPosition || cs.webkitMaskPosition || '0% 0%',
        maskRepeat: cs.maskRepeat || cs.webkitMaskRepeat || 'repeat',
        maskComposite: cs.maskComposite || cs.webkitMaskComposite || 'add',
        listStyleType: cs.listStyleType,
        listStyleImage: cs.listStyleImage,
        display: cs.display,
        listStylePosition: cs.listStylePosition,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        zIndex: cs.zIndex,
        position: cs.position,
        float: cs.float,
        order: cs.order,
        flexDirection: cs.flexDirection,
        emptyCellsHidden: (tag === 'td' || tag === 'th') && cs.emptyCells === 'hide' && (el.textContent || '').trim() === '' && el.children.length === 0,
        // Form-control fields — input / progress / meter / select / details
        // + ::-webkit-* pseudos for slider track/thumb, color swatch, number
        // spin button, search cancel, file-selector button. See
        // walker/form-controls.ts. Input value-capture-as-text and color-
        // input border tinting deliberately stay inline (entangled with
        // text-shaping and border-color emission respectively).
        ...captureFormControls(el, cs, tag),
        textShadow: cs.textShadow,
        ...threadFrozenTransform(cs, frozenTransform, frozenTransformOrigin),
        // CSS Transforms 2 §4: `transform-style` != `flat` (i.e. `preserve-3d`)
        // creates a stacking context. Captured so the renderer's SC detection
        // sees it; otherwise z-index:-1 descendants hoist past their intended
        // SC and end up behind the wrong background (DM-589).
        transformStyle: cs.transformStyle,
        willChange: cs.willChange,
        contain: cs.contain,
        isolation: cs.isolation,
        writingMode: cs.writingMode,
        textOrientation: cs.textOrientation,
        // CSS resize: 'none' / 'both' / 'vertical' / 'horizontal' / 'block' /
        // 'inline'. When non-none on a <textarea> Chrome paints a small
        // diagonal-line resize handle in the bottom-right corner. (DM-339)
        resize: cs.resize,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        color: normColor(cs.color),
        // DM-587: live-rect capture records text bboxes at scaled (live)
        // viewport coords, but `cs.fontSize` and `canvas.measureText` are in
        // CSS px (unscaled). Multiply by the cumulative ancestor scale so
        // the renderer's text-Y math (baseline = top + ascent) lands the
        // baseline inside the scaled bbox — without this, glyphs inside e.g.
        // a `transform: scale(0.7)` container overflow their captured cell
        // and escape per-label `overflow: hidden` clip-paths. _cumulativeScale
        // is pre-computed in the pre-pass above. Defaults to 1 for elements
        // outside any scaled ancestor (the common case).
        fontSize: (function() {
          var _fs = parseFloat(cs.fontSize);
          if (!isFinite(_fs)) return cs.fontSize;
          var _s = _scaleMag(el);
          if (_s === 1) return cs.fontSize;
          return (_fs * _s).toFixed(4) + 'px';
        })(),
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        opacity: cs.opacity,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        fontKerning: cs.fontKerning,
        fontStretch: cs.fontStretch,
        fontVariationSettings: cs.fontVariationSettings,
        fontFeatureSettings: cs.fontFeatureSettings,
        // CSS font-variant-caps. 'small-caps' / 'all-small-caps' route to
        // the OpenType smcp feature; renderer applies synthesized small-caps
        // when the active font lacks smcp (Helvetica, Times, etc.). DM-361.
        fontVariantCaps: cs.fontVariantCaps,
        direction: cs.direction,
        // Computed BCP-47 language tag from el.lang or nearest ancestor
        // [lang], falling back to document.documentElement.lang. Used by the
        // path renderer to route CJK Han fallback to the right PingFang
        // regional variant. (DM-394)
        lang: (function() {
          var n = el;
          while (n != null && n.nodeType === 1) {
            if (n.lang) return n.lang;
            n = n.parentElement;
          }
          return document.documentElement.lang || '';
        })(),
        textDecorationLine: cs.textDecorationLine,
        textDecorationColor: cs.textDecorationColor,
        textDecorationStyle: cs.textDecorationStyle,
        textDecorationThickness: cs.textDecorationThickness,
        textUnderlineOffset: cs.textUnderlineOffset,
        textDecorationSkipInk: cs.textDecorationSkipInk,
      },
      children, imageSrc, imageIntrinsic, imageBroken, imageAlt, svgContent, pseudoImages,
      pseudoBoxes: pseudoBoxes.length > 0 ? pseudoBoxes : undefined,
      // SK-1115: ::marker pseudo styles plus list-marker intrinsic dims and
      // list-item index — see walker/lists-counters.ts.
      ..._listsCounters,
      textSegments: textSegments.length > 0 ? textSegments : undefined,
      textTop, textLeft, textHeight, textWidth,
      // DM-587: fontAscent + fontDescent come from `canvas.measureText` using
      // the unscaled `cs.fontSize`, so scale them to match the also-scaled
      // captured fontSize. Otherwise the renderer's baseline math reads
      // unscaled ascent values, and glyphs sit too far below their captured
      // bbox top inside a `transform: scale(<1)` container.
      fontAscent: fontAscent != null ? fontAscent * _scaleMag(el) : fontAscent,
      fontDescent: fontDescent != null ? fontDescent * _scaleMag(el) : fontDescent,
      inputXOffsets,
      textImageUri, textImageScale,
      // Placeholder metadata (SK-1097 / SK-1100 / SK-1099): captured in
      // walker/input-value.ts when the host is a placeholder-shown input
      // or textarea. Undefined elsewhere.
      isPlaceholderText: isPlaceholderCapture || undefined,
      placeholderColor,
      placeholderFontStyle,
      placeholderFontWeight,
      // SK-1108 / SK-1128: textarea soft-wrap + writing-mode != horizontal-tb
      // content-box raster rect — see walker/text-segments.ts.
      elementRaster: computeElementRaster(el, cs, tag, rect, vp),
      // DM-680: per-axis cumulative ancestor scale, exposed ONLY when
      // anisotropic (sx ≠ sy within a small epsilon). The geometric mean is
      // already folded into fontSize / fontAscent / fontDescent above, so
      // the renderer's text-emission path only needs to apply a per-axis
      // correction transform when the two axes diverge. Emitting these on
      // every transformed element would add noise to the captured tree.
      ...(function () {
        const _s = _scaleXY(el);
        const _sx = _s[0], _sy = _s[1];
        if (Math.abs(_sx - _sy) > 1e-4) return { cumScaleX: _sx, cumScaleY: _sy };
        return {};
      })(),
    };
    // DM-450: hidden/collapsed table cell — keep the cell's box + borders so
    // shared edges of the collapsed table grid still paint, but suppress
    // text, children, and background fill (per CSS visibility:hidden).
    if (bordersOnlyCell) {
      _captured.text = '';
      _captured.children = [];
      _captured.styles.backgroundColor = 'rgba(0, 0, 0, 0)';
      _captured.styles.backgroundImage = undefined;
      _captured.textSegments = undefined;
      _captured.imageSrc = undefined;
      _captured.svgContent = undefined;
      _captured.pseudoImages = undefined;
      _captured.elementRaster = undefined;
    }
    // Replaced-element snapshot routing — <iframe>/<canvas>/<video>/<object>/
    // <embed>, custom elements with open shadow DOM, and the CSS sprite-icon
    // image-replacement idiom. Handler mutates _captured (.replacedSnapshot,
    // .imageReplacement, and on the sprite-icon path .styles.backgroundImage /
    // .text / .textSegments). See walker/replaced-elements.ts.
    handleReplacedElement(el, cs, tag, rect, _captured, bordersOnlyCell);
    return _captured;
  };

  const root = document.querySelector(sel);
  if (!root) return { tree: [], warnings: [] };

  // DM-513: pre-pass to find position:fixed / position:sticky descendants
  // whose rect intersects the viewport. Their DOM-tree parents may be far
  // outside the viewport (e.g. slashdot's #mongo-stick-it ad bar pinned at
  // top:710px while its <footer> ancestor sits at y=7140 in document flow),
  // and the per-element viewport filter in captureInner would otherwise drop
  // the whole subtree. We mark every ancestor of every in-viewport fixed/
  // sticky element so captureInner knows to walk past those ancestors as
  // transparent containers. position:absolute is NOT included because absolute
  // elements are positioned relative to their containing block, so if their
  // CB ancestor's rect is offscreen, so is the absolute child.
  const _fixedAncestors = new Set();
  const _allEls = root.getElementsByTagName('*');
  for (let _i = 0; _i < _allEls.length; _i++) {
    const _el = _allEls[_i];
    const _pos = getComputedStyle(_el).position;
    if (_pos !== 'fixed' && _pos !== 'sticky') continue;
    const _r = _el.getBoundingClientRect();
    const _outside = _r.right < vp.x || _r.bottom < vp.y || _r.left > vp.x + vp.width || _r.top > vp.y + vp.height;
    if (_outside) continue;
    // Walk up and mark every ancestor up to root.
    let _cur = _el.parentElement;
    while (_cur != null && _cur !== root.parentElement) {
      if (_fixedAncestors.has(_cur)) break;
      _fixedAncestors.add(_cur);
      _cur = _cur.parentElement;
    }
  }

  // DM-587: every descendant of a transformed ancestor must escape the
  // outsideViewport early-return in captureInner. Because the per-element
  // freeze pass clears each ancestor's CSS transform before descending,
  // getBoundingClientRect on a descendant returns its NATURAL-layout
  // position (no ancestor translates / scales). For a carousel-style
  // widget where the "current slide" is brought into the viewport by a
  // parent `transform: translate(-Npx, 0)` (Stripe's connect-platform
  // payment-card-content does exactly this), the descendant's natural
  // rect is offscreen — without this set the cull drops it and the
  // renderer never sees the slide at all. The renderer re-applies the
  // saved transform when drawing, so descendants captured here will be
  // painted at the correct post-transform position.
  const _transformInfluenced = new Set();
  for (let _ti = 0; _ti < _allEls.length; _ti++) {
    const _tel = _allEls[_ti];
    const _tt = getComputedStyle(_tel).transform;
    if (_tt === 'none' || _tt === '') continue;
    // Mark the transformed element itself AND every descendant. The element
    // itself needs the exemption because its own post-transform rect may be
    // entirely outside the viewport (e.g. framer's marquee `<ul>` is
    // `transform: translateX(-1000px)` at some animation frames), and the
    // `outsideViewport` cull would drop the ul + abort recursion before its
    // (in-viewport) descendant lis ever get walked. Including the transformed
    // element keeps the recursion alive so its descendants are captured.
    // (DM-637 / framer brand-logo carousel.)
    _transformInfluenced.add(_tel);
    const _tdescs = _tel.getElementsByTagName('*');
    for (let _tj = 0; _tj < _tdescs.length; _tj++) {
      _transformInfluenced.add(_tdescs[_tj]);
    }
  }

  // DM-587: every element's cumulative ancestor scale. The live-rect capture
  // model records every rect in scaled (live) viewport coords — but text
  // metrics from `getComputedStyle.fontSize` and `canvas.measureText` are in
  // CSS px (unscaled). Inside a `transform: scale(0.7)` container, glyphs
  // would be painted at full CSS size into a scaled-down captured bbox,
  // overflowing it. Pre-compute the cumulative scale here so the captureInner
  // pass can multiply font-size + font-ascent + font-descent at capture time.
  // Walk top-down so each element sees its ancestor's already-folded scale.
  // For non-scale transforms (rotate, skew, perspective) we approximate by
  // sqrt(|a*d|) which is exact for pure scale and 1 for pure rotation — the
  // error grows for combined rotate+scale but no real-world fixture exercises
  // that on text-bearing elements. Translations contribute scale=1.
  // DM-680: cumulative ancestor scale is captured PER AXIS (sx, sy). The
  // map value is `[sx, sy]`. Geometric-mean magnitude is still used to
  // pre-scale fontSize / fontAscent / fontDescent (so the SVG re-rasterizer
  // sees Chrome-equivalent font metrics in the common uniform case). When
  // the scale is anisotropic (sx ≠ sy, e.g. `transform: scale(1.3, 0.8)`),
  // we also expose `cumScaleX` / `cumScaleY` on the captured element so the
  // renderer can wrap text in a correction `<g transform="scale(cx, cy)">`
  // pivoted around the text origin — matching how Chrome paints glyphs
  // into the post-transform device space with per-axis scaling.
  const _cumulativeScale = new Map();
  const _computeOwnScale = (_tt) => {
    if (_tt == null || _tt === 'none' || _tt === '') return [1, 1];
    const _m2 = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)/.exec(_tt);
    let _sa = 1, _sd = 1;
    if (_m2 != null) { _sa = parseFloat(_m2[1]); _sd = parseFloat(_m2[4]); }
    else {
      const _m3 = /^matrix3d\(([^)]+)\)/.exec(_tt);
      if (_m3 != null) {
        const _parts = _m3[1].split(',');
        _sa = parseFloat(_parts[0]); _sd = parseFloat(_parts[5]);
      }
    }
    if (!isFinite(_sa) || !isFinite(_sd)) return [1, 1];
    const _sx = Math.abs(_sa) > 0 ? Math.abs(_sa) : 1;
    const _sy = Math.abs(_sd) > 0 ? Math.abs(_sd) : 1;
    return [_sx, _sy];
  };
  for (let _si = 0; _si < _allEls.length; _si++) {
    const _el = _allEls[_si];
    let _cumX = 1, _cumY = 1;
    const _pe = _el.parentElement;
    if (_pe != null && _cumulativeScale.has(_pe)) {
      const _p = _cumulativeScale.get(_pe);
      _cumX = _p[0]; _cumY = _p[1];
    }
    const _ownT = getComputedStyle(_el).transform;
    if (_ownT != null && _ownT !== 'none' && _ownT !== '') {
      const _own = _computeOwnScale(_ownT);
      _cumX *= _own[0]; _cumY *= _own[1];
    }
    if (_cumX !== 1 || _cumY !== 1) _cumulativeScale.set(_el, [_cumX, _cumY]);
  }
  // Helper: read the per-axis scale for an element, defaulting to [1, 1].
  const _scaleXY = (el) => _cumulativeScale.get(el) || [1, 1];
  // Helper: geometric-mean magnitude (the value the old single-scalar code
  // used). Drives fontSize / fontAscent / fontDescent pre-scaling so the
  // SVG re-rasterizer sees Chrome-equivalent font metrics in the uniform
  // case; the renderer applies a per-axis correction transform on top when
  // sx ≠ sy.
  const _scaleMag = (el) => {
    const s = _scaleXY(el);
    return Math.sqrt(s[0] * s[1]);
  };

  // CSS counters pre-walk (DM-357). Walk the document in DOM order,
  // applying counter-reset / counter-set / counter-increment per the
  // computed style of each element, and snapshot the active counter
  // scope chain at every element. The pseudo emit loop later substitutes
  // counter(name) / counters(name, sep) tokens against this snapshot.
  // Without this, content like 'counter(section) "."' was emitted
  // verbatim — so headings rendered as just '.' instead of '1.', '2.',
  // '99.', etc. Counter scoping rules (CSS Lists & Counters Level 3):
  // counter-reset on element X creates a counter scoped to X plus all
  // descendants; counter() resolves to the innermost ancestor's value;
  // counters() joins all values along the ancestor chain (outermost first).
  const _counterSnapshot = new WeakMap();
  function _parseCounterDecl(declStr, defaultValue) {
    if (!declStr || declStr === 'none') return [];
    // Format: "name1 [num] name2 [num] ..."
    const tokens = declStr.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      const name = tokens[i++];
      if (!name) continue;
      let value = defaultValue;
      if (i < tokens.length && /^-?\d+$/.test(tokens[i])) {
        value = parseInt(tokens[i++], 10);
      }
      out.push({ name, value });
    }
    return out;
  }
  // Active counter scope stack: each entry { name, value, owner }.
  const _activeScopes = [];
  function _findInnermost(name) {
    for (let i = _activeScopes.length - 1; i >= 0; i--) {
      if (_activeScopes[i].name === name) return _activeScopes[i];
    }
    return null;
  }
  function _counterPreWalk(el) {
    const cs = window.getComputedStyle(el);
    const owned = [];
    _parseCounterDecl(cs.counterReset, 0).forEach(({name, value}) => {
      const scope = { name, value, owner: el };
      _activeScopes.push(scope);
      owned.push(scope);
    });
    // DM-705 / DM-706: CSS Lists 3 §2.3 ("Properties on a single element are
    // processed in the order reset, increment, set") — increment runs BEFORE
    // set. Our previous order (reset, set, increment) made
    // `counter-set: section 99` followed by an implicit `counter-increment:
    // section` paint as "100." instead of Chrome's "99." for the
    // `.restart` h2 in `24-counters.html`. Same off-by-one (always +1) in
    // `24-deep-counter-scope.html`.
    _parseCounterDecl(cs.counterIncrement, 1).forEach(({name, value}) => {
      const s = _findInnermost(name);
      if (s) s.value += value;
      else { const ns = { name, value, owner: el }; _activeScopes.push(ns); owned.push(ns); }
    });
    _parseCounterDecl(cs.counterSet, 0).forEach(({name, value}) => {
      const s = _findInnermost(name);
      if (s) s.value = value;
      else { const ns = { name, value, owner: el }; _activeScopes.push(ns); owned.push(ns); }
    });
    // Snapshot the active scopes (shallow copy of name+value pairs).
    _counterSnapshot.set(el, _activeScopes.map((s) => ({ name: s.name, value: s.value })));
    for (const child of el.children) _counterPreWalk(child);
    // Pop scopes owned by this element on exit (counter scope ends with the
    // owner element's subtree).
    while (_activeScopes.length > 0 && owned.length > 0
      && _activeScopes[_activeScopes.length - 1] === owned[owned.length - 1]) {
      _activeScopes.pop();
      owned.pop();
    }
  }
  _counterPreWalk(root);

  const result = [];
  // Capture the root element itself when it has visible border or background
  // (DM-362: <body style="border:3px solid pink"> was not rendering because
  // we only walked root.children). When the root has nothing visually
  // distinctive, fall through to the prior child-walk so we don't wrap
  // every page in a redundant outer rect.
  const rootCs = window.getComputedStyle(root);
  const rootHasBorder = (parseFloat(rootCs.borderTopWidth) || 0) > 0
    || (parseFloat(rootCs.borderRightWidth) || 0) > 0
    || (parseFloat(rootCs.borderBottomWidth) || 0) > 0
    || (parseFloat(rootCs.borderLeftWidth) || 0) > 0;
  const rootBg = rootCs.backgroundColor;
  const rootHasBg = rootBg != null && rootBg !== 'rgba(0, 0, 0, 0)' && rootBg !== 'transparent';
  // DM-365: invalid HTML like <p>foo<div>bar</div>baz</p> auto-closes the <p>
  // when the <div> opens, leaving "baz" as a direct text-node child of <body>.
  // Chrome paints it; we'd miss it if we only walked root.children (Element
  // children only). When the root has any direct text-node child with non-
  // whitespace content, capture root so its text-node walk picks them up.
  let rootHasDirectText = false;
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim() !== '') {
      rootHasDirectText = true;
      break;
    }
  }
  if (rootHasBorder || rootHasBg || rootHasDirectText) {
    const c = capture(root);
    if (c) result.push(c);
  } else {
    for (const child of root.children) {
      const c = capture(child);
      if (c) result.push(c);
    }
  }
  // DM-493: attach the collected mask fragment defs to the first root element
  // as a top-level payload. Renderer reads tree[0].maskDefs to emit the mask
  // defs into the output SVG.
  if (_maskDefs.size > 0 && result.length > 0) {
    result[0].maskDefs = Array.from(_maskDefs.values());
  }
  // DM-494: attach mask raster references (mask-image: element(#id)). Skip
  // null entries (display:none / zero-area / not-found targets). The post-
  // capture rasterize pass on the Node side fills in dataUri.
  if (_maskRasters.size > 0 && result.length > 0) {
    var rasterArr = [];
    for (var entry of _maskRasters.values()) {
      if (entry != null) rasterArr.push(entry);
    }
    if (rasterArr.length > 0) result[0].maskRasters = rasterArr;
  }
  // DM-552: stamp page-level dark-mode signals on the captured tree's root
  // element. The renderer reads these to emit color-scheme="dark" on the
  // root <svg> (this slice) and to source the body-bg fallback in the
  // transparent-root case (DM-554 wires up the second consumer).
  if (result.length > 0) {
    try {
      var _isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      result[0].styles.rootColorScheme = _isDark ? 'dark' : 'light';
      result[0].styles.rootBgComputed = window.getComputedStyle(document.documentElement).backgroundColor;
    } catch (_e) { /* no-op — never block capture on this */ }
  }
  return { tree: result, warnings: _warnings };
}
;
