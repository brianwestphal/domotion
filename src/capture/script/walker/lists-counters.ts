// @ts-nocheck
//
// List & counter capture: list-item detection, list-style-image intrinsic
// dimensions, list-item index computation, and `::marker` pseudo style
// capture. Used by the captureInner walker once per element.
//
// Counter snapshot resolution (counter-reset / counter-set / counter-increment
// + counter() / counters() expansion against ancestor scopes) lives in the
// outer orchestrator's pre-walk and stays there — it runs once before the
// walker, not per-walk-step.
//
// Bundled into the page-context capture script via the index.ts orchestrator;
// no runtime imports of its own. Use `// @ts-nocheck` at the top because the
// outer-page environment exposes `document` / `window` / `Image` without the
// project's tsconfig DOM lib applying.

export const createListsCountersHandler = ({ normColor, resolveCounterStyle, isCustomCounterStyle }) => {

  const captureListsCounters = (el, cs, tag) => {
    // CSS treats any element with display:list-item as a list item — the tag
    // alone isn't enough. An <li> with display:inline-block (e.g. a horizontal
    // social-icon strip) does NOT paint a marker per spec. Conversely a <div>
    // or <span> with `display: list-item` DOES paint one and contributes to
    // the implicit counter.
    const isListItem = cs.display != null && cs.display.includes('list-item');

    let listMarkerIntrinsic = undefined;
    let listItemIndex = undefined;
    let markerFirstLineDy = undefined;
    let markerFirstLineHeight = undefined;

    if (isListItem) {
      // DM-1270: the marker aligns to the FIRST line of text, not to the li's
      // border-box top. A tall inline on the first line (e.g. an emoji `::after`
      // that extends above the text) raises the li's border box, so the text
      // line sits below `el` top. Capture the first line-box rect (relative to
      // the li top + its height) so the renderer can center the marker on it
      // instead of guessing from `line-height`.
      try {
        const liTop = el.getBoundingClientRect().top;
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = range.getClientRects();
        if (rects.length > 0) {
          markerFirstLineDy = rects[0].top - liTop;
          markerFirstLineHeight = rects[0].height;
        }
      } catch (e) { /* no line box */ }
      // Intrinsic dims of list-style-image so the renderer paints the marker
      // at its natural size (CSS default).
      if (cs.listStyleImage && cs.listStyleImage !== 'none') {
        const u = /^url\((?:"|')?([^"')]+)/.exec(cs.listStyleImage);
        if (u != null) {
          const img = new Image();
          img.src = u[1];
          if (img.naturalWidth > 0) listMarkerIntrinsic = { w: img.naturalWidth, h: img.naturalHeight };
        }
      }
      // 1-based index for numeric/alpha markers. For <li> respect <ol start>,
      // <ol reversed>, and <li value>. For non-<li> display:list-item elements,
      // just count display:list-item siblings in DOM order.
      const parent = el.parentElement;
      if (parent != null) {
        if (tag === 'li') {
          const siblings = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === 'li');
          const parentTag = parent.tagName.toLowerCase();
          const reversed = parentTag === 'ol' && parent.hasAttribute('reversed');
          let start = 1;
          if (parentTag === 'ol' && parent.hasAttribute('start')) start = parseInt(parent.getAttribute('start'), 10) || 1;
          if (reversed) start = siblings.length;
          let cur = start;
          for (const s of siblings) {
            if (s.hasAttribute('value')) cur = parseInt(s.getAttribute('value'), 10) || cur;
            if (s === el) { listItemIndex = cur; break; }
            cur += reversed ? -1 : 1;
          }
        } else {
          let cur = 1;
          for (const s of parent.children) {
            const sd = window.getComputedStyle(s).display;
            if (sd != null && sd.includes('list-item')) {
              if (s === el) { listItemIndex = cur; break; }
              cur += 1;
            }
          }
        }
      }
    }

    // ::marker pseudo styles. Only meaningful on list items; for everything
    // else the values come back equal to the element's own font and are
    // quietly ignored at render time, so leave them undefined.
    const markerCs = isListItem ? window.getComputedStyle(el, '::marker') : null;
    let markerContent = markerCs ? markerCs.content : undefined;

    // DM-770: if list-style-type names a custom @counter-style and the
    // ::marker pseudo doesn't already define a `content` override, resolve
    // the marker symbol from the captured rule definitions. Chrome's CSSOM
    // returns the resolved `::marker { content }` as the literal `"normal"`
    // even when the painted marker is a custom symbol, so we re-implement
    // the resolution algorithm against the captured rule map.
    if (isListItem && resolveCounterStyle != null && listItemIndex != null) {
      const lsType = cs.listStyleType;
      const isCustom = lsType != null && isCustomCounterStyle != null && isCustomCounterStyle(lsType);
      const noAuthorContent = markerContent == null || markerContent === '' || markerContent === 'normal';
      if (isCustom && noAuthorContent) {
        const resolved = resolveCounterStyle(lsType, listItemIndex);
        if (resolved != null) {
          // Wrap as a CSS-string so the render-time `rawContent` parser
          // (which strips surrounding quotes) accepts it.
          markerContent = '"' + resolved.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        }
      }
    }

    return {
      listMarkerIntrinsic,
      listItemIndex,
      markerColor: markerCs ? normColor(markerCs.color) : undefined,
      markerFontWeight: markerCs ? markerCs.fontWeight : undefined,
      markerFontSize: markerCs ? markerCs.fontSize : undefined,
      markerContent,
      markerFontFamily: markerCs ? markerCs.fontFamily : undefined,
      markerFirstLineDy,
      markerFirstLineHeight,
    };
  };

  return { captureListsCounters };
};
