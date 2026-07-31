// @ts-nocheck
//
// DM-1126: detect, at CAPTURE time (in Chrome, with the real shaper), whether
// Chrome inserts a U+25CC DOTTED CIRCLE base before an orphaned combining mark.
//
// Chrome's HarfBuzz/CoreText shaping inserts a dotted circle before SOME orphaned
// complex-shaper marks but not others, and the decision is NOT a Unicode property
// (canonical-combining-class / general-category do not split the set) — it's the
// shaper's per-mark choice, and it even picks different fonts per mark. The
// renderer (Node + fontkit) cannot replicate it: fontkit's `layout(lone mark)`
// emits just the bare mark for BOTH circle and no-circle cells. So the ONLY
// reliable gate is Chrome itself.
//
// DM-1851: the probe asks DOM LAYOUT, not canvas.
//
// It used to rasterise `mark` and `"◌"+mark` to a 2D canvas and compare ink. That
// measured canvas correctly and answered the wrong question: canvas 2D text and
// DOM layout do not shape an uncovered mark the same way. For a mark NO font in
// the cascade covers, canvas draws ◌+tofu while DOM draws a bare tofu — so the
// probe reported "Chrome auto-inserts a circle here" for exactly the cells where
// Chrome paints none, and the renderer duly synthesised a circle that Chrome does
// not paint. Reproduced at 12 regions / 0.41% on the Devanagari-Extended fixture,
// and confirmed against CDP `CSS.getPlatformFontsForNode`, which reports a single
// `.notdef` for those codepoints.
//
// The comparison itself was sound; only its oracle was wrong. So the same
// bare-vs-combined test now runs against a laid-out DOM element, which is the
// thing actually being captured.
//
// Measured against Chrome's own paint (CDP glyph counts) over 104 mark codepoints
// strided across all 36 complex-shaper ranges:
//
//     canvas (before)                101/104
//     DOM (this)                     102/104
//     canvas + resolver-coverage     102/104
//
// The third of those was the considered alternative — keep the canvas probe and
// suppress its verdict when our own resolver says nothing covers the codepoint.
// It scores identically. DOM was chosen because it removes the oracle mismatch at
// the source rather than patching one of its consequences, and because it keeps
// this capture-time decision independent of a render-side coverage predicate
// being correct. The two residual misses (U+0951, U+1B6B — Chrome circles, no
// oracle detects it) are shared by all three and are not addressed here.
//
// Pre-filter `cp >= 0x0900`: scopes the probe to the Indic / Brahmic / SE-Asian
// complex-shaper blocks where this matters. Latin / Cyrillic / Hebrew / Arabic
// combining marks (all < 0x0900) are intentionally out of scope — they keep the
// existing behavior, holding the blast radius tight. The caller additionally
// gates on the mark being ORPHANED (no base in its cluster).

export const createDottedCircleDetect = () => {
  const _cache = new Map();

  // Measure in a span that is attached ONLY for the duration of the measurement.
  //
  // The canvas this replaced was a DETACHED element — it never touched the page.
  // A DOM measurement has to be laid out, so it must be attached, and that makes
  // it a mutation of the very document being captured. Leaving it in place (even
  // hidden) leaves live text in the tree and an extra box in the layout, which is
  // the one structural difference between this probe and the canvas one that
  // could affect anything other than the verdict.
  //
  // So: attach, measure, detach — synchronously, within one call, so the document
  // is never observably different from the outside. `visibility:hidden` rather
  // than `display:none` because a display:none element is not laid out and
  // reports zero width; the negative offset keeps it out of the flow while it is
  // briefly present.
  const measureWidth = (s, font) => {
    const el = document.createElement('span');
    el.style.cssText =
      'position:absolute;left:-99999px;top:-99999px;visibility:hidden;'
      + 'white-space:pre;pointer-events:none;margin:0;padding:0;border:0;';
    // Fixed 32px probe (independent of the element's font size): whether Chrome
    // circles a mark is a property of the (mark, font) pair, not the size.
    el.style.font = '32px ' + font;
    el.textContent = s;
    document.body.appendChild(el);
    try {
      return el.getBoundingClientRect().width;
    } finally {
      el.remove();
    }
  };

  // Does Chrome auto-insert a U+25CC before this lone mark/cluster-letter in
  // `font`? Probes category M (combining marks), category Lo (some Brahmic
  // cluster-initial LETTERS — e.g. Soyombo U+11A84) AND category Lm (modifier
  // LETTERS the Universal Shaping Engine also circles when orphaned — e.g. Kirat
  // Rai U+16D6B/6C, length / vowel modifiers that paint "◌ □" when stranded).
  // The width heuristic below is the real gate (a normal letter lays out WITHOUT
  // a circle, so bare ≠ comb → false), so including Lo / Lm only widens what's
  // probed, never forces a false positive.
  const markGetsDottedCircle = (cp, ch, font) => {
    if (cp < 0x0900) return false;
    if (font == null || font === '') return false;
    if (!/\p{M}|\p{Lo}|\p{Lm}/u.test(ch)) return false;
    const key = cp + '|' + font;
    const hit = _cache.get(key);
    if (hit !== undefined) return hit;
    let res = false;
    try {
      const bare = measureWidth(ch, font);
      const comb = measureWidth('◌' + ch, font);
      // Auto-inserted ⟺ the bare mark ALREADY lays out as ◌+mark, so adding an
      // explicit ◌ changes nothing and the two widths agree. When Chrome paints
      // the mark alone — whether as a spacing mark with its own advance or as a
      // lone tofu for an uncovered codepoint — the explicit circle adds its
      // advance and `comb` is measurably wider.
      //
      // 5%: the two cases are far apart in practice (identical widths versus a
      // whole extra advance, typically +60% or more), so the threshold is not a
      // tuned constant — it only absorbs sub-pixel layout rounding.
      res = bare > 0 && comb > 0 && Math.abs(comb - bare) / comb < 0.05;
    } catch (e) {
      res = false;
    }
    _cache.set(key, res);
    return res;
  };

  return { markGetsDottedCircle };
};
