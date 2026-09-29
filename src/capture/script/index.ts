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
// walker handlers live under `./walker/`. `walker/capture-phases.ts` owns the
// geometry/style admission, pseudo/closed-shadow normalization, child
// traversal, and final result-assembly boundaries. This file keeps the
// remaining content/style record body and top-level orchestration
// (fixed-ancestor pre-pass, counter pre-walk, root-element capture, mask-def +
// dark-mode attachment to the result tree).

import { createColorNorm } from "./color-norm.js";
import { createEmojiDetect } from "./emoji-detect.js";
import { createDottedCircleDetect } from "./dotted-circle-detect.js";
import { createFontMetrics } from "./font-metrics.js";
import { createPlaceholderShown } from "./placeholder-shown.js";
import { createFontFamilyDefault } from "./font-family-default.js";
import { collectFontFeatureValues } from "./font-feature-values.js";
import { createFontPaletteResolver } from "./font-palette.js";
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
import { createTransformsHandler, composeEffectiveTransform, transformHasRotationOrSkew } from "./walker/transforms.js";
import {
  createBordersBackgroundsHandler,
  physicalComputedGradientImage,
  physicalComputedTileSize as physicalComputedCssPixelTerms,
} from "./walker/borders-backgrounds.js";
import { createBackgroundAttachmentHandler } from "./walker/background-attachment.js";
import { createPseudoContentHandler } from "./walker/pseudo-content.js";
import { createInputValueHandler } from "./walker/input-value.js";
import { createTextSegmentsHandler, computeElementRaster } from "./walker/text-segments.js";
import { createPseudoInjectHandler } from "./walker/pseudo-inject.js";
import { createResizeHandleHandler } from "./walker/resize-handle.js";
import {
  assembleCaptureResultPhase,
  captureGeometryStylePhase,
  captureTraversalPhase,
} from "./walker/capture-phases.js";
import { createLineClampHandler } from "./line-clamp.js";
import { resolveElementCursor, extractCssUrl, isOutsideCaptureViewport } from "./utils.js";
import { parseCrossOriginAllowlist } from "./cross-origin.js";
import { selectProjectiveRasterOwnerIndexes } from "../projective-owner.js";
import { backdropEffectNeutralizations, backdropRootReasons } from "../backdrop-effect-space.js";
import { captureFontFamilyStack } from "../../font-family-stack.js";
import {
  projectiveFrameStateFor,
  projectiveTransformFor,
  transformSubtreeRasterFor,
} from "./walker/projective-state.js";
import { createCounterScopes } from "./walker/counter-scopes.js";
import { createIframeRecursionHandler } from "./walker/iframe-recursion.js";
import { createStyleRecordBuilder } from "./walker/style-record.js";
import { createNativeControlsHandler } from "./walker/native-controls.js";
import { createTextPhaseHandler } from "./walker/text-phase.js";
import { captureImageElement } from "./walker/image-elements.js";
import { createFidelityWarnings } from "./walker/fidelity-warnings.js";
import {
  captureBackdropFilterRaster,
  captureNativeControlDecorationRaster,
  captureNativeControlRaster,
  captureScrollbarRecord,
  computedSizeFontMetric,
} from "./walker/element-rasters.js";
import { createScrollMarkersHandler } from "./walker/scroll-markers.js";

