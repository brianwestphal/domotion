/**
 * A live affine wrapper can reuse local box painting only when the source
 * geometry and every retained descendant share one proven inverse.
 */
export interface LiveTransformPaintSpace {
  ownerBox: DOMRect;
  localRect: (element: Element) => DOMRect | undefined;
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

/**
 * Positive diagonal scales on both axes collapse the accumulation through
 * both the active animation and sampled-transform branches of Chromium's
 * CanPropagateSubpixelAccumulation. An axis left at one needs separate
 * animation/compositing evidence.
 */
export const reconstructLiveTransformPaintSpace = (
  owner: Element,
  style: CSSStyleDeclaration,
  transform: string,
  allowDirectText = false,
): LiveTransformPaintSpace | undefined => {
  const doc = owner.ownerDocument;
  const view = doc.defaultView;
  if (view == null || view !== view.top || owner.getRootNode() !== doc) return undefined;
  if (view.devicePixelRatio !== 1 || (view.visualViewport?.scale ?? 1) !== 1) return undefined;
  if (style.transformBox === "content-box" || style.transformBox === "fill-box") return undefined;
  if (!transform.startsWith("matrix(")) return undefined;
  const matrix = new DOMMatrix(transform);
  if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0) return undefined;
  if (!(matrix.a > 0) || !(matrix.d > 0) || matrix.a === 1 || matrix.d === 1) return undefined;

  const origin = style.transformOrigin.trim().split(/\s+/);
  if (origin.length !== 2 || origin.some((part) => !/^-?(?:\d+\.?\d*|\.\d+)px$/.test(part))) return undefined;
  const [ox, oy] = origin.map(Number.parseFloat);
  for (let parent = owner.parentElement; parent != null; parent = parent.parentElement) {
    const parentStyle = view.getComputedStyle(parent);
    if (!hasCommonGeometry(parentStyle) || hasOwnTransform(parentStyle) || parent.shadowRoot != null) return undefined;
  }

  // A descendant's own layout can be changed by resolving relative
  // coordinates in a producer that still reads live quads or screenshots.
  // Authenticate the entire retained subtree before emitting any wrapper.
  const hasQualifiedText =
    allowDirectText &&
    Array.from(owner.childNodes).every(({ nodeType }) => nodeType === Node.TEXT_NODE || nodeType === Node.COMMENT_NODE);
  if (!hasQualifiedText && (owner.textContent ?? "").trim() !== "") return undefined;
  const boxes = new Map<Element, DOMRect>();
  const elements = [owner, ...owner.getElementsByTagName("*")];
  const liveOwner = owner.getBoundingClientRect();
  const left = liveOwner.left - matrix.e - (1 - matrix.a) * ox;
  const top = liveOwner.top - matrix.f - (1 - matrix.d) * oy;
  for (const element of elements) {
    const cs = element === owner ? style : view.getComputedStyle(element);
    if (
      !ordinaryBox.test(element.tagName) ||
      element.shadowRoot != null ||
      !singleBoxDisplay.test(cs.display) ||
      !hasCommonGeometry(cs) ||
      cs.position === "fixed" ||
      (element !== owner && hasOwnTransform(cs)) ||
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
  return ownerBox == null ? undefined : { ownerBox, localRect: (element) => boxes.get(element) };
};
