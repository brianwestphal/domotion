// @ts-nocheck
//
// Border + background + outline + box-shadow capture. The bulk of this is
// cs.X passthrough (the renderer does the real work — emitting SVG strokes
// for borders, gradient defs for background-image, etc.), with a handful of
// computed fields:
//
//   - **backgroundColor placeholder-shown fallback** (DM-283): when the
//     captured element is empty-with-placeholder, walk the captured
//     `:placeholder-shown` rules and prefer that color over Chrome's
//     resolved `rgba(0,0,0,0)` (which it returns when only the
//     `background` shorthand was set).
//
//   - **borderTop/Right/Bottom/LeftRadius**: resolve % corner-radii to px
//     against rect width/height. Chrome's computed longhand still
//     preserves %, so a `border-radius: 50%` would read as the literal
//     string "50%" and downstream parseFloat would mistake it for 50 px.
//     See SK-1093.
//
//   - **borderTop/Right/Bottom/LeftColor color-input tint workaround**
//     (DM-434): Chromium's appearance:auto `<input type=color>` paints
//     a 1px rgb(118,118,118) border, but getComputedStyle reports
//     rgb(0,0,0). Override at capture so the generic border-emit path
//     paints the same chrome Chromium paints. The workaround stays here
//     (rather than in form-controls) because it's a per-side border-color
//     override that intermixes with the normal `normColor(cs.borderXColor,
//     cs.color)` emission.
//
//   - **frostedBgFallback** (DM-476): when an element has a
//     backdrop-filter and an effectively-transparent background-color,
//     stash the document body's resolved bg color so the renderer can
//     paint it behind the would-have-been-frosted region. See
//     docs/19-frosted-backdrop-fallback.md.
//
//   - **backgroundIntrinsic** (DM-308): per-layer intrinsic dims of
//     background-image url() layers. Split background-image on top-level
//     commas (parens-aware) so each layer's url() can be probed for
//     naturalWidth/Height via a fresh Image().
//
//   - **borderImageIntrinsicWidth / Height**: same pattern for border-
//     image-source url().

import { extractCssUrl } from "../utils.js";
import {
  collapsedBorderStyle,
  collapsedBorderFragmentLogicalRects,
  collapsedBorderLogicalRects,
  createCollapsedBorderGrid,
  mergeCollapsedBorderBox,
} from "./collapsed-border.js";

/** Computed border/outline lengths are serialized in pre-effective-zoom CSS
 * pixels, while captured DOMRects are already in painted coordinates. Blink's
 * paint code consumes the zoomed ComputedStyle value, so cross that boundary
 * exactly once during capture. Chromium 7d859f271c:
 * StyleBuilderConverter::{ConvertBorderWidth,ConvertOutlineOffset} stores
 * zoomed integer lengths; longhands_custom.cc serializes them through
 * ZoomAdjustedPixelValue before getComputedStyle exposes them. */
export const physicalComputedPaintLength = (value, effectiveZoom) => {
  if (effectiveZoom === 1) return value;
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return value;
  return `${Math.round(number * effectiveZoom * 1e6) / 1e6}px`;
};

/** Computed background sizes retain pre-zoom px lengths while their consumer
 * rect is physical. Percentages already use that rect; scale only px terms,
 * including px components inside calc(). */
export const physicalComputedTileSize = (value, effectiveZoom) => {
  if (effectiveZoom === 1) return value;
  return value.replace(/(-?(?:\d+(?:\.\d+)?|\.\d+))px\b/g, (_match, number) =>
    `${Math.round(parseFloat(number) * effectiveZoom * 1e6) / 1e6}px`);
};

/** Computed gradient stop lengths are serialized before effective zoom, while
 * Blink resolves them against the zoomed concrete-image gradient line. Scale
 * only px tokens inside gradient functions; URL/data payloads and unrelated
 * background layers remain byte-identical. */
