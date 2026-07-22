// @ts-nocheck
//
// Codepoint predicate for glyphs Chrome paints via a color-bitmap font
// (Apple Color Emoji on macOS, Noto Color Emoji on Linux) even when a
// path-font has a glyph. fontkit cannot emit a <path> from CBDT/sbix bitmap
// tables, so these need to be rasterized via page.screenshot and embedded
// as <image>. See SK-1058.
//
// Narrow scope on purpose: the Miscellaneous-Symbols / Geometric-Shapes /
// Arrows blocks have path glyphs in Apple Symbols that render faithfully
// (e.g. ⚑ U+2691, → U+2192), so they stay on the path pipeline. The lists
// below are codepoints we've observed Chrome routing to the emoji font
// despite path availability (checkmark family), plus the canonical emoji
// planes (U+1F300+).

export const createEmojiDetect = () => {
  // Codepoints in U+2700-27BF (Dingbats) that Chrome paints via Apple Color
  // Emoji rather than the monochrome Zapf Dingbats / Apple Symbols glyph —
  // confirmed empirically per DM-269 (✨ rendered as color emoji, not the
  // Zapf glyph). Default emoji-presentation per Unicode emoji-data: ✨ ❌ ❎
  // ❓ ❔ ❕ ❗ ➕ ➖ ➗ ➡ ➰ ➿ etc. Without explicit variation selectors,
  // Chrome picks color presentation for these. The rasterGlyph system stamps
  // the captured PNG over the path-mode glyph so this list lets the screen-
  // shotter pick them up.
  const rasterCps = new Set([
    0x2728, 0x2753, 0x2754, 0x2755, 0x2757,
    0x274C, 0x274E, 0x2795, 0x2796, 0x2797, 0x27A1, 0x27B0, 0x27BF,
    // Dingbats with default emoji presentation (Emoji_Presentation=Yes per
    // Unicode emoji-data) that NO macOS text symbol font covers, so Chrome
    // always routes them to Apple Color Emoji. Bare (no VS-16), they were
    // painting as a dropped/empty path-mode glyph: ✅ ✊ ✋. Unconditional like
    // the ✨ ❌ ➡ family above — emoji presentation wins over the cascade.
    0x2705, 0x270A, 0x270B,
  ]);
  // DM-1165: the Miscellaneous Symbols and Arrows (U+2B??) code points with
  // default emoji presentation — ⬅⬆⬇ (2B05-07), ⬛⬜ (2B1B/1C), ⭐ (2B50),
  // ⭕ (2B55). DM-728 added these to `rasterCps` unconditionally for the ⭐ in
  // `20-deep-font-palette.html`, but Chrome's choice is actually CASCADE-
  // DEPENDENT: when the element's font stack reaches a monochrome symbol/math
  // font that covers them first, Chrome paints text, not color. Verified via
  // `CSS.getPlatformFontsForNode` on the 2B00 fixture (cells lead with "Apple
  // Symbols"): 2B05→Apple Symbols, 2B1B & 2B50→STIX Two Math — all MONOCHROME,
  // so the unconditional raster was stamping blue emoji / a yellow star over
  // Chrome's black arrows / hollow star. Probe per-element via `isColorGlyph`
  // in `needsRaster` instead (color → raster, monochrome → path). A Set so the
  // membership test in `needsRaster` is O(1).
  const emojiPresentation2B = new Set([
    0x2B05, 0x2B06, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55,
  ]);
  // Checks/crosses ✓✔✖✗ (2713/2714/2716/2717) — CASCADE-DEPENDENT like the
  // 2B?? family above, NOT unconditional raster (where they previously
  // lived). They are text-presentation by default (2714/2716 are Emoji=Yes
  // with Emoji_Presentation=No; 2713/2717 aren't emoji at all), and CDP
  // CSS.getPlatformFontsForNode shows Chrome painting TEXT glyphs (Lucida
  // Grande / Zapf Dingbats) on 02-text-symbols' generic-family rows — the
  // unconditional raster stamped the Apple Color Emoji bitmap over Chrome's
  // bold Zapf check. But the per-Unicode-block fixture cells, whose stacks
  // cascade to the color font, DO paint the emoji. Probe per element.
  const checksCrossesCps = new Set([0x2713, 0x2714, 0x2716, 0x2717]);
  // Codepoints in the U+2600-26FF Misc Symbols block with EmojiPresentation=Yes
  // per Unicode emoji-data: Chrome paints these as color emoji by default
  // (without needing the U+FE0F variation selector). Source: unicode.org
  // emoji-data v15.1. DM-278.
  const emojiPresentation26 = new Set([
    0x2614, 0x2615, 0x2648, 0x2649, 0x264A, 0x264B, 0x264C, 0x264D,
    0x264E, 0x264F, 0x2650, 0x2651, 0x2652, 0x2653, 0x267F, 0x2693,
    0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BE, 0x26C4, 0x26C5, 0x26CE,
    0x26D4, 0x26EA, 0x26F2, 0x26F3, 0x26F5, 0x26FA, 0x26FD,
  ]);
  // Codepoints in U+2600-26FF that are Emoji=Yes but default to text
  // presentation. Authors typically pair these with U+FE0F (the emoji
  // variation selector) to force the color emoji glyph. The FE0F-aware
  // detection in textNeedsRaster catches that pairing; for cases where the
  // codepoint appears bare (no VS), text presentation is correct and we
  // still path-render.
  const emojiBaseCps = new Set([
    0x2600, 0x2601, 0x2602, 0x2603, 0x2604, 0x260E, 0x2611, 0x2618,
    0x261D, 0x2620, 0x2622, 0x2623, 0x2626, 0x262A, 0x262E, 0x262F,
    0x2638, 0x2639, 0x263A, 0x2640, 0x2642, 0x265F, 0x2660, 0x2663,
    0x2665, 0x2666, 0x2668, 0x267B, 0x267E, 0x2692, 0x2694, 0x2695,
    0x2696, 0x2697, 0x2699, 0x269B, 0x269C, 0x26A0, 0x26A7, 0x26B0,
    0x26B1, 0x26C8, 0x26CF, 0x26D1, 0x26D3, 0x26E9, 0x26F0, 0x26F1,
    0x26F4, 0x26F7, 0x26F8, 0x26F9,
    // DM-728: Dingbats block (U+27??) codepoints with text-default
    // presentation that flip to color emoji when paired with U+FE0F. The
    // fixture's ❤️ (U+2764 + U+FE0F) heart was painting as a small black
    // monochrome glyph before this entry was added; with it, the VS-16
    // pairing routes through the raster overlay path so Apple Color Emoji
    // paints the red heart Chrome shows.
    0x2702, 0x2708, 0x2709, 0x270C, 0x270D, 0x270F, 0x2712, 0x2716,
    0x271D, 0x2721, 0x2733, 0x2734, 0x2744, 0x2747, 0x2763, 0x2764,
  ]);

  // DM-1025: the BMP "default emoji presentation" symbols above (zodiac signs,
  // ☔ ☕ ⚡ ⛪ ⛲ …) only paint as COLOR emoji when the element's font cascade
  // actually reaches the color-emoji font. When the author lists a text symbol
  // font that covers the codepoint FIRST — e.g. the html-test cells use
  // `"Apple Symbols", … , "Apple Color Emoji", …` and Chrome resolves the
  // zodiac signs to Apple Symbols (verified via CSS.getPlatformFontsForNode) —
  // Chrome paints the MONOCHROME text glyph, and rastering a color emoji over
  // it is wrong. Probe Chrome's actual choice the same way Chrome makes it:
  // render the codepoint to a canvas with the element's font (canvas uses the
  // identical font cascade + rasterizer as the page) and check whether any
  // pixel came out colored. Apple/Noto Color Emoji ignore the black fillStyle
  // and stamp their colored bitmap; a text glyph stays black/gray. Cached per
  // (codepoint, font) — the ambiguous symbols are rare.
  let _colorCanvas = null;
  let _colorCtx = null;
  const _colorCache = new Map();
  const isColorGlyph = (cp, font) => {
    // No font context (e.g. the pseudo-content path) → preserve the prior
    // unconditional behavior: assume the default-presentation emoji renders in
    // color.
    if (font == null || font === '') return true;
    const key = cp + '|' + font;
    const hit = _colorCache.get(key);
    if (hit !== undefined) return hit;
    if (_colorCtx == null) {
      _colorCanvas = document.createElement('canvas');
      _colorCanvas.width = 48;
      _colorCanvas.height = 48;
      _colorCtx = _colorCanvas.getContext('2d', { willReadFrequently: true });
    }
    let colored = true; // fail safe: if the probe can't run, keep rastering
    try {
      _colorCtx.clearRect(0, 0, 48, 48);
      _colorCtx.fillStyle = '#000';
      _colorCtx.textBaseline = 'top';
      _colorCtx.font = '32px ' + font;
      _colorCtx.fillText(String.fromCodePoint(cp), 8, 4);
      const data = _colorCtx.getImageData(0, 0, 48, 48).data;
      colored = false;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue; // transparent
        if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 24) {
          colored = true;
          break;
        }
      }
    } catch (e) { /* keep colored = true */ }
    _colorCache.set(key, colored);
    return colored;
  };

  // DM-1706: some Apple Color Emoji glyphs are GRAY (✔️ ✖️ heavy check /
  // multiply), so the chromatic-pixel probe above reads them as "not color"
  // even when Chrome IS painting the emoji. Discriminate by the defining
  // property of color-font glyphs instead: they IGNORE the canvas fill color.
  // Render the cp twice (black vs red fill) — a text glyph's pixels change, a
  // color-emoji bitmap's don't.
  const _fillCache = new Map();
  const ignoresFillColor = (cp, font) => {
    if (font == null || font === '') return true;
    const key = cp + '|' + font;
    const hit = _fillCache.get(key);
    if (hit !== undefined) return hit;
    let ignores = true; // fail safe: keep rastering when the probe can't run
    try {
      if (_colorCtx == null) {
        _colorCanvas = document.createElement('canvas');
        _colorCanvas.width = 48;
        _colorCanvas.height = 48;
        _colorCtx = _colorCanvas.getContext('2d', { willReadFrequently: true });
      }
      const draw = (fill) => {
        _colorCtx.clearRect(0, 0, 48, 48);
        _colorCtx.fillStyle = fill;
        _colorCtx.textBaseline = 'top';
        _colorCtx.font = '32px ' + font;
        _colorCtx.fillText(String.fromCodePoint(cp), 8, 4);
        return _colorCtx.getImageData(0, 0, 48, 48).data;
      };
      const a = draw('#000');
      const b = new Uint8ClampedArray(a); // copy — getImageData reuses buffers in some engines
      b.set(a);
      const c = draw('#f00');
      let ink = false, differs = false;
      for (let i = 0; i < b.length; i += 4) {
        if (b[i + 3] >= 8 || c[i + 3] >= 8) ink = true;
        if (Math.abs(b[i] - c[i]) > 16 || Math.abs(b[i + 1] - c[i + 1]) > 16) { differs = true; break; }
      }
      ignores = ink && !differs;
    } catch (e) { /* keep ignores = true */ }
    _fillCache.set(key, ignores);
    return ignores;
  };

  const needsRaster = (cp, nextCp, font) => {
    // `rasterCps` (the ✨ ❌ ➡ checkmark/star family) are codepoints Chrome
    // routes to the COLOR emoji font even when a text font in the cascade has
    // a monochrome glyph — emoji presentation wins regardless of the author's
    // font, so they stay unconditional. (Gating them on the canvas probe
    // regressed 2700-dingbats: the probe picks Zapf's mono glyph, but Chrome's
    // page still paints the color emoji.)
    if (rasterCps.has(cp)) return true;
    // DM-1025: the U+2600-26FF "emojiPresentation26" symbols (zodiac signs,
    // ☔ etc.) are different — Chrome paints the MONOCHROME text glyph when the
    // author lists a text symbol font that covers them first (the html-test
    // cells lead with "Apple Symbols"; CSS.getPlatformFontsForNode confirms
    // Chrome resolves those cells to Apple Symbols, not Apple Color Emoji).
    // Probe Chrome's actual choice per element font via the canvas (color →
    // raster, monochrome → path) instead of unconditionally rastering a color
    // emoji over Chrome's text glyph.
    if (emojiPresentation26.has(cp)) return isColorGlyph(cp, font);
    // U+FE0F (Variation Selector-16) after a base emoji codepoint requests
    // emoji presentation — Chrome paints the colorful glyph instead of the
    // text-mode path glyph. DM-278.
    if (nextCp === 0xFE0F && (emojiBaseCps.has(cp) || emojiPresentation26.has(cp))) return true;
    // Bare (no VS-16) text-default emoji base codepoints — Chrome paints the
    // COLOR glyph only when its font cascade actually reaches the color-emoji
    // font (e.g. the html-test cells lead the family with "Apple Color Emoji"
    // when no text font covers the codepoint), and the MONOCHROME text glyph
    // otherwise. Probe Chrome's actual choice via the canvas (same rule as the
    // emojiPresentation26 branch above) instead of unconditionally path- OR
    // raster-rendering. Catches bare ✌ (U+270C) / ✒ (U+2712) the FE0F-only
    // gate dropped, while leaving cascade-monochrome ✈ (U+2708) on the path.
    // Checks/crosses ✓✔✖✗ — cascade-dependent (see checksCrossesCps above),
    // probed via FILL-COLOR INVARIANCE: Apple's ✔️ ✖️ emojis are GRAY, so the
    // chromatic isColorGlyph probe reads them as text even when Chrome paints
    // the emoji. Must precede the emojiBaseCps branch (0x2716 is in that set
    // and its chromatic probe would intercept with the wrong answer).
    if (checksCrossesCps.has(cp)) return ignoresFillColor(cp, font);
    if (emojiBaseCps.has(cp)) return isColorGlyph(cp, font);
    // Regional-indicator flags (pairs are joined into country flag emoji).
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;
    // Enclosed Alphanumeric Supplement (U+1F100-1F1FF) squared-letter emoji
    // with default emoji presentation (Emoji_Presentation=Yes): 🆎 and 🆑–🆚
    // (CL / COOL / FREE / ID / NEW / NG / OK / SOS / UP! / VS). They sit BELOW
    // the 0x1F300 floor of the main-block check below, so they were dropped to
    // an empty path-mode glyph; no text font carries them, so Chrome always
    // paints the color emoji (unconditional, like the ✨ family).
    if (cp === 0x1F18E || (cp >= 0x1F191 && cp <= 0x1F19A)) return true;
    // DM-1110: Enclosed Ideographic Supplement (U+1F200-1F2FF) squared / circled
    // CJK emoji that Chrome paints via Apple Color Emoji: 🈁 U+1F201, 🈂 U+1F202,
    // 🈚 U+1F21A, 🈯 U+1F22F, 🈲–🈺 U+1F232-1F23A, 🉐 U+1F250, 🉑 U+1F251. Like the
    // 1F100 squared letters above, they sit BELOW the 0x1F300 floor of the main-
    // block check below, so they were dropped to an empty path-mode glyph. The
    // set is unconditional: it's the Emoji_Presentation=Yes codepoints of the
    // block (color wins over the cascade) PLUS the three text-default ones
    // (1F201 / 1F202 / 1F237) which no macOS text font covers, so Chrome routes
    // them to the color font too. The canvas `isColorGlyph` probe can't gate
    // these — for SMP squared-CJK codepoints canvas font fallback diverges from
    // page layout and reports monochrome even where the page paints color — so
    // this is verified directly against Chrome's painted output for the 1F200
    // fixture (every one of the 15 cells classified COLOR by a per-cell pixel-
    // saturation scan). 1F232-1F23A is contiguous once 1F237 is folded in.
    if (cp === 0x1F201 || cp === 0x1F202 || cp === 0x1F21A || cp === 0x1F22F
        || (cp >= 0x1F232 && cp <= 0x1F23A) || cp === 0x1F250 || cp === 0x1F251) return true;
    // DM-1125: the Alchemical Symbols block (U+1F700-1F77F) sits inside the
    // main-block range below, but Chrome paints its 116 covered codepoints as
    // MONOCHROME Apple Symbols path glyphs — not color emoji — when the
    // element's cascade reaches Apple Symbols (the html-test cells lead with
    // "Apple Symbols"; CSS.getPlatformFontsForNode confirms it). Unconditionally
    // rastering them stamped a color-bitmap overlay sized to the font CONTENT
    // box (ascent+descent ≈ 29px at 32px), which CLIPPED the tall apparatus
    // glyphs (retort/alembic U+1F76F/U+1F770 etc.) whose ink overflows that box
    // — Chrome paints the full ink, the raster cropped it. Probe Chrome's actual
    // choice per element font via the canvas (color → raster, monochrome → path)
    // exactly like the DM-1025 emojiPresentation26 branch, so the rare cell whose
    // cascade DOES reach the color font still rasters correctly.
    if (cp >= 0x1F700 && cp <= 0x1F77F) return isColorGlyph(cp, font);
    // DM-1168: the two Emoji_Presentation=Yes code points in the Enclosed CJK
    // Letters and Months block (U+3200-32FF) — ㊗ U+3297 CIRCLED IDEOGRAPH
    // CONGRATULATION and ㊙ U+3299 CIRCLED IDEOGRAPH SECRET. Chrome paints them
    // as Apple Color Emoji by default (the fixture cells show the red circled
    // ideographs). But several macOS text fonts (Hiragino, Arial Unicode) also
    // cover them with a MONOCHROME glyph, so a `lang=ja` cascade that reaches
    // Hiragino first paints text, not color. Probe Chrome's actual per-element
    // choice via the canvas (color → raster, monochrome → path), exactly like
    // the DM-1025 emojiPresentation26 / DM-1125 alchemical branches.
    if (cp === 0x3297 || cp === 0x3299) return isColorGlyph(cp, font);
    // DM-1173: 〽 U+303D PART ALTERNATION MARK (CJK Symbols and Punctuation,
    // U+3000-303F). Emoji=Yes but text-default presentation, so Chrome paints
    // the color glyph only when the cascade reaches Apple Color Emoji and no
    // text font covers it first (many do — Hiragino, M+ 1p, Shippori Mincho).
    // The fixture cell paints the orange color mark, so probe per-element font
    // (color → raster, monochrome → path) like the branches above.
    if (cp === 0x303D) return isColorGlyph(cp, font);
    // DM-1165: the U+2B?? emoji-presentation symbols (arrows ⬅⬆⬇, squares ⬛⬜,
    // ⭐, ⭕). Cascade-dependent — Chrome paints text when the stack reaches a
    // monochrome symbol/math font first (Apple Symbols / STIX Two Math), color
    // otherwise. See `emojiPresentation2B` above.
    if (emojiPresentation2B.has(cp)) return isColorGlyph(cp, font);
    // DM-1167: the ONLY two codepoints in the Misc Symbols & Pictographs block
    // (U+1F300-1F5FF) that a macOS text font also covers monochrome are
    // 🌐 U+1F310 (GLOBE WITH MERIDIANS) and 🎤 U+1F3A4 (MICROPHONE) — Apple
    // Symbols carries both. When the element's cascade leads with Apple Symbols
    // (the html-test `.f1` cells do; CSS.getPlatformFontsForNode confirms),
    // Chrome paints the MONOCHROME path glyph, not the color emoji. Probe
    // Chrome's actual per-element choice (color → raster, monochrome → path)
    // exactly like the DM-1125 Alchemical / DM-1168 ㊗㊙ branches, instead of
    // unconditionally stamping the Apple Color Emoji bitmap over Chrome's text
    // glyph. The common Apple-Color-Emoji-first cell still rasters (probe → true).
    if (cp === 0x1F310 || cp === 0x1F3A4) return isColorGlyph(cp, font);
    // Main emoji blocks: Misc Symbols & Pictographs, Emoticons, Transport &
    // Map, Alchemical, Supplemental Symbols & Pictographs, Pictographs
    // Extended-A, Symbols & Pictographs Extended-B.
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
    return false;
  };

  const textNeedsRaster = (s, font) => {
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i);
      const step = cp > 0xFFFF ? 2 : 1;
      const nextCp = i + step < s.length ? s.codePointAt(i + step) : 0;
      if (needsRaster(cp, nextCp, font)) return true;
      if (cp > 0xFFFF) i++;
    }
    return false;
  };

  return { needsRaster, textNeedsRaster };
};
