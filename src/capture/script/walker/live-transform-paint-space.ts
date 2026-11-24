import { qualifyLiveSourceImage, type LiveSourceImage } from "./live-source-image.js";
import { svgTransformCoordinate } from "../../../render/transforms.js";
import { isPaintedColor } from "../../../utils/transparent-background.js";
import {
  captureBorderPaintSnap,
  registerFrozenPaintBase,
  registerPaintTransformTranslation,
  releaseFrozenPaintBase,
  releasePaintTransformTranslation,
} from "./border-paint-snap.js";

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

interface NestedLiveOwner {
  box: DOMRect;
  transform: string;
  origin: string;
}

export interface NestedLiveTransformPaintSpace {
  outer: NestedLiveOwner;
  localRect: (element: Element) => DOMRect | undefined;
  owners: ReadonlyMap<Element, NestedLiveOwner>;
  release: () => void;
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

const hasUnclippedPaintPlane = (style: CSSStyleDeclaration): boolean =>
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

const pausedTransformEffect = (owner: Element, style: CSSStyleDeclaration): KeyframeEffect | undefined => {
  if (style.translate !== "none" || style.rotate !== "none" || style.scale !== "none" || style.willChange !== "auto")
    return undefined;
  const animations = owner.getAnimations();
  const animation = animations[0];
  return animations.length === 1 &&
    animation instanceof CSSAnimation &&
    animation.playState === "paused" &&
    !animation.pending &&
    animation.effect instanceof KeyframeEffect &&
    animation.effect.target === owner &&
    animation.effect.getKeyframes().some((frame) => "transform" in frame)
    ? animation.effect
    : undefined;
};

const hasDirectText = (element: Element): boolean =>
  Array.from(element.childNodes).some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() !== "");

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
    if (
      oneAxis ||
      textElement != null ||
      imageElement.childElementCount !== 0 ||
      pausedTransformEffect(owner, style) == null
    )
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
    if (image != null && (!hasUnclippedPaintPlane(parentStyle) || !hasNoCurrentAnimations(parent))) return undefined;
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
    if (hasDirectText(element) && element !== textElement) return undefined;
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
      (image != null && !hasUnclippedPaintPlane(cs)) ||
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

interface NestedTransform {
  element: Element;
  box: DOMRect;
  matrix: DOMMatrixReadOnly;
  origin: string;
  pivot: [number, number];
}

const integralDiagonal = (value: string): DOMMatrixReadOnly | undefined => {
  try {
    const matrix = new DOMMatrix(value);
    const { a, b, c, d, e, f } = matrix;
    if (matrix.is2D && b === 0 && c === 0 && a > 1 && d > 1 && [a, d, e, f].every(Number.isSafeInteger)) return matrix;
  } catch {
    return undefined;
  }
};

const ownsIntegralPausedEffect = (owner: Element, style: CSSStyleDeclaration): boolean => {
  const effect = pausedTransformEffect(owner, style);
  if (effect?.composite !== "replace" || effect.getComputedTiming().progress == null) return false;
  const frames = effect.getKeyframes();
  const allowed = ["offset", "computedOffset", "easing", "composite", "transform"];
  return (
    frames.length >= 2 &&
    frames.every(
      (frame) =>
        Object.keys(frame).every((key) => allowed.includes(key)) &&
        (frame.composite === "auto" || frame.composite === "replace") &&
        typeof frame["transform"] === "string" &&
        integralDiagonal(frame["transform"]) != null,
    )
  );
};

const opaqueRgb = (color: string): boolean => /^rgb\(\d+, \d+, \d+\)$/.test(color);

function solidBoxOutline(style: CSSStyleDeclaration): number | undefined {
  if (style.outlineStyle === "none" || style.outlineStyle === "hidden" || !isPaintedColor(style.outlineColor)) return 0;
  const width = Number.parseFloat(style.outlineWidth);
  if (
    style.outlineStyle === "solid" &&
    style.outlineOffset === "0px" &&
    opaqueRgb(style.outlineColor) &&
    Number.isSafeInteger(width) &&
    width >= 0
  )
    return width;
}

