// @ts-nocheck
//
// DM-770 / DM-788: resolves a custom @counter-style name + 1-based index to
// the marker symbol string per the CSS Counter Styles algorithms (cyclic,
// fixed, numeric, alphabetic, symbolic, additive) plus prefix / suffix /
// pad / negative / range / fallback / extends descriptors.
//
// Used by:
//   - lists-counters.ts to resolve `list-style-type: <custom-name>` markers
//     on <li> elements (DM-770)
//   - pseudo-content.ts to resolve `counter(name, custom-style)` /
//     `counters(name, sep, custom-style)` inside `::before` / `::after`
//     `content` declarations (DM-788)
//
// The counter-style rule map is populated by `_walkRulesForCounterStyles` in
// the orchestrator pre-walk (`src/capture/script/index.ts`); both walkers
// close over the same object reference so a single sweep of styleSheets is
// shared across the capture.
//
// Bundled into the page-context capture script via the index.ts orchestrator;
// no runtime imports of its own.

export const createCounterStyleResolver = ({ counterStyles }) => {
  // Built-in counter-style names whose algorithm the render side already
  // covers inside `formatListMarker`. When an `extends` / `fallback` chain
  // bottoms out at one of these, return the formatted symbol so the caller
  // can stamp it directly without recursing through this resolver.
  const BUILTINS = new Set([
    'decimal', 'decimal-leading-zero',
    'lower-alpha', 'lower-latin', 'upper-alpha', 'upper-latin',
    'lower-roman', 'upper-roman',
    'lower-greek',
    'disc', 'circle', 'square', 'none',
  ]);

  // Marker-context resolution (used by list-item ::marker). Returns the full
  // string with prefix + pad + value + suffix wrapping per the CSS spec.
  const resolveCounterStyle = (name, n) => _resolve(name, n, 0, true);
  // Counter-function-context resolution (used by `counter()` / `counters()`
  // inside `content`). Per Chrome's paint, the function returns only the
  // pad-formatted value: prefix / suffix are NOT included. Matches DM-788
  // empirical probe.
  const resolveCounterValue = (name, n) => _resolve(name, n, 0, false);
  const isCustomCounterStyle = (name) => counterStyles[name] != null;

  const _resolve = (name, n, depth, wrap) => {
    if (depth > 16) return null; // fallback / extends loop guard
    if (BUILTINS.has(name)) return _formatBuiltin(name, n);
    const def = counterStyles[name];
    if (def == null) return _formatBuiltin('decimal', n);
    if (def.system === 'extends' && def.extendsName != null) {
      const childSym = _resolve(def.extendsName, n, depth + 1, wrap);
      if (childSym == null) return null;
      const padded = _applyPad(childSym, def.padLen, def.padSym);
      return wrap ? (def.prefix + padded + def.suffix) : padded;
    }
    if (n < def.rangeLo || n > def.rangeHi) {
      // CSS Counter Styles §2: the fallback generates only the VALUE
      // representation — the ORIGINAL style's prefix/suffix still wrap it.
      // (Recursing with `wrap` dropped the custom suffix entirely for builtin
      // fallbacks — the fixed-system list's "11"/"12" markers lost their " "
      // suffix and painted flush against the content.)
      const fb = _resolve(def.fallback ?? 'decimal', n, depth + 1, false);
      if (fb == null) return null;
      return wrap ? (def.prefix + fb + def.suffix) : fb;
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
        if (def.symbols.length === 0 || abs <= 0) break;
        const base = def.symbols.length;
        let v = abs;
        let s = '';
        while (v > 0) { v--; s = def.symbols[v % base] + s; v = Math.floor(v / base); }
        core = s;
        break;
      }
      case 'symbolic': {
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
          core = v === 0 ? s : null;
        }
        break;
      }
    }
    if (core == null) {
      // Same fallback rule as the range check above: value only, original affixes.
      const fb = _resolve(def.fallback ?? 'decimal', n, depth + 1, false);
      if (fb == null) return null;
      return wrap ? (def.prefix + fb + def.suffix) : fb;
    }
    const padded = _applyPad(core, def.padLen, def.padSym);
    const sign = negative ? def.negPrefix : '';
    const signTail = negative ? def.negSuffix : '';
    return wrap
      ? (def.prefix + sign + padded + signTail + def.suffix)
      : (sign + padded + signTail);
  };

  const _applyPad = (s, len, sym) => {
    if (!len || !sym) return s;
    while ([...s].length < len) s = sym + s;
    return s;
  };

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

  return { resolveCounterStyle, resolveCounterValue, isCustomCounterStyle };
};
