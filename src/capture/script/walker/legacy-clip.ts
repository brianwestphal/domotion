//
// Legacy CSS `clip: rect(...)`. Part of the page-`evaluate`d CAPTURE_SCRIPT
// bundle — self-contained, page globals only.
//
// Blink creates a CssClip paint property node only for an out-of-flow
// positioned box with a non-auto clip (`LayoutObject::HasClip`,
// core/layout/layout_object.h:1523-1526). Its rect is the border box with each
// non-auto side moved to its offset (`LayoutBox::ClipRect`,
// core/layout/layout_box.cc:2499-2529), and paint uses its pixel-snapped form
// (`UpdateCssClip`, core/paint/paint_property_tree_builder.cc:2414-2438). The
// node clips the box's own paint and every descendant, including fixed
// descendants whose containing block it is not (`UpdateOutOfFlowContext`,
// :3420-3449). Chromium 6b5a1b80.

interface ClipLayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const translationOnly = (style: CSSStyleDeclaration): boolean => {
  if ((style.rotate || "none") !== "none" || (style.scale || "none") !== "none") return false;
  const transform = style.transform || "none";
  if (transform === "none") return true;
  const matrix = /^matrix\(([^)]*)\)$/.exec(transform);
  if (matrix == null) return false;
  const [a, b, c, d] = matrix[1].split(",").map((part) => parseFloat(part));
  return a === 1 && b === 0 && c === 0 && d === 1;
};

/** The box's legacy clip rect in viewport coordinates, or undefined. */
export const captureLegacyClipRect = ({
  el,
  cs,
  rect,
  vp,
  zoom,
  sel,
  warn,
}: {
  el: Element;
  cs: CSSStyleDeclaration;
  rect: ClipLayoutRect;
  vp: { x: number; y: number };
  zoom: number;
  sel: string;
  warn: (selector: string, property: string, message: string) => void;
}): { x: number; y: number; width: number; height: number } | undefined => {
  if (cs.position !== "absolute" && cs.position !== "fixed") return undefined;
  const value = (cs.clip || "auto").trim();
  if (value === "auto") return undefined;
  const match = /^rect\((.*)\)$/.exec(value);
  const sides = match != null ? match[1].split(/\s*,\s*|\s+/) : [];
  const lengths = sides.map((side) =>
    side === "auto" ? null : /^-?[\d.]+(?:e-?\d+)?px$/.test(side) ? parseFloat(side) : NaN,
  );
  if (sides.length !== 4 || lengths.some((length) => length != null && !Number.isFinite(length))) {
    warn(sel, "clip", `legacy clip "${value}" is not a resolved pixel rect; it is not painted`);
    return undefined;
  }
  // The rect is local to the border box; only translation keeps it an
  // axis-aligned viewport rect. Zoom changes the length space.
  for (let owner: Element | null = el; owner != null; owner = owner.parentElement) {
    const view = owner.ownerDocument.defaultView;
    if (view == null || !translationOnly(owner === el ? cs : view.getComputedStyle(owner))) {
      warn(sel, "clip", "legacy clip under a non-translation transform is not painted");
      return undefined;
    }
  }
  if (zoom !== 1) {
    warn(sel, "clip", "legacy clip under CSS zoom is not painted");
    return undefined;
  }
  const [top, right, bottom, left] = lengths;
  const width = rect.width;
  const height = rect.height;
  let x = rect.left - vp.x;
  let y = rect.top - vp.y;
  let clipWidth = width;
  let clipHeight = height;
  if (left != null) {
    x += left;
    clipWidth -= left;
  }
  if (right != null) clipWidth -= width - right;
  if (top != null) {
    y += top;
    clipHeight -= top;
  }
  if (bottom != null) clipHeight -= height - bottom;
  // ToSnappedClipRect: snap each edge to the pixel grid.
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  return {
    x: x0,
    y: y0,
    width: Math.max(0, Math.round(x + clipWidth) - x0),
    height: Math.max(0, Math.round(y + clipHeight) - y0),
  };
};
