// @ts-nocheck
//
// Multi-fragment inline / multi-column block detection, extracted from the
// capture script's captureInner (DM-1436). Part of the page-evaluated
// CAPTURE_SCRIPT bundle. Mutates the captured node in place — sets
// inlineFragments / fragmentAxis / boxDecorationBreak when the element paints
// across more than one line-box / column fragment. See the inline comments for
// the trigger conditions (DM-754 / DM-937).

export const detectInlineFragments = (el, cs, vp, captured) => {
      // CSS Multi-column Layout paints rules in each column row. A
      // column-span:all child ends the current row and starts another, so a
      // rule reconstructed from the container's union box would incorrectly
      // cross the spanner. Capture the physical row intervals here while the
      // DOM's computed margins and border/padding geometry are available.
      var _ownCount = parseInt(cs.columnCount, 10);
      var _ownColumnWidth = parseFloat(cs.columnWidth || '');
      var _ownGap = parseFloat(cs.columnGap || '');
      if (!Number.isFinite(_ownGap)) _ownGap = parseFloat(cs.fontSize || '16') || 16;
      var _ruleWidth = parseFloat(cs.columnRuleWidth || '0') || 0;
      var _ruleStyle = cs.columnRuleStyle || 'none';
      if (_ruleWidth > 0 && _ruleStyle !== 'none' && _ruleStyle !== 'hidden') {
        var _box = el.getBoundingClientRect();
        var _contentLeft = _box.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
        var _contentRight = _box.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0);
        var _contentTop = _box.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
        var _contentBottom = _box.bottom - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingBottom) || 0);
        var _contentWidth = _contentRight - _contentLeft;
        if (!(Number.isFinite(_ownCount) && _ownCount > 1) && Number.isFinite(_ownColumnWidth) && _ownColumnWidth > 0) {
          _ownCount = Math.max(1, Math.floor((_contentWidth + _ownGap) / (_ownColumnWidth + _ownGap)));
        }
        if (Number.isFinite(_ownCount) && _ownCount > 1 && _contentWidth > 0 && _contentBottom > _contentTop) {
          var _rows = [];
          var _rowStart = _contentTop;
          for (var _si = 0; _si < el.children.length; _si++) {
            var _span = el.children[_si];
            var _spanCs = window.getComputedStyle(_span);
            if (_spanCs.columnSpan !== 'all') continue;
            var _spanRect = _span.getBoundingClientRect();
            var _spanTop = _spanRect.top - (parseFloat(_spanCs.marginTop) || 0);
            var _spanBottom = _spanRect.bottom + (parseFloat(_spanCs.marginBottom) || 0);
            if (_spanTop > _rowStart) _rows.push([_rowStart, Math.min(_spanTop, _contentBottom)]);
            _rowStart = Math.max(_rowStart, _spanBottom);
          }
          if (_contentBottom > _rowStart) _rows.push([_rowStart, _contentBottom]);
          var _columnWidth = (_contentWidth - _ownGap * (_ownCount - 1)) / _ownCount;
          var _rules = [];
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
        }
      }
      var _bgC = captured.styles.backgroundColor;
      var _hasBg = _bgC != null && _bgC !== '' && _bgC !== 'transparent' && _bgC !== 'rgba(0, 0, 0, 0)';
      var _hasBgImage = captured.styles.backgroundImage != null
        && captured.styles.backgroundImage !== '' && captured.styles.backgroundImage !== 'none';
      var _btw = parseFloat(captured.styles.borderTopWidth || '0') || 0;
      var _brw = parseFloat(captured.styles.borderRightWidth || '0') || 0;
      var _bbw = parseFloat(captured.styles.borderBottomWidth || '0') || 0;
      var _blw = parseFloat(captured.styles.borderLeftWidth || '0') || 0;
      var _hasBorder = _btw > 0 || _brw > 0 || _bbw > 0 || _blw > 0;
      var _hasPaint = _hasBg || _hasBgImage || _hasBorder;
      var _isInline = cs.display === 'inline';
      var _isBlockLevel = !_isInline && (
        cs.display === 'block' || cs.display === 'list-item' || cs.display === 'flex'
        || cs.display === 'grid' || cs.display === 'flow-root'
        || cs.display === 'inline-block' || cs.display === 'inline-flex' || cs.display === 'inline-grid'
      );
      var _inMultiColumn = false;
      if (_isBlockLevel && _hasPaint) {
        // Walk ancestors looking for a multi-column container. `column-count`
        // is the most common; `column-width: <length>` also creates columns.
        // Stop at <body> (no column container above that level in practice).
        var _a = el.parentElement;
        while (_a != null) {
          var _ac = window.getComputedStyle(_a);
          var _cc = parseInt(_ac.columnCount, 10);
          var _cw = _ac.columnWidth;
          if ((Number.isFinite(_cc) && _cc > 1) || (_cw != null && _cw !== 'auto' && _cw !== '' && _cw !== 'normal')) {
            _inMultiColumn = true;
            break;
          }
          if (_a === document.body) break;
          _a = _a.parentElement;
        }
      }
      // DM-937: detect "inline-with-block-descendant" — an inline element
      // (e.g. a `<label>`) that wraps a block-level child (`display:block`
      // /list-item/flex/grid). Per CSS 2.1 §9.2.1.1 Chrome inserts
      // "anonymous block boxes" around the block-level descendants and
      // fragments the inline accordingly, but the painted border on each
      // resulting fragment looks like a CLONE box (all four corners
      // rounded, all four sides drawn) rather than the inline-axis SLICE
      // semantics (first owns left, last owns right). Fixture: the .drop
      // label in 06-forms-style-file with `border-radius: 10px` and
      // `<strong>`/`<small>` block children — Chrome paints each
      // fragment as a self-contained rounded box.
      var _hasBlockDescendant = false;
      if (_isInline && _hasPaint) {
        var _stack = [el];
        while (_stack.length > 0) {
          var _n = _stack.pop();
          var _kids = _n.children;
          for (var _ki = 0; _ki < _kids.length; _ki++) {
            var _k = _kids[_ki];
            var _kd = window.getComputedStyle(_k).display;
            if (_kd === 'block' || _kd === 'list-item' || _kd === 'flex' || _kd === 'grid' || _kd === 'flow-root' || _kd === 'table') {
              _hasBlockDescendant = true;
              break;
            }
            _stack.push(_k);
          }
          if (_hasBlockDescendant) break;
        }
      }
      if (_hasPaint && (_isInline || _inMultiColumn)) {
        var _cr = el.getClientRects();
        if (_cr != null && _cr.length > 1) {
          var _frags = [];
          for (var _ci = 0; _ci < _cr.length; _ci++) {
            var _f = _cr[_ci];
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
          if (_frags.length > 1) {
            captured.inlineFragments = _frags;
            // DM-754: stash the fragmentation axis derived from `display`.
            // Inline-wrap (e.g. `<span>` wrapping across line boxes) slices
            // horizontally — first owns the left side, last owns the right.
            // Block-level fragmentation inside a multi-column container
            // slices vertically — first owns the top, last owns the bottom.
            // Both axes produce vertically-stacked frag rects so we can't
            // distinguish them geometrically at render time.
            captured.fragmentAxis = _isInline ? 'inline' : 'block';
            // DM-937: when the inline has block-level descendants, Chrome
            // paints each fragment as a complete rounded box (every side,
            // every corner) — equivalent to `box-decoration-break: clone`
            // — rather than the inline-axis slice it normally uses. Force
            // clone here so the renderer's per-fragment path keeps all
            // sides + corners. Author-set `box-decoration-break: slice` is
            // overridden (rare in practice — the painted look in Chrome
            // wins per the project's fidelity rule).
            if (_hasBlockDescendant) {
              captured.styles.boxDecorationBreak = 'clone';
            }
          }
        }
      }
};
