//
// Multi-fragment inline / multi-column block detection, extracted from the
// capture script's captureInner (DM-1436). Part of the page-evaluated
// CAPTURE_SCRIPT bundle. Mutates the captured node in place — sets
// inlineFragments / fragmentAxis / boxDecorationBreak when the element paints
// across more than one line-box / column fragment. See the inline comments for
// the trigger conditions (DM-754 / DM-937).
//
// The helpers below are module-level functions with explicit parameters, so
// esbuild bundles them into the same page-evaluated script; none of them
// closes over mutable module state.

import { isPaintedColor } from "../../../utils/transparent-background.js";
import type { CapturedElement } from "../../types.js";

type InlineFragment = NonNullable<CapturedElement["inlineFragments"]>[number];
type ColumnRule = NonNullable<CapturedElement["columnRules"]>[number];

/**
 * Physical row intervals of a multi-column container's content box. A
 * column-span:all child ends the current column row and starts another below
 * its margin box.
 */
const columnRowIntervals = (el: Element, contentTop: number, contentBottom: number): Array<[number, number]> => {
  var _rows: Array<[number, number]> = [];
  var _rowStart = contentTop;
  for (var _si = 0; _si < el.children.length; _si++) {
    var _span = el.children[_si];
    var _spanCs = window.getComputedStyle(_span);
    if (_spanCs.columnSpan !== "all") continue;
    var _spanRect = _span.getBoundingClientRect();
    var _spanTop = _spanRect.top - (parseFloat(_spanCs.marginTop) || 0);
    var _spanBottom = _spanRect.bottom + (parseFloat(_spanCs.marginBottom) || 0);
    if (_spanTop > _rowStart) _rows.push([_rowStart, Math.min(_spanTop, contentBottom)]);
    _rowStart = Math.max(_rowStart, _spanBottom);
  }
  if (contentBottom > _rowStart) _rows.push([_rowStart, contentBottom]);
  return _rows;
};

/**
 * CSS Multi-column Layout paints rules in each column row. A column-span:all
 * child ends the current row and starts another, so a rule reconstructed from
 * the container's union box would incorrectly cross the spanner. Capture the
 * physical row intervals here while the DOM's computed margins and
 * border/padding geometry are available.
 */
const captureColumnRules = (
  el: Element,
  cs: CSSStyleDeclaration,
  vp: { x: number; y: number },
  captured: CapturedElement,
): void => {
  var _ownCount = parseInt(cs.columnCount, 10);
  var _ownColumnWidth = parseFloat(cs.columnWidth || "");
  var _ownGap = parseFloat(cs.columnGap || "");
  if (!Number.isFinite(_ownGap)) _ownGap = parseFloat(cs.fontSize || "16") || 16;
  var _ruleWidth = parseFloat(cs.columnRuleWidth || "0") || 0;
  var _ruleStyle = cs.columnRuleStyle || "none";
  if (!(_ruleWidth > 0 && _ruleStyle !== "none" && _ruleStyle !== "hidden")) return;
  var _box = el.getBoundingClientRect();
  var _contentLeft = _box.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
  var _contentRight = _box.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0);
  var _contentTop = _box.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
  var _contentBottom = _box.bottom - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingBottom) || 0);
  var _contentWidth = _contentRight - _contentLeft;
  if (!(Number.isFinite(_ownCount) && _ownCount > 1) && Number.isFinite(_ownColumnWidth) && _ownColumnWidth > 0) {
    _ownCount = Math.max(1, Math.floor((_contentWidth + _ownGap) / (_ownColumnWidth + _ownGap)));
  }
  if (!(Number.isFinite(_ownCount) && _ownCount > 1 && _contentWidth > 0 && _contentBottom > _contentTop)) return;
  var _rows = columnRowIntervals(el, _contentTop, _contentBottom);
  var _columnWidth = (_contentWidth - _ownGap * (_ownCount - 1)) / _ownCount;
  var _rules: ColumnRule[] = [];
  for (var _ri = 1; _ri < _ownCount; _ri++) {
    var _ruleX = _contentLeft + _ri * _columnWidth + (_ri - 0.5) * _ownGap - vp.x;
    for (var _rsi = 0; _rsi < _rows.length; _rsi++) {
      if (_rows[_rsi][1] <= _rows[_rsi][0]) continue;
      _rules.push({
        x: _ruleX,
        y1: _rows[_rsi][0] - vp.y,
        y2: _rows[_rsi][1] - vp.y,
        width: _ruleWidth,
        color: cs.columnRuleColor,
        style: _ruleStyle,
      });
    }
  }
  if (_rules.length > 0) captured.columnRules = _rules;
};