export const physicalComputedGradientImage = (value, effectiveZoom) => {
  if (effectiveZoom === 1 || value == null || value === "" || value === "none") return value;
  const start = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
  let out = "";
  let cursor = 0;
  for (;;) {
    start.lastIndex = cursor;
    const match = start.exec(value);
    if (match == null) return out + value.slice(cursor);
    out += value.slice(cursor, match.index);
    let depth = 1;
    let quote = "";
    let escaped = false;
    let end = start.lastIndex;
    for (; end < value.length && depth > 0; end++) {
      const ch = value[end];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (quote !== "") { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    const call = value.slice(match.index, end).replace(/(-?(?:\d+(?:\.\d+)?|\.\d+))px\b/g, (_token, number) =>
      `${Math.round(parseFloat(number) * effectiveZoom * 1e6) / 1e6}px`);
    out += call;
    cursor = end;
  }
};

/** Reconstruct Blink's caption-excluding TableGridRect from the already-laid-
 * out caption fragments. `table_layout_algorithm.cc` advances a logical block
 * offset by each top caption's start margin, fragment size, and end margin,
 * records the table-box extent, then lays out bottom captions the same way.
 * DOMRects give us the fragment offsets and sizes; only the adjoining block
 * margin needs to be restored. */
export const tableGridRectFromCaptions = (tableRect, writingMode, captions) => {
  const vertical = /^(?:vertical|sideways)-/.test(writingMode);
  const blockReverse = writingMode === 'vertical-rl' || writingMode === 'sideways-rl';
  const blockExtent = vertical ? tableRect.width : tableRect.height;
  const logicalEdges = (rect) => {
    if (!vertical) return { start: rect.top - tableRect.top, end: rect.bottom - tableRect.top };
    if (blockReverse) return { start: tableRect.right - rect.right, end: tableRect.right - rect.left };
    return { start: rect.left - tableRect.left, end: rect.right - tableRect.left };
  };

  let blockStart = 0;
  let blockEnd = blockExtent;
  let sawBottom = false;
  for (const caption of captions) {
    const edges = logicalEdges(caption.rect);
    if (caption.side === 'bottom') {
      if (!sawBottom) {
        blockEnd = edges.start - caption.marginBlockStart;
        sawBottom = true;
      }
    } else {
      // Top captions are laid out in tree order before the table box. The
      // LAST one owns the final child block offset; do not max() here because
      // a negative end margin is allowed to overlap the table grid.
      blockStart = edges.end + caption.marginBlockEnd;
    }
  }
  if (!vertical) {
    return {
      x: tableRect.left,
      y: tableRect.top + blockStart,
      width: tableRect.width,
      height: blockEnd - blockStart,
    };
  }
  return {
    x: blockReverse ? tableRect.right - blockEnd : tableRect.left + blockStart,
    y: tableRect.top,
    width: blockEnd - blockStart,
    height: tableRect.height,
  };
};

export const createBordersBackgroundsHandler = ({ normColor, normGradientColors, resolvePlaceholderShownBg, resolveCornerRadius, effectiveZoomFor = () => 1, warn = () => {}, shortSelector = () => "", vp = { x: 0, y: 0 } }) => {
  const isUaColorBorder = (tag, el, cs, side) =>
    tag === 'input' && el.type === 'color'
    && normColor(cs[side], cs.color).replace(/\s+/g, '') === 'rgb(0,0,0)';

  const tintedBorderColor = (tag, el, cs, side) =>
    isUaColorBorder(tag, el, cs, side) ? 'rgb(118,118,118)' : normColor(cs[side], cs.color);

  const pseudoCreatesInflowFragment = (el, pseudo) => {
    const styleWindow = el.ownerDocument?.defaultView ?? window;
    const pcs = styleWindow.getComputedStyle(el, pseudo);
    const content = pcs.content;
    return content != null && content !== '' && content !== 'none' && content !== 'normal'
      && pcs.display !== 'none' && pcs.position !== 'absolute' && pcs.position !== 'fixed';
  };

  const nodeCreatesInflowFragment = (node) => {
    // Text contributes only when inline layout produced an actual fragment.
    // This distinguishes NBSP (a fragment) from collapsed ASCII whitespace
    // without encoding either character class in Domotion.
    if (node.nodeType === 3) {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      const hasFragment = range.getClientRects().length > 0;
      if (range.detach) range.detach();
      return hasFragment;
    }
    if (node.nodeType !== 1) return false;
    const styleWindow = node.ownerDocument?.defaultView ?? window;
    const ncs = styleWindow.getComputedStyle(node);
    if (ncs.display === 'none' || ncs.position === 'absolute' || ncs.position === 'fixed') return false;
    if (ncs.display !== 'contents') return true;
    if (pseudoCreatesInflowFragment(node, '::before')) return true;
    for (const child of node.childNodes) if (nodeCreatesInflowFragment(child)) return true;
    return pseudoCreatesInflowFragment(node, '::after');
  };

  const tableCellHasInflowFragments = (cell) => {
    if (pseudoCreatesInflowFragment(cell, '::before')) return true;
    for (const child of cell.childNodes) if (nodeCreatesInflowFragment(child)) return true;
    return pseudoCreatesInflowFragment(cell, '::after');
  };

  // `FinalizeTableCellLayout` checks whether the fragment builder has any
  // in-flow children. `empty-cells` is ignored for collapsed-border tables.
  const isTableCellHiddenByEmptyCells = (el, cs, tag) =>
    (tag === 'td' || tag === 'th') && cs.borderCollapse !== 'collapse'
      && cs.emptyCells === 'hide' && !tableCellHasInflowFragments(el);

  const resolveTableGridRect = (el, cs, tag, rect) => {
    if (tag !== 'table') return undefined;
    const captions = [];
    for (const child of el.children) {
      const styleWindow = child.ownerDocument?.defaultView ?? window;
      const ccs = styleWindow.getComputedStyle(child);
      if (ccs.display !== 'table-caption') continue;
      const captionRect = child.getBoundingClientRect();
      const zoom = effectiveZoomFor(child);
      const vertical = /^(?:vertical|sideways)-/.test(cs.writingMode);
      const blockReverse = cs.writingMode === 'vertical-rl' || cs.writingMode === 'sideways-rl';
      const marginBlockStart = parseFloat(vertical
        ? (blockReverse ? ccs.marginRight : ccs.marginLeft)
        : ccs.marginTop) * zoom || 0;
      const marginBlockEnd = parseFloat(vertical
        ? (blockReverse ? ccs.marginLeft : ccs.marginRight)
        : ccs.marginBottom) * zoom || 0;
      captions.push({
        rect: captionRect,
        side: ccs.captionSide === 'bottom' ? 'bottom' : 'top',
        marginBlockStart,
        marginBlockEnd,
      });
    }
    if (captions.length === 0) return undefined;
    const grid = tableGridRectFromCaptions(rect, cs.writingMode, captions);
    return { x: grid.x - vp.x, y: grid.y - vp.y, width: grid.width, height: grid.height };
  };

  const computeFrostedBgFallback = (cs) => {
    const bdf = cs.backdropFilter || cs.webkitBackdropFilter || '';
    if (bdf === '' || bdf === 'none') return undefined;
    const bgCol = normColor(cs.backgroundColor, cs.color);
    // Parse alpha out of "rgba(r,g,b,a)" / "rgb(r,g,b)" / "rgb(r g b / a)".
    // normColor canonicalises to one of these forms.
    let a = 1;
    const m = /rgba?\(\s*[^,)\s]+[ ,]+[^,)\s]+[ ,]+[^,)\s]+(?:[ ,/]+([^)]+))?\)/.exec(bgCol);
    if (m != null && m[1] != null) {
      const av = parseFloat(m[1]);
      if (!isNaN(av)) a = av;
    }
    if (a > 0.1) return undefined;
    const bodyBg = normColor(window.getComputedStyle(document.body).backgroundColor);
    // If body itself is transparent (rare on real pages), default to white.
    let bodyA = 1;
    const bm = /rgba?\(\s*[^,)\s]+[ ,]+[^,)\s]+[ ,]+[^,)\s]+(?:[ ,/]+([^)]+))?\)/.exec(bodyBg);
    if (bm != null && bm[1] != null) {
      const bav = parseFloat(bm[1]);
      if (!isNaN(bav)) bodyA = bav;
    }
    return bodyA <= 0.1 ? 'rgb(255,255,255)' : bodyBg;
  };

  const computeBackgroundImages = (el, cs) => {
    const bgImage = cs.backgroundImage;
    if (bgImage == null || bgImage === 'none' || bgImage === '') return undefined;
    const records = el && el.__domotionBackgroundImages;
    if (!Array.isArray(records)) {
      warn(shortSelector(el), 'background-image', 'capture-time selected-image sizing record was unavailable');
      return undefined;
    }
    const recordWarnings = [];
    for (const record of records) {
      if (record == null || record.warning == null) continue;
      recordWarnings.push('layer ' + record.layerIndex + ': ' + record.warning);
    }
    if (recordWarnings.length > 0) {
      // The warning buffer de-duplicates by selector + feature. Preserve every
      // failing layer in one diagnostic instead of letting the first one hide
      // later loading/opaque/unsupported states.
      warn(shortSelector(el), 'background-image', recordWarnings.join('; '));
    }
    return records;
  };

  const computeBorderImageIntrinsic = (cs, dim) => {
    const url = extractCssUrl(cs.borderImageSource || '');
    if (url == null) return undefined;
    const img = new Image();
    img.src = url;
    return img[dim] || undefined;
  };

  // Blink does not paint collapsed borders on individual table parts. Build
  // one table-owned logical edge graph, then cache its physical paint rects so
  // the table and every contributing descendant consume the same decision.
  const resolveCollapsedTableRects = (table) => {
    if (table.__dmCollapsedBorderRects !== undefined) return table.__dmCollapsedBorderRects;
    const tableCs = getComputedStyle(table);
    if (tableCs.borderCollapse !== 'collapse') return (table.__dmCollapsedBorderRects = null);
    const writingMode = tableCs.writingMode || 'horizontal-tb';
    const direction = tableCs.direction === 'rtl' ? 'rtl' : 'ltr';
    const sectionEls = Array.from(table.children).filter((x) => x.tagName === 'THEAD' || x.tagName === 'TBODY' || x.tagName === 'TFOOT');
    const directRows = Array.from(table.children).filter((x) => x.tagName === 'TR');
    const rowEntries = [];
    if (directRows.length) for (const row of directRows) rowEntries.push({ row, section: null, sectionIndex: -1 });
    for (let sectionIndex = 0; sectionIndex < sectionEls.length; sectionIndex++) {
      for (const row of Array.from(sectionEls[sectionIndex].children).filter((x) => x.tagName === 'TR')) rowEntries.push({ row, section: sectionEls[sectionIndex], sectionIndex });
    }
    if (!rowEntries.length) return (table.__dmCollapsedBorderRects = null);
    const occupancy = [], cells = [], sections = new Map();
    let columns = 0;
    for (let r = 0; r < rowEntries.length; r++) {
      occupancy[r] ||= [];
      const entry = rowEntries[r];
      if (entry.section != null) {
        const current = sections.get(entry.section);
        if (current == null) sections.set(entry.section, { start: r, count: 1 });
        else current.count++;
      }
      let c = 0;
      for (const cell of Array.from(entry.row.children).filter((x) => x.tagName === 'TD' || x.tagName === 'TH')) {
        while (occupancy[r][c] != null) c++;
        const colspan = Math.max(1, cell.colSpan || 1);
        let rowspan = Math.max(1, cell.rowSpan || 1);
        if (entry.section != null) {
          const sectionRows = Array.from(entry.section.children).filter((x) => x.tagName === 'TR');
          const localRow = sectionRows.indexOf(entry.row);
          rowspan = Math.min(rowspan, sectionRows.length - localRow);
        } else rowspan = Math.min(rowspan, rowEntries.length - r);
        const meta = { cell, row: r, column: c, rowspan, colspan };
        cells.push(meta);
        for (let rr = r; rr < r + rowspan; rr++) {
          occupancy[rr] ||= [];
          for (let cc = c; cc < c + colspan; cc++) occupancy[rr][cc] = meta;
        }
        c += colspan;
        columns = Math.max(columns, c);
      }
    }
    if (!columns) return (table.__dmCollapsedBorderRects = null);
    const grid = createCollapsedBorderGrid(rowEntries.length, columns);
    let boxOrder = 0;
    const physicalBorders = (node, order) => {
      const cs = getComputedStyle(node);
      const zoom = effectiveZoomFor(node);
      const one = (side) => ({
        side: side.toLowerCase(), order,
        w: parseFloat(physicalComputedPaintLength(cs['border' + side + 'Width'], zoom)) || 0,
        style: collapsedBorderStyle(cs['border' + side + 'Style']),
        color: normColor(cs['border' + side + 'Color'], cs.color),
      });
      return { top: one('Top'), right: one('Right'), bottom: one('Bottom'), left: one('Left') };
    };
    for (const meta of cells) mergeCollapsedBorderBox(grid, meta.row, meta.column, meta.rowspan, meta.colspan, physicalBorders(meta.cell, ++boxOrder), writingMode, direction, true);
    for (let r = 0; r < rowEntries.length; r++) mergeCollapsedBorderBox(grid, r, 0, 1, columns, physicalBorders(rowEntries[r].row, ++boxOrder), writingMode, direction);
    for (const [section, span] of sections) mergeCollapsedBorderBox(grid, span.start, 0, span.count, columns, physicalBorders(section, ++boxOrder), writingMode, direction);
    const columnEntries = [];
    for (const child of Array.from(table.children)) {
      if (child.tagName === 'COL') {
        columnEntries.push({ col: child, group: null, start: columnEntries.length, span: Math.max(1, child.span || 1) });
      } else if (child.tagName === 'COLGROUP') {
        const start = columnEntries.reduce((n, item) => Math.max(n, item.start + item.span), 0);
        const cols = Array.from(child.children).filter((x) => x.tagName === 'COL');
        if (!cols.length) columnEntries.push({ col: null, group: child, start, span: Math.max(1, child.span || 1) });
        else {
          let at = start;
          for (const col of cols) { const span = Math.max(1, col.span || 1); columnEntries.push({ col, group: child, start: at, span }); at += span; }
        }
      }
    }
    const columnOrder = ++boxOrder;
    for (const entry of columnEntries) if (entry.col != null) mergeCollapsedBorderBox(grid, 0, entry.start, rowEntries.length, entry.span, physicalBorders(entry.col, columnOrder), writingMode, direction);
    const groupOrder = ++boxOrder;
    const groupsSeen = new Set();
    for (const entry of columnEntries) if (entry.group != null && !groupsSeen.has(entry.group)) {
      groupsSeen.add(entry.group);
      const members = columnEntries.filter((x) => x.group === entry.group);
      const start = Math.min(...members.map((x) => x.start));
      const end = Math.max(...members.map((x) => x.start + x.span));
      mergeCollapsedBorderBox(grid, 0, start, rowEntries.length, end - start, physicalBorders(entry.group, groupOrder), writingMode, direction);
    }
    mergeCollapsedBorderBox(grid, 0, 0, rowEntries.length, columns, physicalBorders(table, ++boxOrder), writingMode, direction);

    const tableRect = table.getBoundingClientRect();
    const trackLines = (samples, fallbackEnd) => {
      const lines = samples.map((values) => {
        if (!values.length) return null;
        values.sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
      });
      if (lines[0] == null) lines[0] = 0;
      if (lines[lines.length - 1] == null) lines[lines.length - 1] = fallbackEnd;
      for (let i = 1; i < lines.length - 1; i++) if (lines[i] == null) {
        let hi = i + 1; while (hi < lines.length && lines[hi] == null) hi++;
        lines[i] = lines[i - 1] + (lines[hi] - lines[i - 1]) / (hi - i + 1);
      }
      return lines;
    };
    const tableFragments = Array.from(table.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (tableFragments.length > 1) {
      // DM-2322: TablePainter owns one global edge graph but paints it once per
      // physical table fragment. CSSOM exposes the corresponding table/row/
      // cell fragment boxes through getClientRects(), which lets us reproduce
      // Blink's section-local row offsets without guessing fragmentainer cuts.
      const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const fragmentIndexFor = (rect) => {
        let best = -1, area = 0;
        for (let i = 0; i < tableFragments.length; i++) {
          const candidate = overlapArea(rect, tableFragments[i]);
          if (candidate > area) { best = i; area = candidate; }
        }
        return best;
      };
      const horizontal = writingMode === 'horizontal-tb';
      const blockReverse = writingMode === 'vertical-rl' || writingMode === 'sideways-rl';
      const repeatedSections = new Map();
      for (const section of sectionEls) {
        if (section.tagName !== 'THEAD' && section.tagName !== 'TFOOT') continue;
        const rects = Array.from(section.getClientRects());
        const mapped = new Set(rects.map(fragmentIndexFor).filter((index) => index >= 0));
        if (rects.length === tableFragments.length && tableFragments.length > 1 && mapped.size === 1) {
          repeatedSections.set(section, { kind: section.tagName === 'THEAD' ? 'header' : 'footer', sourceFragment: [...mapped][0] });
        }
      }
      const translatedRect = (rect, dx, dy) => ({
        x: rect.x + dx, y: rect.y + dy,
        left: rect.left + dx, right: rect.right + dx,
        top: rect.top + dy, bottom: rect.bottom + dy,
        width: rect.width, height: rect.height,
      });
      const fragmentRectsFor = (node, section) => {
        const rects = Array.from(node.getClientRects());
        const repeated = repeatedSections.get(section);
        if (repeated == null || !rects.length) return rects.map((rect) => ({ rect, fragment: fragmentIndexFor(rect), repeated: false }));
        const sourceRect = rects[0];
        const sourceFragment = tableFragments[repeated.sourceFragment];
        return tableFragments.map((target, fragment) => {
          let dx, dy;
          if (horizontal) {
            dx = target.left - sourceFragment.left;
            dy = repeated.kind === 'header' ? target.top - sourceFragment.top : target.bottom - sourceFragment.bottom;
          } else {
            dy = target.top - sourceFragment.top;
            if (repeated.kind === 'header') dx = blockReverse ? target.right - sourceFragment.right : target.left - sourceFragment.left;
            else dx = blockReverse ? target.left - sourceFragment.left : target.right - sourceFragment.right;
          }
          return { rect: translatedRect(sourceRect, dx, dy), fragment, repeated: true };
        });
      };
      const rowPieces = rowEntries.map((entry, row) => fragmentRectsFor(entry.row, entry.section)
        .map((piece) => ({ rect: piece.rect, fragment: piece.fragment, repeated: piece.repeated, row, section: entry.section }))
        .filter((piece) => piece.fragment >= 0));
      const cellPieces = cells.map((meta) => fragmentRectsFor(meta.cell, rowEntries[meta.row].section)
        .map((piece) => ({ rect: piece.rect, fragment: piece.fragment, meta }))
        .filter((piece) => piece.fragment >= 0));
      const sectionPieces = new Map(sectionEls.map((section) => [section, fragmentRectsFor(section, section)]));
      const physicalRects = [];
      for (let fragmentIndex = 0; fragmentIndex < tableFragments.length; fragmentIndex++) {
        const fragmentRect = tableFragments[fragmentIndex];
        const inlineReverse = direction === 'rtl';
        const logical = (rect) => ({
          inlineStart: horizontal
            ? (inlineReverse ? fragmentRect.right - rect.right : rect.left - fragmentRect.left)
            : (inlineReverse ? fragmentRect.bottom - rect.bottom : rect.top - fragmentRect.top),
          inlineEnd: horizontal
            ? (inlineReverse ? fragmentRect.right - rect.left : rect.right - fragmentRect.left)
            : (inlineReverse ? fragmentRect.bottom - rect.top : rect.bottom - fragmentRect.top),
          blockStart: horizontal ? rect.top - fragmentRect.top : (blockReverse ? fragmentRect.right - rect.right : rect.left - fragmentRect.left),
          blockEnd: horizontal ? rect.bottom - fragmentRect.top : (blockReverse ? fragmentRect.right - rect.left : rect.right - fragmentRect.left),
        });
        const inlineSamples = Array.from({ length: columns + 1 }, () => []);
        for (const pieces of cellPieces) for (const piece of pieces) if (piece.fragment === fragmentIndex) {
          const coords = logical(piece.rect), meta = piece.meta;
          inlineSamples[meta.column].push(coords.inlineStart);
          inlineSamples[meta.column + meta.colspan].push(coords.inlineEnd);
        }
        const inlineExtent = horizontal ? fragmentRect.width : fragmentRect.height;
        const inlineLines = trackLines(inlineSamples, inlineExtent);
        const piecesHere = rowPieces.flat().filter((piece) => piece.fragment === fragmentIndex);
        const sectionGroups = new Map();
        for (const piece of piecesHere) {
          const key = piece.section ?? table;
          let group = sectionGroups.get(key);
          if (group == null) { group = []; sectionGroups.set(key, group); }
          group.push(piece);
        }
        const groups = Array.from(sectionGroups.values()).map((pieces) => {
          pieces.sort((a, b) => logical(a.rect).blockStart - logical(b.rect).blockStart || a.row - b.row);
          const first = pieces[0], last = pieces[pieces.length - 1];
          const blockLines = pieces.map((piece) => logical(piece.rect).blockStart);
          const sectionRect = first.section == null ? null : sectionPieces.get(first.section)?.find((piece) => piece.fragment === fragmentIndex)?.rect;
          blockLines.push(sectionRect == null ? logical(last.rect).blockEnd : logical(sectionRect).blockEnd);
          const firstPieceIndex = rowPieces[first.row].findIndex((piece) => piece === first);
          const lastPieceIndex = rowPieces[last.row].findIndex((piece) => piece === last);
          return {
            rowStart: first.row,
            blockLines,
            startRowFragmented: !first.repeated && firstPieceIndex > 0,
            endRowFragmented: !last.repeated && lastPieceIndex >= 0 && lastPieceIndex < rowPieces[last.row].length - 1,
          };
        }).sort((a, b) => a.blockLines[0] - b.blockLines[0]);
        for (let i = 0; i < groups.length; i++) {
          groups[i].hasContentBefore = i === 0 && groups[i].rowStart > 0;
          groups[i].hasContentAfter = i === groups.length - 1
            && groups[i].rowStart + groups[i].blockLines.length < grid.rows + 1;
        }
        const logicalRects = collapsedBorderFragmentLogicalRects(grid, inlineLines, groups);
        for (const rect of logicalRects) {
          let x, y, width, height;
          if (horizontal) {
            x = inlineReverse ? fragmentRect.right - rect.inlineStart - rect.inlineSize : fragmentRect.left + rect.inlineStart;
            y = fragmentRect.top + rect.blockStart; width = rect.inlineSize; height = rect.blockSize;
          } else {
            x = blockReverse ? fragmentRect.right - rect.blockStart - rect.blockSize : fragmentRect.left + rect.blockStart;
            y = inlineReverse ? fragmentRect.bottom - rect.inlineStart - rect.inlineSize : fragmentRect.top + rect.inlineStart;
            width = rect.blockSize; height = rect.inlineSize;
          }
          const snap = (start, size) => { const rounded = Math.round(start); return { start: rounded, size: Math.max(0, Math.round(start + size) - rounded) }; };
          const sx = snap(x, width), sy = snap(y, height);
          if (sx.size > 0 && sy.size > 0) physicalRects.push({ x: sx.start, y: sy.start, width: sx.size, height: sy.size, axis: rect.axis, style: rect.winner.style, color: rect.winner.color });
        }
      }
      table.__dmCollapsedCells = new Set(cells.map((meta) => meta.cell));
      table.__dmCollapsedBorderRects = physicalRects;
      return physicalRects;
    }
    const inlineSamples = Array.from({ length: columns + 1 }, () => []);
    const blockSamples = Array.from({ length: rowEntries.length + 1 }, () => []);
    const horizontal = writingMode === 'horizontal-tb';
    const blockReverse = writingMode === 'vertical-rl' || writingMode === 'sideways-rl';
    const inlineReverse = direction === 'rtl';
    for (const meta of cells) {
      const rect = meta.cell.getBoundingClientRect();
      const inlineStart = horizontal
        ? (inlineReverse ? tableRect.right - rect.right : rect.left - tableRect.left)
        : (inlineReverse ? tableRect.bottom - rect.bottom : rect.top - tableRect.top);
      const inlineEnd = horizontal
        ? (inlineReverse ? tableRect.right - rect.left : rect.right - tableRect.left)
        : (inlineReverse ? tableRect.bottom - rect.top : rect.bottom - tableRect.top);
      const blockStart = horizontal ? rect.top - tableRect.top : (blockReverse ? tableRect.right - rect.right : rect.left - tableRect.left);
      const blockEnd = horizontal ? rect.bottom - tableRect.top : (blockReverse ? tableRect.right - rect.left : rect.right - tableRect.left);
      inlineSamples[meta.column].push(inlineStart); inlineSamples[meta.column + meta.colspan].push(inlineEnd);
      blockSamples[meta.row].push(blockStart); blockSamples[meta.row + meta.rowspan].push(blockEnd);
    }
    const inlineExtent = horizontal ? tableRect.width : tableRect.height;
    const blockExtent = horizontal ? tableRect.height : tableRect.width;
    const logicalRects = collapsedBorderLogicalRects(grid, trackLines(inlineSamples, inlineExtent), trackLines(blockSamples, blockExtent));
    const snap = (start, size) => { const rounded = Math.round(start); return { start: rounded, size: Math.max(0, Math.round(start + size) - rounded) }; };
    const physicalRects = logicalRects.map((rect) => {
      let x, y, width, height;
      if (horizontal) {
        x = inlineReverse ? tableRect.right - rect.inlineStart - rect.inlineSize : tableRect.left + rect.inlineStart;
        y = tableRect.top + rect.blockStart; width = rect.inlineSize; height = rect.blockSize;
      } else {
        x = blockReverse ? tableRect.right - rect.blockStart - rect.blockSize : tableRect.left + rect.blockStart;
        y = inlineReverse ? tableRect.bottom - rect.inlineStart - rect.inlineSize : tableRect.top + rect.inlineStart;
        width = rect.blockSize; height = rect.inlineSize;
      }
      const sx = snap(x, width), sy = snap(y, height);
      return { x: sx.start, y: sy.start, width: sx.size, height: sy.size, axis: rect.axis, style: rect.winner.style, color: rect.winner.color };
    }).filter((rect) => rect.width > 0 && rect.height > 0);
    table.__dmCollapsedCells = new Set(cells.map((meta) => meta.cell));
    table.__dmCollapsedBorderRects = physicalRects;
    return physicalRects;
  };
  // DM-1260: under border-collapse, the table / row / section / column-group /
  // column box borders don't paint as boxes — their contribution is resolved into
  // the cell edges above. Suppress them so we don't paint concentric structural
  // borders on top of the resolved cell borders.
  const isCollapsedStructural = (tag, cs) => cs.borderCollapse === 'collapse'
    && (tag === 'table' || tag === 'tr' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'colgroup' || tag === 'col');

  const captureBordersBackgrounds = (el, cs, tag, rect, isPlaceholderCapture, effectiveZoom = 1) => {
    const backgroundImages = computeBackgroundImages(el, cs);
    return ({
    tableGridRect: resolveTableGridRect(el, cs, tag, rect),
    backgroundColor: (function () {
      if (isPlaceholderCapture) {
        const psBg = resolvePlaceholderShownBg(el);
        if (psBg !== '') return normColor(psBg);
      }
      return normColor(cs.backgroundColor, cs.color);
    })(),
    borderColor: normColor(cs.borderColor, cs.color),
    borderWidth: physicalComputedPaintLength(cs.borderWidth, effectiveZoom),
    borderRadius: cs.borderRadius,
    borderTopLeftRadius: resolveCornerRadius(cs.borderTopLeftRadius, rect.width, rect.height, effectiveZoom),
    borderTopRightRadius: resolveCornerRadius(cs.borderTopRightRadius, rect.width, rect.height, effectiveZoom),
    borderBottomRightRadius: resolveCornerRadius(cs.borderBottomRightRadius, rect.width, rect.height, effectiveZoom),
    borderBottomLeftRadius: resolveCornerRadius(cs.borderBottomLeftRadius, rect.width, rect.height, effectiveZoom),
    cornerTopLeftShape: cs.cornerTopLeftShape,
    cornerTopRightShape: cs.cornerTopRightShape,
    cornerBottomRightShape: cs.cornerBottomRightShape,
    cornerBottomLeftShape: cs.cornerBottomLeftShape,
    borderTopWidth: physicalComputedPaintLength(cs.borderTopWidth, effectiveZoom),
    borderRightWidth: physicalComputedPaintLength(cs.borderRightWidth, effectiveZoom),
    borderBottomWidth: physicalComputedPaintLength(cs.borderBottomWidth, effectiveZoom),
    borderLeftWidth: physicalComputedPaintLength(cs.borderLeftWidth, effectiveZoom),
    borderTopStyle: cs.borderTopStyle,
    borderRightStyle: cs.borderRightStyle,
    borderBottomStyle: cs.borderBottomStyle,
    borderLeftStyle: cs.borderLeftStyle,
    borderTopColor: tintedBorderColor(tag, el, cs, 'borderTopColor'),
    borderRightColor: tintedBorderColor(tag, el, cs, 'borderRightColor'),
    borderBottomColor: tintedBorderColor(tag, el, cs, 'borderBottomColor'),
    borderLeftColor: tintedBorderColor(tag, el, cs, 'borderLeftColor'),
    borderCollapse: cs.borderCollapse,
    // DM-1260: full collapsed-border conflict resolution. For a cell, override
    // each side with the resolved winning border (overlapping the adjacent cell's
    // matching resolved side); for a collapsed structural element, suppress its
    // box border (folded into the cells). Placed AFTER the per-side width/style/
    // color fields above so it wins. Complex tables (no resolution) fall through.
    ...(function () {
      let collapsedTable = null;
      if (cs.borderCollapse === 'collapse') {
        collapsedTable = tag === 'table' ? el : el.closest && el.closest('table');
      }
      const tableRects = collapsedTable != null ? resolveCollapsedTableRects(collapsedTable) : null;
      if (tableRects != null && tag === 'table') {
        return {
          collapsedBorderRects: tableRects,
          borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
          borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
          borderWidth: '0px', borderColor: 'rgba(0, 0, 0, 0)',
        };
      }
      if (tableRects != null && (isCollapsedStructural(tag, cs) || tag === 'td' || tag === 'th')) {
        return {
          borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
          borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
          borderWidth: '0px', borderColor: 'rgba(0, 0, 0, 0)',
        };
      }
      if (isCollapsedStructural(tag, cs)) {
        return {
          borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
          borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
          // Also clear the shorthands — the renderer's legacy uniform-border path
          // falls back to `borderWidth` / `borderColor` when the per-side parses
          // resolve to a zero-width border, which would re-paint the structural box.
          borderWidth: '0px', borderColor: 'rgba(0, 0, 0, 0)',
        };
      }
      return {};
    })(),
    frostedBgFallback: computeFrostedBgFallback(cs),
    backgroundImage: physicalComputedGradientImage(normGradientColors(cs.backgroundImage, cs.color), effectiveZoom),
    backgroundSize: physicalComputedTileSize(cs.backgroundSize, effectiveZoom),
    // Computed px terms are serialized before effective zoom, while the
    // captured positioning/painting DOMRects are already physical. Blink's
    // FillLayer stores zoomed Length values, so cross that boundary once here
    // for position just as we already do for background-size.
    backgroundPosition: physicalComputedTileSize(cs.backgroundPosition, effectiveZoom),
    backgroundRepeat: cs.backgroundRepeat,
    backgroundClip: cs.backgroundClip,
    backgroundBlendMode: cs.backgroundBlendMode,
    // DM-462: -webkit-text-fill-color is the property that actually makes
    // the headline text transparent in the background-clip:text idiom
    // (cs.color may still report a normal value).
    webkitTextFillColor: cs.webkitTextFillColor || cs.WebkitTextFillColor || undefined,
    // DM-749: Stripe's keynote-speaker headline pattern — a span with
    // `background-image: <gradient>; background-clip: text; -webkit-text-
    // fill-color: transparent` wraps a child div that holds the actual
    // text. The gradient is on the parent but Chrome lets it paint through
    // the child's glyphs because background-clip: text masks the gradient
    // by the union of all descendant text shapes. When the element's own
    // bg-image is none AND its text-fill-color is transparent AND an
    // ancestor has background-clip: text with a gradient, capture that
    // ancestor's gradient so the renderer can use it as the glyph fill.
    ...(function () {
      const ownTfc = cs.webkitTextFillColor || cs.WebkitTextFillColor || '';
      // Only meaningful when our own text is transparent.
      if (!/^(rgba\(0[^)]*?,\s*0\)|transparent)$/i.test(ownTfc.trim())) {
        return { inheritedTextFillGradient: undefined };
      }
      // Walk up at most 8 ancestors looking for `background-clip: text`
      // + a non-none `background-image`. 8 covers the Stripe hds-heading
      // depth-of-2 nesting comfortably without scanning the whole tree.
      let p = el.parentElement;
      let depth = 0;
      while (p != null && depth < 8) {
        const pcs = window.getComputedStyle(p);
        const bc = (pcs.backgroundClip || '') + ' ' + (pcs.webkitBackgroundClip || '');
        if (/\btext\b/i.test(bc) && pcs.backgroundImage && pcs.backgroundImage !== 'none' && pcs.backgroundImage !== '') {
          // DM-908: the gradient resolves against the ANCESTOR's bbox (the
          // element that set `background-clip: text`), not the current
          // child element. Capture both so the renderer can build a
          // gradient def with the right `gradientUnits="userSpaceOnUse"`
          // coordinates. When two sibling children inherit from the same
          // ancestor, each then references the SAME gradient span — they
          // share one continuous gradient instead of each repainting a
          // full pink-to-purple ramp within its own bbox.
          const prect = p.getBoundingClientRect();
          return {
            inheritedTextFillGradient: pcs.backgroundImage,
            inheritedTextFillGradientRect: { x: prect.x, y: prect.y, width: prect.width, height: prect.height },
          };
        }
        p = p.parentElement;
        depth++;
      }
      return { inheritedTextFillGradient: undefined };
    })(),
    // DM-719: `-webkit-text-stroke-width` / `-webkit-text-stroke-color` paint a
    // stroke around each glyph outline. Captured so the renderer can add a
    // `stroke` attribute to the text-path emission.
    webkitTextStrokeWidth: cs.webkitTextStrokeWidth || cs.WebkitTextStrokeWidth || undefined,
    webkitTextStrokeColor: cs.webkitTextStrokeColor || cs.WebkitTextStrokeColor || undefined,
    paintOrder: cs.paintOrder || undefined,
    backgroundOrigin: cs.backgroundOrigin,
    backgroundAttachment: cs.backgroundAttachment,
    backgroundImages,
    // Compatibility projection only. The selected candidate and complete
    // natural-sizing state live in backgroundImages.
    backgroundIntrinsic: (() => {
      return backgroundImages?.map((record) => record != null
        && record.naturalWidth != null && record.naturalHeight != null
        ? { w: record.naturalWidth, h: record.naturalHeight }
        : null);
    })(),
    borderImageSource: cs.borderImageSource,
    borderImageSlice: cs.borderImageSlice,
    borderImageWidth: cs.borderImageWidth,
    borderImageOutset: cs.borderImageOutset,
    borderImageRepeat: cs.borderImageRepeat,
    borderImageIntrinsicWidth: computeBorderImageIntrinsic(cs, 'naturalWidth'),
    borderImageIntrinsicHeight: computeBorderImageIntrinsic(cs, 'naturalHeight'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: physicalComputedPaintLength(cs.outlineWidth, effectiveZoom),
    outlineColor: normColor(cs.outlineColor),
    outlineOffset: physicalComputedPaintLength(cs.outlineOffset, effectiveZoom),
    boxShadow: cs.boxShadow,
    // box-decoration-break: 'slice' (default) vs 'clone'. Drives per-fragment
    // paint of wrapped inline elements; see CapturedElement.inlineFragments.
    boxDecorationBreak: cs.boxDecorationBreak || cs.webkitBoxDecorationBreak || 'slice',
    });
  };

  return { captureBordersBackgrounds, isTableCellHiddenByEmptyCells };
};
