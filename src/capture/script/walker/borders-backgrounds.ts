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
import { validateCollapsedBorderFragmentRecord } from "../../collapsed-border-fragment-record.js";

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

const scalePhysicalNumber = (value, effectiveZoom) =>
  Math.round(value * effectiveZoom * 1e6) / 1e6;

const splitGradientArguments = (value) => {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote !== "") { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
};

/**
 * Blink's deprecated grammar uses unitless numbers—not CSS lengths—for its
 * point components and radial radii. `PositionFromValue` / `ResolveRadius`
 * multiply those numbers by EffectiveZoom at paint time. Scale only the
 * grammar-owned geometry slots here; numeric color-stop offsets remain
 * fractions and must never be zoomed.
 */
export const physicalComputedLegacyGradient = (call, effectiveZoom) => {
  if (effectiveZoom === 1) return call;
  const match = /^-webkit-gradient\s*\(\s*(linear|radial)\s*,([\s\S]*)\)$/i.exec(call.trim());
  if (match == null) return call;
  const radial = match[1].toLowerCase() === "radial";
  const args = splitGradientArguments(match[2]);
  if (args.length < (radial ? 4 : 2)) return call;
  const number = /^([+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?)$/i;
  const point = (value) => value.trim().split(/\s+/).map((token) => {
    const parsed = number.exec(token);
    return parsed == null ? token : String(scalePhysicalNumber(Number(parsed[1]), effectiveZoom));
  }).join(" ");
  args[0] = point(args[0]);
  if (radial) {
    const firstRadius = number.exec(args[1]);
    if (firstRadius != null) args[1] = String(scalePhysicalNumber(Number(firstRadius[1]), effectiveZoom));
    args[2] = point(args[2]);
    const secondRadius = number.exec(args[3]);
    if (secondRadius != null) args[3] = String(scalePhysicalNumber(Number(secondRadius[1]), effectiveZoom));
  } else {
    args[1] = point(args[1]);
  }
  return `-webkit-gradient(${match[1].toLowerCase()}, ${args.join(", ")})`;
};

/** Computed gradient stop lengths are serialized before effective zoom, while
 * Blink resolves them against the zoomed concrete-image gradient line. Scale
 * only px tokens inside modern gradient functions and only geometry-owned
 * unitless numbers inside deprecated gradients; URL/data payloads and
 * unrelated background layers remain byte-identical. */
export const physicalComputedGradientImage = (value, effectiveZoom) => {
  if (effectiveZoom === 1 || value == null || value === "" || value === "none") return value;
  const start = /(?:-webkit-gradient|\b(?:repeating-)?(?:linear|radial|conic)-gradient)\(/gi;
  const isTopLevel = (end) => {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = 0; index < end; index++) {
      const ch = value[index];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (quote !== "") { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    return depth === 0 && quote === "";
  };
  let out = "";
  let cursor = 0;
  let searchCursor = 0;
  for (;;) {
    start.lastIndex = searchCursor;
    const match = start.exec(value);
    if (match == null) return out + value.slice(cursor);
    if (!isTopLevel(match.index)) {
      searchCursor = start.lastIndex;
      continue;
    }
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
    const rawCall = value.slice(match.index, end);
    const call = /^-webkit-gradient/i.test(rawCall)
      ? physicalComputedLegacyGradient(rawCall, effectiveZoom)
      : rawCall.replace(/(-?(?:\d+(?:\.\d+)?|\.\d+))px\b/g, (_token, number) =>
          `${scalePhysicalNumber(parseFloat(number), effectiveZoom)}px`);
    out += call;
    cursor = end;
    searchCursor = end;
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

export const createBordersBackgroundsHandler = ({ normColor, normGradientColors, resolvePlaceholderShownBg, resolveCornerRadius, effectiveZoomFor = () => 1, warn = () => {}, shortSelector = () => "", vp = { x: 0, y: 0 }, collapsedBorderFragmentRecordFor = () => undefined }) => {
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

  // A td/th only participates in Blink's table border-collapse machinery
  // while its generated box is a table cell. Author CSS can change a td to a
  // block (the DM-2654 fixture does this via a shared `.lab` rule); the
  // inherited computed `border-collapse: collapse` value then remains visible
  // through CSSOM even though it is inert for that ordinary block box.
  const isCollapsedTableCell = (tag, cs) =>
    (tag === 'td' || tag === 'th') && cs.display === 'table-cell';

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
      for (const cell of Array.from(entry.row.children).filter((x) =>
        (x.tagName === 'TD' || x.tagName === 'TH')
          && getComputedStyle(x).display === 'table-cell')) {
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
      // Blink stores global start-row + exact row offsets on every physical
      // section fragment (`table_section_layout_algorithm.cc:47-164`) and
      // TablePainter consumes those fields directly (`table_painters.cc:
      // 490-727`). Never reconstruct that private state from CSSOM alone. The
      // prepass correlated ordered getClientRects with DOM.getContentQuads in
      // an all-transform-neutral epoch; any missing/ambiguous record withholds
      // collapsed-border vector paint instead of reviving the old heuristic.
      const record = collapsedBorderFragmentRecordFor(table);
      const recordErrors = record?.status === 'authenticated'
        ? validateCollapsedBorderFragmentRecord(record)
        : [record?.reason || 'authenticated physical section-fragment record missing'];
      if (record?.status !== 'authenticated'
          || recordErrors.length > 0
          || record.writingMode !== writingMode
          || record.direction !== direction
          || record.totalRows !== grid.rows
          || record.totalColumns !== grid.columns
          || record.tableFragments.length !== tableFragments.length) {
        warn(shortSelector(table), 'fragmented collapsed-table ownership',
          `collapsed-border vector paint withheld: ${recordErrors.join('; ') || 'record/table structure mismatch'}`);
        table.__dmCollapsedCells = new Set(cells.map((meta) => meta.cell));
        table.__dmCollapsedBorderRects = [];
        table.__dmCollapsedBorderFragmentRecord = record;
        return table.__dmCollapsedBorderRects;
      }
      const horizontal = writingMode === 'horizontal-tb';
      const blockReverse = writingMode === 'vertical-rl' || writingMode === 'sideways-rl';
      const physicalRects = [];
      for (const fragment of record.tableFragments) {
        const fragmentIndex = fragment.fragmentIndex;
        const fragmentRect = {
          left: fragment.physicalRect.x,
          top: fragment.physicalRect.y,
          right: fragment.physicalRect.x + fragment.physicalRect.width,
          bottom: fragment.physicalRect.y + fragment.physicalRect.height,
          width: fragment.physicalRect.width,
          height: fragment.physicalRect.height,
        };
        const inlineReverse = direction === 'rtl';
        const groups = fragment.sectionFragments.map((section) => ({
          rowStart: section.globalStartRowIndex,
          blockLines: section.logicalRowOffsets,
          hasContentBefore: section.hasContentBefore,
          hasContentAfter: section.hasContentAfter,
          startRowFragmented: section.startContinuedRow,
          endRowFragmented: section.endContinuedRow,
        }));
        const logicalRects = collapsedBorderFragmentLogicalRects(grid, record.globalColumnOffsets, groups);
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
          if (sx.size > 0 && sy.size > 0) physicalRects.push({ x: sx.start, y: sy.start, width: sx.size, height: sy.size, axis: rect.axis, style: rect.winner.style, color: rect.winner.color, fragmentIndex });
        }
      }
      table.__dmCollapsedCells = new Set(cells.map((meta) => meta.cell));
      table.__dmCollapsedBorderRects = physicalRects;
      table.__dmCollapsedBorderFragmentRecord = {
        ...record,
        consumedBy: 'collapsed-border-fragment-logical-rects-v1',
      };
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
    // Normalize the inherited-but-inert value on DOM cells whose author style
    // generates a non-table-cell box. This keeps the renderer's ordinary box
    // border path from centering the stroke on a table grid line.
    borderCollapse: (tag === 'td' || tag === 'th') && !isCollapsedTableCell(tag, cs)
      ? 'separate'
      : cs.borderCollapse,
    // DM-1260: full collapsed-border conflict resolution. For a cell, override
    // each side with the resolved winning border (overlapping the adjacent cell's
    // matching resolved side); for a collapsed structural element, suppress its
    // box border (folded into the cells). Placed AFTER the per-side width/style/
    // color fields above so it wins. Complex tables (no resolution) fall through.
    ...(function () {
      let collapsedTable = null;
      if (cs.borderCollapse === 'collapse'
          && ((tag !== 'td' && tag !== 'th') || isCollapsedTableCell(tag, cs))) {
        collapsedTable = tag === 'table' ? el : el.closest && el.closest('table');
      }
      const tableRects = collapsedTable != null ? resolveCollapsedTableRects(collapsedTable) : null;
      if (tableRects != null && tag === 'table') {
        return {
          collapsedBorderRects: tableRects,
          collapsedBorderFragmentRecord: collapsedTable.__dmCollapsedBorderFragmentRecord,
          borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
          borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
          borderWidth: '0px', borderColor: 'rgba(0, 0, 0, 0)',
        };
      }
      if (tableRects != null && (isCollapsedStructural(tag, cs) || isCollapsedTableCell(tag, cs))) {
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
    borderImageSource: physicalComputedGradientImage(cs.borderImageSource, effectiveZoom),
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