/**
 * Walk ancestors looking for a multi-column container. `column-count` is the
 * most common; `column-width: <length>` also creates columns. Stop at <body>
 * (no column container above that level in practice).
 */
const isInsideMultiColumnContainer = (el: Element): boolean => {
  var _a = el.parentElement;
  while (_a != null) {
    var _ac = window.getComputedStyle(_a);
    var _cc = parseInt(_ac.columnCount, 10);
    var _cw = _ac.columnWidth;
    if ((Number.isFinite(_cc) && _cc > 1) || (_cw != null && _cw !== "auto" && _cw !== "" && _cw !== "normal")) {
      return true;
    }
    if (_a === document.body) break;
    _a = _a.parentElement;
  }
  return false;
};

/** Viewport-relative getClientRects() fragments with positive area. */
const collectPaintedClientRects = (cr: DOMRectList, vp: { x: number; y: number }): InlineFragment[] => {
  var _frags: InlineFragment[] = [];
  for (var _ci = 0; _ci < cr.length; _ci++) {
    var _f = cr[_ci];
    // Skip zero-area fragments — Chrome occasionally emits these for
    // empty trailing inline runs.
    if (_f.width <= 0 || _f.height <= 0) continue;
    _frags.push({
      x: _f.left - vp.x,
      y: _f.top - vp.y,
      width: _f.width,
      height: _f.height,
    });
  }
  return _frags;
};

/**
 * Physical offset of one fragment inside the stitched box, given the logical
 * size consumed by the fragments before it.
 */
const stitchedFragmentOffset = (
  isInline: boolean,
  direction: string,
  writingMode: string,
  stitchedSize: number,
  consumed: number,
  logicalSize: number,
): { x: number; y: number } => {
  var _horizontalWriting = writingMode === "horizontal-tb";
  if (isInline) {
    // ComputeFragmentOffsetOnLine swaps the physical before/after
    // sums for RTL before PaintRectForImageStrip shifts X/Y.
    var _inlineOffset = direction === "rtl" ? stitchedSize - consumed - logicalSize : consumed;
    return _horizontalWriting ? { x: _inlineOffset, y: 0 } : { x: 0, y: _inlineOffset };
  }
  if (_horizontalWriting) return { x: 0, y: consumed };
  if (writingMode === "vertical-rl" || writingMode === "sideways-rl") {
    // WritingModeConverter maps logical block-start to the
    // physical right edge for *-rl modes.
    return { x: stitchedSize - consumed - logicalSize, y: 0 };
  }
  return { x: consumed, y: 0 };
};

/**
 * DM-2365: Blink paints sliced decorations against one imaginary
 * unfragmented box, then clips that paint back to the physical
 * fragment. Preserve that box per fragment so the renderer does
 * not have to infer logical order from viewport placement (which
 * fails for RTL and vertical writing modes).
 *
 * InlineBoxFragmentPainter::PaintRectForImageStrip stitches the
 * logical inline sizes. OffsetInStitchedFragments stitches the
 * logical block sizes and maps the consumed block offset back to
 * a physical axis. getClientRects() exposes those same physical
 * LayoutUnit fragment sizes in layout order.
 */
