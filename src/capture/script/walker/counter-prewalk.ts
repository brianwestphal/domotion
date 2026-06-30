// @ts-nocheck
//
// DM-770: the `@counter-style` pre-walk — collects every `@counter-style` rule
// definition from `document.styleSheets` into the shared counter-style map that
// `createCounterStyleResolver` (counter-style-resolver.ts) reads. Chrome doesn't
// expose the resolved marker string via `getComputedStyle(li, '::marker')
// .content` (it returns "normal" even for a custom symbol), so we re-implement
// the resolution against the captured rule map; this pre-walk is the capture
// half that fills it.
//
// Extracted verbatim from the index.ts orchestrator (DM-1086) so the parser +
// walker live next to the resolver that consumes their output. Bundled into the
// page-context capture script via the index.ts orchestrator; runs in-page, so it
// uses page globals (document, window.CSSCounterStyleRule) and closes over
// nothing but the passed-in `counterStyles` map.

export const createCounterStylePrewalk = ({ counterStyles }) => {
  function _parseStringList(s) {
    // CSS string list — sequence of "double-quoted" strings (CSS escapes any
    // quote char). Whitespace-separated. Returns array of unescaped strings.
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      const q = s[i];
      if (q !== '"' && q !== "'") {
        // Unquoted identifier (used by symbol shortcuts in some browsers).
        let j = i;
        while (j < s.length && !/\s/.test(s[j])) j++;
        out.push(s.slice(i, j));
        i = j;
        continue;
      }
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\' && j + 1 < s.length) {
          // CSS escape: \HHHHHH (hex) or \char.
          const hex = /^\\([0-9a-fA-F]{1,6})\s?/.exec(s.slice(j));
          if (hex != null) {
            val += String.fromCodePoint(parseInt(hex[1], 16));
            j += hex[0].length;
            continue;
          }
          val += s[j + 1];
          j += 2;
        } else {
          val += s[j];
          j++;
        }
      }
      out.push(val);
      i = j + 1;
    }
    return out;
  }
  function _parseAdditiveSymbols(s) {
    // `additive-symbols: 10 "X", 9 "IX", 5 "V", ...`
    // Comma-separated weight + symbol pairs. Returns array sorted by weight
    // descending (largest first — required by the additive algorithm).
    const out = [];
    for (const tok of s.split(',')) {
      const m = /(-?\d+)\s+(.+)/.exec(tok.trim());
      if (m == null) continue;
      const weight = parseInt(m[1], 10);
      const sym = _parseStringList(m[2])[0] ?? '';
      out.push({ weight, sym });
    }
    out.sort((a, b) => b.weight - a.weight);
    return out;
  }
  function _walkRulesForCounterStyles(rules) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      // CSSCounterStyleRule.type === 11. Also covered by `instanceof
      // CSSCounterStyleRule` in modern browsers — both forms work.
      if (rule.type === 11 || (window.CSSCounterStyleRule != null && rule instanceof window.CSSCounterStyleRule)) {
        const name = rule.name;
        if (!name) continue;
        let extendsName;
        let sys = rule.system || 'symbolic';
        // `system: extends upper-roman` → sys == "extends upper-roman".
        const extMatch = /^extends\s+(\S+)/.exec(sys);
        if (extMatch) {
          extendsName = extMatch[1];
          sys = 'extends';
        } else {
          // `system: cyclic`, `system: fixed [N]`, etc. Strip the keyword.
          const sysMatch = /^(cyclic|numeric|alphabetic|symbolic|fixed|additive)\b/.exec(sys);
          sys = sysMatch ? sysMatch[1] : 'symbolic';
        }
        const symbols = rule.symbols ? _parseStringList(rule.symbols) : [];
        const additiveSymbols = rule.additiveSymbols ? _parseAdditiveSymbols(rule.additiveSymbols) : [];
        const prefix = rule.prefix ? (_parseStringList(rule.prefix)[0] ?? '') : '';
        // Default suffix is ". " for most systems per the CSS spec; Chrome
        // returns the empty string when no `suffix` descriptor is set. Treat
        // empty as default.
        const suffix = rule.suffix ? (_parseStringList(rule.suffix)[0] ?? '. ') : '. ';
        const negativeRaw = rule.negative;
        let negPrefix = '-';
        let negSuffix = '';
        if (negativeRaw) {
          const nlist = _parseStringList(negativeRaw);
          negPrefix = nlist[0] ?? '-';
          if (nlist.length > 1) negSuffix = nlist[1];
        }
        let padLen = 0;
        let padSym = '';
        if (rule.pad) {
          const pm = /^\s*(\d+)\s+(.+)$/.exec(rule.pad);
          if (pm != null) {
            padLen = parseInt(pm[1], 10);
            padSym = _parseStringList(pm[2])[0] ?? '';
          }
        }
        let rangeLo = -Infinity;
        let rangeHi = Infinity;
        if (rule.range && rule.range !== 'auto') {
          // "infinite infinite" or "1 39" or "-3 5" etc.
          const rm = /(-?\d+|infinite)\s+(-?\d+|infinite)/.exec(rule.range);
          if (rm != null) {
            rangeLo = rm[1] === 'infinite' ? -Infinity : parseInt(rm[1], 10);
            rangeHi = rm[2] === 'infinite' ? Infinity : parseInt(rm[2], 10);
          }
        }
        const fallback = rule.fallback || 'decimal';
        counterStyles[name] = { system: sys, symbols, additiveSymbols, prefix, suffix, negPrefix, negSuffix, padLen, padSym, rangeLo, rangeHi, fallback, extendsName };
      } else if (rule.cssRules) {
        // @media / @supports / @layer — walk nested rule lists.
        _walkRulesForCounterStyles(rule.cssRules);
      }
    }
  }
  // Run the sweep over every stylesheet (CORS-protected sheets throw on
  // `.cssRules` access — skip them silently). DM-1443: accepts an optional
  // `doc` so the same pre-walk can collect `@counter-style` rules from a
  // recursed same-origin iframe's own stylesheets, not just the top document.
  return (doc) => {
    const _doc = doc || document;
    for (const sheet of Array.from(_doc.styleSheets)) {
      try {
        _walkRulesForCounterStyles(sheet.cssRules);
      } catch (e) {
        // CORS-protected stylesheet — skip.
      }
    }
  };
};