const captureDocumentTree = (args) => {
  const sel = args.sel;
  const vp = args.vp;
  // DM-1442: cross-origin <iframe> recursion allowlist (the parsed
  // `--cross-origin-frames` value, passed in as `args.cof`). null in the
  // default (Phase 1) configuration — only same-origin frames recurse then.
  const _crossOriginAllow = parseCrossOriginAllowlist(args.cof);
  // DM-2537: Node authenticates each live main-world browsing context against
  // Chromium's DevTools FrameId before this synchronous walk begins. The
  // private registry is capture-local and removed in a finally; it prevents a
  // repeated URL, stale allowlist, or sibling-frame index from authorizing the
  // wrong document during a multi-segment scroll capture.
  const _frameScrollKey = typeof args.fk === "string" ? args.fk : "";
  const _svgReferenceScopes = new WeakMap();
  let _nextSvgReferenceScope = 0;
  function _svgReferenceScope(el) {
    var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
    var existing = _svgReferenceScopes.get(root);
    if (existing != null) return existing;
    var allocated = _nextSvgReferenceScope++;
    _svgReferenceScopes.set(root, allocated);
    return allocated;
  }
  let _backdropRasterSeq = 0;
  // DM-2469: the Node/CDP affine probe retains live nodes in a private
  // per-frame registry. The synchronous walker consumes only immutable facts;
  // no author-visible attributes or source-order guesses are involved.
  function _textPaintRegistryFor(el) {
    if (typeof args.tgk !== "string" || args.tgk === "") return undefined;
    var view = el.ownerDocument != null ? el.ownerDocument.defaultView : undefined;
    return view != null ? view[args.tgk] : undefined;
  }
  function _textPaintElementIndexFor(el) {
    var registry = _textPaintRegistryFor(el);
    return registry != null && registry.indexByElement != null ? registry.indexByElement.get(el) : undefined;
  }
  function _textPaintFactFor(el) {
    var registry = _textPaintRegistryFor(el);
    var index = _textPaintElementIndexFor(el);
    return registry != null && index != null && registry.factsByElement != null
      ? registry.factsByElement[index]
      : undefined;
  }
  function _textPaintSourceKeyFor(el) {
    var registry = _textPaintRegistryFor(el);
    var index = _textPaintElementIndexFor(el);
    return registry != null && index != null ? registry.token + ":" + index : undefined;
  }
  function _textPaintSourceTextNodeIndexFor(node) {
    var registry = node != null && node.ownerDocument != null ? node.ownerDocument.defaultView?.[args.tgk] : undefined;
    return registry != null && registry.indexByTextNode != null ? registry.indexByTextNode.get(node) : undefined;
  }
  // DM-2467: exact generated-content fragment records are installed by one
  // frame-scoped CDP prepass. Presence (including a terminal-raster record)
  // disables the legacy clone/probe path for that live host.
  function _pseudoFragmentFactsFor(el) {
    if (typeof args.pgk !== "string" || args.pgk === "") return undefined;
    var view = el.ownerDocument != null ? el.ownerDocument.defaultView : undefined;
    var registry = view != null ? view[args.pgk] : undefined;
    var index = registry != null && registry.indexByElement != null ? registry.indexByElement.get(el) : undefined;
    return registry != null && index != null && registry.factsByElement != null
      ? registry.factsByElement[index]
      : undefined;
  }

  // Wire up per-concern helpers. Each factory closes over its own state and
  // returns the handles captureInner / the orchestration tail call. Renamed
  // (e.g. `warnings: _warnings`) to keep captureInner's existing references
  // unchanged.
  const { normColor, normGradientColors } = createColorNorm();
  const { rasterCandidates, textNeedsRaster } = createEmojiDetect();
  const { markGetsDottedCircle } = createDottedCircleDetect();
  const { measureFontMetrics: _measureFontMetrics, substituteAliasedFamilies: _substituteAliasedFamilies } =
    createFontMetrics();
  const { resolvePlaceholderShownBg: _resolvePlaceholderShownBg } = createPlaceholderShown();
  const { familyIsUADefault: _familyIsUADefault, pseudoFamilyIsAuthored: _pseudoFamilyIsAuthored } =
    createFontFamilyDefault();
  const _fontFamilyStackFor = (el, computedFontFamily, pseudo) => {
    // Generated/first-letter/placeholder styles inherit the host's
    // kStandardFamily unless they resolve to a distinct family. CSSOM exposes
    // only the concrete settings name, so join the pseudo back to the host's
    // already-audited declaredness seam before creating the structured list.
    const hostFamily =
      pseudo == null ? computedFontFamily : (el.ownerDocument?.defaultView ?? window).getComputedStyle(el).fontFamily;
    const inheritedHostStandard =
      (pseudo == null || (computedFontFamily === hostFamily && !_pseudoFamilyIsAuthored(el, pseudo))) &&
      _familyIsUADefault(el, hostFamily);
    return captureFontFamilyStack(computedFontFamily, inheritedHostStandard);
  };
  const { resolveFontPalette: _resolveFontPalette, resolveShadowFontPalettes: _resolveShadowFontPalettes } =
    createFontPaletteResolver();
  const _fontFeatureValuesByDocument = new WeakMap();
  const _fontFeatureValuesFor = (doc) => {
    let tables = _fontFeatureValuesByDocument.get(doc);
    if (tables == null) {
      tables = collectFontFeatureValues(doc);
      _fontFeatureValuesByDocument.set(doc, tables);
    }
    return tables;
  };
  const { resolvePseudo: _resolvePseudo, resolveCornerRadius: _resolveCornerRadius } = createPseudoRules(
    args.ps,
    args.pk,
  );
  const { warn, shortSelector, warnings: _warnings } = createWarnings();
  // DM-770: counter-style map is populated by the pre-walk below (which
  // reads @counter-style rules from document.styleSheets); declared here so
  // the lists-counters and pseudo-content handlers close over the same
  // object reference via the shared counter-style resolver.
  const _counterStyles = {};
  // DM-1443: the `@counter-style` collector, captured so it can be re-run
  // against a recursed iframe's own document (`_runCounterStylePrewalk(doc)`).
  const _runCounterStylePrewalk = createCounterStylePrewalk({ counterStyles: _counterStyles });
  const { resolveCounterStyle, resolveCounterValue, isCustomCounterStyle } = createCounterStyleResolver({
    counterStyles: _counterStyles,
  });
  const { captureListsCounters } = createListsCountersHandler({
    normColor,
    resolveCounterStyle,
    isCustomCounterStyle,
    measureFontMetrics: _measureFontMetrics,
  });
  const { handleReplacedElement } = createReplacedElementsHandler({ vp });
  const {
    discoverMasks,
    computeMaskIntrinsic,
    discoverClipPaths,
    discoverFilters,
    maskDefs: _maskDefs,
    maskRasters: _maskRasters,
    clipPathDefs: _clipPathDefs,
    filterDefs: _filterDefs,
  } = createMasksClipsHandler({ vp, warn, referenceScopeFor: _svgReferenceScope });
  const { captureFormControls } = createFormControlsHandler({
    normColor,
    resolvePseudo: _resolvePseudo,
    fontFamilyStackFor: _fontFamilyStackFor,
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    physicalComputedGradientImage,
  });
  const { wrapWithFrozenTransform, threadFrozenTransform } = createTransformsHandler();
  // Fragmented collapsed-table paint is allowed only when the Node/CDP
  // prepass authenticated one transform-neutral physical section record from
  // independent CSSOM and protocol geometry. Keep the live DOM correlation in
  // a private WeakMap; no author-visible id participates in ownership.
  const _collapsedBorderFragmentRegistry = typeof args.cbfk === "string" ? globalThis[args.cbfk] : null;
  const _collapsedBorderFragmentByTable = new WeakMap();
  if (
    _collapsedBorderFragmentRegistry != null &&
    Array.isArray(_collapsedBorderFragmentRegistry.tables) &&
    Array.isArray(_collapsedBorderFragmentRegistry.records)
  ) {
    for (let _cbfi = 0; _cbfi < _collapsedBorderFragmentRegistry.tables.length; _cbfi++) {
      const _cbfTable = _collapsedBorderFragmentRegistry.tables[_cbfi];
      const _cbfRecord = _collapsedBorderFragmentRegistry.records[_cbfi];
      if (_cbfTable != null && _cbfRecord != null) {
        _collapsedBorderFragmentByTable.set(_cbfTable, _cbfRecord);
      }
    }
  }
  const { captureBordersBackgrounds, isTableCellHiddenByEmptyCells } = createBordersBackgroundsHandler({
    normColor,
    normGradientColors,
    resolvePlaceholderShownBg: _resolvePlaceholderShownBg,
    resolveCornerRadius: _resolveCornerRadius,
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    warn,
    shortSelector,
    vp,
    collapsedBorderFragmentRecordFor: (table) => _collapsedBorderFragmentByTable.get(table),
  });
  const { captureBackgroundAttachment } = createBackgroundAttachmentHandler({
    vp,
    transformRelatedBoxFor: (el) => _transformRelatedBox.get(el),
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    scrollbarPropertyKey: args.sk,
  });
  const { capturePseudoContent } = createPseudoContentHandler({
    vp,
    normColor,
    measureFontMetrics: _measureFontMetrics,
    textNeedsRaster,
    resolveCounterValue,
    composeEffectiveTransform,
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    physicalComputedCssPixelTerms,
    physicalComputedGradientImage,
    fontFamilyStackFor: _fontFamilyStackFor,
    pseudoImageSizingKey: args.pik,
  });
  const { captureInputValue } = createInputValueHandler({
    vp,
    normColor,
    measureFontMetrics: _measureFontMetrics,
    fontFamilyStackFor: _fontFamilyStackFor,
    valueTextGeometryKey: args.ivk,
  });
  const { finalizeLineClampText } = createLineClampHandler({
    vp,
    measureFontMetrics: _measureFontMetrics,
    normColor,
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    fontFamilyStackFor: _fontFamilyStackFor,
  });
  const { captureTextSegments } = createTextSegmentsHandler({
    vp,
    measureFontMetrics: _measureFontMetrics,
    rasterCandidates,
    normColor,
    markGetsDottedCircle,
    finalizeLineClampText,
    fontFamilyStackFor: _fontFamilyStackFor,
    sourceTextNodeIndexFor: _textPaintSourceTextNodeIndexFor,
  });
  const { injectPseudoSegments } = createPseudoInjectHandler();
  const { captureResizeHandle } = createResizeHandleHandler({
    resolvePseudo: _resolvePseudo,
    normColor,
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    themeThickness: args.rt,
    scaleFromDIP: args.rs,
    vp,
  });

  const capture = (el) => {
    // Freeze the element's CSS transform for the duration of the capture
    // so getBoundingClientRect returns un-transformed coords; the renderer
    // re-applies the saved transform via an SVG group wrapper. See
    // walker/transforms.ts for the rationale.
    // A recursed iframe's element belongs to its own Window. Calling the top
    // window's getter for a foreign-document element can return default UA
    // values for inherited properties (notably Times for `font-family`) even
    // though Chromium paints the frame's authored face.
    const styleWindow = el.ownerDocument?.defaultView ?? window;
    const cs = styleWindow.getComputedStyle(el);
    return wrapWithFrozenTransform(el, cs, captureInner);
  };
  const captureInner = (el, cs, frozenTransform, frozenTransformOrigin) => {
    const rect = el.getBoundingClientRect();
    const _textPaintFact = _textPaintFactFor(el);
    const _pseudoFragmentFacts = _pseudoFragmentFactsFor(el);
    const _capturedFontFamilyStack = _fontFamilyStackFor(el, cs.fontFamily);
    let transformSubtreeRaster;
    const _projectiveIndex = _projectiveNodeIndex.get(el);
    const _projectiveFact = _projectiveIndex != null ? _projectiveFacts[_projectiveIndex] : undefined;
    const projectiveFrameState = projectiveFrameStateFor(args, _projectiveFact, _nonAffineProjectiveRoots.has(el));
    let projectiveTransform;
    let projectiveHidden;
    const _projective = projectiveTransformFor(
      vp,
      rect,
      _projectedQuads.get(el),
      el.parentElement != null ? _projectiveAbsH.get(el.parentElement) : undefined,
      cs.backfaceVisibility,
    );
    if (_projective != null) {
      projectiveTransform = _projective.transform;
      projectiveHidden = _projective.hidden;
      _projectiveAbsH.set(el, _projective.absolute);
    }
    const _makeTransformSubtreeRaster = () => transformSubtreeRasterFor(el, rect, vp, _projectiveNodeIndex.get(el));
    // SVG cannot encode a projective fourth corner or preserve-3d flattening.
    // Snapshot the outermost 3D context once; descendants remain in the tree
    // for metadata/paint ordering but the renderer returns after this image.
    if (_nonAffineProjectiveRoots.has(el)) {
      transformSubtreeRaster = _makeTransformSubtreeRaster();
    }
    // Missing, changing, singular, or projective text-fragment facts are an
    // explicit Chromium surface boundary. Never fall back to the legacy
    // scalar font/rect approximation for that transformed subtree.
    if (_textPaintFact != null && _textPaintFact.surfaceReason != null && transformSubtreeRaster == null) {
      transformSubtreeRaster = _makeTransformSubtreeRaster();
      warn(
        shortSelector(el),
        "<transform>",
        "Chromium text-fragment geometry unavailable; retained one outer raster surface: " +
          _textPaintFact.surfaceReason,
      );
    }
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
    const _geometryStyle = captureGeometryStylePhase({
      el,
      cs,
      rect,
      vp,
      fixedAncestors: _fixedAncestors,
      transformInfluenced: _transformInfluenced,
      animInfluenced: _animInfluenced,
      isOutsideCaptureViewport,
    });
    if (_geometryStyle == null) return null;
    const {
      outsideViewport,
      bordersOnlyCell,
      contentVisibilityHidden: _contentVisHidden,
      zeroSized,
      tag,
    } = _geometryStyle;

    // Emit warnings for features domotion can't fully round-trip. Keep
    // these short and actionable — consumers (CLI, tests, demo scripts) log
    // them so the fidelity gaps are self-documenting.
    const sel = shortSelector(el);
    const {
      _effectiveAppearance,
      _fileSelectorCapture,
      _missingNativeDecorationKinds,
      _nativeControlTag,
      _nativeDecorationKinds,
      _nativeDecorationParts,
      _nativeDecorationUnavailableReason,
      _selectDisplayTextGeometry,
    } = captureNativeControlState({ el, cs, tag, sel, _pseudoFragmentFacts });
    warnBeforeMaskDiscovery(el, cs, sel);
    // Mask discovery — same-document fragment refs (`url("#id")`), element
    // refs (`element(#id)`), and warnings for unsupported mask sources.
    // Handler owns the maskDefs / maskRasters Maps that the orchestration
    // tail consumes. See walker/masks-clips.ts.
    const _maskFragmentReferences = discoverMasks(el, cs, sel);
    const _maskFragmentReferenceScope =
      _maskFragmentReferences != null && _maskFragmentReferences.length === 1
        ? _maskFragmentReferences[0].scope
        : undefined;
    // DM-826: clip-path: url("#id") same-document fragment refs. Sibling of
    // the mask discovery above; collects inline <clipPath> defs the
    // renderer copies into the output SVG. See docs/39.
    const _clipFragmentReferenceScope = discoverClipPaths(el, cs, sel);
    // DM-934: CSS `filter: url(#id)` referencing an inline SVG <filter>.
    // Collect the def so the renderer can copy it into the output SVG;
    // the existing pass-through of cs.filter as an inline style then
    // resolves against that same-document def.
    const urlFilterRasterToken = discoverFilters(el, cs, sel);
    warnAfterMaskDiscovery(el, cs, tag, sel);
    let svgContent = undefined;
    const {
      text,
      textTop,
      textLeft,
      textHeight,
      textWidth,
      fontAscent,
      fontDescent,
      inputXOffsets,
      placeholderColor,
      placeholderFontStyle,
      placeholderFontWeight,
      placeholderFontFamily,
      placeholderFontFamilyStack,
      lineClampTextFragments,
      textSegments,
      pseudoBoxes,
      pseudoImages,
      isPlaceholderCapture,
    } = captureTextPhase({ el, cs, tag, rect, _contentVisHidden, _pseudoFragmentFacts });

    let textImageUri = undefined;
    const textImageScale = 2;

    const { imageSrc, imageIntrinsic, imageEffectiveZoom, imageBroken, imageAlt, brokenImageFallback } =
      captureImageElement({
        el,
        tag,
        rect,
        vp,
        sel,
        effectiveZoomFor: _effectiveZoomFor,
        sourceNodeIndex: _projectiveNodeIndex.get(el),
      });
    const _listsCounters = captureListsCounters(el, cs, tag);
    let svgReferenceScope = undefined;
    if (tag === "svg") {
      const inlineSvgCapture = captureInlineSvg(el, cs, warn, sel);
      svgContent = inlineSvgCapture.content;
      // Missing/singular CTMs and failed isolated-clone correlation are an
      // explicit vector boundary, never a request for cssTransformToSvg's six-
      // entry matrix3d approximation. Reuse the outer Chromium raster owner.
      if (inlineSvgCapture.affineFreezeFailed && transformSubtreeRaster == null) {
        transformSubtreeRaster = _makeTransformSubtreeRaster();
      }
      svgReferenceScope = _svgReferenceScope(el);
    }

    const children = captureTraversalPhase({
      el,
      tag,
      contentVisibilityHidden: _contentVisHidden,
      capture,
    });

    const _animId = el.dataset != null ? el.dataset.domotionAnim : undefined;
    // DM-900: author-supplied magic-move pairing key (`data-magic-key`). When
    // present on the same logical element across two animation frames, the
    // magic-move matcher force-pairs them ahead of its fingerprint heuristic.
    const _magicKey = el.dataset != null ? el.dataset.magicKey : undefined;

    // <fieldset>+<legend> box adjustment (DM-1436: extracted to walker/fieldset-legend.ts).
    const _fsBox = computeFieldsetLegendBox(el, tag, rect, vp);

    const _captured = {
      tag,
      text,
      x: _fsBox.x,
      y: _fsBox.y,
      width: _fsBox.width,
      height: _fsBox.height,
      fieldsetLegendNotch: _fsBox.fieldsetLegendNotch,
      resizeHandle: captureResizeHandle(el, cs, tag, rect),
      // DM-2481: populated by the Node-side live Chromium marker probe.  The
      // serialized record is already in capture-viewport coordinates and may
      // be explicitly partial/unavailable; the renderer must never infer a
      // replacement from scrollWidth/clientWidth or scroll offsets.
      scrollbars: captureScrollbarRecord({ args, el, cs, warn, sel }),
      animId: _animId,
      magicKey: _magicKey,
      // DM-2457: private correlation only. The Node/CDP post-pass resolves the
      // real generated ::marker fragment and deletes this index before return.
      _summaryMarkerSourceNodeIndex:
        tag === "summary" && cs.display != null && cs.display.includes("list-item")
          ? _projectiveNodeIndex.get(el)
          : undefined,
      svgReferenceScope,
      fragmentReferenceScope:
        _maskFragmentReferenceScope != null ? _maskFragmentReferenceScope : _clipFragmentReferenceScope,
      fragmentReferenceZoom:
        (_maskFragmentReferences != null && _maskFragmentReferences.length > 0) || _clipFragmentReferenceScope != null
          ? _effectiveZoomFor(el)
          : undefined,
      maskFragmentReferences:
        _maskFragmentReferences != null && _maskFragmentReferences.length > 0 ? _maskFragmentReferences : undefined,
      // DM-1106: effective cursor keyword for the auto cursor-overlay hit-test.
      // Omitted when it resolves to the default arrow (the common case) to keep
      // the tree lean — the overlay treats a missing value as `default`.
      cursor: (() => {
        const _c = resolveElementCursor(el, cs);
        return _c === "default" ? undefined : _c;
      })(),
      styles: buildStyleRecord({
        el,
        cs,
        tag,
        rect,
        frozenTransform,
        frozenTransformOrigin,
        projectiveTransform,
        isPlaceholderCapture,
        _effectiveAppearance,
        _selectDisplayTextGeometry,
        _capturedFontFamilyStack,
        _fileSelectorCapture,
      }),
      projectiveTransform,
      projectiveHidden,
      projectiveFrameState,
      transformSubtreeRaster,
      children,
      imageSrc,
      imageIntrinsic,
      imageEffectiveZoom,
      imageBroken,
      imageAlt,
      brokenImageFallback,
      svgContent,
      pseudoFragments: Array.isArray(_pseudoFragmentFacts) ? _pseudoFragmentFacts : undefined,
      pseudoImages,
      pseudoBoxes: pseudoBoxes.length > 0 ? pseudoBoxes : undefined,
      // SK-1115: ::marker pseudo styles plus list-marker intrinsic dims and
      // list-item index — see walker/lists-counters.ts.
      ..._listsCounters,
      textSegments: textSegments.length > 0 ? textSegments : undefined,
      textPaintGeometry: _textPaintFact != null ? _textPaintFact.geometry : undefined,
      // Correlation marker emitted only by the all-transform-neutral probe
      // capture and consumed before that intermediate tree is discarded.
      _textPaintSourceKey: args.tgp === true ? _textPaintSourceKeyFor(el) : undefined,
      lineClampTextFragments: lineClampTextFragments || undefined,
      textTop,
      textLeft,
      textHeight,
      textWidth,
      // DM-2446: Blink chooses and measures the face at computed size
      // (logical CSS size × effective zoom), then the transform stage scales
      // those metrics into paint space. Re-measure at computed size instead of
      // multiplying logical-size metrics by zoom: variable-font metrics can
      // change non-linearly when the computed size selects another instance.
      fontAscent: computedSizeFontMetric({
        metric: "ascent",
        value: fontAscent,
        cs,
        el,
        _effectiveZoomFor,
        _measureFontMetrics,
      }),
      fontDescent: computedSizeFontMetric({
        metric: "descent",
        value: fontDescent,
        cs,
        el,
        _effectiveZoomFor,
        _measureFontMetrics,
      }),
      inputXOffsets,
      textImageUri,
      textImageScale,
      // Placeholder metadata (SK-1097 / SK-1100 / SK-1099): captured in
      // walker/input-value.ts when the host is a placeholder-shown input
      // or textarea. Undefined elsewhere.
      isPlaceholderText: isPlaceholderCapture || undefined,
      placeholderColor,
      placeholderFontStyle,
      placeholderFontWeight,
      placeholderFontFamily,
      placeholderFontFamilyStack,
      // Old-capture compatibility field. Current textarea and vertical text
      // capture is fully vector; see walker/text-segments.ts.
      elementRaster: computeElementRaster(el, cs, tag, rect, vp),
      // DM-2149 / DM-2453: snapshot only appearances for which Blink's
      // ThemePainter owns the complete host. EffectiveAppearance is derived
      // above from the actual auto mapping and cascade-origin author flags.
      // menulist-button/listbox/base states keep their author-owned host box
      // structural; native decoration splitting is owned by DM-2455.
      nativeControlRaster: captureNativeControlRaster({
        _nativeControlTag,
        rect,
        _effectiveAppearance,
        cs,
        vp,
        _projectiveNodeIndex,
        sel,
        tag,
        el,
      }),
      // A CSS-owned host can still contain either ThemePainter's select arrow
      // or layout-backed closed-UA-shadow decorations. Keep the host box and
      // value text structural, but reserve this narrow overlay so a failed
      // Chromium isolation can never reopen the sampled glyph functions.
      nativeControlDecorationRaster: captureNativeControlDecorationRaster({
        _nativeDecorationKinds,
        rect,
        _nativeDecorationParts,
        vp,
        _nativeDecorationUnavailableReason,
        sel,
        _missingNativeDecorationKinds,
        _projectiveNodeIndex,
        el,
      }),
      // DM-2171: backdrop-filter samples already-painted content behind this
      // element through a distinct Blink effect node. An img-rendered SVG has
      // no equivalent input surface, so preserve Chromium's composited pixels
      // for the complete isolation subtree at its paint-order position.
      backdropFilterRaster: captureBackdropFilterRaster({
        cs,
        rect,
        el,
        vp,
        sel,
        _backdropEffectSpaceFor,
        nextBackdropToken: () => "bf" + _backdropRasterSeq++,
      }),
      // DM-2415: a CSS URL filter containing feConvolveMatrix needs Blink's
      // original layer-space SourceGraphic pixels. The Node post-pass replaces
      // this placeholder with the isolated, fully-filtered Chromium surface.
      urlFilterRaster:
        urlFilterRasterToken == null
          ? undefined
          : {
              x: rect.left - vp.x,
              y: rect.top - vp.y,
              width: rect.width,
              height: rect.height,
              token: urlFilterRasterToken,
            },
    };
    return assembleCaptureResultPhase({
      captured: _captured,
      el,
      cs,
      tag,
      rect,
      vp,
      bordersOnlyCell,
      detectInlineFragments,
      iframeFrameAuthority: _iframeFrameAuthority,
      captureIframeRecursion: _captureIframeRecursion,
      handleReplacedElement,
      captureScrollMarkerGroup: _captureScrollMarkerGroup,
      captureScrollButtons: _captureScrollButtons,
    });
  };

  const { _captureScrollMarkerGroup, _captureScrollButtons } = createScrollMarkersHandler({ capture, sel });

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
  const _allEls = root.getElementsByTagName("*");
  for (let _i = 0; _i < _allEls.length; _i++) {
    const _el = _allEls[_i];
    const _pos = getComputedStyle(_el).position;
    if (_pos !== "fixed" && _pos !== "sticky") continue;
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
    if (_tt === "none" || _tt === "") continue;
    // Mark the transformed element itself AND every descendant. The element
    // itself needs the exemption because its own post-transform rect may be
    // entirely outside the viewport (e.g. framer's marquee `<ul>` is
    // `transform: translateX(-1000px)` at some animation frames), and the
    // `outsideViewport` cull would drop the ul + abort recursion before its
    // (in-viewport) descendant lis ever get walked. Including the transformed
    // element keeps the recursion alive so its descendants are captured.
    // (DM-637 / framer brand-logo carousel.)
    _transformInfluenced.add(_tel);
    const _tdescs = _tel.getElementsByTagName("*");
    for (let _tj = 0; _tj < _tdescs.length; _tj++) {
      _transformInfluenced.add(_tdescs[_tj]);
    }
  }

  // DM-2385: a computed transform-related value does not imply that Blink's
  // LayoutObject can apply it. In particular, a non-replaced `display:inline`
  // element serializes perspective/transform normally but fails the `IsBox()` arm
  // in ComputeIsFixedContainer and creates neither a fixed CB nor a perspective
  // paint node. ComputedStyle's stacking-context predicate remains separate.
  // CSSOM does not expose IsBox(), but fixed ownership is
  // observable without matrix inference: give a neutral temporary host the
  // candidate's computed display and an active perspective; its fixed child's
  // offsetParent is that host exactly when Blink constructed an IsBox layout
  // object. Using a neutral host avoids changing the source element or letting
  // its independent filter/contain state answer the transform question. Probe
  // only transform-related candidates, remove the zero-size host immediately,
  // and retain the boolean for perspective activation and fixed ownership.
  const _transformRelatedBox = new WeakMap();
  const _transformRelatedWillChange = new Set([
    "transform",
    "transform-style",
    "perspective",
    "translate",
    "rotate",
    "scale",
    "offset-path",
    "offset-position",
  ]);
  const _hasTransformRelatedSignal = (_cs) => {
    if (
      (_cs.transform != null && _cs.transform !== "" && _cs.transform !== "none") ||
      (_cs.translate != null && _cs.translate !== "" && _cs.translate !== "none") ||
      (_cs.rotate != null && _cs.rotate !== "" && _cs.rotate !== "none") ||
      (_cs.scale != null && _cs.scale !== "" && _cs.scale !== "none") ||
      _cs.transformStyle === "preserve-3d" ||
      (_cs.perspective != null && _cs.perspective !== "" && _cs.perspective !== "none")
    )
      return true;
    if (_cs.willChange == null || _cs.willChange === "" || _cs.willChange === "auto") return false;
    const _tokens = _cs.willChange.split(/[\s,]+/);
    for (let _wi = 0; _wi < _tokens.length; _wi++) {
      if (_transformRelatedWillChange.has(_tokens[_wi].toLowerCase())) return true;
    }
    return false;
  };
  const _ownershipEls = [root, ...Array.from(_allEls)];
  // Attachment ownership walks beyond the selected capture root. A fixed
  // background on the root still becomes scroll-attached when an authored
  // transform ancestor outside that root establishes the containing block;
  // likewise, a transform on an inert inline ancestor must remain a negative
  // control. Include those ancestors in the LayoutBox applicability probe.
  let _ownershipAncestor = root.parentElement;
  while (_ownershipAncestor != null) {
    _ownershipEls.push(_ownershipAncestor);
    _ownershipAncestor = _ownershipAncestor.parentElement;
  }
  // DM-2487: snapshot the ancestor effect tree before the transform walker can
  // temporarily freeze rotate/skew declarations. This source-owned record is
  // consumed by the Node screenshot pass; ordinary stacking, isolation,
  // overflow, positioning, and transforms do not become Backdrop Roots.
  const _backdropEffectFacts = new WeakMap();
  const _backdropFactsFor = (_element, _style) => ({
    isDocumentRoot: _element === _element.ownerDocument.documentElement,
    opacity: _style.opacity || "1",
    filter: _style.filter || "none",
    backdropFilter: _style.backdropFilter || _style.webkitBackdropFilter || "none",
    clipPath: _style.clipPath || "none",
    maskImage: _style.maskImage || "none",
    maskBorderSource: _style.maskBorderSource || "none",
    mixBlendMode: _style.mixBlendMode || "normal",
    willChange: _style.willChange || "auto",
    transform: _style.transform || "none",
    translate: _style.translate || "none",
    rotate: _style.rotate || "none",
    scale: _style.scale || "none",
  });
  for (let _bi = 0; _bi < _ownershipEls.length; _bi++) {
    const _element = _ownershipEls[_bi];
    const _styleWindow = _element.ownerDocument?.defaultView ?? window;
    _backdropEffectFacts.set(_element, _backdropFactsFor(_element, _styleWindow.getComputedStyle(_element)));
  }
  const _backdropEffectSpaceFor = (_target) => {
    const _ancestors = [];
    let _nearestRoot;
    let _ancestor = _target.parentElement;
    let _depth = 1;
    while (_ancestor != null) {
      const _styleWindow = _ancestor.ownerDocument?.defaultView ?? window;
      const _facts =
        _backdropEffectFacts.get(_ancestor) || _backdropFactsFor(_ancestor, _styleWindow.getComputedStyle(_ancestor));
      const _reasons = backdropRootReasons(_facts);
      const _neutralize = backdropEffectNeutralizations(_facts);
      const _selector = shortSelector(_ancestor);
      if (_nearestRoot == null && _reasons.length > 0) {
        _nearestRoot = {
          kind: _facts.isDocumentRoot ? "document" : "element",
          depth: _depth,
          selector: _selector,
          reasons: _reasons,
        };
      }
      if (_reasons.length > 0 || _neutralize.length > 0) {
        _ancestors.push({ depth: _depth, selector: _selector, reasons: _reasons, neutralize: _neutralize });
      }
      _ancestor = _ancestor.parentElement;
      _depth++;
    }
    // A connected HTML target always reaches documentElement. Keep this
    // conservative fallback explicit for detached/custom-document probes.
    if (_nearestRoot == null) {
      _nearestRoot = { kind: "document", depth: 0, selector: "html", reasons: ["document-root"] };
    }
    return {
      source: "blink-backdrop-effect-tree-v1",
      nearestRoot: _nearestRoot,
      ancestors: _ancestors,
    };
  };
  const _probeUnsupportedTags = /^(?:AUDIO|CANVAS|EMBED|IFRAME|IMG|INPUT|METER|OBJECT|PROGRESS|SELECT|TEXTAREA|VIDEO)$/;
  for (let _oi = 0; _oi < _ownershipEls.length; _oi++) {
    const _owner = _ownershipEls[_oi];
    const _ownerStyle = getComputedStyle(_owner);
    if (!_hasTransformRelatedSignal(_ownerStyle)) continue;
    // Replaced/control content and SVG suppress an appended HTML child, so a
    // false result there would describe the probe host rather than IsBox().
    // Such elements cannot expose an authored fixed descendant through this
    // tree; leave the fact undefined so their own perspective paint retains
    // the source-compatible fallback.
    if (_owner.namespaceURI === "http://www.w3.org/2000/svg" || _probeUnsupportedTags.test(_owner.tagName)) continue;
    const _probeHost = document.createElement("span");
    _probeHost.setAttribute("aria-hidden", "true");
    _probeHost.style.setProperty("all", "initial", "important");
    _probeHost.style.setProperty("display", _ownerStyle.display, "important");
    _probeHost.style.setProperty("perspective", "1px", "important");
    _probeHost.style.setProperty("visibility", "hidden", "important");
    _probeHost.style.setProperty("width", "0", "important");
    _probeHost.style.setProperty("height", "0", "important");
    _probeHost.style.setProperty("margin", "0", "important");
    _probeHost.style.setProperty("padding", "0", "important");
    _probeHost.style.setProperty("border", "0", "important");
    const _probe = document.createElement("i");
    _probe.setAttribute("aria-hidden", "true");
    _probe.style.setProperty("all", "initial", "important");
    _probe.style.setProperty("position", "fixed", "important");
    _probe.style.setProperty("width", "0", "important");
    _probe.style.setProperty("height", "0", "important");
    _probeHost.appendChild(_probe);
    try {
      (document.body || document.documentElement).appendChild(_probeHost);
      _transformRelatedBox.set(_owner, _probe.offsetParent === _probeHost);
    } catch (_e) {
      // If the neutral host cannot participate in layout, leave the compatible
      // computed-style fallback undefined rather than guessing.
    } finally {
      _probeHost.remove();
    }
  }

  // DM-2474: CSS 3D ownership comes from Chromium's live paint quads, gathered
  // by the Node/CDP prepass before capture mutates transforms.  DOM object
  // correlation is held in a private page-global array, so no marker attribute
  // or appended HTML child can change SVG layout.  SVG graphics children are
  // source-flattened affine and deliberately do not receive a general box
  // homography; outer SVG roots and HTML boxes may.
  const _projectiveFacts = Array.isArray(args.pq) ? args.pq : [];
  const _projectiveDomNodes =
    typeof args.pqk === "string" && Array.isArray(globalThis[args.pqk]) ? globalThis[args.pqk] : [];
  const _projectiveNodeIndex = new WeakMap();
  const _projectedQuads = new WeakMap();
  const _projectiveAbsH = new WeakMap();
  for (let _pi = 0; _pi < _projectiveFacts.length; _pi++) {
    const _fact = _projectiveFacts[_pi];
    const _pel = _projectiveDomNodes[_pi];
    if (_pel == null || _fact == null) continue;
    _projectiveNodeIndex.set(_pel, _pi);
    if (_fact.role === "svg-graphics") continue;
    const _values = _fact.borderQuad || _fact.quad;
    if (!Array.isArray(_values) || _values.length !== 8) continue;
    _projectedQuads.set(_pel, [
      { x: _values[0], y: _values[1] },
      { x: _values[2], y: _values[3] },
      { x: _values[4], y: _values[5] },
      { x: _values[6], y: _values[7] },
    ]);
  }
  const _nonAffineProjectiveRoots = new Set();
  for (const _ownerIndex of selectProjectiveRasterOwnerIndexes(_projectiveFacts)) {
    const _owner = _projectiveDomNodes[_ownerIndex];
    if (_owner != null) _nonAffineProjectiveRoots.add(_owner);
  }

  // DM-1532: an element carrying `data-domotion-anim` gets a post-capture
  // intra-frame animation that CAN be a transform (e.g. an odometer digit reel
  // whose strip `translateY`-rolls, scrolling otherwise-offscreen digit cells
  // through a clipped window). Capture runs on the static, untransformed DOM and
  // can't know the animation's range, so it would drop those offscreen cells
  // before the animation ever brings them in. Exempt the whole animated subtree
  // from the `outsideViewport` early-return; the post-capture, animation-aware
  // viewBox cull (`cullElementsOutsideViewBox`) then trims any that never
  // actually enter the viewport during the scene. Mirrors `_transformInfluenced`.
  const _animInfluenced = new Set();
  for (let _ai = 0; _ai < _allEls.length; _ai++) {
    const _ael = _allEls[_ai];
    if (_ael.dataset == null || _ael.dataset.domotionAnim == null || _ael.dataset.domotionAnim === "") continue;
    _animInfluenced.add(_ael);
    const _adescs = _ael.getElementsByTagName("*");
    for (let _aj = 0; _aj < _adescs.length; _aj++) _animInfluenced.add(_adescs[_aj]);
  }

  // DM-2470: keep effective CSS zoom as a local layout/metric input. CSS
  // transforms never enter this map; authoritative textPaintGeometry owns
  // their complete signed affine mapping after shaping.
  const _cumulativeZoom = new Map();
  const _effectiveZoomFor = (el) => {
    if (el == null) return 1;
    const hit = _cumulativeZoom.get(el);
    if (hit != null) return hit;
    const parentZoom = _effectiveZoomFor(el.parentElement);
    const own = parseFloat(getComputedStyle(el).zoom);
    const zoom = parentZoom * (Number.isFinite(own) && own > 0 ? own : 1);
    _cumulativeZoom.set(el, zoom);
    return zoom;
  };
  // Background attachment is a separate box-paint protocol. Its live physical
  // scroll geometry still needs pure scale magnitudes, so keep that conversion
  // narrowly named and owned here rather than sharing it with text.
  const _backgroundAttachmentAxisScale = (_tt) => {
    if (_tt == null || _tt === "none" || _tt === "") return [1, 1];
    const _m2 = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)/.exec(_tt);
    let _sa = 1,
      _sd = 1;
    if (_m2 != null) {
      _sa = parseFloat(_m2[1]);
      _sd = parseFloat(_m2[4]);
    } else {
      const _m3 = /^matrix3d\(([^)]+)\)/.exec(_tt);
      if (_m3 != null) {
        const _parts = _m3[1].split(",");
        _sa = parseFloat(_parts[0]);
        _sd = parseFloat(_parts[5]);
      }
    }
    if (!isFinite(_sa) || !isFinite(_sd)) return [1, 1];
    const _sx = Math.abs(_sa) > 0 ? Math.abs(_sa) : 1;
    const _sy = Math.abs(_sd) > 0 ? Math.abs(_sd) : 1;
    return [_sx, _sy];
  };
  // Background attachment geometry is serialized in the same physical space
  // as the element rect. Pure translate/scale transforms stay live during
  // capture, so their scale is already baked into that space. Rotation/skew
  // transforms are temporarily frozen and later re-applied by the SVG wrapper;
  // folding their matrix a/d terms into scroll offsets would apply that part
  // twice. Resolve the scale along the real DOM ancestry and cache the result.
  const _backgroundAttachmentPaintScale = new WeakMap();
  const _backgroundAttachmentPaintScaleFor = (el) => {
    if (el == null) return [1, 1];
    const _hit = _backgroundAttachmentPaintScale.get(el);
    if (_hit != null) return _hit;
    const _parent = _backgroundAttachmentPaintScaleFor(el.parentElement);
    const _styleWindow = el.ownerDocument?.defaultView ?? window;
    const _style = _styleWindow.getComputedStyle(el);
    const _effectiveTransform = composeEffectiveTransform(_style);
    const _ownScale = transformHasRotationOrSkew(_effectiveTransform)
      ? [1, 1]
      : _backgroundAttachmentAxisScale(_effectiveTransform);
    const _ownZoom = parseFloat(_style.zoom);
    const _zoom = Number.isFinite(_ownZoom) && _ownZoom > 0 ? _ownZoom : 1;
    const _resolved = [_parent[0] * _ownScale[0] * _zoom, _parent[1] * _ownScale[1] * _zoom];
    _backgroundAttachmentPaintScale.set(el, _resolved);
    return _resolved;
  };
  const { counterSnapshot: _counterSnapshot, counterPreWalk: _counterPreWalk } = createCounterScopes();
  _counterPreWalk(root);
  const { _captureIframeRecursion, _iframeFrameAuthority, _iframeIsRecursable } = createIframeRecursionHandler({
    _counterPreWalk,
    _counterSnapshot,
    _counterStyles,
    _crossOriginAllow,
    _fixedAncestors,
    _frameScrollKey,
    _runCounterStylePrewalk,
    _transformInfluenced,
    capture,
    normColor,
    vp,
  });
  const { warnBeforeMaskDiscovery, warnAfterMaskDiscovery } = createFidelityWarnings({
    warn,
    _iframeIsRecursable,
    _iframeFrameAuthority,
    _frameScrollKey,
  });
  const { captureTextPhase } = createTextPhaseHandler({
    capturePseudoContent,
    _counterSnapshot,
    captureInputValue,
    captureTextSegments,
    injectPseudoSegments,
    _effectiveZoomFor,
    _measureFontMetrics,
  });
  const { captureNativeControlState } = createNativeControlsHandler({
    args,
    vp,
    warn,
    normColor,
    captureTextSegments,
    _effectiveZoomFor,
    _fontFamilyStackFor,
    _measureFontMetrics,
  });
  const buildStyleRecord = createStyleRecordBuilder({
    captureFormControls,
    threadFrozenTransform,
    _backgroundAttachmentPaintScaleFor,
    _effectiveZoomFor,
    _fontFeatureValuesFor,
    _resolveFontPalette,
    _resolveShadowFontPalettes,
    _transformRelatedBox,
    captureBackgroundAttachment,
    captureBordersBackgrounds,
    computeMaskIntrinsic,
    isTableCellHiddenByEmptyCells,
    normColor,
  });

  // DM-770: collect `@counter-style` rule definitions from all stylesheets into
  // the shared `_counterStyles` map, so the lists-counters / pseudo-content
  // walkers can resolve `list-style-type: <custom-name>` and `counter(name,
  // style)` markers per system. Chrome doesn't expose the resolved marker via
  // `getComputedStyle(li, '::marker').content`, so the resolver re-implements
  // the CSS algorithm against this map. (Parser + walker extracted to
  // walker/counter-prewalk.ts — DM-1086.)
  _runCounterStylePrewalk();

  const result = [];
  // Capture the root element itself when it has visible border or background
  // (DM-362: <body style="border:3px solid pink"> was not rendering because
  // we only walked root.children). When the root has nothing visually
  // distinctive, fall through to the prior child-walk so we don't wrap
  // every page in a redundant outer rect.
  const rootCs = window.getComputedStyle(root);
  const rootHasBorder =
    (parseFloat(rootCs.borderTopWidth) || 0) > 0 ||
    (parseFloat(rootCs.borderRightWidth) || 0) > 0 ||
    (parseFloat(rootCs.borderBottomWidth) || 0) > 0 ||
    (parseFloat(rootCs.borderLeftWidth) || 0) > 0;
  const rootBg = rootCs.backgroundColor;
  // DM-855: also capture the root when it carries a gradient/image background,
  // not just a solid color. `backgroundColor` is `transparent` for a
  // gradient-only <body>, so checking it alone made us skip capturing the root
  // element and drop its background entirely. Treating a non-`none`
  // `background-image` as "has background" captures the root as a normal
  // element, routing its gradient through the existing element-gradient path.
  const rootBgImage = rootCs.backgroundImage;
  const rootHasBgImage = rootBgImage != null && rootBgImage !== "none" && rootBgImage !== "";
  const rootHasBg = (rootBg != null && rootBg !== "rgba(0, 0, 0, 0)" && rootBg !== "transparent") || rootHasBgImage;
  // DM-365: invalid HTML like <p>foo<div>bar</div>baz</p> auto-closes the <p>
  // when the <div> opens, leaving "baz" as a direct text-node child of <body>.
  // Chrome paints it; we'd miss it if we only walked root.children (Element
  // children only). When the root has any direct text-node child with non-
  // whitespace content, capture root so its text-node walk picks them up.
  let rootHasDirectText = false;
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim() !== "") {
      rootHasDirectText = true;
      break;
    }
  }
  if (rootHasBorder || rootHasBg || rootHasDirectText || _nonAffineProjectiveRoots.has(root)) {
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
      var _rootScrollbarOwner = document.scrollingElement;
      var _rootScrollbarRecord =
        _rootScrollbarOwner != null && typeof args.sk === "string" && args.sk !== ""
          ? _rootScrollbarOwner[args.sk]
          : undefined;
      if (_rootScrollbarRecord != null) result[0].rootScrollbars = _rootScrollbarRecord;
      var _isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      result[0].styles.rootColorScheme = _isDark ? "dark" : "light";
      var _docCs = window.getComputedStyle(document.documentElement);
      result[0].styles.rootBgComputed = _docCs.backgroundColor;
      // DM-1244: <html>'s overflow decides whether <body>'s overflow propagates
      // to the viewport (it only does when <html> is `overflow: visible`). The
      // renderer needs it to know whether to apply <body>'s own overflow clip.
      result[0].styles.rootOverflowX = _docCs.overflowX;
      result[0].styles.rootOverflowY = _docCs.overflowY;
    } catch (_e) {
      /* no-op — never block capture on this */
    }
  }
  return { tree: result, warnings: _warnings };
};

/** Serializable in-page capture entry point; orchestration lives above. */
export const captureScript = (args) => captureDocumentTree(args);
