//
// Named sub-records of the captured element record — scrollbars, native-control rasters, the
// backdrop-filter raster and the computed-size font metrics — extracted from the capture script's
// `captureInner` so the record literal reads as a list of named pieces. Part of the page-`evaluate`d
// CAPTURE_SCRIPT bundle — self-contained, page globals only; every input is an explicit parameter.

import { isWholeHostNativeAppearance } from "../../effective-appearance.js";
import type { CaptureScriptArgs, CapturedElement, CapturedScrollbarSet } from "../../types.js";

type ViewportOrigin = { x: number; y: number };
type NativeDecorationPart = { kind: string; index: number; x: number; y: number; width: number; height: number };

export const captureScrollbarRecord = ({
  args,
  el,
  cs,
  warn,
  sel,
}: {
  args: CaptureScriptArgs;
  el: Element;
  cs: CSSStyleDeclaration;
  warn: (selector: string, category: string, message: string) => void;
  sel: string;
}): CapturedScrollbarSet | undefined => {
  const _record =
    typeof args.scrollbarPropertyKey === "string" && args.scrollbarPropertyKey !== ""
      ? (el as unknown as Record<string, CapturedScrollbarSet | undefined>)[args.scrollbarPropertyKey]
      : undefined;
  if (
    _record == null &&
    (cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowY === "auto" || cs.overflowY === "scroll")
  ) {
    warn(
      sel,
      "scrollbar-capture",
      "live Chromium scrollbar probe did not correlate this scroll host; legacy synthesis is disabled",
    );
  }
  return _record;
};

export const captureNativeControlRaster = ({
  _nativeControlTag,
  rect,
  _effectiveAppearance,
  cs,
  vp,
  _projectiveNodeIndex,
  sel,
  tag,
  el,
}: {
  _nativeControlTag: boolean;
  rect: DOMRect;
  _effectiveAppearance: string | null;
  cs: CSSStyleDeclaration;
  vp: ViewportOrigin;
  _projectiveNodeIndex: Map<Element, number>;
  sel: string;
  tag: string;
  el: Element;
}) => {
  if (!_nativeControlTag || rect.width <= 0 || rect.height <= 0) return undefined;
  if (_effectiveAppearance != null && !isWholeHostNativeAppearance(_effectiveAppearance)) return undefined;
  // null is the explicit fail-closed state: the cascade origin was not
  // available, so preserve Chromium's source paint rather than guessing
  // that the author or theme owns the box.
  // Author outlines and validation-state focus rings paint outside the
  // host border box even though the themed control itself is native.
  // Blink's outline visual overflow is width + positive offset; include
  // that surface in the same snapshot instead of clipping it at `rect`.
  const outlineWidth = parseFloat(cs.outlineWidth) || 0;
  const outlineOffset = parseFloat(cs.outlineOffset) || 0;
  const expand =
    cs.outlineStyle !== "none" && cs.outlineStyle !== "hidden" ? Math.max(0, outlineWidth + outlineOffset) : 0;
  // Skia AA coverage may extend one device-independent pixel past the
  // layout border box (notably the lower edge of rounded author borders
  // on otherwise native inputs). Preserve that visual-overflow fringe;
  // the screenshot and emitted <image> use this same rect, so no scaling
  // or fixture geometry is introduced.
  const paintOverflow = 1;
  const rasterExpand = expand + paintOverflow;
  return {
    x: rect.left - vp.x - rasterExpand,
    y: rect.top - vp.y - rasterExpand,
    width: rect.width + rasterExpand * 2,
    height: rect.height + rasterExpand * 2,
    // Private capture-to-live-DOM correlation. The Node post-pass uses
    // the pre-existing source registry, so no marker attribute can
    // activate author CSS before the isolated Chromium screenshot.
    sourceNodeIndex: _projectiveNodeIndex.get(el),
    selector: sel,
    // LayoutProgress::IsDeterminate feeds ThemePainterDefault's native
    // progress parameters. Only the missing-value state advances its
    // platform paint independently of author animation timelines.
    frameSensitive: (tag === "progress" && !el.hasAttribute("value")) || undefined,
  };
};

