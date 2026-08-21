import {
  insetCornerRadii,
  outsetCornerRadiiWithCoverageCorrection,
  type CornerRadii,
} from "./borders.js";

export type OverflowClipReferenceBox = "border-box" | "padding-box" | "content-box";

export interface ParsedOverflowClipMargin {
  referenceBox: OverflowClipReferenceBox;
  margin: number;
  /** Blink `ComputedStyle::OverflowClipMarginHasAnEffect()`. */
  hasEffect: boolean;
}

export interface PhysicalBoxSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface OverflowClipActivation {
  overflowX?: string;
  overflowY?: string;
  contain?: string;
  isReplaced?: boolean;
  /** Override for source-level tests/special layout objects. Defaults true. */
  respectsCssOverflow?: boolean;
  /** Override when the caller has a layout-derived scroll-container bit. */
  isScrollContainer?: boolean;
}

export interface OverflowClipMarginGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  corners: CornerRadii;
  outsets: PhysicalBoxSides;
}

const REFERENCE_BOXES = new Set<OverflowClipReferenceBox>(["border-box", "padding-box", "content-box"]);
const SCROLLABLE_OVERFLOW = new Set(["auto", "hidden", "overlay", "scroll"]);

/** Parse Chromium's computed shorthand serialization, including ref-box-only zero values. */
export function parseOverflowClipMargin(raw: string | undefined): ParsedOverflowClipMargin | null {
  if (raw == null || raw.trim() === "") return null;
  let referenceBox: OverflowClipReferenceBox = "padding-box";
  let margin = 0;
  let sawLength = false;
  let sawReferenceBox = false;
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    if (REFERENCE_BOXES.has(token as OverflowClipReferenceBox)) {
      if (sawReferenceBox) return null;
      referenceBox = token as OverflowClipReferenceBox;
      sawReferenceBox = true;
      continue;
    }
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px)?$/.exec(token);
    if (match == null || sawLength) return null;
    margin = Number(match[1]);
    // Computed CSSOM serializes nonzero lengths with a px unit. Permit bare
    // zero only as the CSS-wide unitless-zero spelling for legacy captures.
    if (match[2] == null && margin !== 0) return null;
    sawLength = true;
  }
  // CSS Overflow 4 parses this length with ValueRange::kNonNegative. A
  // negative value can only arrive through a hand-authored legacy capture;
  // reject it just as Chromium rejects the declaration.
  if (!Number.isFinite(margin) || margin < 0) return null;
  return {
    referenceBox,
    margin,
    hasEffect: referenceBox !== "padding-box" || margin !== 0,
  };
}

/**
 * Blink `LayoutObject::ShouldApplyOverflowClipMargin` activation.
 *
 * Ordinary boxes require clip on BOTH axes; one-axis clip+visible is an
 * intentionally unrounded negative control. Replaced elements use clip for
 * every non-visible overflow value. Paint containment is the other positive
 * route, but any real scroll container exits before those checks.
 */
export function shouldApplyOverflowClipMargin(
  parsed: ParsedOverflowClipMargin | null,
  activation: OverflowClipActivation,
): boolean {
  if (parsed == null || !parsed.hasEffect || activation.respectsCssOverflow === false) return false;
  const overflowX = (activation.overflowX ?? "visible").toLowerCase();
  const overflowY = (activation.overflowY ?? "visible").toLowerCase();
  const isReplaced = activation.isReplaced === true;
  const isScrollContainer = activation.isScrollContainer
    ?? (!isReplaced && (SCROLLABLE_OVERFLOW.has(overflowX) || SCROLLABLE_OVERFLOW.has(overflowY)));
  if (isScrollContainer) return false;
  const isOverflowClip = isReplaced
    ? overflowX !== "visible" && overflowY !== "visible"
    : overflowX === "clip" && overflowY === "clip";
  const paintContainment = /\b(?:content|paint|strict)\b/i.test(activation.contain ?? "");
  return isOverflowClip || paintContainment;
}

/** Replaced boxes for which Blink lets CSS overflow govern the content. */
export function isOverflowRespectingReplacedElement(tag: string): boolean {
  const normalized = tag.toLowerCase();
  return normalized === "img" || normalized === "video" || normalized === "canvas"
    || normalized === "svg" || normalized === "iframe" || normalized === "frame"
    || normalized === "embed" || normalized === "object";
}

/** Captured tags that take LayoutObject's replaced-element activation branch. */
export function isOverflowReplacedElement(tag: string, inputType?: string): boolean {
  return isOverflowRespectingReplacedElement(tag)
    || (tag.toLowerCase() === "input" && inputType?.toLowerCase() === "image");
}

