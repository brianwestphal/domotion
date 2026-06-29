// @ts-nocheck
//
// <fieldset> top-aligned <legend> box adjustment, extracted from the capture
// script's `captureInner` (DM-1436). Part of the page-`evaluate`d CAPTURE_SCRIPT
// bundle — self-contained, page globals only, no module-scope closures.
//
// Chrome's UA fieldset paints its top border at the legend's vertical center,
// with a notch cut in the border across the legend's x range.
// `fieldset.getBoundingClientRect()` returns the OUTER box that includes the
// legend's full height — so the visible box top sits legend.height/2 below
// rect.top. Inset the captured y/height to match Chrome's painted box, and
// capture the legend's x range for the renderer to notch the top border behind
// it. DM-342/DM-343.

export const computeFieldsetLegendBox = (el, tag, rect, vp) => {
  let fieldsetLegendNotch;
  let fsX = rect.left - vp.x;
  let fsY = rect.top - vp.y;
  let fsW = rect.width;
  let fsH = rect.height;
  if (tag === 'fieldset') {
    for (let i = 0; i < el.children.length; i++) {
      const ch = el.children[i];
      if (ch.tagName.toLowerCase() !== 'legend') continue;
      const lr = ch.getBoundingClientRect();
      // Top-aligned legend (legend.top === fieldset.top, with sub-px slack).
      if (lr.height > 0 && lr.width > 0 && Math.abs(lr.top - rect.top) < 2) {
        const inset = lr.height / 2;
        fsY = (rect.top - vp.y) + inset;
        fsH = rect.height - inset;
        fieldsetLegendNotch = { x: lr.left - vp.x, y: lr.top - vp.y, w: lr.width, h: lr.height };
      }
      break;
    }
  }
  return { x: fsX, y: fsY, width: fsW, height: fsH, fieldsetLegendNotch };
};
