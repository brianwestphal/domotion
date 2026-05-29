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
import { createCounterStyleResolver } from "./walker/counter-style-resolver.js";
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
  const { normColor, normGradientColors } = createColorNorm();
  const { needsRaster, textNeedsRaster } = createEmojiDetect();
  const { measureFontMetrics: _measureFontMetrics, substituteAliasedFamilies: _substituteAliasedFamilies } = createFontMetrics();
  const { resolvePlaceholderShownBg: _resolvePlaceholderShownBg } = createPlaceholderShown();
  const { resolvePseudo: _resolvePseudo, resolveCornerRadius: _resolveCornerRadius } = createPseudoRules();
  const { warn, shortSelector, warnings: _warnings } = createWarnings();
  // DM-770: counter-style map is populated by the pre-walk below (which
  // reads @counter-style rules from document.styleSheets); declared here so
  // the lists-counters and pseudo-content handlers close over the same
  // object reference via the shared counter-style resolver.
  const _counterStyles = {};
  const { resolveCounterStyle, resolveCounterValue, isCustomCounterStyle } = createCounterStyleResolver({ counterStyles: _counterStyles });
  const { captureListsCounters } = createListsCountersHandler({ normColor, resolveCounterStyle, isCustomCounterStyle });
  const { handleReplacedElement } = createReplacedElementsHandler({ vp });
  const { discoverMasks, discoverClipPaths, maskDefs: _maskDefs, maskRasters: _maskRasters, clipPathDefs: _clipPathDefs } = createMasksClipsHandler({ vp, warn });
  const { captureFormControls } = createFormControlsHandler({ normColor, resolvePseudo: _resolvePseudo });
  const { wrapWithFrozenTransform, threadFrozenTransform } = createTransformsHandler();
  const { captureBordersBackgrounds } = createBordersBackgroundsHandler({
    normColor,
    normGradientColors,
    resolvePlaceholderShownBg: _resolvePlaceholderShownBg,
    resolveCornerRadius: _resolveCornerRadius,
  });
  const { capturePseudoContent } = createPseudoContentHandler({
    vp,
    normColor,
    measureFontMetrics: _measureFontMetrics,
    textNeedsRaster,
    resolveCounterValue,
    isCustomCounterStyle,
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

    // DM-750: `content-visibility: hidden` skips paint AND layout of the
    // subtree; Chrome treats the element as a sized placeholder (driven by
    // `contain-intrinsic-size`) with no visible children. `getBoundingClientRect`
    // on the host still returns the placeholder box, but child rects would
    // re-trigger layout if asked, producing rects that don't match what Chrome
    // actually paints. Capture the host (so background / border / placeholder
    // box land in the output) but drop the entire subtree's text + children.
    // `content-visibility: auto` is handled implicitly — Chrome paints in-
    // viewport `auto` sections normally, and the live-rect capture inherits
    // that. Out-of-viewport `auto` sections are already culled by the captured
    // viewport's bbox filter.
    const _contentVisHidden = cs.contentVisibility === 'hidden';

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
    // DM-826: clip-path: url("#id") same-document fragment refs. Sibling of
    // the mask discovery above; collects inline <clipPath> defs the
    // renderer copies into the output SVG. See docs/39.
    discoverClipPaths(el, cs, sel);
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
    // DM-750: content-visibility:hidden hides the host's subtree, which
    // includes generated content from ::before / ::after. Skip the pseudo
    // capture too so the placeholder host is just an empty rect.
    const _pcResult = _contentVisHidden
      ? { pseudoSegments: [], pseudoBoxes: [] }
      : capturePseudoContent(el, cs, rect, _counterSnapshot);
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
    if (tag !== 'svg' && tag !== 'img' && !textIsHiddenFallback && !_contentVisHidden) {
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
      svgContent = clone.outerHTML;
    }

    const children = [];
    // DM-750: see the `content-visibility: hidden` note above — capture the
    // host's own box (background / border / placeholder) but drop the subtree
    // entirely. Skip the whole `for (child of el.children)` loop so neither
    // children nor their text gets pushed.
    if (_contentVisHidden) {
      // fall through to the rest of the capture with `children = []`.
    } else
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
    // DM-900: author-supplied magic-move pairing key (`data-magic-key`). When
    // present on the same logical element across two animation frames, the
    // magic-move matcher force-pairs them ahead of its fingerprint heuristic.
    const _magicKey = el.dataset != null ? el.dataset.magicKey : undefined;

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
      magicKey: _magicKey,
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
        // DM-761: `overflow-clip-margin` extends the overflow clip outward
        // from a reference box (content / padding / border) by a length.
        // Only meaningful for `overflow: clip`; `hidden` ignores it. Captured
        // as the resolved string ("20px" / "content-box 12px") so the renderer
        // can parse the reference-box keyword + length together.
        overflowClipMargin: cs.overflowClipMargin || undefined,
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
        maskClip: cs.maskClip || cs.webkitMaskClip || 'border-box',
        // DM-758: `mask-border-source` / legacy `-webkit-mask-box-image`. Chrome
        // exposes only the legacy webkit name; modern `maskBorderSource`
        // returns undefined. Capture source + slice / width / outset so the
        // renderer can decide whether to route through the simplified
        // full-element mask path (only safe when width / outset both `0`).
        maskBorderSource: cs.webkitMaskBoxImageSource && cs.webkitMaskBoxImageSource !== 'none'
          ? cs.webkitMaskBoxImageSource
          : undefined,
        maskBorderSlice: cs.webkitMaskBoxImageSlice || undefined,
        maskBorderWidth: cs.webkitMaskBoxImageWidth || undefined,
        maskBorderOutset: cs.webkitMaskBoxImageOutset || undefined,
        // DM-793: legacy `-webkit-mask-box-image-repeat` keyword (stretch /
        // repeat / round / space) per axis. Mirrors `border-image-repeat`.
        maskBorderRepeat: cs.webkitMaskBoxImageRepeat || undefined,
        // DM-793: intrinsic dimensions of the mask-border-source raster /
        // SVG asset. Same probe pattern as `borderImageIntrinsic*` — a
        // detached `<img>` resolves the URL against the document base and
        // reports `naturalWidth` / `naturalHeight` for raster sources and
        // the `<svg width/height>` attributes (or viewBox-derived size) for
        // SVG sources. Captured at capture time so the renderer can compute
        // 9-slice source rects without re-fetching the asset.
        maskBorderIntrinsicWidth: (function() {
          var _m = /^url\((?:"|')?([^"')]+)/.exec(cs.webkitMaskBoxImageSource || '');
          if (_m == null) return undefined;
          var _img = new Image();
          _img.src = _m[1];
          return _img.naturalWidth || undefined;
        })(),
        maskBorderIntrinsicHeight: (function() {
          var _m = /^url\((?:"|')?([^"')]+)/.exec(cs.webkitMaskBoxImageSource || '');
          if (_m == null) return undefined;
          var _img = new Image();
          _img.src = _m[1];
          return _img.naturalHeight || undefined;
        })(),
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
        textUnderlinePosition: cs.textUnderlinePosition,
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
    // Elements that fragment into multiple paint boxes need per-fragment
    // paint of background + border, not a single rect covering the bbox
    // (the bbox is the union of every fragment and produces an over-wide /
    // over-tall shape that paints across the gap between fragments).
    // Trigger when:
    //   1. The element has a non-transparent background OR a non-zero border
    //      width on any side, AND
    //   2. `el.getClientRects()` returns more than one rect, AND
    //   3. The element is either
    //      (a) `display: inline` and wrapped onto multiple lines, OR
    //      (b) DM-754: block-level (block / list-item / flex / grid /
    //          flow-root) inside a multi-column container ancestor —
    //          `column-count > 1` or `column-width: <length>` — where a
    //          tall block fragments at the column boundary.
    // Without the `display` / ancestor-column guard we'd trip on table cells
    // and other layouts where Chrome legitimately reports multiple client
    // rects for an axis-aligned bbox (e.g. SVG paint shapes); restrict to
    // the two known fragmentation cases.
    //
    // The renderer reads `inlineFragments`, detects axis from frag geometry
    // (block-axis when fragments stack vertically, inline-axis when they
    // stack horizontally), and walks per-fragment with the right
    // `box-decoration-break` slice/clone semantics for that axis.
    {
      var _bgC = _captured.styles.backgroundColor;
      var _hasBg = _bgC != null && _bgC !== '' && _bgC !== 'transparent' && _bgC !== 'rgba(0, 0, 0, 0)';
      var _hasBgImage = _captured.styles.backgroundImage != null
        && _captured.styles.backgroundImage !== '' && _captured.styles.backgroundImage !== 'none';
      var _btw = parseFloat(_captured.styles.borderTopWidth || '0') || 0;
      var _brw = parseFloat(_captured.styles.borderRightWidth || '0') || 0;
      var _bbw = parseFloat(_captured.styles.borderBottomWidth || '0') || 0;
      var _blw = parseFloat(_captured.styles.borderLeftWidth || '0') || 0;
      var _hasBorder = _btw > 0 || _brw > 0 || _bbw > 0 || _blw > 0;
      var _hasPaint = _hasBg || _hasBgImage || _hasBorder;
      var _isInline = cs.display === 'inline';
      var _isBlockLevel = !_isInline && (
        cs.display === 'block' || cs.display === 'list-item' || cs.display === 'flex'
        || cs.display === 'grid' || cs.display === 'flow-root'
        || cs.display === 'inline-block' || cs.display === 'inline-flex' || cs.display === 'inline-grid'
      );
      var _inMultiColumn = false;
      if (_isBlockLevel && _hasPaint) {
        // Walk ancestors looking for a multi-column container. `column-count`
        // is the most common; `column-width: <length>` also creates columns.
        // Stop at <body> (no column container above that level in practice).
        var _a = el.parentElement;
        while (_a != null) {
          var _ac = window.getComputedStyle(_a);
          var _cc = parseInt(_ac.columnCount, 10);
          var _cw = _ac.columnWidth;
          if ((Number.isFinite(_cc) && _cc > 1) || (_cw != null && _cw !== 'auto' && _cw !== '' && _cw !== 'normal')) {
            _inMultiColumn = true;
            break;
          }
          if (_a === document.body) break;
          _a = _a.parentElement;
        }
      }
      // DM-937: detect "inline-with-block-descendant" — an inline element
      // (e.g. a `<label>`) that wraps a block-level child (`display:block`
      // /list-item/flex/grid). Per CSS 2.1 §9.2.1.1 Chrome inserts
      // "anonymous block boxes" around the block-level descendants and
      // fragments the inline accordingly, but the painted border on each
      // resulting fragment looks like a CLONE box (all four corners
      // rounded, all four sides drawn) rather than the inline-axis SLICE
      // semantics (first owns left, last owns right). Fixture: the .drop
      // label in 06-forms-style-file with `border-radius: 10px` and
      // `<strong>`/`<small>` block children — Chrome paints each
      // fragment as a self-contained rounded box.
      var _hasBlockDescendant = false;
      if (_isInline && _hasPaint) {
        var _stack = [el];
        while (_stack.length > 0) {
          var _n = _stack.pop();
          var _kids = _n.children;
          for (var _ki = 0; _ki < _kids.length; _ki++) {
            var _k = _kids[_ki];
            var _kd = window.getComputedStyle(_k).display;
            if (_kd === 'block' || _kd === 'list-item' || _kd === 'flex' || _kd === 'grid' || _kd === 'flow-root' || _kd === 'table') {
              _hasBlockDescendant = true;
              break;
            }
            _stack.push(_k);
          }
          if (_hasBlockDescendant) break;
        }
      }
      if (_hasPaint && (_isInline || _inMultiColumn)) {
        var _cr = el.getClientRects();
        if (_cr != null && _cr.length > 1) {
          var _frags = [];
          for (var _ci = 0; _ci < _cr.length; _ci++) {
            var _f = _cr[_ci];
            // Skip zero-area fragments — Chrome occasionally emits these for
            // empty trailing inline runs.
            if (_f.width <= 0 || _f.height <= 0) continue;
            _frags.push({
              x: _f.left - vp.x,
              y: _f.top - vp.y,
              width: _f.width,
              height: _f.height,
            });
          }
          if (_frags.length > 1) {
            _captured.inlineFragments = _frags;
            // DM-754: stash the fragmentation axis derived from `display`.
            // Inline-wrap (e.g. `<span>` wrapping across line boxes) slices
            // horizontally — first owns the left side, last owns the right.
            // Block-level fragmentation inside a multi-column container
            // slices vertically — first owns the top, last owns the bottom.
            // Both axes produce vertically-stacked frag rects so we can't
            // distinguish them geometrically at render time.
            _captured.fragmentAxis = _isInline ? 'inline' : 'block';
            // DM-937: when the inline has block-level descendants, Chrome
            // paints each fragment as a complete rounded box (every side,
            // every corner) — equivalent to `box-decoration-break: clone`
            // — rather than the inline-axis slice it normally uses. Force
            // clone here so the renderer's per-fragment path keeps all
            // sides + corners. Author-set `box-decoration-break: slice` is
            // overridden (rare in practice — the painted look in Chrome
            // wins per the project's fidelity rule).
            if (_hasBlockDescendant) {
              _captured.styles.boxDecorationBreak = 'clone';
            }
          }
        }
      }
    }

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
    const _ownCs = getComputedStyle(_el);
    const _ownT = _ownCs.transform;
    if (_ownT != null && _ownT !== 'none' && _ownT !== '') {
      const _own = _computeOwnScale(_ownT);
      _cumX *= _own[0]; _cumY *= _own[1];
    }
    // DM-755: CSS `zoom` is a legacy WebKit / IE property that Chrome still
    // honors as a real layout-affecting scaler. `getComputedStyle().zoom`
    // returns the resolved factor as a string ("1", "0.5", "2", "1.5" for
    // 150%, "reset"); `getBoundingClientRect()` already includes the zoom
    // in coordinates, but `getComputedStyle()` returns `fontSize` /
    // `padding` etc. in PRE-zoom CSS pixels. Folding zoom into the same
    // cumulative scale that handles `transform: scale()` re-uses the
    // downstream `fontSize × cum` and `cumScaleX / cumScaleY` correction
    // wrappers — text inside a `zoom: 2` box gets painted at 2× the
    // captured font size, matching Chrome's effective paint.
    const _ownZ = parseFloat(_ownCs.zoom);
    if (Number.isFinite(_ownZ) && _ownZ > 0 && _ownZ !== 1) {
      _cumX *= _ownZ; _cumY *= _ownZ;
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

  // DM-770: collect `@counter-style` rule definitions from all stylesheets
  // so the lists-counters walker can resolve `list-style-type: <custom-name>`
  // to the right symbol per system (cyclic / fixed / numeric / alphabetic /
  // symbolic / additive) plus prefix / suffix / pad / negative / range /
  // fallback / extends descriptors. Chrome doesn't expose the resolved
  // marker string via `getComputedStyle(li, '::marker').content` (returns
  // "normal" even when the resolved marker is a custom symbol) so we
  // re-implement the resolution algorithm against the captured rule map.
  function _parseStringList(s) {
    // CSS string list — sequence of "double-quoted" strings (CSS escapes any
    // quote char). Whitespace-separated. Returns array of unescaped strings.
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      const q = s[i];
      if (q !== '"' && q !== "'") {
        // Unquoted identifier (used by symbol shortcuts in some browsers).
        let j = i;
        while (j < s.length && !/\s/.test(s[j])) j++;
        out.push(s.slice(i, j));
        i = j;
        continue;
      }
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\' && j + 1 < s.length) {
          // CSS escape: \HHHHHH (hex) or \char.
          const hex = /^\\([0-9a-fA-F]{1,6})\s?/.exec(s.slice(j));
          if (hex != null) {
            val += String.fromCodePoint(parseInt(hex[1], 16));
            j += hex[0].length;
            continue;
          }
          val += s[j + 1];
          j += 2;
        } else {
          val += s[j];
          j++;
        }
      }
      out.push(val);
      i = j + 1;
    }
    return out;
  }
  function _parseAdditiveSymbols(s) {
    // `additive-symbols: 10 "X", 9 "IX", 5 "V", ...`
    // Comma-separated weight + symbol pairs. Returns array sorted by weight
    // descending (largest first — required by the additive algorithm).
    const out = [];
    for (const tok of s.split(',')) {
      const m = /(-?\d+)\s+(.+)/.exec(tok.trim());
      if (m == null) continue;
      const weight = parseInt(m[1], 10);
      const sym = _parseStringList(m[2])[0] ?? '';
      out.push({ weight, sym });
    }
    out.sort((a, b) => b.weight - a.weight);
    return out;
  }
  function _walkRulesForCounterStyles(rules) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      // CSSCounterStyleRule.type === 11. Also covered by `instanceof
      // CSSCounterStyleRule` in modern browsers — both forms work.
      if (rule.type === 11 || (window.CSSCounterStyleRule != null && rule instanceof window.CSSCounterStyleRule)) {
        const name = rule.name;
        if (!name) continue;
        let extendsName;
        let sys = rule.system || 'symbolic';
        // `system: extends upper-roman` → sys == "extends upper-roman".
        const extMatch = /^extends\s+(\S+)/.exec(sys);
        if (extMatch) {
          extendsName = extMatch[1];
          sys = 'extends';
        } else {
          // `system: cyclic`, `system: fixed [N]`, etc. Strip the keyword.
          const sysMatch = /^(cyclic|numeric|alphabetic|symbolic|fixed|additive)\b/.exec(sys);
          sys = sysMatch ? sysMatch[1] : 'symbolic';
        }
        const symbols = rule.symbols ? _parseStringList(rule.symbols) : [];
        const additiveSymbols = rule.additiveSymbols ? _parseAdditiveSymbols(rule.additiveSymbols) : [];
        const prefix = rule.prefix ? (_parseStringList(rule.prefix)[0] ?? '') : '';
        // Default suffix is ". " for most systems per the CSS spec; Chrome
        // returns the empty string when no `suffix` descriptor is set. Treat
        // empty as default.
        const suffix = rule.suffix ? (_parseStringList(rule.suffix)[0] ?? '. ') : '. ';
        const negativeRaw = rule.negative;
        let negPrefix = '-';
        let negSuffix = '';
        if (negativeRaw) {
          const nlist = _parseStringList(negativeRaw);
          negPrefix = nlist[0] ?? '-';
          if (nlist.length > 1) negSuffix = nlist[1];
        }
        let padLen = 0;
        let padSym = '';
        if (rule.pad) {
          const pm = /^\s*(\d+)\s+(.+)$/.exec(rule.pad);
          if (pm != null) {
            padLen = parseInt(pm[1], 10);
            padSym = _parseStringList(pm[2])[0] ?? '';
          }
        }
        let rangeLo = -Infinity;
        let rangeHi = Infinity;
        if (rule.range && rule.range !== 'auto') {
          // "infinite infinite" or "1 39" or "-3 5" etc.
          const rm = /(-?\d+|infinite)\s+(-?\d+|infinite)/.exec(rule.range);
          if (rm != null) {
            rangeLo = rm[1] === 'infinite' ? -Infinity : parseInt(rm[1], 10);
            rangeHi = rm[2] === 'infinite' ? Infinity : parseInt(rm[2], 10);
          }
        }
        const fallback = rule.fallback || 'decimal';
        _counterStyles[name] = { system: sys, symbols, additiveSymbols, prefix, suffix, negPrefix, negSuffix, padLen, padSym, rangeLo, rangeHi, fallback, extendsName };
      } else if (rule.cssRules) {
        // @media / @supports / @layer — walk nested rule lists.
        _walkRulesForCounterStyles(rule.cssRules);
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      _walkRulesForCounterStyles(sheet.cssRules);
    } catch (e) {
      // CORS-protected stylesheets throw on .cssRules access. Skip silently.
    }
  }

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
  // DM-855: also capture the root when it carries a gradient/image background,
  // not just a solid color. `backgroundColor` is `transparent` for a
  // gradient-only <body>, so checking it alone made us skip capturing the root
  // element and drop its background entirely. Treating a non-`none`
  // `background-image` as "has background" captures the root as a normal
  // element, routing its gradient through the existing element-gradient path.
  const rootBgImage = rootCs.backgroundImage;
  const rootHasBgImage = rootBgImage != null && rootBgImage !== 'none' && rootBgImage !== '';
  const rootHasBg = (rootBg != null && rootBg !== 'rgba(0, 0, 0, 0)' && rootBg !== 'transparent') || rootHasBgImage;
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
  // DM-826: same shape as maskDefs above — top-level collection of inline
  // <clipPath> defs the renderer emits into the output SVG. See docs/39.
  if (_clipPathDefs.size > 0 && result.length > 0) {
    result[0].clipPathDefs = Array.from(_clipPathDefs.values());
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