/** Resolve the source `RespectsCSSOverflow()` virtual from captured layout identity. */
export function capturedBoxRespectsCssOverflow(
  tag: string,
  display: string | undefined,
  rootOverflowX?: string,
  rootOverflowY?: string,
): boolean {
  const normalizedTag = tag.toLowerCase();
  const normalizedDisplay = (display ?? "").toLowerCase();
  // These layout objects override the LayoutBlock true path. Inline/contents
  // objects do not supply a principal box on which overflow can act.
  if (normalizedTag === "fieldset" || normalizedTag === "tr" || normalizedTag === "thead"
    || normalizedTag === "tbody" || normalizedTag === "tfoot" || normalizedTag === "col"
    || normalizedTag === "colgroup" || normalizedDisplay === "inline"
    || normalizedDisplay === "contents" || normalizedDisplay === "table-row"
    || normalizedDisplay === "table-row-group" || normalizedDisplay === "table-header-group"
    || normalizedDisplay === "table-footer-group" || normalizedDisplay === "table-column"
    || normalizedDisplay === "table-column-group") return false;
  // LayoutBlock rejects whichever element defines the viewport overflow.
  if (normalizedTag === "html") return false;
  if (normalizedTag === "body") {
    const htmlOverflowVisible = (rootOverflowX == null || rootOverflowX === "visible")
      && (rootOverflowY == null || rootOverflowY === "visible");
    if (htmlOverflowVisible) return false;
  }
  return true;
}

/** Resolve a captured style to the used, source-activated margin or null. */
export function usedOverflowClipMargin(
  raw: string | undefined,
  activation: OverflowClipActivation,
): ParsedOverflowClipMargin | null {
  const parsed = parseOverflowClipMargin(raw);
  return shouldApplyOverflowClipMargin(parsed, activation) ? parsed : null;
}

/**
 * Transcribe `AdjustRoundedClipForOverflowClipMargin`: start from Blink's
 * pixel-snapped contoured inner border, apply reference-box + margin outsets,
 * and correct each rounded corner using the stable coverage-factor algorithm.
 */
export function overflowClipMarginGeometry(
  borderBox: { x: number; y: number; width: number; height: number },
  borders: PhysicalBoxSides,
  padding: PhysicalBoxSides,
  outerCorners: CornerRadii,
  value: ParsedOverflowClipMargin,
): OverflowClipMarginGeometry {
  const innerLeft = Math.round(borderBox.x + borders.left);
  const innerTop = Math.round(borderBox.y + borders.top);
  const innerRight = Math.round(borderBox.x + borderBox.width - borders.right);
  const innerBottom = Math.round(borderBox.y + borderBox.height - borders.bottom);
  const sourceWidth = Math.max(0, innerRight - innerLeft);
  const sourceHeight = Math.max(0, innerBottom - innerTop);
  const innerCorners = insetCornerRadii(outerCorners, borders.top, borders.right, borders.bottom, borders.left);

  let outsets: PhysicalBoxSides;
  if (value.referenceBox === "border-box") {
    outsets = {
      top: borders.top + value.margin,
      right: borders.right + value.margin,
      bottom: borders.bottom + value.margin,
      left: borders.left + value.margin,
    };
  } else if (value.referenceBox === "content-box") {
    outsets = {
      top: value.margin - padding.top,
      right: value.margin - padding.right,
      bottom: value.margin - padding.bottom,
      left: value.margin - padding.left,
    };
  } else {
    outsets = { top: value.margin, right: value.margin, bottom: value.margin, left: value.margin };
  }

  return {
    x: innerLeft - outsets.left,
    y: innerTop - outsets.top,
    width: Math.max(0, sourceWidth + outsets.left + outsets.right),
    height: Math.max(0, sourceHeight + outsets.top + outsets.bottom),
    corners: outsetCornerRadiiWithCoverageCorrection(
      innerCorners,
      outsets.top,
      outsets.right,
      outsets.bottom,
      outsets.left,
      sourceWidth,
      sourceHeight,
    ),
    outsets,
  };
}

/** Extra rectangular room the renderer's synthetic outer wrapper must retain. */
export function overflowClipMarginOuterExtension(
  borderBox: { x: number; y: number; width: number; height: number },
  geometry: OverflowClipMarginGeometry,
): PhysicalBoxSides {
  return {
    top: Math.max(0, borderBox.y - geometry.y),
    right: Math.max(0, geometry.x + geometry.width - borderBox.x - borderBox.width),
    bottom: Math.max(0, geometry.y + geometry.height - borderBox.y - borderBox.height),
    left: Math.max(0, borderBox.x - geometry.x),
  };
}
