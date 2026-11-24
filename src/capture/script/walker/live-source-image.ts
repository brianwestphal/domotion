import { snapImagePaintRect } from "../../../render/image-paint-snap.js";
import { svgTransformCoefficient, svgTransformCoordinate } from "../../../render/transforms.js";
import { isPaintedColor } from "../../../utils/transparent-background.js";
import { captureBorderPaintSnap, captureImagePaintBasis } from "./border-paint-snap.js";

export interface LiveSourceImage {
  element: HTMLImageElement;
  source: string;
  width: number;
  height: number;
}

const pngPrefix = "data:image/png;base64,";
const uint32 = (data: string, index: number): number =>
  data.charCodeAt(index) * 0x1000000 +
  data.charCodeAt(index + 1) * 0x10000 +
  data.charCodeAt(index + 2) * 0x100 +
  data.charCodeAt(index + 3);

/**
 * Blink's accepted resource must be the original, opaque, single-frame
 * RGB PNG. Only the header, image data, terminator and optional physical
 * density record are understood here. The same bytes are embedded in SVG.
 */
function matchesStaticRgbPng(source: string, width: number, height: number): boolean {
  if (!source.startsWith(pngPrefix)) return false;
  let data: string;
  try {
    data = atob(source.slice(pngPrefix.length));
  } catch {
    return false;
  }
  if (
    data.length < 33 ||
    !data.startsWith("\x89PNG\r\n\x1a\n") ||
    uint32(data, 8) !== 13 ||
    data.slice(12, 16) !== "IHDR" ||
    uint32(data, 16) !== width ||
    uint32(data, 20) !== height ||
    data.slice(24, 29) !== "\x08\x02\0\0\0"
  )
    return false;
  let hasImageData = false;
  for (let offset = 33; offset + 12 <= data.length;) {
    const length = uint32(data, offset);
    const kind = data.slice(offset + 4, offset + 8);
    offset += length + 12;
    if (offset > data.length) return false;
    if (kind === "IEND") return length === 0 && hasImageData && offset === data.length;
    if (kind === "IDAT") hasImageData ||= length > 0;
    else if (kind !== "pHYs" || length !== 9 || hasImageData) return false;
  }
  return false;
}

export function qualifyLiveSourceImage(
  element: HTMLImageElement,
  style: CSSStyleDeclaration,
): LiveSourceImage | undefined {
  const source = element.currentSrc;
  const { naturalWidth: width, naturalHeight: height } = element;
  if (
    !element.complete ||
    width <= 0 ||
    height <= 0 ||
    element.src !== source ||
    element.hasAttribute("srcset") ||
    style.content !== "normal" ||
    style.objectFit !== "fill" ||
    style.objectPosition !== "50% 50%" ||
    style.imageOrientation !== "from-image" ||
    style.imageRendering !== "auto" ||
    style.borderRadius !== "0px" ||
    [
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
      style.paddingTop,
      style.paddingRight,
      style.paddingBottom,
      style.paddingLeft,
    ].some((value) => value !== "0px") ||
    !matchesStaticRgbPng(source, width, height)
  )
    return;
  return { element, source, width, height };
}

/**
 * Use the very paint basis and snap that the image renderer consumes. A
 * matching content rect with fractional device edges can still have different
 * alpha coverage in Blink and SVG, including at an integral scale.
 */
export function liveSourceImageHasAlignedPaint(
  image: LiveSourceImage,
  localRect: DOMRect,
  ownerBox: DOMRect,
  ownerStyle: CSSStyleDeclaration,
  matrix: DOMMatrixReadOnly,
  viewport: { x: number; y: number; width: number; height: number },
): boolean {
  const { element, source, width, height } = image;
  if (
    !element.complete ||
    element.currentSrc !== source ||
    element.naturalWidth !== width ||
    element.naturalHeight !== height ||
    !Number.isInteger(viewport.x) ||
    !Number.isInteger(viewport.y)
  )
    return false;
  const basis = captureImagePaintBasis(element, localRect);
  if (basis == null) return false;
  const rect = {
    x: localRect.left - viewport.x,
    y: localRect.top - viewport.y,
    width: localRect.width,
    height: localRect.height,
  };
  const dest = snapImagePaintRect(rect, basis, rect);
  if (dest.width !== width || dest.height !== height) return false;
  const [originX, originY] = ownerStyle.transformOrigin.trim().split(/\s+/).map(Number.parseFloat);
  const ox = ownerBox.left - viewport.x + originX;
  const oy = ownerBox.top - viewport.y + originY;
  // Include the paint adjustment in the matrix. Require all values to survive
  // the renderer's serialization so alignment describes the emitted wrapper.
  const { a, d, e, f } = matrix;
  if (
    [a, d].some((value) => svgTransformCoefficient(value) !== value) ||
    [e, f, ox, oy, dest.x, dest.y].some((value) => svgTransformCoordinate(value) !== value) ||
    [a, d, e, f, ox, oy, dest.x, dest.y].some((value) => Math.fround(value) !== value)
  )
    return false;
  const projectX = (x: number) => ox + a * (x - ox) + e;
  const projectY = (y: number) => oy + d * (y - oy) + f;
  const left = projectX(dest.x);
  const top = projectY(dest.y);
  const right = projectX(dest.x + dest.width);
  const bottom = projectY(dest.y + dest.height);
  if (
    ![left, top, right, bottom].every(Number.isInteger) ||
    left < 0 ||
    top < 0 ||
    right > viewport.width ||
    bottom > viewport.height
  )
    return false;

  // The enclosing compositor layer also paints the owner's outline. An
  // aligned image can sit inside an outline with fractional device edges.
  const outlineWidth = Number.parseFloat(ownerStyle.outlineWidth);
  if (
    ownerStyle.outlineStyle === "none" ||
    ownerStyle.outlineStyle === "hidden" ||
    outlineWidth === 0 ||
    !isPaintedColor(ownerStyle.outlineColor)
  )
    return true;
  if (
    ownerStyle.outlineStyle !== "solid" ||
    ownerStyle.outlineOffset !== "0px" ||
    ownerStyle.borderRadius !== "0px" ||
    !["none", ""].includes(ownerStyle.getPropertyValue("border-shape")) ||
    !Number.isInteger(outlineWidth) ||
    outlineWidth < 0
  )
    return false;
  const owner = element.parentElement;
  const snap = owner == null ? undefined : captureBorderPaintSnap(owner, ownerBox);
  if (snap == null) return false;
  const ownerX = ownerBox.left - viewport.x;
  const ownerY = ownerBox.top - viewport.y;
  const innerLeft = ownerX + snap.left;
  const innerTop = ownerY + snap.top;
  const innerRight = ownerX + ownerBox.width + snap.right;
  const innerBottom = ownerY + ownerBox.height + snap.bottom;
  if (innerRight <= innerLeft || innerBottom <= innerTop) return false;
  const xEdges = [innerLeft, innerRight, innerLeft - outlineWidth, innerRight + outlineWidth];
  const yEdges = [innerTop, innerBottom, innerTop - outlineWidth, innerBottom + outlineWidth];
  return (
    [...xEdges, ...yEdges].every((edge) => svgTransformCoordinate(edge) === edge) &&
    xEdges.every((edge) => Number.isInteger(projectX(edge))) &&
    yEdges.every((edge) => Number.isInteger(projectY(edge)))
  );
}
