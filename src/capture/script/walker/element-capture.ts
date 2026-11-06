//
// The per-element capture walk (`capture` / `captureInner`) of the in-page
// CAPTURE_SCRIPT, split out of `src/capture/script/index.ts`. The walk is
// cyclic with several handlers the orchestrator builds from it (scroll
// markers, iframe recursion), and it consumes prepass facts the orchestrator
// computes only after the capture root is known. `createElementCapture()`
// therefore returns `capture` immediately and receives its dependencies
// through `bind()` before the first call; every dependency is read at call
// time exactly as the former closure read them. Bundled into the page script
// by esbuild, so nothing here may reach Node modules at runtime.

import { computeFieldsetLegendBox } from "./fieldset-legend.js";
import { detectInlineFragments } from "./fragmentation.js";
import { captureInlineSvg } from "./inline-svg.js";
import { captureImageElement } from "./image-elements.js";
import { computeElementRaster } from "./text-segments.js";
import { assembleCaptureResultPhase, captureGeometryStylePhase, captureTraversalPhase } from "./capture-phases.js";
import { projectiveStateFor, transformSubtreeRasterFor, transformSubtreeRasterOwner } from "./projective-state.js";
import {
  captureBackdropFilterRaster,
  captureNativeControlDecorationRaster,
  captureNativeControlRaster,
  captureScrollbarRecord,
  computedSizeFontMetric,
} from "./element-rasters.js";
import { resolveElementCursor, isOutsideCaptureViewport } from "../utils.js";
import type { CaptureScriptArgs, CapturedElement } from "../../types.js";
import type { ProjectivePaintNodeFact } from "../../projective-owner.js";
import type { createNativeControlsHandler } from "./native-controls.js";
import type { createFidelityWarnings } from "./fidelity-warnings.js";
import type { createMasksClipsHandler } from "./masks-clips.js";
import type { createTextPhaseHandler } from "./text-phase.js";
import type { createListsCountersHandler } from "./lists-counters.js";
import type { createResizeHandleHandler } from "./resize-handle.js";
import type { createStyleRecordBuilder } from "./style-record.js";
import type { createTransformsHandler } from "./transforms.js";
import type { createFontMetrics } from "../font-metrics.js";
import type { createReplacedElementsHandler } from "./replaced-elements.js";

type AssemblePhaseInput = Parameters<typeof assembleCaptureResultPhase>[0];
type NativeControlState = ReturnType<ReturnType<typeof createNativeControlsHandler>["captureNativeControlState"]>;
type TextPhase = ReturnType<ReturnType<typeof createTextPhaseHandler>["captureTextPhase"]>;
type FontMetrics = ReturnType<typeof createFontMetrics>;
type TextPaintFact = { geometry?: CapturedElement["textPaintGeometry"] } | undefined;

