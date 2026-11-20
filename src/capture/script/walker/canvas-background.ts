//
// Document canvas background ownership. Part of the page-`evaluate`d
// CAPTURE_SCRIPT bundle — self-contained, page globals only.
//
// Blink paints the document background from the viewport's style, which
// `StyleResolver::PropagateStyleToViewport` takes from <html>, or from the
// first <body> when <html> has no background and neither element applies
// containment (core/css/resolver/style_resolver.cc:3390-3500, Chromium
// 7d859f27). The box whose background moved to the view no longer paints it
// (`LayoutBoxModelObject::BackgroundTransfersToView`,
// core/layout/layout_box_model_object.cc:1095-1126). The root element's box
// is the positioning area; the painting area is the whole canvas.

import type { CapturedElement } from "../../types.js";

/** `ComputedStyle::HasBackground`: a visible color or any image layer. */
const hasBackground = (cs: CSSStyleDeclaration): boolean => {
  const image = cs.backgroundImage;
  if (image != null && image !== "" && image !== "none") return true;
  const color = cs.backgroundColor;
  if (color == null || color === "" || color === "transparent") return false;
  const m = /^rgba?\(([^)]*)\)$/i.exec(color.trim());
  if (m == null) return true;
  const parts = m[1].split(/[\s,/]+/).filter((part) => part !== "");
  if (parts.length < 4) return true;
  const alpha = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return !(alpha === 0);
};

/** `ShouldApplyAnyContainment` for the root/body boxes: any `contain` value or
 * a `content-visibility` that implies containment. A missing box (display
 * none/contents) stops propagation too (`ShouldStopBodyPropagation`). */
const stopsPropagation = (el: Element): boolean => {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.display === "contents") return true;
  if (cs.contain != null && cs.contain !== "" && cs.contain !== "none") return true;
  const visibility = (cs as CSSStyleDeclaration & { contentVisibility?: string }).contentVisibility;
  return visibility != null && visibility !== "" && visibility !== "visible";
};

/** The top document's first <body> child of <html> (`Document::FirstBodyElement`). */
const firstBody = (doc: Document): Element | null => {
  const root = doc.documentElement;
  if (root == null || root.localName !== "html") return null;
  for (const child of Array.from(root.children)) {
    if (child.localName === "body") return child;
  }
  return null;
};

/** Which element's background the top document's canvas paints, if any. */
export const documentCanvasSource = (): "html" | "body" | null => {
  const root = document.documentElement;
  if (root == null) return null;
  if (hasBackground(getComputedStyle(root))) return "html";
  const body = firstBody(document);
  if (body == null || root.localName !== "html") return null;
  if (stopsPropagation(root) || stopsPropagation(body)) return null;
  return hasBackground(getComputedStyle(body)) ? "body" : null;
};

/** The element the top document's canvas background comes from, if any. */
export const documentCanvasSourceElement = (): Element | null => {
  const source = documentCanvasSource();
  if (source === "html") return document.documentElement;
  return source === "body" ? firstBody(document) : null;
};

/** True for the top document's body when its background moved to the view. */
export const bodyBackgroundTransfersToView = (el: Element): boolean =>
  el.ownerDocument === document && el === firstBody(document) && documentCanvasSource() === "body";

/** The root element's border box and edge widths: the canvas background's
 * positioning area, in capture coordinates. */
export const documentRootBox = (vp: { x: number; y: number }) => {
  const root = document.documentElement;
  if (root == null) return undefined;
  const cs = getComputedStyle(root);
  const zoom = parseFloat(cs.zoom) || 1;
  const rect = root.getBoundingClientRect();
  const px = (value: string) => `${(parseFloat(value) || 0) * zoom}px`;
  return {
    x: rect.left - vp.x,
    y: rect.top - vp.y,
    // The stitched root size LayoutView paint positions against, matching
    // the URL-layer canvas record (`background-attachment.ts`).
    width: Math.max(rect.width, Number(root.scrollWidth || 0) * zoom),
    height: Math.max(rect.height, Number(root.scrollHeight || 0) * zoom),
    borderTopWidth: px(cs.borderTopWidth),
    borderRightWidth: px(cs.borderRightWidth),
    borderBottomWidth: px(cs.borderBottomWidth),
    borderLeftWidth: px(cs.borderLeftWidth),
    paddingTop: px(cs.paddingTop),
    paddingRight: px(cs.paddingRight),
    paddingBottom: px(cs.paddingBottom),
    paddingLeft: px(cs.paddingLeft),
  };
};

/**
 * Stamp the canvas background record on the captured tree's first element:
 * the source element's full style record (the same builder every captured
 * element uses, so URL selections, intrinsic sizes and the canvas attachment
 * record come along) positioned at the root box. Independent of where the
 * capture is rooted: Blink paints the canvas from the viewport style whatever
 * element a screenshot clips to.
 */
export const stampDocumentCanvasBackground = (
  result: CapturedElement[],
  buildStyleRecord: (scope: {
    el: HTMLElement;
    cs: CSSStyleDeclaration;
    tag: string;
    rect: DOMRect;
    _capturedFontFamilyStack: unknown;
  }) => unknown,
  fontFamilyStackFor: (el: Element, computedFontFamily: string) => unknown,
) => {
  if (result.length === 0) return;
  const rootBox = result[0].documentRootBox;
  const source = documentCanvasSourceElement();
  if (rootBox == null || source == null) return;
  const cs = getComputedStyle(source);
  const tag = source.localName;
  result[0].documentCanvasBackground = {
    tag,
    text: "",
    x: rootBox.x,
    y: rootBox.y,
    width: rootBox.width,
    height: rootBox.height,
    children: [],
    styles: buildStyleRecord({
      el: source as HTMLElement,
      cs,
      tag,
      rect: source.getBoundingClientRect(),
      _capturedFontFamilyStack: fontFamilyStackFor(source, cs.fontFamily),
    }) as CapturedElement["styles"],
  };
};
