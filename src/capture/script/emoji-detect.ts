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
    0x2713, 0x2714, 0x2716, 0x2717, 0x2728, 0x2753, 0x2754, 0x2755, 0x2757,
    0x274C, 0x274E, 0x2795, 0x2796, 0x2797, 0x27A1, 0x27B0, 0x27BF,
  ]);
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
  ]);

  const needsRaster = (cp, nextCp) => {
    if (rasterCps.has(cp)) return true;
    if (emojiPresentation26.has(cp)) return true;
    // U+FE0F (Variation Selector-16) after a base emoji codepoint requests
    // emoji presentation — Chrome paints the colorful glyph instead of the
    // text-mode path glyph. DM-278.
    if (nextCp === 0xFE0F && (emojiBaseCps.has(cp) || emojiPresentation26.has(cp))) return true;
    // Regional-indicator flags (pairs are joined into country flag emoji).
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;
    // Main emoji blocks: Misc Symbols & Pictographs, Emoticons, Transport &
    // Map, Alchemical, Supplemental Symbols & Pictographs, Pictographs
    // Extended-A, Symbols & Pictographs Extended-B.
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
    return false;
  };

  const textNeedsRaster = (s) => {
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i);
      const step = cp > 0xFFFF ? 2 : 1;
      const nextCp = i + step < s.length ? s.codePointAt(i + step) : 0;
      if (needsRaster(cp, nextCp)) return true;
      if (cp > 0xFFFF) i++;
    }
    return false;
  };

  return { needsRaster, textNeedsRaster };
};
