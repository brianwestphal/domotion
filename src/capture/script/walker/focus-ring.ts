//
// `outline-style: auto` focus rings. Part of the page-`evaluate`d
// CAPTURE_SCRIPT bundle — self-contained, page globals only.
//
// Blink paints an auto outline as two rings, ignoring `outline-width`
// (`PaintFocusRing`, core/paint/outline_painter.cc:853-893, Chromium
// 6b5a1b80). Each is an anti-aliased stroke centered on a rounded rect
// (`DrawPlatformFocusRing`, platform/graphics/platform_focus_ring.cc).
//
// - Ring width W = AdjustBorderWidthByZoom(3, zoom) = max(floor(3·zoom), 1)
//   at zoom >= 1, else 3 (`FocusRingStrokeWidth`, :39-48;
//   ui/native_theme/native_theme.cc:176-179).
// - Both rings stroke at 2W/3.
// - The inner ring is offset by `FocusRingOffset` (:59-73). That is the
//   integer outline-offset, less AdjustBorderWidthByZoom(1, zoom) when the
//   smallest border is at least that wide.
// - The outer ring sits a further ceil(W/3) out and paints first: white, or
//   #101010 under a dark used color scheme.
// - The inner ring takes the outline color, except that it is white in a dark
//   scheme on non-mac builds.

/** Renderer-facing facts for one auto outline. Lengths are physical px. */
export interface FocusRingFacts {
  ringWidth: number;
  ringOffset: number;
  outlineOffset: number;
  outerColor: string;
  innerColor: string;
  /** Inputs of Blink's corner-radius branch choice. */
  corners: FocusRingCornerSource;
}

/** NativeThemeBase parts whose radius a focus ring copies. */
export type FocusRingNativePart = "checkbox" | "radio" | "push-button" | "text-field";

/**
 * `GetFocusRingCornerRadii` (core/paint/outline_painter.cc:755-803, chromium
 * 6b5a1b80) reads cascade origin, which getComputedStyle does not expose:
 *
 * 1. A nonzero border radius with `HasAuthorBorderRadius()` (or a base
 *    effective appearance) grows those radii by the outline offset.
 * 2. Otherwise, without `HasAuthorBorder()`, an effective appearance takes
 *    the NativeTheme part radius.
 * 3. Otherwise every corner is the ring width W.
 *
 * Capture records the origin-dependent inputs; the renderer applies the
 * nonzero-radius test of step 1 to the radii it already parses.
 */
export interface FocusRingCornerSource {
  /** Step 1 applies when the border radius is nonzero. */
  borderRadiusEligible: boolean;
  /** Step 2's part, when the box has no author border. */
  nativePart?: FocusRingNativePart;
  /** The zoom-adjusted part radius (`AdjustBorderRadiusByZoom`). Radio has
   * none: its radius is half the larger reference-box side. */
  nativePartRadius?: number;
  /** A native control whose cascade origin was unavailable. Step 1 is
   * assumed and step 2 cannot be decided. */
  unresolved?: boolean;
}

/** Cascade-origin facts from the Chromium matched-style pre-pass. */
interface FocusRingOriginFacts {
  available: boolean;
  hasAuthorBorder: boolean;
  hasAuthorBorderRadius: boolean;
}

/**
 * Resolve the corner source for a native control from its effective
 * appearance and author-origin facts. Elements outside the pre-pass have no
 * effective appearance; Blink's UA sheet gives them no border radius, so any
 * radius is authored.
 */
