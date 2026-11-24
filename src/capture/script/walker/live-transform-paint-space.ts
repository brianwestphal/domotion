import { qualifyLiveSourceImage, type LiveSourceImage } from "./live-source-image.js";

/**
 * A live affine wrapper can reuse local box painting only when the source
 * geometry and every retained descendant share one proven inverse.
 */
export interface LiveTransformPaintSpace {
  ownerBox: DOMRect;
  localRect: (element: Element) => DOMRect | undefined;
  elements: Element[];
  image?: LiveSourceImage;
}

const ordinaryBox = /^(DIV|SPAN|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|FIGURE|FIGCAPTION|P|H[1-6])$/;
const singleBoxDisplay = /^(block|flow-root|inline-block|flex|inline-flex|grid|inline-grid)$/;
const layoutUnit = (value: number): number => Math.round(value * 64) / 64;

const hasOwnTransform = (style: CSSStyleDeclaration): boolean =>
  [style.transform, style.translate, style.rotate, style.scale, style.perspective].some(
    (value) => value !== "" && value !== "none",
  ) || style.transformStyle === "preserve-3d";

const hasCommonGeometry = (style: CSSStyleDeclaration): boolean =>
  style.zoom === "1" &&
  style.position !== "sticky" &&
  style.offsetPath === "none" &&
  style.columnCount === "auto" &&
  style.columnWidth === "auto" &&
  style.contentVisibility === "visible" &&
  /^(none|auto|)$/.test(style.getPropertyValue("position-anchor")) &&
  /^(none|)$/.test(style.getPropertyValue("position-area"));

const hasGeneratedBox = (view: Window, element: Element): boolean =>
  ["::before", "::after"].some((pseudo) => {
    const content = view.getComputedStyle(element, pseudo).content;
    return content !== "none" && content !== "normal" && content !== "";
  });

const hasNoCurrentAnimations = (element: Element): boolean =>
  typeof element.getAnimations === "function" && element.getAnimations().length === 0;

const hasUnclippedImagePlane = (style: CSSStyleDeclaration): boolean =>
  style.visibility === "visible" &&
  style.opacity === "1" &&
  style.mixBlendMode === "normal" &&
  style.backfaceVisibility === "visible" &&
  style.contain === "none" &&
  style.clip === "auto" &&
  style.overflowX === "visible" &&
  style.overflowY === "visible" &&
  style.filter === "none" &&
  style.backdropFilter === "none" &&
  style.clipPath === "none" &&
  style.maskImage === "none" &&
  style.getPropertyValue("-webkit-box-reflect") === "none";

const hasPausedTransform = (owner: Element, style: CSSStyleDeclaration): boolean => {
  if (style.translate !== "none" || style.rotate !== "none" || style.scale !== "none" || style.willChange !== "auto")
    return false;
  const animations = owner.getAnimations();
  const animation = animations[0];
  return (
    animations.length === 1 &&
    animation instanceof CSSAnimation &&
    animation.playState === "paused" &&
    !animation.pending &&
    animation.effect instanceof KeyframeEffect &&
    animation.effect.target === owner &&
    animation.effect.getKeyframes().some((frame) => "transform" in frame)
  );
};

/**
 * Positive diagonal scales on both axes collapse the accumulation through
 * both the active animation and sampled-transform branches of Chromium's
 * CanPropagateSubpixelAccumulation. A declared transition with no animation
 * uses the sampled-transform branch, which preserves the unit axis.
 */