const assignStitchedBackgroundGeometry = (
  frags: InlineFragment[],
  cs: CSSStyleDeclaration,
  isInline: boolean,
): void => {
  var _writingMode = String(cs.writingMode || "horizontal-tb").toLowerCase();
  var _horizontalWriting = _writingMode === "horizontal-tb";
  // Inline fragmentation stitches the inline axis, block fragmentation the
  // block axis; in horizontal writing those are width and height.
  var _stitchesWidth = isInline === _horizontalWriting;
  var _logicalSizes = [];
  var _stitchedSize = 0;
  for (var _gsi = 0; _gsi < frags.length; _gsi++) {
    var _logicalSize = _stitchesWidth ? frags[_gsi].width : frags[_gsi].height;
    _logicalSizes.push(_logicalSize);
    _stitchedSize += _logicalSize;
  }
  var _consumed = 0;
  for (var _gfi = 0; _gfi < frags.length; _gfi++) {
    var _gf = frags[_gfi];
    var _offset = stitchedFragmentOffset(
      isInline,
      cs.direction,
      _writingMode,
      _stitchedSize,
      _consumed,
      _logicalSizes[_gfi],
    );
    _gf.backgroundOffsetInStitchedBox = {
      x: _offset.x,
      y: _offset.y,
    };
    _gf.backgroundPositioningArea = {
      x: _gf.x - _offset.x,
      y: _gf.y - _offset.y,
      width: _stitchesWidth ? _stitchedSize : _gf.width,
      height: _stitchesWidth ? _gf.height : _stitchedSize,
    };
    _consumed += _logicalSizes[_gfi];
  }
};

export const detectInlineFragments = (
  el: Element,
  cs: CSSStyleDeclaration,
  vp: { x: number; y: number },
  captured: CapturedElement,
): void => {
  captureColumnRules(el, cs, vp, captured);
  var _bgC = captured.styles.backgroundColor;
  var _hasBg = isPaintedColor(_bgC);
  var _hasBgImage =
    captured.styles.backgroundImage != null &&
    captured.styles.backgroundImage !== "" &&
    captured.styles.backgroundImage !== "none";
  var _hasMaskImage =
    captured.styles.maskImage != null && captured.styles.maskImage !== "" && captured.styles.maskImage !== "none";
  var _btw = parseFloat(captured.styles.borderTopWidth || "0") || 0;
  var _brw = parseFloat(captured.styles.borderRightWidth || "0") || 0;
  var _bbw = parseFloat(captured.styles.borderBottomWidth || "0") || 0;
  var _blw = parseFloat(captured.styles.borderLeftWidth || "0") || 0;
  var _hasBorder = _btw > 0 || _brw > 0 || _bbw > 0 || _blw > 0;
  // TextDecorationInfo owns a distinct DecoratingBox for every wrapped
  // FragmentItem even when the inline has no background/border paint.
  // Preserve those getClientRects() fragments for render-side decoration
  // ownership instead of reducing them to a union or rounded baselines.
  var _hasDecoration =
    captured.styles.textDecorationLine != null &&
    captured.styles.textDecorationLine !== "" &&
    captured.styles.textDecorationLine !== "none";
  var _hasPaint = _hasBg || _hasBgImage || _hasBorder || _hasMaskImage;
  var _isInline = cs.display === "inline";
  var _isBlockLevel =
    !_isInline &&
    (cs.display === "block" ||
      cs.display === "list-item" ||
      cs.display === "flex" ||
      cs.display === "grid" ||
      cs.display === "flow-root" ||
      cs.display === "inline-block" ||
      cs.display === "inline-flex" ||
      cs.display === "inline-grid");
  var _inMultiColumn = _isBlockLevel && _hasPaint && isInsideMultiColumnContainer(el);
  if (!((_hasPaint || _hasDecoration) && (_isInline || _inMultiColumn))) return;
  var _cr = el.getClientRects();
  if (_cr == null || _cr.length <= 1) return;
  var _frags = collectPaintedClientRects(_cr, vp);
  if (_frags.length <= 1) return;
  if (_hasBgImage) assignStitchedBackgroundGeometry(_frags, cs, _isInline);
  captured.inlineFragments = _frags;
  // DM-754: stash the fragmentation axis derived from `display`.
  // Inline-wrap (e.g. `<span>` wrapping across line boxes) slices
  // horizontally — first owns the left side, last owns the right.
  // Block-level fragmentation inside a multi-column container
  // slices vertically — first owns the top, last owns the bottom.
  // Both axes produce vertically-stacked frag rects so we can't
  // distinguish them geometrically at render time.
  captured.fragmentAxis = _isInline ? "inline" : "block";
  // Block-in-inline layout also reports the anonymous inline
  // fragments through getClientRects(). Preserve the authored
  // box-decoration-break value: Blink uses the normal `slice`
  // semantics by default even when block descendants caused the
  // split (for example 06-forms-style-file's `.drop` label).
};