export const focusRingCornerSource = (
  nativeControl: boolean,
  effectiveAppearance: string | null | undefined,
  facts: FocusRingOriginFacts | undefined,
  effectiveZoom: number,
): FocusRingCornerSource => {
  if (!nativeControl) return { borderRadiusEligible: true };
  if (effectiveAppearance == null || facts == null || !facts.available) {
    return { borderRadiusEligible: true, unresolved: true };
  }
  const hasAppearance = effectiveAppearance !== "none";
  const baseAppearance = effectiveAppearance === "base" || effectiveAppearance === "base-select";
  const source: FocusRingCornerSource = {
    borderRadiusEligible: (hasAppearance && baseAppearance) || facts.hasAuthorBorderRadius,
  };
  if (facts.hasAuthorBorder || !hasAppearance) return source;
  let part: FocusRingNativePart | undefined;
  switch (effectiveAppearance) {
    case "checkbox":
      part = "checkbox";
      break;
    case "radio":
      part = "radio";
      break;
    case "push-button":
    case "square-button":
    case "button":
      part = "push-button";
      break;
    case "textfield":
    case "textarea":
    case "searchfield":
      part = "text-field";
      break;
  }
  if (part == null) return source;
  source.nativePart = part;
  // NativeThemeBase::GetBorderRadiusForPart is 2 for checkbox, push button
  // and text field (ui/native_theme/native_theme_base.cc:115-129, chromium
  // 7d859f27); the web theme on macOS, Linux and Windows inherits it.
  // AdjustBorderRadiusByZoom zooms those three as a border width.
  if (part !== "radio") source.nativePartRadius = adjustBorderWidthByZoom(2, effectiveZoom);
  return source;
};

/** Used dark color scheme for an ordinary element (`ComputedStyleBuilder::
 * SetUsedColorScheme`, core/style/computed_style.cc:3232-3256). A computed
 * `normal` takes the page's `<meta name=color-scheme>` flags
 * (`ApplyColorSchemeValue`, longhands_custom.cc:2746-2763); forced darkening
 * is off in capture. */
const usedDarkColorScheme = (el: Element, cs: CSSStyleDeclaration): boolean => {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  let scheme = (cs.colorScheme || "normal").trim().toLowerCase();
  if (scheme === "normal") {
    const metas = doc.documentElement != null ? doc.documentElement.getElementsByTagName("meta") : [];
    for (let i = 0; i < metas.length; i++) {
      if ((metas[i].getAttribute("name") || "").toLowerCase() !== "color-scheme") continue;
      const content = (metas[i].getAttribute("content") || "").trim().toLowerCase();
      if (content !== "" && typeof CSS !== "undefined" && CSS.supports("color-scheme", content)) {
        scheme = content;
        break;
      }
    }
  }
  const tokens = scheme.split(/\s+/);
  const hasDark = tokens.indexOf("dark") >= 0;
  const hasLight = tokens.indexOf("light") >= 0;
  const prefersDark = win != null && win.matchMedia("(prefers-color-scheme: dark)").matches;
  return (hasDark && prefersDark) || (hasDark && !hasLight);
};

const adjustBorderWidthByZoom = (width: number, zoom: number): number => Math.max(Math.floor(width * zoom), 1);

/** Focus-ring facts for an `outline-style: auto` box, or undefined. */
export const captureFocusRing = (
  el: Element,
  cs: CSSStyleDeclaration,
  effectiveZoom: number,
  outlineColor: string,
): FocusRingFacts | undefined => {
  if (cs.outlineStyle !== "auto") return undefined;
  const ringWidth = effectiveZoom >= 1 ? adjustBorderWidthByZoom(3, effectiveZoom) : 3;
  // OutlineInfo::GetFromStyle stores the float offset in an int.
  const outlineOffset = Math.trunc((parseFloat(cs.outlineOffset) || 0) * effectiveZoom) + 0;
  const maxInsideBorderWidth = adjustBorderWidthByZoom(1, effectiveZoom);
  const minBorderWidth =
    Math.min(
      parseFloat(cs.borderTopWidth) || 0,
      parseFloat(cs.borderRightWidth) || 0,
      parseFloat(cs.borderBottomWidth) || 0,
      parseFloat(cs.borderLeftWidth) || 0,
    ) * effectiveZoom;
  const ringOffset = minBorderWidth >= maxInsideBorderWidth ? outlineOffset - maxInsideBorderWidth : outlineOffset;
  const dark = usedDarkColorScheme(el, cs);
  const mac = /^Mac/.test(navigator.platform || "");
  return {
    ringWidth,
    ringOffset,
    outlineOffset,
    outerColor: dark ? "rgb(16, 16, 16)" : "rgb(255, 255, 255)",
    innerColor: dark && !mac ? "rgb(255, 255, 255)" : outlineColor,
    // Refined from cascade-origin facts by the style record.
    corners: { borderRadiusEligible: true },
  };
};
