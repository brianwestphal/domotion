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
// walker handlers live under `./walker/`. `walker/element-capture.ts` owns the
// per-element walk (`capture` / `captureInner`), `walker/capture-phases.ts` its
// geometry/style admission, pseudo/closed-shadow normalization, child
// traversal, and final result-assembly boundaries, and
// `walker/document-prepass.ts` the fact registries, root-relative prepasses,
// root capture, and top-level payload attachment. This file only wires the
// factories together in the order the live page must be observed.

import { createColorNorm } from "./color-norm.js";
import { createEmojiDetect } from "./emoji-detect.js";
import { createDottedCircleDetect } from "./dotted-circle-detect.js";
import { createFontMetrics } from "./font-metrics.js";
import { createPlaceholderShown } from "./placeholder-shown.js";
import { createFontFamilyDefault } from "./font-family-default.js";
import { createFontPaletteResolver } from "./font-palette.js";
import { createPseudoRules } from "./pseudo-rules.js";
import { createWarnings } from "./warnings.js";
import { createCounterStyleResolver } from "./walker/counter-style-resolver.js";
import { createCounterStylePrewalk } from "./walker/counter-prewalk.js";
import { createListsCountersHandler } from "./walker/lists-counters.js";
import { createReplacedElementsHandler } from "./walker/replaced-elements.js";
import { createMasksClipsHandler } from "./walker/masks-clips.js";
import { createFormControlsHandler } from "./walker/form-controls.js";
import { createTransformsHandler, composeEffectiveTransform } from "./walker/transforms.js";
import {
  createBordersBackgroundsHandler,
  physicalComputedGradientImage,
  physicalComputedTileSize as physicalComputedCssPixelTerms,
} from "./walker/borders-backgrounds.js";
import { createBackgroundAttachmentHandler } from "./walker/background-attachment.js";
import { createPseudoContentHandler } from "./walker/pseudo-content.js";
import { createInputValueHandler } from "./walker/input-value.js";
import { createTextSegmentsHandler } from "./walker/text-segments.js";
import { createPseudoInjectHandler } from "./walker/pseudo-inject.js";
import { createResizeHandleHandler } from "./walker/resize-handle.js";
import { createLineClampHandler } from "./line-clamp.js";
import type { CaptureScriptArgs } from "../types.js";
import { parseCrossOriginAllowlist } from "./cross-origin.js";
import { captureFontFamilyStack } from "../../font-family-stack.js";
import { createCounterScopes } from "./walker/counter-scopes.js";
import { createIframeRecursionHandler } from "./walker/iframe-recursion.js";
import { createStyleRecordBuilder } from "./walker/style-record.js";
import { createNativeControlsHandler } from "./walker/native-controls.js";
import { createTextPhaseHandler } from "./walker/text-phase.js";
import { createFidelityWarnings } from "./walker/fidelity-warnings.js";
import { createScrollMarkersHandler } from "./walker/scroll-markers.js";
import { createElementCapture } from "./walker/element-capture.js";
import type { ElementCaptureDeps } from "./walker/element-capture.js";
import {
  attachRootPayloads,
  buildCollapsedBorderFragmentLookup,
  captureRootElements,
  collectAnimInfluenced,
  collectFixedAncestors,
  collectOwnershipElements,
  collectTransformInfluenced,
  createBackdropEffectSpace,
  createBackgroundAttachmentPaintScale,
  createCaptureFactRegistries,
  createEffectiveZoomResolver,
  createFontFeatureValuesLookup,
  createSvgReferenceScopes,
  indexProjectiveFacts,
  probeTransformRelatedBoxes,
  probeContainmentEligibility,
} from "./walker/document-prepass.js";

