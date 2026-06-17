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
// Detection: render `mark` and `"◌"+mark` to a canvas with the element's font.
// When Chrome auto-inserts the circle for the bare mark, the two renderings are
// the SAME cluster (◌+mark), so their ink matches in both pixel COUNT and WIDTH.
// A spacing mark (own advance) that does NOT get a circle renders narrower bare
// than combined, so the width check excludes it. Validated 43/43 against CDP
// `getPlatformFontsForNode` glyph counts on the 1CD0-1CFF Vedic fixture.
//
// Pre-filter `cp >= 0x0900`: scopes the probe to the Indic / Brahmic / SE-Asian
// complex-shaper blocks where this matters. Latin / Cyrillic / Hebrew / Arabic
// combining marks (all < 0x0900) are intentionally out of scope — they keep the
// existing behavior, holding the blast radius tight. The caller additionally
// gates on the mark being ORPHANED (no base in its cluster).

export const createDottedCircleDetect = () => {
  let _cv = null;
  let _ctx = null;
  const _cache = new Map();

  // Fixed 32px probe (independent of the element's font size): whether Chrome
  // circles a mark is a property of the (mark, font) pair, not the size, and a
  // fixed size keeps the pixel-count / width thresholds stable.
  const inkStats = (s, font) => {
    if (_ctx == null) {
      _cv = document.createElement('canvas');
      _cv.width = 96;
      _cv.height = 64;
      _ctx = _cv.getContext('2d', { willReadFrequently: true });
    }
    _ctx.clearRect(0, 0, 96, 64);
    _ctx.fillStyle = '#000';
    _ctx.textBaseline = 'middle';
    _ctx.font = '32px ' + font;
    _ctx.fillText(s, 40, 32);
    const data = _ctx.getImageData(0, 0, 96, 64).data;
    let cnt = 0, minx = 1e9, maxx = -1;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        if (data[(y * 96 + x) * 4 + 3] > 20) {
          cnt++;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
        }
      }
    }
    return { cnt, w: cnt > 0 ? (maxx - minx + 1) : 0 };
  };

  // Does Chrome auto-insert a U+25CC before this lone mark/cluster-letter in
  // `font`? Probes category M (combining marks) AND category Lo (some Brahmic
  // cluster-initial LETTERS — e.g. Soyombo U+11A84 — that the Universal Shaping
  // Engine also circles when orphaned). The ink heuristic below is the real gate
  // (a normal letter renders WITHOUT a circle, so bare ≠ comb → false), so
  // including Lo only widens what's probed, never forces a false positive.
  const markGetsDottedCircle = (cp, ch, font) => {
    if (cp < 0x0900) return false;
    if (font == null || font === '') return false;
    if (!/\p{M}|\p{Lo}/u.test(ch)) return false;
    const key = cp + '|' + font;
    const hit = _cache.get(key);
    if (hit !== undefined) return hit;
    let res = false;
    try {
      const bare = inkStats(ch, font);
      const comb = inkStats('◌' + ch, font);
      // Auto-inserted ⟺ the bare-mark render ALREADY contains the circle, so
      // bare ≈ comb in count and width. Spacing marks make `comb` markedly
      // wider (the explicit ◌ adds its advance) → excluded by the width ratio.
      const ratio = comb.cnt > 0 ? bare.cnt / comb.cnt : 0;
      res = bare.cnt > 20 && ratio > 0.9 && comb.w <= bare.w * 1.25;
    } catch (e) {
      res = false;
    }
    _cache.set(key, res);
    return res;
  };

  return { markGetsDottedCircle };
};