export type ElementCaptureDeps = {
  args: CaptureScriptArgs;
  vp: CaptureScriptArgs["viewport"];
  warn: (selector: string, property: string, message: string) => void;
  shortSelector: (el: Element) => string;
  wrapWithFrozenTransform: ReturnType<typeof createTransformsHandler>["wrapWithFrozenTransform"];
  textPaintFactFor: (el: Element) => TextPaintFact;
  textPaintSourceKeyFor: (el: Element) => string | undefined;
  pseudoFragmentFactsFor: (el: Element) => CapturedElement["pseudoFragments"] | undefined;
  fontFamilyStackFor: (el: Element, computedFontFamily: string, pseudo?: string) => unknown;
  svgReferenceScope: (el: Element) => number;
  effectiveZoomFor: (el: Element | null) => number;
  measureFontMetrics: FontMetrics["measureFontMetrics"];
  measureNormalLineSpacing: FontMetrics["measureNormalLineSpacing"];
  // Prepass facts.
  fixedAncestors: Set<Element>;
  transformInfluenced: Set<Element>;
  animInfluenced: Set<Element>;
  projectiveFacts: ProjectivePaintNodeFact[];
  projectiveNodeIndex: WeakMap<Element, number>;
  nonAffineProjectiveRoots: Set<Element>;
  projectedQuads: WeakMap<Element, Array<{ x: number; y: number }>>;
  projectiveAbsH: WeakMap<Element, number[]>;
  backdropEffectSpaceFor: Parameters<typeof captureBackdropFilterRaster>[0]["_backdropEffectSpaceFor"];
  // Per-concern handlers.
  captureNativeControlState: ReturnType<typeof createNativeControlsHandler>["captureNativeControlState"];
  warnBeforeMaskDiscovery: ReturnType<typeof createFidelityWarnings>["warnBeforeMaskDiscovery"];
  warnAfterMaskDiscovery: ReturnType<typeof createFidelityWarnings>["warnAfterMaskDiscovery"];
  discoverFragmentReferences: ReturnType<typeof createMasksClipsHandler>["discoverFragmentReferences"];
  captureTextPhase: ReturnType<typeof createTextPhaseHandler>["captureTextPhase"];
  captureListsCounters: ReturnType<typeof createListsCountersHandler>["captureListsCounters"];
  captureResizeHandle: ReturnType<typeof createResizeHandleHandler>["captureResizeHandle"];
  buildStyleRecord: ReturnType<typeof createStyleRecordBuilder>;
  handleReplacedElement: ReturnType<typeof createReplacedElementsHandler>["handleReplacedElement"];
  iframeFrameAuthority: AssemblePhaseInput["iframeFrameAuthority"];
  captureIframeRecursion: AssemblePhaseInput["captureIframeRecursion"];
  captureScrollMarkerGroup: AssemblePhaseInput["captureScrollMarkerGroup"];
  captureScrollButtons: AssemblePhaseInput["captureScrollButtons"];
};

// The source-owned facts of one element, gathered in walk order before the
// captured record is assembled.
type ElementFacts = {
  el: Element;
  cs: CSSStyleDeclaration;
  tag: string;
  rect: DOMRect;
  sel: string;
  frozenTransform?: string | null;
  frozenTransformOrigin?: string | null;
  textPaintFact: TextPaintFact;
  pseudoFragmentFacts: CapturedElement["pseudoFragments"] | undefined;
  capturedFontFamilyStack: unknown;
  native: NativeControlState;
  maskFragmentReferences: CapturedElement["maskFragmentReferences"] | null | undefined;
  maskFragmentReferenceScope: number | null | undefined;
  clipFragmentReferenceScope: number | null | undefined;
  urlFilterRasterToken: string | null | undefined;
  text: TextPhase;
  image: ReturnType<typeof captureImageElement>;
  listsCounters: ReturnType<ReturnType<typeof createListsCountersHandler>["captureListsCounters"]>;
  svgContent: string | undefined;
  svgReferenceScope: number | undefined;
  children: CapturedElement["children"];
  fieldsetBox: ReturnType<typeof computeFieldsetLegendBox>;
  projective: ReturnType<typeof projectiveStateFor>;
  transformSubtreeRaster: CapturedElement["transformSubtreeRaster"];
};

// DM-1532 / DM-2474: resolve the element's 3D paint state and whether it
// owns a Chromium transform-subtree raster boundary.
const resolveElementProjection = (
  d: ElementCaptureDeps,
  el: Element,
  cs: CSSStyleDeclaration,
  rect: DOMRect,
  textPaintFact: TextPaintFact,
) => {
  const projectiveIndex = d.projectiveNodeIndex.get(el);
  const ownsRasterBoundary = d.nonAffineProjectiveRoots.has(el);
  const projective = projectiveStateFor({
    args: d.args,
    vp: d.vp,
    cs,
    rect,
    fact: projectiveIndex != null ? d.projectiveFacts[projectiveIndex] : undefined,
    ownsRasterBoundary,
    quad: d.projectedQuads.get(el),
    parentAbsolute: el.parentElement != null ? d.projectiveAbsH.get(el.parentElement) : undefined,
    recordAbsolute: (absolute) => d.projectiveAbsH.set(el, absolute),
  });
  const makeTransformSubtreeRaster = () => transformSubtreeRasterFor(el, rect, d.vp, d.projectiveNodeIndex.get(el));
  const transformSubtreeRaster = transformSubtreeRasterOwner({
    makeRaster: makeTransformSubtreeRaster,
    ownsRasterBoundary,
    textPaintFact: textPaintFact as { surfaceReason?: string | null } | undefined,
    warn: d.warn,
    selector: () => d.shortSelector(el),
  });
  return { projective, transformSubtreeRaster, makeTransformSubtreeRaster };
};