const captureDocumentTree = (args: CaptureScriptArgs) => {
  const sel = args.selector;
  const vp = args.viewport;
  // DM-1442: cross-origin <iframe> recursion allowlist (the parsed
  // `--cross-origin-frames` value, passed in as `args.crossOriginFrames`). null in the
  // default (Phase 1) configuration — only same-origin frames recurse then.
  const _crossOriginAllow = parseCrossOriginAllowlist(args.crossOriginFrames);
  // DM-2537: Node authenticates each live main-world browsing context against
  // Chromium's DevTools FrameId before this synchronous walk begins. The
  // private registry is capture-local and removed in a finally; it prevents a
  // repeated URL, stale allowlist, or sibling-frame index from authorizing the
  // wrong document during a multi-segment scroll capture.
  const _frameScrollKey = typeof args.frameScrollPropertyKey === "string" ? args.frameScrollPropertyKey : "";
  const _svgReferenceScope = createSvgReferenceScopes();
  const { textPaintFactFor, textPaintSourceKeyFor, textPaintSourceTextNodeIndexFor, pseudoFragmentFactsFor } =
    createCaptureFactRegistries(args);

  // Wire up per-concern helpers. Each factory closes over its own state and
  // returns the handles the element walk / the orchestration tail call.
  const { normColor: normalizeColor, normGradientColors: normalizeGradientColors } = createColorNorm();
  const normColor = normalizeColor as (color: string, elementColor?: string) => string;
  const normGradientColors = normalizeGradientColors as (image: string, elementColor?: string) => string;
  const { rasterCandidates, textNeedsRaster } = createEmojiDetect();
  const { markGetsDottedCircle } = createDottedCircleDetect();
  const {
    measureFontMetrics: _measureFontMetrics,
    measureNormalLineSpacing: _measureNormalLineSpacing,
    substituteAliasedFamilies: _substituteAliasedFamilies,
  } = createFontMetrics();
  const { resolvePlaceholderShownBg: _resolvePlaceholderShownBg } = createPlaceholderShown();
  const {
    familyIsUADefault: _familyIsUADefault,
    pseudoFamilyIsAuthored: _pseudoFamilyIsAuthored,
    familyTypeFromDeclaration: _familyTypeFromDeclaration,
  } = createFontFamilyDefault(args.fontFamilyDeclarationPropertyKey);
  const _fontFamilyStackFor = (el: Element, computedFontFamily: string, pseudo?: string) => {
    // Generated/first-letter/placeholder styles inherit the host's
    // kStandardFamily unless they resolve to a distinct family. CSSOM exposes
    // only the concrete settings name, so join the pseudo back to the host's
    // already-audited declaredness seam before creating the structured list.
    const hostFamily =
      pseudo == null ? computedFontFamily : (el.ownerDocument?.defaultView ?? window).getComputedStyle(el).fontFamily;
    const provenType = _familyTypeFromDeclaration(el, computedFontFamily, pseudo);
    const inheritedHostStandard =
      provenType === "standard" || provenType === "concrete"
        ? provenType === "standard"
        : (pseudo == null || (computedFontFamily === hostFamily && !_pseudoFamilyIsAuthored(el, pseudo))) &&
          _familyIsUADefault(el, hostFamily, provenType === "unusable");
    return captureFontFamilyStack(computedFontFamily, inheritedHostStandard);
  };
  const { resolveFontPalette: _resolveFontPalette, resolveShadowFontPalettes: _resolveShadowFontPalettes } =
    createFontPaletteResolver();
  const _fontFeatureValuesFor = createFontFeatureValuesLookup();
  const { resolvePseudo: _resolvePseudo, resolveCornerRadius: _resolveCornerRadius } = createPseudoRules(
    args.pseudoStylesByHost as Parameters<typeof createPseudoRules>[0],
    args.pseudoStylePropertyKey,
  );
  const { warn, shortSelector, warnings: _warnings } = createWarnings();
  // DM-770: counter-style map is populated by the pre-walk below (which
  // reads @counter-style rules from document.styleSheets); declared here so
  // the lists-counters and pseudo-content handlers close over the same
  // object reference via the shared counter-style resolver.
  const _counterStyles: Parameters<typeof createCounterStyleResolver>[0]["counterStyles"] = {};
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
    discoverFragmentReferences,
    computeMaskIntrinsic,
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
  const _collapsedBorderFragmentByTable = buildCollapsedBorderFragmentLookup(args);
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
    scrollbarPropertyKey: args.scrollbarPropertyKey,
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
    pseudoImageSizingKey: args.pseudoImageSizingKey,
  });
  const { captureInputValue } = createInputValueHandler({
    vp,
    normColor,
    measureFontMetrics: _measureFontMetrics,
    fontFamilyStackFor: _fontFamilyStackFor,
    valueTextGeometryKey: args.inputValuePropertyKey,
    warn,
    shortSelector,
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
    sourceTextNodeIndexFor: textPaintSourceTextNodeIndexFor,
  });
  const { injectPseudoSegments } = createPseudoInjectHandler();
  const { captureResizeHandle } = createResizeHandleHandler({
    resolvePseudo: _resolvePseudo,
    normColor,
    effectiveZoomFor: (el) => _effectiveZoomFor(el),
    themeThickness: args.resizerThemeThickness,
    scaleFromDIP: args.resizerScaleFromDip,
    vp,
  });

  // The per-element walk (walker/element-capture.ts). Its dependencies are
  // bound below, once the root-relative prepasses have run.
  const elementCapture = createElementCapture();
  const capture = elementCapture.capture;

  const { _captureScrollMarkerGroup, _captureScrollButtons } = createScrollMarkersHandler({ capture });

  const root = document.querySelector(sel);
  if (!root) return { tree: [], warnings: [] };

  // Root-relative prepasses (walker/document-prepass.ts), in the order they
  // must observe the live page: before any transform is frozen.
  const _allEls = root.getElementsByTagName("*");
  const _fixedAncestors = collectFixedAncestors(root, _allEls, vp);
  const _transformInfluenced = collectTransformInfluenced(_allEls);
  const _transformRelatedBox = new WeakMap<Element, boolean>();
  const _paintOrLayoutContainmentEligible = new WeakMap<Element, boolean>();
  const _ownershipEls = collectOwnershipElements(root, _allEls);
  const _backdropEffectSpaceFor = createBackdropEffectSpace(_ownershipEls, shortSelector);
  probeTransformRelatedBoxes(_ownershipEls, _transformRelatedBox);
  probeContainmentEligibility(_ownershipEls, _paintOrLayoutContainmentEligible);
  const { projectiveFacts, projectiveNodeIndex, projectedQuads, projectiveAbsH, nonAffineProjectiveRoots } =
    indexProjectiveFacts(args);
  const _animInfluenced = collectAnimInfluenced(_allEls);
  const _effectiveZoomFor = createEffectiveZoomResolver();
  const _backgroundAttachmentPaintScaleFor = createBackgroundAttachmentPaintScale();
  const { counterSnapshot: _counterSnapshot, counterPreWalk: _counterPreWalk } = createCounterScopes();
  _counterPreWalk(root);
  const { _captureIframeRecursion, _iframeFrameAuthority, _iframeIsRecursable } = createIframeRecursionHandler({
    _counterPreWalk,
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
    _iframeIsRecursable: _iframeIsRecursable as Parameters<typeof createFidelityWarnings>[0]["_iframeIsRecursable"],
    _iframeFrameAuthority: _iframeFrameAuthority as Parameters<
      typeof createFidelityWarnings
    >[0]["_iframeFrameAuthority"],
    _frameScrollKey,
  });
  const { captureTextPhase } = createTextPhaseHandler({
    capturePseudoContent: capturePseudoContent as Parameters<typeof createTextPhaseHandler>[0]["capturePseudoContent"],
    _counterSnapshot,
    captureInputValue: captureInputValue as Parameters<typeof createTextPhaseHandler>[0]["captureInputValue"],
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
    captureFormControls: captureFormControls as Parameters<typeof createStyleRecordBuilder>[0]["captureFormControls"],
    threadFrozenTransform,
    _backgroundAttachmentPaintScaleFor,
    _effectiveZoomFor,
    _fontFeatureValuesFor,
    _resolveFontPalette,
    _resolveShadowFontPalettes,
    _transformRelatedBox,
    _paintOrLayoutContainmentEligible,
    captureBackgroundAttachment: captureBackgroundAttachment as Parameters<
      typeof createStyleRecordBuilder
    >[0]["captureBackgroundAttachment"],
    captureBordersBackgrounds: captureBordersBackgrounds as Parameters<
      typeof createStyleRecordBuilder
    >[0]["captureBordersBackgrounds"],
    computeMaskIntrinsic,
    isTableCellHiddenByEmptyCells,
    normColor,
  });
  elementCapture.bind({
    args,
    vp,
    warn,
    shortSelector,
    wrapWithFrozenTransform,
    textPaintFactFor,
    textPaintSourceKeyFor,
    pseudoFragmentFactsFor,
    fontFamilyStackFor: _fontFamilyStackFor,
    svgReferenceScope: _svgReferenceScope,
    effectiveZoomFor: _effectiveZoomFor,
    measureFontMetrics: _measureFontMetrics,
    measureNormalLineSpacing: _measureNormalLineSpacing,
    fixedAncestors: _fixedAncestors,
    transformInfluenced: _transformInfluenced,
    animInfluenced: _animInfluenced,
    projectiveFacts,
    projectiveNodeIndex,
    nonAffineProjectiveRoots,
    projectedQuads,
    projectiveAbsH,
    backdropEffectSpaceFor: _backdropEffectSpaceFor as ElementCaptureDeps["backdropEffectSpaceFor"],
    captureNativeControlState,
    warnBeforeMaskDiscovery,
    warnAfterMaskDiscovery,
    discoverFragmentReferences,
    captureTextPhase,
    captureListsCounters,
    captureResizeHandle,
    buildStyleRecord,
    handleReplacedElement,
    iframeFrameAuthority: _iframeFrameAuthority as ElementCaptureDeps["iframeFrameAuthority"],
    captureIframeRecursion: _captureIframeRecursion as ElementCaptureDeps["captureIframeRecursion"],
    captureScrollMarkerGroup: _captureScrollMarkerGroup as ElementCaptureDeps["captureScrollMarkerGroup"],
    captureScrollButtons: _captureScrollButtons as ElementCaptureDeps["captureScrollButtons"],
  });

  // DM-770: collect `@counter-style` rule definitions from all stylesheets into
  // the shared `_counterStyles` map, so the lists-counters / pseudo-content
  // walkers can resolve `list-style-type: <custom-name>` and `counter(name,
  // style)` markers per system. Chrome doesn't expose the resolved marker via
  // `getComputedStyle(li, '::marker').content`, so the resolver re-implements
  // the CSS algorithm against this map. (Parser + walker extracted to
  // walker/counter-prewalk.ts — DM-1086.)
  _runCounterStylePrewalk();

  const result = captureRootElements(
    root,
    capture,
    nonAffineProjectiveRoots,
    args.insetRootShadowContextKey,
    pseudoFragmentFactsFor,
  );
  attachRootPayloads(result, args, {
    maskDefs: _maskDefs,
    clipPathDefs: _clipPathDefs,
    filterDefs: _filterDefs,
    maskRasters: _maskRasters,
  });
  return { tree: result, warnings: _warnings };
};

/** Serializable in-page capture entry point; orchestration lives above. */
export const captureScript = (args: CaptureScriptArgs) => captureDocumentTree(args);