export const reconstructLiveTransformPaintSpace = (
  owner: Element,
  style: CSSStyleDeclaration,
  transform: string,
  { textElement, declaredTransition }: { textElement?: Element; declaredTransition: boolean },
): LiveTransformPaintSpace | undefined => {
  const doc = owner.ownerDocument;
  const view = doc.defaultView;
  if (view == null || view !== view.top || owner.getRootNode() !== doc) return undefined;
  if (view.devicePixelRatio !== 1 || (view.visualViewport?.scale ?? 1) !== 1) return undefined;
  if (style.transformBox === "content-box" || style.transformBox === "fill-box") return undefined;
  if (!transform.startsWith("matrix(")) return undefined;
  const matrix = new DOMMatrix(transform);
  if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0) return undefined;
  if (!(matrix.a > 0) || !(matrix.d > 0)) return undefined;
  if (matrix.a === 1 && matrix.d === 1) return undefined;
  const oneAxis = matrix.a === 1 || matrix.d === 1;
  if (
    oneAxis &&
    (textElement != null || !declaredTransition || style.willChange !== "auto" || !hasNoCurrentAnimations(owner))
  ) {
    return undefined;
  }

  const origin = style.transformOrigin.trim().split(/\s+/);
  if (origin.length !== 2 || origin.some((part) => !/^-?(?:\d+\.?\d*|\.\d+)px$/.test(part))) return undefined;
  const [ox, oy] = origin.map(Number.parseFloat);
  const child = owner.firstElementChild;
  const imageElement = owner.childElementCount === 1 && child instanceof HTMLImageElement ? child : undefined;
  let image: LiveSourceImage | undefined;
  if (imageElement != null) {
    if (oneAxis || textElement != null || imageElement.childElementCount !== 0 || !hasPausedTransform(owner, style))
      return undefined;
    image = qualifyLiveSourceImage(imageElement, view.getComputedStyle(imageElement));
    if (image == null || !hasNoCurrentAnimations(imageElement)) return undefined;
  }
  for (let parent = owner.parentElement; parent != null; parent = parent.parentElement) {
    const parentStyle = view.getComputedStyle(parent);
    if (!hasCommonGeometry(parentStyle) || hasOwnTransform(parentStyle) || parent.shadowRoot != null) return undefined;
    // A unit axis walks past the owner. The current paint basis does not
    // combine that partially resolved offset with an outer isolation reset.
    if (oneAxis && (parentStyle.contain !== "none" || !hasNoCurrentAnimations(parent))) return undefined;
    if (image != null && (!hasUnclippedImagePlane(parentStyle) || !hasNoCurrentAnimations(parent))) return undefined;
  }

  // A descendant's own layout can be changed by resolving relative
  // coordinates in a producer that still reads live quads or screenshots.
  // Authenticate the entire retained subtree before emitting any wrapper.
  if (textElement != null && textElement !== owner && textElement.parentElement !== owner) return undefined;
  const elements = [owner, ...owner.getElementsByTagName("*")];
  if (textElement != null && textElement !== owner && elements.length !== 2) return undefined;
  const boxes = new Map<Element, DOMRect>();
  const liveOwner = owner.getBoundingClientRect();
  const left = liveOwner.left - matrix.e - (1 - matrix.a) * ox;
  const top = liveOwner.top - matrix.f - (1 - matrix.d) * oy;
  for (const element of elements) {
    const containsDirectText = Array.from(element.childNodes).some(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() !== "",
    );
    if (containsDirectText && element !== textElement) return undefined;
    if (element === textElement && element.childElementCount !== 0) return undefined;
    const cs = element === owner ? style : view.getComputedStyle(element);
    if (
      (!ordinaryBox.test(element.tagName) && element !== imageElement) ||
      element.shadowRoot != null ||
      !singleBoxDisplay.test(cs.display) ||
      !hasCommonGeometry(cs) ||
      cs.position === "fixed" ||
      (element !== owner && hasOwnTransform(cs)) ||
      (element !== owner && oneAxis && (cs.willChange !== "auto" || !hasNoCurrentAnimations(element))) ||
      cs.transformStyle !== "flat" ||
      cs.perspective !== "none" ||
      cs.contain !== "none" ||
      cs.clip !== "auto" ||
      cs.overflowX !== "visible" ||
      cs.overflowY !== "visible" ||
      cs.filter !== "none" ||
      cs.backdropFilter !== "none" ||
      cs.clipPath !== "none" ||
      cs.maskImage !== "none" ||
      cs.backgroundImage !== "none" ||
      cs.borderImageSource !== "none" ||
      hasGeneratedBox(view, element) ||
      (image != null && !hasUnclippedImagePlane(cs)) ||
      element.getClientRects().length !== 1
    ) {
      return undefined;
    }
    const live = element === owner ? liveOwner : element.getBoundingClientRect();
    const values = [
      left + (live.left - liveOwner.left) / matrix.a,
      top + (live.top - liveOwner.top) / matrix.d,
      live.width / matrix.a,
      live.height / matrix.d,
    ];
    const local = values.map(layoutUnit);
    if (values.some((value, index) => !Number.isFinite(value) || Math.abs(value - local[index]) > 1 / 1024)) {
      return undefined;
    }
    boxes.set(element, new DOMRect(local[0], local[1], local[2], local[3]));
  }
  const ownerBox = boxes.get(owner);
  return ownerBox == null ? undefined : { ownerBox, localRect: (element) => boxes.get(element), elements, image };
};