// Inline <svg>: bake the clone (walker/inline-svg.ts). Missing/singular CTMs
// and failed isolated-clone correlation are an explicit vector boundary,
// never a request for cssTransformToSvg's six-entry matrix3d approximation;
// the caller reuses the outer Chromium raster owner when one is required.
const captureInlineSvgPhase = (d: ElementCaptureDeps, el: Element, cs: CSSStyleDeclaration, sel: string) => {
  const externalSvgDocuments =
    typeof d.args.externalSvgUseKey === "string" && d.args.externalSvgUseKey !== ""
      ? ((globalThis as Record<string, unknown>)[d.args.externalSvgUseKey] as Parameters<typeof captureInlineSvg>[4])
      : undefined;
  return captureInlineSvg(el as SVGSVGElement, cs, d.warn, sel, externalSvgDocuments);
};

// Record identity, box, and reference-scope fields (the head of the record).
const buildCapturedIdentity = (d: ElementCaptureDeps, f: ElementFacts) => {
  const { el, cs, tag, rect, sel } = f;
  return {
    tag,
    text: f.text.text,
    x: f.fieldsetBox.x,
    y: f.fieldsetBox.y,
    width: f.fieldsetBox.width,
    height: f.fieldsetBox.height,
    fieldsetLegendNotch: f.fieldsetBox.fieldsetLegendNotch,
    resizeHandle: d.captureResizeHandle(el as HTMLElement, cs, tag, rect),
    // DM-2481: populated by the Node-side live Chromium marker probe.  The
    // serialized record is already in capture-viewport coordinates and may
    // be explicitly partial/unavailable; the renderer must never infer a
    // replacement from scrollWidth/clientWidth or scroll offsets.
    scrollbars: captureScrollbarRecord({ args: d.args, el, cs, warn: d.warn, sel }),
    animId: (el as HTMLElement).dataset?.domotionAnim,
    // DM-900: author-supplied magic-move pairing key (`data-magic-key`). When
    // present on the same logical element across two animation frames, the
    // magic-move matcher force-pairs them ahead of its fingerprint heuristic.
    magicKey: (el as HTMLElement).dataset?.magicKey,
    // DM-2457: private correlation only. The Node/CDP post-pass resolves the
    // real generated ::marker fragment and deletes this index before return.
    _summaryMarkerSourceNodeIndex:
      tag === "summary" && cs.display != null && cs.display.includes("list-item")
        ? d.projectiveNodeIndex.get(el)
        : undefined,
    svgReferenceScope: f.svgReferenceScope,
    fragmentReferenceScope:
      f.maskFragmentReferenceScope != null ? f.maskFragmentReferenceScope : f.clipFragmentReferenceScope,
    fragmentReferenceZoom:
      (f.maskFragmentReferences != null && f.maskFragmentReferences.length > 0) || f.clipFragmentReferenceScope != null
        ? d.effectiveZoomFor(el)
        : undefined,
    maskFragmentReferences:
      f.maskFragmentReferences != null && f.maskFragmentReferences.length > 0 ? f.maskFragmentReferences : undefined,
    // DM-1106: effective cursor keyword for the auto cursor-overlay hit-test.
    // Omitted when it resolves to the default arrow (the common case) to keep
    // the tree lean — the overlay treats a missing value as `default`.
    cursor: (() => {
      const _c = resolveElementCursor(el as HTMLElement, cs);
      return _c === "default" ? undefined : _c;
    })(),
  };
};

