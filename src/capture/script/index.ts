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
import { createDottedCircleDetect } from "./dotted-circle-detect.js";
import { createFontMetrics } from "./font-metrics.js";
import { createPlaceholderShown } from "./placeholder-shown.js";
import { createPseudoRules } from "./pseudo-rules.js";
import { createWarnings } from "./warnings.js";
import { createCounterStyleResolver } from "./walker/counter-style-resolver.js";
import { createCounterStylePrewalk } from "./walker/counter-prewalk.js";
import { captureInlineSvg } from "./walker/inline-svg.js";
import { computeFieldsetLegendBox } from "./walker/fieldset-legend.js";
import { detectInlineFragments } from "./walker/fragmentation.js";
import { createListsCountersHandler } from "./walker/lists-counters.js";
import { createReplacedElementsHandler } from "./walker/replaced-elements.js";
import { createMasksClipsHandler } from "./walker/masks-clips.js";
import { createFormControlsHandler } from "./walker/form-controls.js";
import { createTransformsHandler, composeEffectiveTransform } from "./walker/transforms.js";
import { createBordersBackgroundsHandler } from "./walker/borders-backgrounds.js";
import { createPseudoContentHandler } from "./walker/pseudo-content.js";
import { createInputValueHandler } from "./walker/input-value.js";
import { createTextSegmentsHandler, computeElementRaster } from "./walker/text-segments.js";
import { createPseudoInjectHandler } from "./walker/pseudo-inject.js";
import { resolveElementCursor, extractCssUrl, sideWidths } from "./utils.js";
import { parseCrossOriginAllowlist, frameHostAllowed } from "./cross-origin.js";

