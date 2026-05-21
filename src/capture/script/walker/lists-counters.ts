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

export const createListsCountersHandler = ({ normColor, counterStyles }) => {
  // DM-770: built-in counter-style names whose algorithm we already cover
  // inside `formatListMarker` on the render side. When `extends` chains
  // resolve down to one of these, we hand off to the renderer's existing
  // marker pipeline instead of attempting to expand here.
  const BUILTINS = new Set([
    'decimal', 'decimal-leading-zero',
    'lower-alpha', 'lower-latin', 'upper-alpha', 'upper-latin',
    'lower-roman', 'upper-roman',
    'lower-greek',
    'disc', 'circle', 'square', 'none',
  ]);

  // Resolve a custom counter-style name + index to its marker symbol string.
  // Returns null when the resolution should fall back to the renderer's
  // built-in marker (i.e. the name is a built-in already, or every step of
  // the resolution failed and the fallback ran out at a built-in).
  const resolveCounterStyle = (name, n) => {
    return _resolve(name, n, 0);
  };
  const _resolve = (name, n, depth) => {
    if (depth > 16) return null; // fallback / extends loop guard
    if (BUILTINS.has(name)) return _formatBuiltin(name, n);
    const def = counterStyles[name];
    if (def == null) return _formatBuiltin('decimal', n);
    // `extends`: inherit all descriptors from the parent and override with
    // anything explicitly set on this rule. Resolve transitively.
    if (def.system === 'extends' && def.extendsName != null) {
      const childSym = _resolve(def.extendsName, n, depth + 1);
      if (childSym == null) return null;
      // Strip the parent's suffix from childSym (`_resolve` returns the
      // unrounded symbol; built-ins add their own). For now we ignore
      // childSym's prefix/suffix and just wrap the parent's symbol portion
      // with the child's prefix / suffix.
      const symPortion = (function () {
        // Built-ins return just the symbol (no prefix/suffix wrapping). For
        // a chained custom `extends`, _resolve already applied wrapping —
        // accept it as-is.
        return childSym;
      }());
      const padded = _applyPad(symPortion, def.padLen, def.padSym);
      return def.prefix + padded + def.suffix;
    }
    // Out-of-range → fallback.
    if (n < def.rangeLo || n > def.rangeHi) {
      const fb = _resolve(def.fallback ?? 'decimal', n, depth + 1);
      return fb;
    }
    const negative = n < 0;
    const abs = Math.abs(n);
    let core = null;
    switch (def.system) {
      case 'cyclic':
        if (def.symbols.length === 0) break;
        core = def.symbols[((abs - 1) % def.symbols.length + def.symbols.length) % def.symbols.length];
        break;
      case 'fixed': {
        // Spec: first-symbol-value defaults to 1; fixed system uses each
        // symbol once for first-symbol-value..first-symbol-value+symbols-1.
        const idx0 = abs - 1;
        if (idx0 >= 0 && idx0 < def.symbols.length) core = def.symbols[idx0];
        break;
      }
      case 'numeric': {
        if (def.symbols.length < 2) break;
        if (abs === 0) { core = def.symbols[0]; break; }
        const base = def.symbols.length;
        let v = abs;
        let s = '';
        while (v > 0) { s = def.symbols[v % base] + s; v = Math.floor(v / base); }
        core = s;
        break;
      }
      case 'alphabetic': {
        // Bijective base-N: digits 1..N. Each "digit" uses symbols[d-1].
        if (def.symbols.length === 0 || abs <= 0) break;
        const base = def.symbols.length;
        let v = abs;
        let s = '';
        while (v > 0) { v--; s = def.symbols[v % base] + s; v = Math.floor(v / base); }
        core = s;
        break;
      }
      case 'symbolic': {
        // Doubles symbols when exhausted: ceil(n/N) copies of symbols[(n-1) % N].
        if (def.symbols.length === 0 || abs <= 0) break;
        const base = def.symbols.length;
        const copies = Math.ceil(abs / base);
        const sym = def.symbols[(abs - 1) % base];
        core = sym.repeat(copies);
        break;
      }
      case 'additive': {
        if (def.additiveSymbols.length === 0) break;
        if (abs === 0) {
          // Spec: additive can only represent 0 if a 0-weight symbol is present.
          const zero = def.additiveSymbols.find((s) => s.weight === 0);
          core = zero ? zero.sym : null;
        } else {
          let v = abs;
          let s = '';
          for (const { weight, sym } of def.additiveSymbols) {
            if (weight <= 0) continue;
            const count = Math.floor(v / weight);
            for (let i = 0; i < count; i++) s += sym;
            v -= count * weight;
          }
          // If we couldn't reduce to zero, the value isn't representable.
          core = v === 0 ? s : null;
        }
        break;
      }
    }
    if (core == null) {
      // System didn't produce a symbol (out of fixed range, additive not
      // representable, etc.). Fall back.
      return _resolve(def.fallback ?? 'decimal', n, depth + 1);
    }
    const padded = _applyPad(core, def.padLen, def.padSym);
    const sign = negative ? def.negPrefix : '';
    const signTail = negative ? def.negSuffix : '';
    return def.prefix + sign + padded + signTail + def.suffix;
  };
  const _applyPad = (s, len, sym) => {
    if (!len || !sym) return s;
    // Pad uses _grapheme count_ in spec; we approximate with code-unit length
    // since the fixture uses single-char pad symbols.
    while ([...s].length < len) s = sym + s;
    return s;
  };
  // Minimal subset of formatListMarker mirrored from the renderer side, used
  // when a custom counter-style's `fallback` or `extends` chain bottoms out
  // at a built-in name.
  const _formatBuiltin = (type, n) => {
    switch (type) {
      case 'decimal': return String(n);
      case 'decimal-leading-zero': return n < 10 && n >= 0 ? '0' + n : String(n);
      case 'lower-alpha':
      case 'lower-latin':
        return _alphaMarker(n, false);
      case 'upper-alpha':
      case 'upper-latin':
        return _alphaMarker(n, true);
      case 'lower-roman': return _romanMarker(n).toLowerCase();
      case 'upper-roman': return _romanMarker(n);
      case 'lower-greek': return _greekMarker(n);
      case 'disc':
      case 'circle':
      case 'square':
      case 'none':
        // Shape / none markers aren't representable as a single symbol
        // string; signal to the caller to use the built-in renderer path.
        return null;
      default: return String(n);
    }
  };
  const _alphaMarker = (n, upper) => {
    if (n <= 0) return String(n);
    const base = upper ? 65 : 97;
    let s = '';
    let v = n;
    while (v > 0) { v--; s = String.fromCharCode(base + (v % 26)) + s; v = Math.floor(v / 26); }
    return s;
  };
  const _greekMarker = (n) => {
    if (n <= 0) return String(n);
    const greek = 'αβγδεζηθικλμνξοπρστυφχψω';
    let s = '';
    let v = n;
    while (v > 0) { v--; s = greek.charAt(v % 24) + s; v = Math.floor(v / 24); }
    return s;
  };
  const _romanMarker = (n) => {
    if (n <= 0 || n >= 4000) return String(n);
    const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
    let s = '';
    let v = n;
    for (let i = 0; i < vals.length; i++) {
      while (v >= vals[i]) { s += syms[i]; v -= vals[i]; }
    }
    return s;
  };

  const captureListsCounters = (el, cs, tag) => {
    // CSS treats any element with display:list-item as a list item — the tag
    // alone isn't enough. An <li> with display:inline-block (e.g. a horizontal
    // social-icon strip) does NOT paint a marker per spec. Conversely a <div>
    // or <span> with `display: list-item` DOES paint one and contributes to
    // the implicit counter.
    const isListItem = cs.display != null && cs.display.includes('list-item');

    let listMarkerIntrinsic = undefined;
    let listItemIndex = undefined;

    if (isListItem) {
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
    if (isListItem && counterStyles != null && listItemIndex != null) {
      const lsType = cs.listStyleType;
      const isCustom = lsType != null && counterStyles[lsType] != null;
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
    };
  };

  return { captureListsCounters };
};