// Styles, projective state, children, replaced/inline-SVG content, and the
// text facts of the record.
const buildCapturedContent = (d: ElementCaptureDeps, f: ElementFacts) => {
  const { el, cs, tag, rect } = f;
  const text = f.text;
  return {
    styles: d.buildStyleRecord({
      el: el as HTMLElement,
      cs,
      tag,
      rect,
      frozenTransform: f.frozenTransform,
      frozenTransformOrigin: f.frozenTransformOrigin,
      isPlaceholderCapture: text.isPlaceholderCapture,
      ...f.native,
      _capturedFontFamilyStack: f.capturedFontFamilyStack,
    } as Parameters<ElementCaptureDeps["buildStyleRecord"]>[0]) as CapturedElement["styles"],
    projectiveTransform: f.projective.projectiveTransform,
    projectiveHidden: f.projective.projectiveHidden,
    projectiveFrameState: f.projective.projectiveFrameState,
    transformSubtreeRaster: f.transformSubtreeRaster,
    children: f.children,
    imageSrc: f.image.imageSrc,
    imageIntrinsic: f.image.imageIntrinsic,
    imageEffectiveZoom: f.image.imageEffectiveZoom,
    imageBroken: f.image.imageBroken,
    imageAlt: f.image.imageAlt,
    brokenImageFallback: f.image.brokenImageFallback,
    svgContent: f.svgContent,
    pseudoFragments: Array.isArray(f.pseudoFragmentFacts) ? f.pseudoFragmentFacts : undefined,
    pseudoImages: text.pseudoImages,
    pseudoBoxes: text.pseudoBoxes.length > 0 ? text.pseudoBoxes : undefined,
    // SK-1115: ::marker pseudo styles plus list-marker intrinsic dims and
    // list-item index — see walker/lists-counters.ts.
    ...f.listsCounters,
    textSegments: text.textSegments.length > 0 ? text.textSegments : undefined,
    textPaintGeometry: f.textPaintFact != null ? f.textPaintFact.geometry : undefined,
    // Correlation marker emitted only by the all-transform-neutral probe
    // capture and consumed before that intermediate tree is discarded.
    _textPaintSourceKey: d.args.textPaintProbe === true ? d.textPaintSourceKeyFor(el) : undefined,
    lineClampTextFragments: text.lineClampTextFragments || undefined,
    textTop: text.textTop,
    textLeft: text.textLeft,
    textHeight: text.textHeight,
    textWidth: text.textWidth,
    // DM-2446: Blink chooses and measures the face at computed size
    // (logical CSS size × effective zoom), then the transform stage scales
    // those metrics into paint space. Re-measure at computed size instead of
    // multiplying logical-size metrics by zoom: variable-font metrics can
    // change non-linearly when the computed size selects another instance.
    fontAscent: computedSizeFontMetric({
      metric: "ascent",
      value: text.fontAscent,
      cs,
      el,
      _effectiveZoomFor: d.effectiveZoomFor,
      _measureFontMetrics: d.measureFontMetrics,
    }),
    fontDescent: computedSizeFontMetric({
      metric: "descent",
      value: text.fontDescent,
      cs,
      el,
      _effectiveZoomFor: d.effectiveZoomFor,
      _measureFontMetrics: d.measureFontMetrics,
    }),
    // Blink's `line-height: normal` at the computed size (see font-metrics.ts); only recorded when the
    // computed value IS `normal`, so a numeric line-height never pays for the probe.
    normalLineHeight:
      cs.lineHeight === "normal" && isFinite(parseFloat(cs.fontSize) * d.effectiveZoomFor(el))
        ? d.measureNormalLineSpacing(cs, (parseFloat(cs.fontSize) * d.effectiveZoomFor(el)).toFixed(4) + "px")
        : undefined,
    inputXOffsets: text.inputXOffsets,
    textImageUri: undefined,
    textImageScale: 2,
    // Placeholder metadata (SK-1097 / SK-1100 / SK-1099): captured in
    // walker/input-value.ts when the host is a placeholder-shown input
    // or textarea. Undefined elsewhere.
    isPlaceholderText: text.isPlaceholderCapture || undefined,
    placeholderColor: text.placeholderColor,
    placeholderFontStyle: text.placeholderFontStyle,
    placeholderFontWeight: text.placeholderFontWeight,
    placeholderFontFamily: text.placeholderFontFamily,
    placeholderFontFamilyStack: text.placeholderFontFamilyStack,
  };
};