export const captureNativeControlDecorationRaster = ({
  _nativeDecorationKinds,
  rect,
  _nativeDecorationParts,
  vp,
  _nativeDecorationUnavailableReason,
  sel,
  _missingNativeDecorationKinds,
  _projectiveNodeIndex,
  el,
}: {
  _nativeDecorationKinds: string[];
  rect: DOMRect;
  _nativeDecorationParts: NativeDecorationPart[];
  vp: ViewportOrigin;
  _nativeDecorationUnavailableReason: string | undefined;
  sel: string;
  _missingNativeDecorationKinds: string[];
  _projectiveNodeIndex: Map<Element, number>;
  el: Element;
}) => {
  if (_nativeDecorationKinds.length === 0 || rect.width <= 0 || rect.height <= 0) return undefined;
  const rasterExpand = 1;
  const _fileButtonPart =
    _nativeDecorationKinds.indexOf("file-selector-button") >= 0
      ? _nativeDecorationParts.find((_part) => _part.kind === "file-selector-button")
      : undefined;
  // ThemePainter owns exactly the file button's border box. The 4px
  // logical-end margin and filename span are separate layout/text paint;
  // author box-shadow is likewise structural outside this source crop.
  const base =
    _fileButtonPart != null
      ? {
          x: _fileButtonPart.x - vp.x,
          y: _fileButtonPart.y - vp.y,
          width: _fileButtonPart.width,
          height: _fileButtonPart.height,
          kinds: _nativeDecorationKinds,
          exactPartBox: true,
        }
      : {
          x: rect.left - vp.x - rasterExpand,
          y: rect.top - vp.y - rasterExpand,
          width: rect.width + rasterExpand * 2,
          height: rect.height + rasterExpand * 2,
          kinds: _nativeDecorationKinds,
        };
  if (_nativeDecorationUnavailableReason != null) {
    return Object.assign(base, {
      unavailableReason: _nativeDecorationUnavailableReason,
      selector: sel,
    });
  }
  if (_missingNativeDecorationKinds.length > 0) {
    return Object.assign(base, {
      unavailableReason: "pierced UA-shadow node missing: " + _missingNativeDecorationKinds.join(", "),
      selector: sel,
    });
  }
  const selectArrow = _nativeDecorationKinds.indexOf("menulist-button-arrow") >= 0;
  if (!selectArrow && _nativeDecorationParts.length === 0) {
    // Used display/visibility/opacity/geometry proves every candidate is
    // currently non-painting (rest/readonly/disabled/base collapse).
    return Object.assign(base, { empty: true });
  }
  return Object.assign(base, {
    sourceNodeIndex: _projectiveNodeIndex.get(el),
    selector: sel,
    selectArrow: selectArrow || undefined,
    parts: _nativeDecorationParts.length > 0 ? _nativeDecorationParts : undefined,
  });
};

export const captureBackdropFilterRaster = ({
  cs,
  rect,
  el,
  vp,
  sel,
  _backdropEffectSpaceFor,
  nextBackdropToken,
}: {
  cs: CSSStyleDeclaration;
  rect: DOMRect;
  el: Element;
  vp: ViewportOrigin;
  sel: string;
  _backdropEffectSpaceFor: (
    el: Element,
  ) => NonNullable<NonNullable<CapturedElement["backdropFilterRaster"]>["effectSpace"]>;
  nextBackdropToken: () => string;
}) => {
  const value =
    cs.backdropFilter || (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || "";
  if (value === "" || value === "none" || rect.width <= 0 || rect.height <= 0) return undefined;
  const token = nextBackdropToken();
  el.setAttribute("data-domotion-backdrop-raster", token);
  return {
    x: rect.left - vp.x,
    y: rect.top - vp.y,
    width: rect.width,
    height: rect.height,
    token,
    selector: sel,
    effectSpace: _backdropEffectSpaceFor(el),
  };
};

/**
 * A font metric re-measured at the element's COMPUTED size (logical CSS size x effective zoom).
 * `metric` is "ascent" or "descent"; `value` is the metric a pseudo/input walker already supplied.
 */
export const computedSizeFontMetric = ({
  metric,
  value,
  cs,
  el,
  _effectiveZoomFor,
  _measureFontMetrics,
}: {
  metric: "ascent" | "descent";
  value: number | null | undefined;
  cs: CSSStyleDeclaration;
  el: Element;
  _effectiveZoomFor: (el: Element) => number;
  _measureFontMetrics: (style: CSSStyleDeclaration, fontSizeOverride?: string) => { ascent: number; descent: number };
}) => {
  if (value == null) return value;
  var _logical = parseFloat(cs.fontSize);
  var _zoom = _effectiveZoomFor(el);
  var _computed = _logical * _zoom;
  if (!isFinite(_computed) || _zoom === 0) return value;
  // Pseudo/input walkers may have supplied metrics for a style other
  // than this host element. Preserve that source and only apply the
  // established local metric when it does not match the host metric.
  if (value !== _measureFontMetrics(cs)[metric]) return value;
  return _measureFontMetrics(cs, _computed.toFixed(4) + "px")[metric];
};
