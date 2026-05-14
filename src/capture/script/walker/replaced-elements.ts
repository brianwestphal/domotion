// @ts-nocheck
//
// Replaced-element snapshot capture: tags the live DOM with
// `data-domotion-rid` and stashes content-box rects on the captured tree so
// the post-capture rasterize pass (on the Node side) can hide everything else
// and screenshot just the painted pixels.
//
// Covers two routing paths:
//
//   1. Built-in replaced tags — <iframe> / <canvas> / <video> / <object> /
//      <embed> — and custom elements (hyphenated tag with an open
//      shadowRoot, e.g. nytimes.com's <nyt-betamax> photo carousel) whose
//      paint can't be reached via the light-DOM walk.
//
//   2. CSS sprite-icon image-replacement: `text-indent: -9999px` (or the
//      modern `text-indent: <neg> + overflow:hidden + white-space:nowrap`
//      variant) plus a background-image. Chrome paints just the sliced
//      sprite region; the text sits offscreen. Domotion's bg-image pattern
//      path can't slice reliably, so we route the element through the same
//      rasterize-painted-rect path used for <canvas>/<video>/<iframe>.
//      Skipped when the element is itself an <img> (the renderer already
//      emits the painted image with proper object-fit) to avoid stacking
//      two <image> tags at the same coords with the snapshot's
//      preserveAspectRatio="none" stretching the result.
//
// The handler mutates the captured-element object in place (sets
// `replacedSnapshot`, optionally `imageReplacement`, and on the sprite-icon
// path clears `styles.backgroundImage` / `text` / `textSegments` so the
// raster isn't drawn under stale bg-image / text emission).
//
// `_replacedIdx` is owned by the factory closure so it persists across
// per-element calls within one captureScript invocation but resets on the
// next.

export const createReplacedElementsHandler = ({ vp }) => {
  let _replacedIdx = 0;

  const handleReplacedElement = (el, cs, tag, rect, captured, bordersOnlyCell) => {
    if (bordersOnlyCell || cs.display === 'none' || rect.width <= 0 || rect.height <= 0) return;

    // Path 1: built-in replaced tags + custom elements with open shadow DOM.
    const isCustomEl = tag.indexOf('-') > 0;
    const hasOpenShadow = isCustomEl && el.shadowRoot != null;
    const customElNeedsSnapshot = isCustomEl && hasOpenShadow;

    if (tag === 'iframe' || tag === 'canvas' || tag === 'video' || tag === 'object' || tag === 'embed' || customElNeedsSnapshot) {
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const cw = rect.width - bl - br - pl - pr;
      const ch = rect.height - bt - bb - pt - pb;
      if (cw > 0 && ch > 0) {
        const rid = 'dr' + (_replacedIdx++);
        el.setAttribute('data-domotion-rid', rid);
        captured.replacedSnapshot = {
          x: rect.left - vp.x + bl + pl,
          y: rect.top - vp.y + bt + pt,
          width: cw,
          height: ch,
          rid,
        };
      }
    }

    // Path 2: CSS sprite-icon image-replacement. Skip when path 1 already
    // captured a snapshot, or the element is an <img> (renderer already
    // emits it via object-fit).
    if (captured.replacedSnapshot != null || captured.imageSrc != null) return;

    const ti = parseFloat(cs.textIndent) || 0;
    const ovX = cs.overflowX === 'hidden' || cs.overflow === 'hidden';
    const hasBgImage = cs.backgroundImage != null && cs.backgroundImage !== 'none' && cs.backgroundImage !== '';
    const phark = ti <= -1000;
    const modern = ti < 0 && ovX && cs.whiteSpace === 'nowrap';
    if ((phark || modern) && hasBgImage) {
      const rid = 'dr' + (_replacedIdx++);
      el.setAttribute('data-domotion-rid', rid);
      const titleText = ((el.getAttribute && el.getAttribute('aria-label')) || captured.text || '').trim();
      captured.replacedSnapshot = {
        x: rect.left - vp.x,
        y: rect.top - vp.y,
        width: rect.width,
        height: rect.height,
        rid,
      };
      captured.imageReplacement = { titleText };
      // Suppress broken bg-image emission and offscreen text — the raster
      // already covers both. Keep border + bg-color emission so a styled
      // border around the icon (rare but supported) still paints.
      captured.styles.backgroundImage = undefined;
      captured.text = '';
      captured.textSegments = undefined;
    }
  };

  return { handleReplacedElement };
};