// Chromium-owned raster sub-records (the tail of the record).
const buildCapturedRasters = (d: ElementCaptureDeps, f: ElementFacts, nextBackdropToken: () => string) => {
  const { el, cs, tag, rect, sel } = f;
  const vp = d.vp;
  return {
    // Old-capture compatibility field. Current textarea and vertical text
    // capture is fully vector; see walker/text-segments.ts.
    elementRaster: computeElementRaster(el, cs, tag, rect, vp),
    // DM-2149 / DM-2453: snapshot only appearances for which Blink's
    // ThemePainter owns the complete host. EffectiveAppearance is derived
    // above from the actual auto mapping and cascade-origin author flags.
    // menulist-button/listbox/base states keep their author-owned host box
    // structural; native decoration splitting is owned by DM-2455.
    nativeControlRaster: captureNativeControlRaster({
      ...f.native,
      rect,
      cs,
      vp,
      _projectiveNodeIndex: d.projectiveNodeIndex,
      sel,
      tag,
      el,
    }),
    // A CSS-owned host can still contain either ThemePainter's select arrow
    // or layout-backed closed-UA-shadow decorations. Keep the host box and
    // value text structural, but reserve this narrow overlay so a failed
    // Chromium isolation can never reopen the sampled glyph functions.
    nativeControlDecorationRaster: captureNativeControlDecorationRaster({
      ...f.native,
      rect,
      vp,
      sel,
      _projectiveNodeIndex: d.projectiveNodeIndex,
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
      _backdropEffectSpaceFor: d.backdropEffectSpaceFor,
      nextBackdropToken,
    }),
    // DM-2415: a CSS URL filter containing feConvolveMatrix needs Blink's
    // original layer-space SourceGraphic pixels. The Node post-pass replaces
    // this placeholder with the isolated, fully-filtered Chromium surface.
    urlFilterRaster:
      f.urlFilterRasterToken == null
        ? undefined
        : {
            x: rect.left - vp.x,
            y: rect.top - vp.y,
            width: rect.width,
            height: rect.height,
            token: f.urlFilterRasterToken,
          },
  };
};