function isSolidPaintBox(element: Element, style: CSSStyleDeclaration, view: Window): boolean {
  return (
    element instanceof HTMLElement &&
    ordinaryBox.test(element.tagName) &&
    style.display === "block" &&
    element.shadowRoot == null &&
    style.whiteSpaceCollapse === "collapse" &&
    !Array.from(element.childNodes).some((child) => child instanceof Text && /[^ \t\n\r\f]/.test(child.data)) &&
    !hasGeneratedBox(view, element) &&
    hasCommonGeometry(style) &&
    hasUnclippedPaintPlane(style) &&
    style.position !== "fixed" &&
    style.transformStyle === "flat" &&
    style.perspective === "none" &&
    style.isolation === "auto" &&
    style.backgroundClip === "border-box" &&
    style.backgroundImage === "none" &&
    (!isPaintedColor(style.backgroundColor) || opaqueRgb(style.backgroundColor)) &&
    style.borderImageSource === "none" &&
    style.borderRadius === "0px" &&
    [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(
      (width) => width === "0px",
    ) &&
    ["", "none"].includes(style.getPropertyValue("border-shape")) &&
    style.boxShadow === "none" &&
    style.content === "normal" &&
    style.willChange === "auto"
  );
}

function invertOwner(box: number[], { matrix, pivot }: NestedTransform): number[] {
  const [x, y, width, height] = box;
  const [px, py] = pivot;
  return [
    px + (x - px - matrix.e) / matrix.a,
    py + (y - py - matrix.f) / matrix.d,
    width / matrix.a,
    height / matrix.d,
  ];
}

function wholeNestedPaintEdges(
  element: Element,
  rect: DOMRect,
  outline: number,
  owners: NestedTransform[],
  paintOwners: ReadonlyMap<Element, NestedLiveOwner>,
  viewport: { x: number; y: number; width: number; height: number },
): boolean {
  const snap = captureBorderPaintSnap(element, rect);
  if (snap == null) return false;
  const left = rect.left - viewport.x + snap.left;
  const right = rect.right - viewport.x + snap.right;
  const top = rect.top - viewport.y + snap.top;
  const bottom = rect.bottom - viewport.y + snap.bottom;
  if (right <= left || bottom <= top) return false;
  let xEdges = [left - outline, left, right, right + outline];
  let yEdges = [top - outline, top, bottom, bottom + outline];
  // Rect backgrounds serialize three decimal places. Preserve those exact
  // coordinates before certifying their projection through the emitted groups.
  if (![...xEdges, ...yEdges].every((edge) => Number(edge.toFixed(3)) === edge && Math.fround(edge) === edge))
    return false;
  for (const { element: owner, box, pivot } of owners) {
    const x = box.x - viewport.x;
    const y = box.y - viewport.y;
    if (!xEdges.every((edge) => Number.isInteger(edge - x)) || !yEdges.every((edge) => Number.isInteger(edge - y)))
      return false;
    const px = pivot[0] - viewport.x;
    const py = pivot[1] - viewport.y;
    const matrix = new DOMMatrix(paintOwners.get(owner)!.transform);
    xEdges = xEdges.map((edge) => px + matrix.a * (edge - px) + matrix.e);
    yEdges = yEdges.map((edge) => py + matrix.d * (edge - py) + matrix.f);
  }
  // Require the full fill and outline to stay on the authenticated device lattice.
  return (
    xEdges.every((x) => Number.isSafeInteger(x) && x >= 0 && x <= viewport.width) &&
    yEdges.every((y) => Number.isSafeInteger(y) && y >= 0 && y <= viewport.height)
  );
}

/** Two held integral affine owners have distinct DOM inverses and paint
 * resets. Qualify the complete subtree before acquiring the paint records for
 * the walk. The caller releases the two bases once its capture scope ends. */
export function reconstructNestedLiveTransformPaintSpace(
  element: Element,
  style: CSSStyleDeclaration,
  viewport: { x: number; y: number; width: number; height: number },
  authenticateParticipants: (elements: Element[]) => boolean,
): NestedLiveTransformPaintSpace | undefined {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (
    view == null ||
    view !== view.top ||
    element.getRootNode() !== doc ||
    view.devicePixelRatio !== 1 ||
    (view.visualViewport?.scale ?? 1) !== 1 ||
    ![viewport.x, viewport.y].every(Number.isSafeInteger) ||
    !ownsIntegralPausedEffect(element, style)
  )
    return undefined;
  for (let parent = element.parentElement; parent != null; parent = parent.parentElement) {
    const css = view.getComputedStyle(parent);
    if (
      !hasCommonGeometry(css) ||
      !hasUnclippedPaintPlane(css) ||
      hasOwnTransform(css) ||
      css.position === "fixed" ||
      css.isolation !== "auto" ||
      css.willChange !== "auto" ||
      parent.shadowRoot != null ||
      !hasNoCurrentAnimations(parent)
    )
      return undefined;
  }

  const boxes = new Map<Element, { rect: DOMRect; outline: number; painted: boolean; owners: NestedTransform[] }>();
  const transforms: NestedTransform[] = [];
  const elements = [element, ...element.getElementsByTagName("*")];
  for (const node of elements) {
    const css = node === element ? style : view.getComputedStyle(node);
    if (!isSolidPaintBox(node, css, view)) return undefined;
    const outline = solidBoxOutline(css);
    const rects = node.getClientRects();
    if (outline == null || rects.length !== 1) return undefined;
    const live = rects[0];
    const owners = transforms.filter(({ element: owner }) => owner.contains(node));
    let values = [live.left, live.top, live.width, live.height];
    for (const owner of owners) values = invertOwner(values, owner);
    const transformed = hasOwnTransform(css);
    let matrix: DOMMatrixReadOnly | undefined;
    let origin: number[] = [];
    if (transformed) {
      if (
        transforms.length === 2 ||
        !["border-box", "view-box"].includes(css.transformBox) ||
        (node !== element && !ownsIntegralPausedEffect(node, css))
      )
        return undefined;
      matrix = integralDiagonal(css.transform);
      const originValues = css.transformOrigin.trim().split(/\s+/);
      if (matrix == null || originValues.length !== 2 || originValues.some((value) => !/^-?\d+px$/.test(value)))
        return undefined;
      origin = originValues.map(Number.parseFloat);
      values = [
        values[0] - matrix.e - (1 - matrix.a) * origin[0],
        values[1] - matrix.f - (1 - matrix.d) * origin[1],
        values[2] / matrix.a,
        values[3] / matrix.d,
      ];
    } else if (node === element || !hasNoCurrentAnimations(node)) return undefined;
    const local = values.map(layoutUnit);
    if (values.some((value, index) => !Number.isFinite(value) || Math.abs(value - local[index]) > 1 / 1024))
      return undefined;
    const rect = new DOMRect(local[0], local[1], local[2], local[3]);
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const painted = outline > 0 || isPaintedColor(css.backgroundColor);
    if (matrix != null) {
      if (!opaqueRgb(css.backgroundColor)) return undefined;
      const pivot: [number, number] = [rect.x + origin[0], rect.y + origin[1]];
      if (
        pivot.some((point, i) => {
          const coordinate = point - (i === 0 ? viewport.x : viewport.y);
          return svgTransformCoordinate(coordinate) !== coordinate || Math.fround(coordinate) !== coordinate;
        })
      )
        return undefined;
      const owner = { element: node, box: rect, matrix, origin: css.transformOrigin, pivot };
      transforms.push(owner);
      owners.push(owner);
    }
    boxes.set(node, {
      rect,
      outline,
      painted,
      owners: owners.reverse(),
    });
  }
  if (transforms.length !== 2) return undefined;

  const owners = new Map<Element, NestedLiveOwner>();
  const release = () => {
    for (const owner of owners.keys()) {
      releaseFrozenPaintBase(owner);
      releasePaintTransformTranslation(owner);
    }
  };
  let keepBases = false;
  try {
    // Registration must run outer-to-inner. The existing border snap helper
    // then measures the inner paint offset in the outer owner's local basis.
    for (const { element: owner, box, matrix, origin } of transforms) {
      const transform = matrix.toString();
      const shift = registerFrozenPaintBase(owner, transform, view.getComputedStyle(owner), box);
      if (shift == null) return undefined;
      const shifted = new DOMMatrix().translate(shift.x, shift.y).multiply(matrix);
      if (
        [shifted.e, shifted.f].some((value) => svgTransformCoordinate(value) !== value || Math.fround(value) !== value)
      ) {
        releaseFrozenPaintBase(owner);
        return undefined;
      }
      const paintTransform = shifted.toString();
      owners.set(owner, { box, transform: paintTransform, origin });
      registerPaintTransformTranslation(owner, paintTransform);
    }
    for (const [node, { rect, outline, painted, owners: ancestry }] of boxes) {
      if (painted && !wholeNestedPaintEdges(node, rect, outline, ancestry, owners, viewport)) return undefined;
    }
    const outer = owners.get(element);
    // DOMRects alone cannot see the effective paint ancestry of a closed
    // slot. Adopt every actual participant only after the whole plan qualifies.
    if (outer == null || !authenticateParticipants(elements)) return undefined;
    keepBases = true;
    return { outer, localRect: (node) => boxes.get(node)?.rect, owners, release };
  } finally {
    if (!keepBases) release();
  }
}
