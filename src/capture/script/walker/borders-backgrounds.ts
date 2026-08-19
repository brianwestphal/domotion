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
import { resolveCollapsedBorderWinner } from "./collapsed-border.js";

export const createBordersBackgroundsHandler = ({ normColor, normGradientColors, resolvePlaceholderShownBg, resolveCornerRadius }) => {
  const isUaColorBorder = (tag, el, cs, side) =>
    tag === 'input' && el.type === 'color'
    && normColor(cs[side], cs.color).replace(/\s+/g, '') === 'rgb(0,0,0)';

  const tintedBorderColor = (tag, el, cs, side) =>
    isUaColorBorder(tag, el, cs, side) ? 'rgb(118,118,118)' : normColor(cs[side], cs.color);

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

  const computeBackgroundIntrinsic = (cs) => {
    const bgImage = cs.backgroundImage;
    if (bgImage == null || bgImage === 'none' || bgImage === '') return undefined;
    // Split on top-level commas respecting nested parens.
    const layers = [];
    let depth = 0, start = 0;
    for (let i = 0; i < bgImage.length; i++) {
      const c = bgImage[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { layers.push(bgImage.slice(start, i)); start = i + 1; }
    }
    layers.push(bgImage.slice(start));

    return layers.map((layer) => {
      // DM-759: `image-set(url(...) 1x, url(...) 2x, ...)` layers wrap their
      // url() candidates inside the function call; the top-level regex
      // below only matches a bare `url(...)` at layer start. Probe the
      // FIRST url() inside the image-set instead so the renderer's `cover`
      // / `contain` math has the right aspect ratio. Picking any candidate
      // works because Chrome's image-set candidates are conventionally the
      // SAME image at different resolutions / formats, so the intrinsic
      // aspect is consistent across them; the absolute scale may differ
      // by the 1x/2x factor but `cover` / `contain` are aspect-driven.
      let searchLayer = layer;
      const imgSet = /^\s*(?:-webkit-)?image-set\(\s*([\s\S]+)\s*\)\s*$/i.exec(layer);
      if (imgSet != null) searchLayer = imgSet[1];
      // Match all three url() forms ("...", '...', bare), unescaping escaped
      // quotes so a data: URL with embedded HTML attribute quotes isn't
      // truncated (DM-308). For image-set candidates the url() may appear
      // anywhere in the inner string, so search the whole SEARCH LAYER.
      const url = extractCssUrl(searchLayer);
      if (url == null) return null;
      const img = new Image();
      img.src = url;
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      return w > 0 && h > 0 ? { w, h } : null;
    });
  };

  const computeBorderImageIntrinsic = (cs, dim) => {
    const url = extractCssUrl(cs.borderImageSource || '');
    if (url == null) return undefined;
    const img = new Image();
    img.src = url;
    return img[dim] || undefined;
  };

  // DM-690: CSS 2.1 §17.6.2.1 — `border-style: hidden` has the highest
  // precedence in `border-collapse: collapse` mode and SUPPRESSES the
  // neighbor cell's matching border too. Walk the table grid neighbors and
  // return per-side flags so the caller can rewrite this cell's border-side
  // styles to `'hidden'` (which the renderer already skips). Scope: simple
  // tables (no rowspan / colspan); good enough for the bug-report fixture
  // `04-deep-border-conflict` and the common-case marketing tables.
  const cellHiddenNeighbors = (el, tag, cs) => {
    const out = { top: false, right: false, bottom: false, left: false };
    if ((tag !== 'td' && tag !== 'th') || cs.borderCollapse !== 'collapse') return out;
    const tr = el.parentElement;
    if (tr == null || tr.tagName !== 'TR') return out;
    const rowCells = Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const colIdx = rowCells.indexOf(el);
    const hiddenSide = (cell, side) => {
      if (cell == null) return false;
      const cs2 = getComputedStyle(cell);
      return cs2['border' + side + 'Style'] === 'hidden';
    };
    if (hiddenSide(rowCells[colIdx - 1], 'Right')) out.left = true;
    if (hiddenSide(rowCells[colIdx + 1], 'Left')) out.right = true;
    // Resolve the surrounding table to walk row-neighbors across
    // thead/tbody/tfoot sections.
    let table = tr.parentElement;
    while (table != null && table.tagName !== 'TABLE') table = table.parentElement;
    if (table != null) {
      const allRows = Array.from(table.querySelectorAll('tr')).filter((t) => t.closest('table') === table);
      const rowIdx = allRows.indexOf(tr);
      const above = allRows[rowIdx - 1];
      const below = allRows[rowIdx + 1];
      if (above != null) {
        const aboveCells = Array.from(above.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        if (hiddenSide(aboveCells[colIdx], 'Bottom')) out.top = true;
      }
      if (below != null) {
        const belowCells = Array.from(below.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        if (hiddenSide(belowCells[colIdx], 'Top')) out.bottom = true;
      }
    }
    return out;
  };

  // DM-1260: full CSS 2.1 §17.6.2.1 collapsed-border conflict resolution. Each
  // grid edge paints the SINGLE winning border, chosen per Blink
  // `table_borders.cc`: `hidden` suppresses; else widest wins; tie → higher
  // style rank; true tie → the source merged first wins (cell > row > section >
  // col > colgroup > table; among cells, the earlier one in DOM order). The
  // renderer already paints collapsed borders CENTERED on the grid line, so when
  // both cells adjacent to an internal edge resolve to the SAME winner they
  // overlap exactly — and structural-element box borders are suppressed (their
  // contribution is folded into the cells' edges here). Scoped to simple tables
  // (no rowspan / colspan); complex tables fall back to `cellHiddenNeighbors`.
  // Blink EBorderStyle ordering (higher wins the `>` tiebreak): double > solid >
  // dashed > dotted > ridge > outset > groove > inset > none; `hidden` separate.
  const sideBorder = (element, side, order) => {
    if (element == null) return null;
    const c = getComputedStyle(element);
    return { w: parseFloat(c['border' + side + 'Width']) || 0, style: c['border' + side + 'Style'], color: c['border' + side + 'Color'], order };
  };
  const resolveEdge = resolveCollapsedBorderWinner;
  // DM-2246: Blink tabulates cells into logical columns before merging border
  // edges (`ColspanCellTabulator` in table_borders.cc). Keep the winning unit
  // edges separate when a span meets several neighbours; a single CSS side
  // cannot represent those T-junctions.
  const resolveCollapsedSpanSegments = (el, tag, cs) => {
    if ((tag !== 'td' && tag !== 'th') || cs.borderCollapse !== 'collapse') return null;
    const tr = el.parentElement;
    let table = tr; while (table != null && table.tagName !== 'TABLE') table = table.parentElement;
    if (tr == null || tr.tagName !== 'TR' || table == null) return null;
    const rows = Array.from(table.querySelectorAll('tr')).filter((r) => r.closest('table') === table);
    const occ = [], meta = new Map(); let hasSpan = false, order = 0, C = 0;
    for (let r = 0; r < rows.length; r++) {
      if (occ[r] == null) occ[r] = [];
      let c = 0;
      for (const cell of Array.from(rows[r].children).filter((x) => x.tagName === 'TD' || x.tagName === 'TH')) {
        while (occ[r][c] != null) c++;
        const rs = Math.max(1, cell.rowSpan || 1), csn = Math.max(1, cell.colSpan || 1);
        hasSpan = hasSpan || rs > 1 || csn > 1;
        const m = { cell, r, c, rs: Math.min(rs, rows.length - r), cs: csn, order: order++ };
        meta.set(cell, m);
        for (let rr = r; rr < r + m.rs; rr++) { if (occ[rr] == null) occ[rr] = []; for (let cc = c; cc < c + csn; cc++) occ[rr][cc] = m; }
        c += csn; C = Math.max(C, c);
      }
    }
    if (!hasSpan) return null;
    const me = meta.get(el); if (me == null) return null;
    // Recover the physical track lines from the boxes that start/end on each
    // logical line. This is the layout result Chromium actually paints; equal
    // logical fractions are wrong whenever rows or columns have unequal used
    // sizes. Multiple boxes may report a shared line, so use their median to
    // avoid choosing one side's collapsed-border half-pixel rounding.
    const xSamples = Array.from({ length: C + 1 }, () => []);
    const ySamples = Array.from({ length: rows.length + 1 }, () => []);
    for (const m of meta.values()) {
      const rect = m.cell.getBoundingClientRect();
      xSamples[m.c].push(rect.left); xSamples[m.c + m.cs].push(rect.right);
      ySamples[m.r].push(rect.top); ySamples[m.r + m.rs].push(rect.bottom);
    }
    const physicalLines = (samples) => {
      const lines = samples.map((values) => {
        if (values.length === 0) return null;
        values.sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
      });
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] != null) continue;
        let lo = i - 1, hi = i + 1;
        while (lo >= 0 && lines[lo] == null) lo--;
        while (hi < lines.length && lines[hi] == null) hi++;
        if (lo >= 0 && hi < lines.length) lines[i] = lines[lo] + (lines[hi] - lines[lo]) * ((i - lo) / (hi - lo));
      }
      return lines;
    };
    const xLines = physicalLines(xSamples), yLines = physicalLines(ySamples);
    const meRect = el.getBoundingClientRect();
    const xRatio = (column) => Math.max(0, Math.min(1, (xLines[column] - meRect.left) / meRect.width));
    const yRatio = (row) => Math.max(0, Math.min(1, (yLines[row] - meRect.top) / meRect.height));
    const candidate = (m, side) => m == null ? null : sideBorder(m.cell, side, m.order / 1000000);
    const same = (a, b) => a != null && b != null && !!a.hidden === !!b.hidden && a.w === b.w && a.style === b.style && a.color === b.color;
    const raw = [];
    const add = (side, start, end, winner) => {
      if (winner == null || winner.hidden) return;
      const prev = raw[raw.length - 1];
      if (prev != null && prev.side === side && Math.abs(prev.end - start) < 1e-8 && same(prev._winner, winner)) prev.end = end;
      else raw.push({ side, start, end, width: winner.w, style: winner.style, color: normColor(winner.color), _winner: winner });
    };
    // As in Blink, a cell contributes along every logical unit of its span.
    // Ownership stays right/bottom plus the table's outer top/left, preventing
    // adjacent cells from double-painting the same centered edge.
    for (let i = 0; i < me.cs; i++) {
      const col = me.c + i;
      const start = xRatio(col), end = xRatio(col + 1);
      if (me.r === 0) add('top', start, end, resolveEdge([candidate(me, 'Top'), sideBorder(table, 'Top', 5)]));
      add('bottom', start, end, resolveEdge([candidate(me, 'Bottom'), candidate(occ[me.r + me.rs] && occ[me.r + me.rs][col], 'Top'), me.r + me.rs === rows.length ? sideBorder(table, 'Bottom', 5) : null]));
    }
    for (let i = 0; i < me.rs; i++) {
      const row = me.r + i;
      const start = yRatio(row), end = yRatio(row + 1);
      if (me.c === 0) add('left', start, end, resolveEdge([candidate(me, 'Left'), sideBorder(table, 'Left', 5)]));
      add('right', start, end, resolveEdge([candidate(me, 'Right'), candidate(occ[row] && occ[row][me.c + me.cs], 'Left'), me.c + me.cs === C ? sideBorder(table, 'Right', 5) : null]));
    }
    return raw.map(({ _winner, ...segment }) => segment);
  };
  const resolveCollapsedCellBorders = (el, tag, cs) => {
    if ((tag !== 'td' && tag !== 'th') || cs.borderCollapse !== 'collapse') return null;
    const tr = el.parentElement;
    if (tr == null || tr.tagName !== 'TR') return null;
    let table = tr.parentElement;
    while (table != null && table.tagName !== 'TABLE') table = table.parentElement;
    if (table == null) return null;
    const allRows = Array.from(table.querySelectorAll('tr')).filter((t) => {
      let p = t.parentElement; while (p != null && p.tagName !== 'TABLE') p = p.parentElement; return p === table;
    });
    const grid = [];
    for (const row of allRows) {
      const cells = Array.from(row.children).filter((x) => x.tagName === 'TD' || x.tagName === 'TH');
      for (const cell of cells) { if ((cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1) return null; }
      grid.push({ row: row, cells: cells });
    }
    let rIdx = -1, cIdx = -1;
    for (let i = 0; i < grid.length; i++) { const j = grid[i].cells.indexOf(el); if (j >= 0) { rIdx = i; cIdx = j; break; } }
    if (rIdx < 0) return null;
    const R = grid.length, C = grid[rIdx].cells.length;
    let section = tr.parentElement;
    if (section == null || (section.tagName !== 'THEAD' && section.tagName !== 'TBODY' && section.tagName !== 'TFOOT')) section = null;
    // Expand <colgroup>/<col> into a per-column [{col, colgroup}] list.
    const colOf = [];
    for (const cg of Array.from(table.children).filter((x) => x.tagName === 'COLGROUP')) {
      const colEls = Array.from(cg.children).filter((x) => x.tagName === 'COL');
      if (colEls.length === 0) { const span = cg.span || 1; for (let i = 0; i < span; i++) colOf.push({ col: null, colgroup: cg }); }
      else for (const col of colEls) { const span = col.span || 1; for (let i = 0; i < span; i++) colOf.push({ col: col, colgroup: cg }); }
    }
    const ci = colOf[cIdx] || { col: null, colgroup: null };
    // Tiny, position-encoded order so earlier cells win ties AND cells (<1) beat
    // structural sources (≥1). row=1, section=2, col=3, colgroup=4, table=5.
    const cellOrd = (r, c) => (r * 1000 + c) / 1000000;
    const cellAt = (r, c) => (grid[r] && grid[r].cells[c]) || null;
    // DM-1260: bail out of conflict resolution when this cell — or any cell that
    // shares one of its edges — is laid OFF the grid by Chrome (a sub-pixel
    // offset, detected by the same shifted-consensus heuristic the renderer uses
    // for collapsed-border centering). For off-grid cells the two "shared" borders
    // do NOT actually coincide (Chrome paints both, a couple px apart), so
    // collapsing them to one winner is wrong — fall back to per-cell own borders
    // (+ the `hidden` neighbor handling). Computed once per table and cached on the
    // table node (page-context scratch property, discarded with the page).
    let offSet = table.__dmOffGridCells;
    if (offSet == null) {
      const rects = [];
      for (const g of grid) for (const cell of g.cells) rects.push({ cell: cell, r: cell.getBoundingClientRect() });
      const vE = [], hE = [];
      for (const o of rects) { vE.push(o.r.left, o.r.right); hE.push(o.r.top, o.r.bottom); }
      const shifted = (coord, others) => {
        for (const a of others) { const d = Math.abs(a - coord); if (d <= 0.5 || d > 2) continue; let agree = 0; for (const b of others) if (Math.abs(b - a) <= 0.5) agree++; if (agree >= 2) return true; }
        return false;
      };
      offSet = new Set();
      for (const o of rects) {
        if (shifted(o.r.left, vE) || shifted(o.r.right, vE) || shifted(o.r.top, hE) || shifted(o.r.bottom, hE)) offSet.add(o.cell);
      }
      table.__dmOffGridCells = offSet;
    }
    for (const n of [el, cellAt(rIdx - 1, cIdx), cellAt(rIdx + 1, cIdx), cellAt(rIdx, cIdx - 1), cellAt(rIdx, cIdx + 1)]) {
      if (n != null && offSet.has(n)) return null;
    }
    // Each grid edge is painted EXACTLY ONCE so two cells can't double-paint a
    // shared edge (which mis-renders when one cell is laid off-grid — its inset
    // paint and the neighbor's centered paint land a few px apart). Convention:
    // every cell paints its RIGHT and BOTTOM edges; it paints TOP/LEFT only when
    // it's the outermost cell (first row / first column). Internal top/left edges
    // are owned by the cell above / to the left (its bottom / right). The winner
    // is resolved from BOTH adjacent cells (+ structural sources) either way, so
    // the single painted border is the correct one.
    const colR = colOf[cIdx + 1] || { col: null, colgroup: null };
    const top = rIdx === 0 ? resolveEdge([
      sideBorder(el, 'Top', cellOrd(rIdx, cIdx)),
      sideBorder(tr, 'Top', 1), sideBorder(section, 'Top', 2), sideBorder(table, 'Top', 5),
    ]) : null;
    const left = cIdx === 0 ? resolveEdge([
      sideBorder(el, 'Left', cellOrd(rIdx, cIdx)),
      sideBorder(ci.col, 'Left', 3), sideBorder(ci.colgroup, 'Left', 4),
      sideBorder(tr, 'Left', 1), sideBorder(table, 'Left', 5),
    ]) : null;
    const right = resolveEdge([
      sideBorder(el, 'Right', cellOrd(rIdx, cIdx)),
      cIdx < C - 1 ? sideBorder(cellAt(rIdx, cIdx + 1), 'Left', cellOrd(rIdx, cIdx + 1)) : null,
      sideBorder(ci.col, 'Right', 3), sideBorder(ci.colgroup, 'Right', 4),
      cIdx < C - 1 ? sideBorder(colR.col, 'Left', 3) : null,
      cIdx === C - 1 ? sideBorder(tr, 'Right', 1) : null,
      cIdx === C - 1 ? sideBorder(table, 'Right', 5) : null,
    ]);
    const bottom = resolveEdge([
      sideBorder(el, 'Bottom', cellOrd(rIdx, cIdx)),
      rIdx < R - 1 ? sideBorder(cellAt(rIdx + 1, cIdx), 'Top', cellOrd(rIdx + 1, cIdx)) : null,
      sideBorder(tr, 'Bottom', 1),
      rIdx < R - 1 ? sideBorder(grid[rIdx + 1].row, 'Top', 1) : null,
      rIdx === R - 1 ? sideBorder(section, 'Bottom', 2) : null,
      rIdx === R - 1 ? sideBorder(table, 'Bottom', 5) : null,
    ]);
    return { top: top, right: right, bottom: bottom, left: left };
  };
  // DM-1260: under border-collapse, the table / row / section / column-group /
  // column box borders don't paint as boxes — their contribution is resolved into
  // the cell edges above. Suppress them so we don't paint concentric structural
  // borders on top of the resolved cell borders.
  const isCollapsedStructural = (tag, cs) => cs.borderCollapse === 'collapse'
    && (tag === 'table' || tag === 'tr' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'colgroup' || tag === 'col');

  const captureBordersBackgrounds = (el, cs, tag, rect, isPlaceholderCapture) => ({
    backgroundColor: (function () {
      if (isPlaceholderCapture) {
        const psBg = resolvePlaceholderShownBg(el);
        if (psBg !== '') return normColor(psBg);
      }
      return normColor(cs.backgroundColor, cs.color);
    })(),
    borderColor: normColor(cs.borderColor, cs.color),
    borderWidth: cs.borderWidth,
    borderRadius: cs.borderRadius,
    borderTopLeftRadius: resolveCornerRadius(cs.borderTopLeftRadius, rect.width, rect.height, parseFloat(cs.zoom) || 1),
    borderTopRightRadius: resolveCornerRadius(cs.borderTopRightRadius, rect.width, rect.height, parseFloat(cs.zoom) || 1),
    borderBottomRightRadius: resolveCornerRadius(cs.borderBottomRightRadius, rect.width, rect.height, parseFloat(cs.zoom) || 1),
    borderBottomLeftRadius: resolveCornerRadius(cs.borderBottomLeftRadius, rect.width, rect.height, parseFloat(cs.zoom) || 1),
    cornerTopLeftShape: cs.cornerTopLeftShape,
    cornerTopRightShape: cs.cornerTopRightShape,
    cornerBottomRightShape: cs.cornerBottomRightShape,
    cornerBottomLeftShape: cs.cornerBottomLeftShape,
    borderTopWidth: cs.borderTopWidth,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
    borderLeftWidth: cs.borderLeftWidth,
    // DM-690: when an adjacent collapsed-table cell declares its matching
    // side as `border-style: hidden`, CSS 2.1 §17.6.2.1 says we MUST treat
    // our side as hidden too (precedence: `hidden > widest > ...`). Override
    // here at capture time so the renderer's existing `style === 'hidden'`
    // skip suppresses the paint on this side. (Cells whose OWN side is
    // already hidden are unaffected — they pass through.)
    ...(function () {
      const hn = cellHiddenNeighbors(el, tag, cs);
      return {
        borderTopStyle: hn.top ? 'hidden' : cs.borderTopStyle,
        borderRightStyle: hn.right ? 'hidden' : cs.borderRightStyle,
        borderBottomStyle: hn.bottom ? 'hidden' : cs.borderBottomStyle,
        borderLeftStyle: hn.left ? 'hidden' : cs.borderLeftStyle,
      };
    })(),
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
      const rb = resolveCollapsedCellBorders(el, tag, cs);
      const spanSegments = resolveCollapsedSpanSegments(el, tag, cs);
      if (spanSegments != null) {
        return {
          collapsedBorderSegments: spanSegments,
          borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
          borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
        };
      }
      if (rb == null) return {};
      const sideOut = (resolved, side) => {
        if (resolved == null) return { ['border' + side + 'Style']: 'none', ['border' + side + 'Width']: '0px' };
        if (resolved.hidden) return { ['border' + side + 'Style']: 'hidden' };
        return {
          ['border' + side + 'Style']: resolved.style,
          ['border' + side + 'Width']: resolved.w + 'px',
          ['border' + side + 'Color']: normColor(resolved.color),
        };
      };
      return { ...sideOut(rb.top, 'Top'), ...sideOut(rb.right, 'Right'), ...sideOut(rb.bottom, 'Bottom'), ...sideOut(rb.left, 'Left') };
    })(),
    frostedBgFallback: computeFrostedBgFallback(cs),
    backgroundImage: normGradientColors(cs.backgroundImage, cs.color),
    backgroundSize: cs.backgroundSize,
    backgroundPosition: cs.backgroundPosition,
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
    backgroundIntrinsic: computeBackgroundIntrinsic(cs),
    borderImageSource: cs.borderImageSource,
    borderImageSlice: cs.borderImageSlice,
    borderImageWidth: cs.borderImageWidth,
    borderImageOutset: cs.borderImageOutset,
    borderImageRepeat: cs.borderImageRepeat,
    borderImageIntrinsicWidth: computeBorderImageIntrinsic(cs, 'naturalWidth'),
    borderImageIntrinsicHeight: computeBorderImageIntrinsic(cs, 'naturalHeight'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: normColor(cs.outlineColor),
    outlineOffset: cs.outlineOffset,
    boxShadow: cs.boxShadow,
    // box-decoration-break: 'slice' (default) vs 'clone'. Drives per-fragment
    // paint of wrapped inline elements; see CapturedElement.inlineFragments.
    boxDecorationBreak: cs.boxDecorationBreak || cs.webkitBoxDecorationBreak || 'slice',
  });

  return { captureBordersBackgrounds };
};