export const captureScript =
(args) => {
  const sel = args.sel;
  const vp = args.vp;
  // DM-1442: cross-origin <iframe> recursion allowlist (the parsed
  // `--cross-origin-frames` value, passed in as `args.cof`). null in the
  // default (Phase 1) configuration — only same-origin frames recurse then.
  const _crossOriginAllow = parseCrossOriginAllowlist(args.cof);

  // Wire up per-concern helpers. Each factory closes over its own state and
  // returns the handles captureInner / the orchestration tail call. Renamed
  // (e.g. `warnings: _warnings`) to keep captureInner's existing references
  // unchanged.
  const { normColor, normGradientColors } = createColorNorm();
  const { needsRaster, textNeedsRaster } = createEmojiDetect();
  const { markGetsDottedCircle } = createDottedCircleDetect();
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
  const { discoverMasks, discoverClipPaths, discoverFilters, maskDefs: _maskDefs, maskRasters: _maskRasters, clipPathDefs: _clipPathDefs, filterDefs: _filterDefs } = createMasksClipsHandler({ vp, warn });
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
    composeEffectiveTransform,
  });
  const { captureInputValue } = createInputValueHandler({ vp, normColor, measureFontMetrics: _measureFontMetrics });
  const { captureTextSegments } = createTextSegmentsHandler({ vp, measureFontMetrics: _measureFontMetrics, needsRaster, normColor, markGetsDottedCircle });
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
    // DM-1027: a lone combining mark (e.g. U+0300 grave in `<g>̀</g>`) lays out
    // with ZERO advance width but still paints ink — the mark's glyph extends
    // left of the origin (negative left side-bearing) at the full line height.
    // Chrome paints it, so dropping the element as "zero-sized" loses the
    // character. Keep a zero-WIDTH element that has non-zero height and
    // non-whitespace text content; truly empty / zero-HEIGHT collapsed
    // elements are still skipped.
    const _inkTextZeroWidth = rect.width === 0 && rect.height > 0
      && el.textContent != null && el.textContent.trim().length > 0;
    if (zeroSized && el.children.length === 0 && !_hasAnim && !_inkTextZeroWidth) return null;

    const tag = el.tagName.toLowerCase();

    // Emit warnings for features domotion can't fully round-trip. Keep
    // these short and actionable — consumers (CLI, tests, demo scripts) log
    // them so the fidelity gaps are self-documenting.
    const sel = shortSelector(el);
    if (cs.transform && cs.transform.startsWith('matrix3d')) {
      warn(sel, 'transform-3d', 'matrix3d/translate3d/rotate3d/perspective downgraded to 2D submatrix; z component + perspective dropped (SK-1135)');
    }
    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      warn(sel, 'backdrop-filter', 'approximated via a frosted-glass background fallback for the transparent-backdrop case (doc 19); no true backdrop blur');
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
    // DM-934: CSS `filter: url(#id)` referencing an inline SVG <filter>.
    // Collect the def so the renderer can copy it into the output SVG;
    // the existing pass-through of cs.filter as an inline style then
    // resolves against that same-document def.
    discoverFilters(el, cs, sel);
    if (cs.borderImageSource && cs.borderImageSource !== 'none') {
      warn(sel, 'border-image', '9-slice composition pending (SK-466); border-image-source ignored');
    }
    if (tag === 'canvas' || tag === 'video' || tag === 'object' || tag === 'embed') {
      warn(sel, '<' + tag + '>', 'element type is not rendered by domotion');
    } else if (tag === 'iframe') {
      // DM-1441: same-origin <iframe> documents recurse to native SVG (crisp,
      // scalable, selectable text). Only warn when the frame's document is
      // inaccessible (cross-origin under the Same-Origin Policy, or a
      // media/pixel frame) and it therefore stays a raster snapshot.
      if (_iframeIsRecursable(el) == null) {
        warn(sel, '<iframe>', 'cross-origin / inaccessible frame rendered as a static raster snapshot; same-origin frames recurse to native SVG');
      }
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
        // DM-991: textareas return per-line textSegments[] alongside the
        // single-line top-level locals; the multi-line text path consumes
        // them just like text-segments.ts emits them for regular text.
        if (_iv.textSegments != null) for (const seg of _iv.textSegments) textSegments.push(seg);
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
      svgContent = captureInlineSvg(el, cs, warn, sel);
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
      if (c) {
        // DM-1177: splice a captured `scroll-marker-group` in as a real sibling
        // of its scroller — before the scroller for `scroll-marker-group: before`,
        // after it for `after`. As a sibling it sits OUTSIDE the scroller's
        // overflow clip (Chrome paints the group outside the scrollport) and the
        // normal paint-order pass places it correctly.
        const _grp = c.scrollMarkerGroup;
        const _before = c._scrollMarkerGroupBefore;
        delete c.scrollMarkerGroup;
        delete c._scrollMarkerGroupBefore;
        // DM-1234: `::scroll-button(<dir>)` paging arrows captured as replica
        // siblings; Chrome paints them OUTSIDE the scroller's overflow clip and
        // ABOVE its content (the fixture's `z-index:1`), so emit them AFTER the
        // scroller (and after the marker group) as last-painted siblings.
        const _btns = c.scrollButtons;
        delete c.scrollButtons;
        if (_grp && _before) children.push(_grp);
        children.push(c);
        if (_grp && !_before) children.push(_grp);
        if (_btns) for (let _bi = 0; _bi < _btns.length; _bi++) children.push(_btns[_bi]);
      }
    }

    const _animId = el.dataset != null ? el.dataset.domotionAnim : undefined;
    // DM-900: author-supplied magic-move pairing key (`data-magic-key`). When
    // present on the same logical element across two animation frames, the
    // magic-move matcher force-pairs them ahead of its fingerprint heuristic.
    const _magicKey = el.dataset != null ? el.dataset.magicKey : undefined;

    // <fieldset>+<legend> box adjustment (DM-1436: extracted to walker/fieldset-legend.ts).
    const _fsBox = computeFieldsetLegendBox(el, tag, rect, vp);

    const _captured = {
      tag, text,
      x: _fsBox.x, y: _fsBox.y,
      width: _fsBox.width, height: _fsBox.height,
      fieldsetLegendNotch: _fsBox.fieldsetLegendNotch,
      animId: _animId,
      magicKey: _magicKey,
      // DM-1106: effective cursor keyword for the auto cursor-overlay hit-test.
      // Omitted when it resolves to the default arrow (the common case) to keep
      // the tree lean — the overlay treats a missing value as `default`.
      cursor: (() => { const _c = resolveElementCursor(el, cs); return _c === 'default' ? undefined : _c; })(),
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
          var _url = extractCssUrl(cs.webkitMaskBoxImageSource || '');
          if (_url == null) return undefined;
          var _img = new Image();
          _img.src = _url;
          return _img.naturalWidth || undefined;
        })(),
        maskBorderIntrinsicHeight: (function() {
          var _url = extractCssUrl(cs.webkitMaskBoxImageSource || '');
          if (_url == null) return undefined;
          var _img = new Image();
          _img.src = _url;
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
        // CSS font-variant-east-asian / -numeric / -ligatures. Each maps to a
        // set of OpenType feature tags (e.g. `traditional` → `trad`, `jis78` →
        // `jp78`, `oldstyle-nums` → `onum`) that the path renderer forwards to
        // fontkit shaping. Without these, e.g. `font-variant-east-asian:
        // traditional` paints the simplified/JP default glyph (国) instead of
        // the traditional form (國). DM-1117.
        fontVariantEastAsian: cs.fontVariantEastAsian,
        fontVariantNumeric: cs.fontVariantNumeric,
        fontVariantLigatures: cs.fontVariantLigatures,
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
        // DM-920: text-emphasis. Captured per CSS Text Decoration 3 §3.5.
        // `text-emphasis-style` resolved string ("filled circle" / "open
        // sesame" / `"★"` etc.) maps to a single mark character in the
        // renderer per Chromium's `ComputedStyle::TextEmphasisMarkString`
        // (third_party/blink/renderer/core/style/computed_style.cc:
        // kBullet U+2022 / kWhiteBullet U+25E6 / kBlackCircle U+25CF /
        // kWhiteCircle U+25CB / kFisheye U+25C9 / kBullseye U+25CE /
        // kBlackUpPointingTriangle U+25B2 / kWhiteUpPointingTriangle
        // U+25B3 / kSesameDot U+FE45 / kWhiteSesameDot U+FE46).
        textEmphasisStyle: cs.textEmphasisStyle,
        textEmphasisColor: cs.textEmphasisColor,
        textEmphasisPosition: cs.textEmphasisPosition,
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
    // Multi-fragment inline / multi-column paint detection (DM-1436: extracted to walker/fragmentation.ts).
    detectInlineFragments(el, cs, vp, _captured);

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
    // DM-1441: same-origin <iframe> recursion. When the frame's document is
    // accessible (same-origin — cross-origin contentDocument is null under the
    // SOP), walk it with the same capture logic and splice the resulting
    // subtree in as the iframe node's child, transformed into the parent's
    // coordinate space. The iframe node then becomes an overflow-clipped
    // container (its own bg/border still paint; children clip to its content
    // box) and the raster-snapshot routing below is skipped for it. See
    // docs/81-iframe-recursion.md.
    if (tag === 'iframe' && !bordersOnlyCell) {
      var _iframeNode = _captureIframeRecursion(el, cs, rect);
      if (_iframeNode != null) {
        _captured.children = [_iframeNode];
        _captured._iframeRecursed = true;
        // Clip the spliced inner document to the iframe content box. The
        // renderer overflow-clips children when overflow != visible.
        _captured.styles.overflowX = 'hidden';
        _captured.styles.overflowY = 'hidden';
      }
    }
    // Replaced-element snapshot routing — <iframe>/<canvas>/<video>/<object>/
    // <embed>, custom elements with open shadow DOM, and the CSS sprite-icon
    // image-replacement idiom. Handler mutates _captured (.replacedSnapshot,
    // .imageReplacement, and on the sprite-icon path .styles.backgroundImage /
    // .text / .textSegments). A recursed iframe (_iframeRecursed) skips the
    // snapshot path. See walker/replaced-elements.ts.
    handleReplacedElement(el, cs, tag, rect, _captured, bordersOnlyCell);
    // The recursion marker is only needed to gate handleReplacedElement; drop
    // it so it doesn't leak into the serialized tree.
    delete _captured._iframeRecursed;
    // DM-1177: CSS `scroll-marker-group` (Chrome 135+). Capture the synthesized
    // dot/pill marker-group box as a replica subtree (see _captureScrollMarkerGroup).
    // Stash it (plus its before/after placement) on the node so the PARENT's
    // children loop can splice it in as a real sibling — emitting it inside the
    // scroller's own render fights the renderer's paint-order / overflow-clip
    // machinery, so it must be a first-class tree node next to the scroller.
    if (!bordersOnlyCell) {
      var _smg = _captureScrollMarkerGroup(el, cs, rect);
      if (_smg) { _captured.scrollMarkerGroup = _smg.node; _captured._scrollMarkerGroupBefore = _smg.before; }
      var _sbtns = _captureScrollButtons(el, cs, rect);
      if (_sbtns) _captured.scrollButtons = _sbtns;
    }
    return _captured;
  };

  // DM-1177: A scroll container with `scroll-marker-group: after | before`
  // synthesizes an anonymous marker-group box, and each scrollable child whose
  // `::scroll-marker` has non-`none` content becomes a dot/pill flex item inside
  // it. The generated boxes have NO DOM node (un-measurable). To reproduce
  // Chrome's paint faithfully without reimplementing the marker-group flex
  // layout, build a hidden REPLICA from the resolved `::scroll-marker-group` /
  // `::scroll-marker` computed styles — `:target-current` is already baked into
  // the active marker's computed style by the engine — position it where Chrome
  // paints the real group (after → below the scroller, before → above it, full
  // scroller width), and walk it with the normal `capture()` so each marker is a
  // styled box (with centered text for pill labels). Chrome lays out the replica
  // identically to the real group, so the measured rects ARE Chrome's geometry.
  function _captureScrollMarkerGroup(el, cs, rect) {
    var smg = cs.scrollMarkerGroup != null && cs.scrollMarkerGroup !== ''
      ? cs.scrollMarkerGroup
      : (cs.getPropertyValue ? cs.getPropertyValue('scroll-marker-group') : '');
    if (!smg || smg.indexOf('none') === 0) return undefined;
    var position = smg.indexOf('before') === 0 ? 'before'
      : (smg.indexOf('after') === 0 ? 'after' : null);
    if (!position) return undefined;
    // One marker per child whose ::scroll-marker has real content.
    var items = [];
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var mcs = window.getComputedStyle(child, '::scroll-marker');
      var content = mcs.content;
      if (!content || content === 'none' || content === 'normal') continue;
      items.push({ mcs: mcs, content: content });
    }
    if (items.length === 0) return undefined;
    var gcs = window.getComputedStyle(el, '::scroll-marker-group');
    var doc = el.ownerDocument;
    var container = doc.createElement('div');
    var groupWidth = rect.width; // scroller border-box width
    container.style.boxSizing = 'border-box';
    container.style.position = 'absolute';
    container.style.margin = '0';
    container.style.display = gcs.display && gcs.display !== 'inline' ? gcs.display : 'flex';
    container.style.justifyContent = gcs.justifyContent || 'center';
    // DM-1257: the markers overflow the padding-height group box (see below), and
    // Chrome top-aligns them at padding-top + marker-margin from the group's TOP
    // edge for BOTH `before` and `after` (verified: `after` dots sit padTop+margin
    // below the scroller-bottom; `before` dots sit padTop+margin below the
    // before-group's top, i.e. flush against the scroller's top edge). So always
    // flex-start — default `normal`/`center` would center them in the zero-height
    // content box and mis-place the row.
    container.style.alignItems = 'flex-start';
    if (gcs.gap && gcs.gap !== 'normal') container.style.gap = gcs.gap;
    container.style.padding = gcs.padding || '0';
    container.style.background = gcs.backgroundColor || 'transparent';
    container.style.borderRadius = gcs.borderRadius || '0';
    container.style.width = groupWidth + 'px';
    container.style.left = '-99999px';
    container.style.top = '0px';
    for (var j = 0; j < items.length; j++) {
      var mc = items[j].mcs;
      var m = doc.createElement('div');
      var txt = items[j].content;
      if (txt === '""' || txt === "''") txt = '';
      else if (txt.length >= 2 && ((txt[0] === '"' && txt[txt.length - 1] === '"') || (txt[0] === "'" && txt[txt.length - 1] === "'"))) txt = txt.slice(1, -1);
      else txt = '';
      m.textContent = txt;
      m.style.boxSizing = mc.boxSizing || 'content-box';
      m.style.flex = '0 0 auto';
      // Empty content ⇒ a sized dot (author set explicit width/height). Non-empty
      // ⇒ a content-sized pill (width/height auto from text + padding).
      if (txt === '') { m.style.width = mc.width; m.style.height = mc.height; }
      m.style.borderRadius = mc.borderRadius;
      m.style.background = mc.backgroundColor;
      m.style.color = mc.color;
      // DM-1257: keep the marker's vertical margin — it offsets each dot inside
      // the group (dot-top = group padding-top + marker margin-top). Horizontal
      // margin spaces the row.
      m.style.marginTop = mc.marginTop || '0'; m.style.marginBottom = mc.marginBottom || '0';
      m.style.marginLeft = mc.marginLeft || '0'; m.style.marginRight = mc.marginRight || '0';
      m.style.padding = mc.padding;
      m.style.fontSize = mc.fontSize;
      m.style.fontWeight = mc.fontWeight;
      m.style.fontFamily = mc.fontFamily;
      m.style.lineHeight = mc.lineHeight;
      m.style.display = mc.display && mc.display !== 'inline' ? mc.display : 'inline-block';
      if (mc.transform && mc.transform !== 'none') m.style.transform = mc.transform;
      if (mc.transformOrigin) m.style.transformOrigin = mc.transformOrigin;
      var bw = parseFloat(mc.borderTopWidth || '0') || 0;
      if (bw > 0) {
        m.style.borderStyle = mc.borderTopStyle; m.style.borderWidth = mc.borderTopWidth; m.style.borderColor = mc.borderTopColor;
      }
      container.appendChild(m);
    }
    // DM-1257: Chrome's generated `::scroll-marker-group` box is PADDING-height —
    // its content height is ~0 and the markers OVERFLOW it (verified with a
    // contrast probe: the group background spans exactly [scroller-border-edge,
    // edge + padding-top + padding-bottom], while the dots sit at padding-top +
    // marker-margin and hang past the box). The box's outer edge is flush against
    // the scroller's border-box edge (top edge at `rect.bottom` for `after`,
    // bottom edge at `rect.top` for `before`). Force the replica to that geometry:
    // padding-only height with overflow visible, so the captured group bg rect
    // matches Chrome AND the captured marker rects land where Chrome paints them.
    // (The earlier `rect.bottom - padTop` + full-flex-height model painted the
    // dots ~16px too high and the bg band the wrong length.)
    var padTop = parseFloat(gcs.paddingTop || '0') || 0;
    var padBottom = parseFloat(gcs.paddingBottom || '0') || 0;
    var groupBoxH = padTop + padBottom;
    container.style.height = groupBoxH + 'px';
    container.style.overflow = 'visible';
    doc.body.appendChild(container);
    var targetTop = position === 'after' ? rect.bottom : (rect.top - groupBoxH);
    container.style.left = (rect.left + window.scrollX) + 'px';
    container.style.top = (targetTop + window.scrollY) + 'px';
    var node = capture(container);
    doc.body.removeChild(container);
    if (!node) return undefined;
    return { node: node, before: position === 'before' };
  }

  // DM-1234: CSS `::scroll-button(<dir>)` paging arrows (Chrome 135+). Like the
  // marker-group these are generated boxes with NO DOM node, and — crucially —
  // Chrome lays them out against the INITIAL CONTAINING BLOCK (the viewport),
  // NOT the scroller's `position:relative` ancestor: `top:50%` resolves to 50%
  // of the viewport height and `left`/`right` to insets from the viewport edges
  // (verified by probe-and-match against Chrome's painted output across two
  // viewport heights — the button center tracked 50%·viewportHeight while the
  // scroller stayed put). `getComputedStyle(el, '::scroll-button(left)')` can't
  // disambiguate the parameterized pseudo — it returns ONE merged style (the
  // box props are shared, but `content` is the cascade-last value and both
  // insets are reported) — so the per-side `content` + the `:disabled`
  // declarations are read from the author stylesheet (CSSOM). Geometry is then
  // resolved the same trick the marker-group uses: an absolutely-positioned
  // replica appended to <body> ALSO takes the ICB as its containing block, so
  // `top:50%`/`left`/`right`/`transform` land exactly where Chrome paints the
  // real button — capture() measures that, so the rect IS Chrome's geometry.
  // Enabled/disabled comes from the captured scroll offset vs the scroll range.
  function _scrollButtonAuthorRules(el) {
    // Per-direction author declarations + the merged `:disabled` declarations,
    // gathered from every stylesheet rule whose `::scroll-button(<dir>)`
    // selector matches `el`. `*` (universal direction) is folded in as a base.
    var sides = {}; var disabled = {}; var star = {};
    var sheets = el.ownerDocument.styleSheets;
    for (var s = 0; s < sheets.length; s++) {
      var rules;
      try { rules = sheets[s].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var sel = rule.selectorText;
        if (!sel) continue;
        var at = sel.indexOf('::scroll-button(');
        if (at < 0) continue;
        var close = sel.indexOf(')', at);
        if (close < 0) continue;
        var dir = sel.slice(at + 16, close).trim();
        var base = sel.slice(0, at).trim();
        var matches = false;
        try { matches = base === '' || el.matches(base); } catch (e) { matches = false; }
        if (!matches) continue;
        var isDisabled = sel.slice(close + 1).indexOf(':disabled') >= 0;
        var bucket = isDisabled ? disabled : (dir === '*' ? star : (sides[dir] || (sides[dir] = {})));
        var decl = rule.style;
        for (var d = 0; d < decl.length; d++) bucket[decl[d]] = decl.getPropertyValue(decl[d]);
      }
    }
    // Fold the universal `*` declarations in as a lower-priority base per side.
    for (var k in sides) {
      if (!Object.prototype.hasOwnProperty.call(sides, k)) continue;
      var merged = {};
      for (var sp in star) if (Object.prototype.hasOwnProperty.call(star, sp)) merged[sp] = star[sp];
      for (var op in sides[k]) if (Object.prototype.hasOwnProperty.call(sides[k], op)) merged[op] = sides[k][op];
      sides[k] = merged;
    }
    return { sides: sides, disabled: disabled };
  }

  function _captureScrollButtons(el, cs, rect) {
    // Cheap gate: only elements that actually generate a scroll-button get the
    // CSSOM scan. A non-`none` `content` on the merged pseudo means buttons exist.
    var probe = window.getComputedStyle(el, '::scroll-button(left)').content;
    if (!probe || probe === 'none' || probe === 'normal') {
      probe = window.getComputedStyle(el, '::scroll-button(right)').content;
      if (!probe || probe === 'none' || probe === 'normal') return undefined;
    }
    var rules = _scrollButtonAuthorRules(el);
    var doc = el.ownerDocument;
    var maxX = el.scrollWidth - el.clientWidth;
    var maxY = el.scrollHeight - el.clientHeight;
    var nodes = [];
    for (var dir in rules.sides) {
      if (!Object.prototype.hasOwnProperty.call(rules.sides, dir)) continue;
      var decls = rules.sides[dir];
      var isDisabled = false;
      if (dir === 'left' || dir === 'inline-start') isDisabled = el.scrollLeft <= 0;
      else if (dir === 'right' || dir === 'inline-end') isDisabled = el.scrollLeft >= maxX - 1;
      else if (dir === 'up' || dir === 'block-start') isDisabled = el.scrollTop <= 0;
      else if (dir === 'down' || dir === 'block-end') isDisabled = el.scrollTop >= maxY - 1;
      var btn = doc.createElement('div');
      var content = '';
      for (var p in decls) {
        if (!Object.prototype.hasOwnProperty.call(decls, p)) continue;
        if (p === 'content') { content = decls[p]; continue; }
        try { btn.style.setProperty(p, decls[p]); } catch (e) { /* unsupported prop */ }
      }
      if (isDisabled) {
        for (var dp in rules.disabled) {
          if (!Object.prototype.hasOwnProperty.call(rules.disabled, dp)) continue;
          try { btn.style.setProperty(dp, rules.disabled[dp]); } catch (e) { /* unsupported */ }
        }
      }
      // Match the real button's containing block (ICB) by living on <body> as an
      // absolutely-positioned box; the author's left/right/top/transform then
      // resolve against the viewport exactly as Chrome resolves them.
      if (!btn.style.position || btn.style.position === 'static') btn.style.position = 'absolute';
      btn.style.margin = '0';
      // Only a quoted string `content` becomes a text glyph. DM-1248: a `url()` /
      // counter() / image content value is NOT text — set no glyph rather than
      // rendering the literal CSS string (e.g. `url("x.png")`) as garbage text.
      // (Faithful image-content rendering is a tracked TODO in DM-1248.)
      var txt = '';
      if (content.length >= 2 && ((content[0] === '"' && content[content.length - 1] === '"') || (content[0] === "'" && content[content.length - 1] === "'"))) {
        txt = content.slice(1, -1);
      }
      btn.textContent = txt;
      doc.body.appendChild(btn);
      var node = capture(btn);
      doc.body.removeChild(btn);
      if (node) nodes.push(node);
    }
    return nodes.length ? nodes : undefined;
  }

  // DM-1441: is this frame cross-origin relative to the top document? Under the
  // Same-Origin Policy a cross-origin `contentDocument` is null, so in the
  // default (no browser flags) configuration this only ever returns false for
  // genuinely accessible frames. It exists so that if a frame's document is
  // readable ONLY because web security was disabled (the planned
  // `--cross-origin-frames` path), Phase-1 same-origin recursion refuses to
  // recurse it until the allowlist gate is wired. srcdoc / about:blank report
  // origin "null" (or inherit the embedder) — treated as same-origin.
  function _frameIsCrossOrigin(el) {
    try {
      var w = el.contentWindow;
      if (w == null) return true;
      var o = w.location && w.location.origin;
      if (o == null || o === '' || o === 'null') return false;
      return o !== location.origin;
    } catch (e) {
      return true;
    }
  }

  // DM-1442: is a cross-origin frame permitted by the `--cross-origin-frames`
  // allowlist? Matched against the frame's CURRENT origin (readable here only
  // because web security was disabled to make the document accessible),
  // falling back to the `src` attribute. null allowlist ⇒ never (Phase 1).
  function _crossOriginFrameAllowed(el) {
    if (_crossOriginAllow == null) return false;
    var url;
    try { url = el.contentWindow && el.contentWindow.location ? el.contentWindow.location.href : el.src; }
    catch (e) { url = el.src; }
    return frameHostAllowed(url || '', _crossOriginAllow);
  }

  // DM-1441 / DM-1442: the accessible document of an <iframe> we may recurse, or
  // null when the frame can't be recursed (cross-origin and not allowlisted,
  // not yet loaded, a media/pixel frame with no DOM, or access throws). Used
  // both to gate the recursion and to decide whether to emit the "rendered as a
  // raster" warning.
  function _iframeIsRecursable(el) {
    if (el.tagName == null || el.tagName.toLowerCase() !== 'iframe') return null;
    var doc;
    try { doc = el.contentDocument; } catch (e) { return null; }
    if (doc == null || doc.body == null || doc.documentElement == null) return null;
    // Same-origin frames always recurse (Phase 1). A cross-origin frame is only
    // reachable here when web security was disabled (the --cross-origin-frames
    // path); recurse it only when its origin is on the allowlist, else leave it
    // as the raster snapshot. (DM-1442)
    if (_frameIsCrossOrigin(el) && !_crossOriginFrameAllowed(el)) return null;
    return doc;
  }

  // DM-1441: walk a same-origin iframe's document into a native-SVG subtree in
  // the parent's coordinate space. Rather than offsetting every captured
  // coordinate field after the fact, we shift the SHARED `vp` origin for the
  // duration of the inner walk: every capture helper reads `vp.x`/`vp.y` live,
  // so the inner subtree comes out already positioned at the iframe's content
  // box AND the viewport cull tests inner content against the real painted
  // region. The shift composes correctly for nested iframes (each inner rect is
  // relative to its own frame's viewport, so successive shifts accumulate the
  // content-box origins down the chain). Returns the inner <html> node, or
  // undefined when the frame isn't recursable.
  function _captureIframeRecursion(el, cs, rect) {
    var doc = _iframeIsRecursable(el);
    if (doc == null) return undefined;
    // Content-box top-left of the iframe in top-document client coords. The
    // inner document's own viewport origin (0,0) sits here, so adding it to the
    // inner rects places them in the parent's space.
    var bsw = sideWidths(cs, 'border', 'Width');
    var dx = rect.left + bsw.left + (parseFloat(cs.paddingLeft) || 0);
    var dy = rect.top + bsw.top + (parseFloat(cs.paddingTop) || 0);
    var savedX = vp.x, savedY = vp.y;
    vp.x = savedX - dx;
    vp.y = savedY - dy;
    var node;
    try {
      node = capture(doc.documentElement);
    } catch (e) {
      node = undefined;
    } finally {
      vp.x = savedX;
      vp.y = savedY;
    }
    return node == null ? undefined : node;
  }

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

  // DM-770: collect `@counter-style` rule definitions from all stylesheets into
  // the shared `_counterStyles` map, so the lists-counters / pseudo-content
  // walkers can resolve `list-style-type: <custom-name>` and `counter(name,
  // style)` markers per system. Chrome doesn't expose the resolved marker via
  // `getComputedStyle(li, '::marker').content`, so the resolver re-implements
  // the CSS algorithm against this map. (Parser + walker extracted to
  // walker/counter-prewalk.ts — DM-1086.)
  createCounterStylePrewalk({ counterStyles: _counterStyles })();

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
  // DM-934: same shape — inline <filter> defs referenced by CSS `filter:
  // url(#id)`. The renderer copies these into the output SVG and the
  // existing pass-through of cs.filter as an inline style on the wrapping
  // group references them.
  if (_filterDefs.size > 0 && result.length > 0) {
    result[0].filterDefs = Array.from(_filterDefs.values());
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
      var _docCs = window.getComputedStyle(document.documentElement);
      result[0].styles.rootBgComputed = _docCs.backgroundColor;
      // DM-1244: <html>'s overflow decides whether <body>'s overflow propagates
      // to the viewport (it only does when <html> is `overflow: visible`). The
      // renderer needs it to know whether to apply <body>'s own overflow clip.
      result[0].styles.rootOverflowX = _docCs.overflowX;
      result[0].styles.rootOverflowY = _docCs.overflowY;
    } catch (_e) { /* no-op — never block capture on this */ }
  }
  return { tree: result, warnings: _warnings };
}
;