export const createElementCapture = () => {
  let deps: ElementCaptureDeps | null = null;
  let backdropRasterSeq = 0;
  const nextBackdropToken = () => "bf" + backdropRasterSeq++;

  const capture = (el: Element): CapturedElement | null => {
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
    return deps!.wrapWithFrozenTransform(el as HTMLElement, cs, captureInner);
  };

  const captureInner = (
    el: Element,
    cs: CSSStyleDeclaration,
    frozenTransform?: string | null,
    frozenTransformOrigin?: string | null,
  ): CapturedElement | null => {
    const d = deps!;
    const vp = d.vp;
    const rect = el.getBoundingClientRect();
    const textPaintFact = d.textPaintFactFor(el);
    const pseudoFragmentFacts = d.pseudoFragmentFactsFor(el);
    const capturedFontFamilyStack = d.fontFamilyStackFor(el, cs.fontFamily);
    const projection = resolveElementProjection(d, el, cs, rect, textPaintFact);
    let transformSubtreeRaster = projection.transformSubtreeRaster;
    // DM-513: when an element's rect is outside the viewport, normally skip the
    // whole subtree. But position:fixed / position:sticky descendants escape
    // their containing-block flow and can paint INSIDE the viewport even when
    // their DOM-tree parent is offscreen (e.g. slashdot's #mongo-stick-it ad
    // bar is position:fixed at top:710px but its parent <footer id="ft"> is
    // at y=7140 in the document flow). Don't return null for an ancestor that
    // has at least one position:fixed/sticky descendant in-viewport — instead
    // capture the element as a transparent container (no own paint, but walk
    // children) so the in-viewport descendants are reached. fixedAncestors
    // is precomputed by the document prepass.
    const geometryStyle = captureGeometryStylePhase({
      el: el as HTMLElement,
      cs,
      rect,
      vp,
      fixedAncestors: d.fixedAncestors,
      transformInfluenced: d.transformInfluenced,
      animInfluenced: d.animInfluenced,
      isOutsideCaptureViewport: (rect) => isOutsideCaptureViewport(rect, vp),
    });
    if (geometryStyle == null) return null;
    const { bordersOnlyCell, contentVisibilityHidden, tag } = geometryStyle;

    // Emit warnings for features domotion can't fully round-trip. Keep
    // these short and actionable — consumers (CLI, tests, demo scripts) log
    // them so the fidelity gaps are self-documenting.
    const sel = d.shortSelector(el);
    const native = d.captureNativeControlState({
      el: el as Parameters<ElementCaptureDeps["captureNativeControlState"]>[0]["el"],
      cs,
      tag,
      sel,
      _pseudoFragmentFacts: pseudoFragmentFacts,
    } as Parameters<ElementCaptureDeps["captureNativeControlState"]>[0]);
    d.warnBeforeMaskDiscovery(el, cs, sel);
    const { maskFragmentReferences, maskFragmentReferenceScope, clipFragmentReferenceScope, urlFilterRasterToken } =
      d.discoverFragmentReferences(el, cs, sel);
    d.warnAfterMaskDiscovery(el, cs, tag, sel);
    let svgContent = undefined;
    const text = d.captureTextPhase({
      el,
      cs,
      tag,
      rect,
      _contentVisHidden: contentVisibilityHidden,
      _pseudoFragmentFacts: pseudoFragmentFacts,
    } as Parameters<ElementCaptureDeps["captureTextPhase"]>[0]);
    const image = captureImageElement({
      el: el as HTMLElement,
      tag,
      rect,
      vp,
      sel,
      effectiveZoomFor: d.effectiveZoomFor,
      sourceNodeIndex: d.projectiveNodeIndex.get(el),
    });
    const listsCounters = d.captureListsCounters(el, cs, tag);
    let svgReferenceScope = undefined;
    if (tag === "svg") {
      const inlineSvgCapture = captureInlineSvgPhase(d, el, cs, sel);
      svgContent = inlineSvgCapture.content;
      if (inlineSvgCapture.rasterOwnershipRequired && transformSubtreeRaster == null) {
        transformSubtreeRaster = projection.makeTransformSubtreeRaster();
      }
      svgReferenceScope = d.svgReferenceScope(el);
    }

    const children = captureTraversalPhase({ el, tag, contentVisibilityHidden, capture });

    // <fieldset>+<legend> box adjustment (DM-1436: extracted to walker/fieldset-legend.ts).
    const fieldsetBox = computeFieldsetLegendBox(el as HTMLElement, tag, rect, vp);

    const facts: ElementFacts = {
      el,
      cs,
      tag,
      rect,
      sel,
      frozenTransform,
      frozenTransformOrigin,
      textPaintFact,
      pseudoFragmentFacts,
      capturedFontFamilyStack,
      native,
      maskFragmentReferences,
      maskFragmentReferenceScope,
      clipFragmentReferenceScope,
      urlFilterRasterToken,
      text,
      image,
      listsCounters,
      svgContent,
      svgReferenceScope,
      children,
      fieldsetBox,
      projective: projection.projective,
      transformSubtreeRaster,
    };
    // Built in walk order: each builder's live probes run in the same
    // sequence the single literal used to evaluate them.
    const captured = {
      ...buildCapturedIdentity(d, facts),
      ...buildCapturedContent(d, facts),
      ...buildCapturedRasters(d, facts, nextBackdropToken),
    } as CapturedElement;
    return assembleCaptureResultPhase({
      captured,
      el,
      cs,
      tag,
      rect,
      vp,
      bordersOnlyCell,
      detectInlineFragments,
      iframeFrameAuthority: d.iframeFrameAuthority,
      captureIframeRecursion: d.captureIframeRecursion,
      handleReplacedElement: d.handleReplacedElement,
      captureScrollMarkerGroup: d.captureScrollMarkerGroup,
      captureScrollButtons: d.captureScrollButtons,
    });
  };

  const bind = (next: ElementCaptureDeps) => {
    deps = next;
  };

  return { capture, bind };
};
