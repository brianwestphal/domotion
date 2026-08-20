// @ts-nocheck
//
// Blink does not classify emoji paint one codepoint at a time. SymbolsIterator
// feeds ICU-derived categories through the pinned emoji-segmenter grammar and
// assigns one of four presentation priorities to each whole token. Keep this
// capture-side port structural: it only identifies candidate spans. The Node
// side resolves the declared family cascade and inspects the selected glyph;
// no codepoint, block, platform, or font name decides raster ownership here.

const RE_EMOJI = /\p{Emoji}/u;
const RE_EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const RE_EMOJI_MODIFIER_BASE = /\p{Emoji_Modifier_Base}/u;
const RE_EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const RE_REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

export const emojiCategory = (cp) => {
  const ch = String.fromCodePoint(cp);
  if (cp <= 0x7F) return cp === 0x23 || cp === 0x2A || (cp >= 0x30 && cp <= 0x39) ? "keycap" : "other";
  if (cp === 0x20E3) return "keycap-mark";
  if (cp === 0x20E0) return "circle-backslash";
  if (cp === 0x200D) return "zwj";
  if (cp === 0xFE0E) return "vs15";
  if (cp === 0xFE0F) return "vs16";
  if (cp === 0x1F3F4) return "tag-base";
  if (cp >= 0xE0020 && cp <= 0xE007E) return "tag-sequence";
  if (cp === 0xE007F) return "tag-term";
  if (RE_EMOJI_MODIFIER_BASE.test(ch)) return "modifier-base";
  if (RE_EMOJI_MODIFIER.test(ch)) return "modifier";
  if (RE_REGIONAL_INDICATOR.test(ch)) return "regional-indicator";
  if (RE_EMOJI_PRESENTATION.test(ch)) return "emoji-default";
  if (RE_EMOJI.test(ch)) return "text-default";
  return "other";
};

const isAnyEmoji = (cat) => cat === "text-default" || cat === "emoji-default"
  || cat === "keycap" || cat === "modifier-base" || cat === "tag-base";

/** Port of emoji_presentation_scanner.rl at Chromium's pinned submodule. */
export const scanEmojiPresentation = (text, classify = emojiCategory) => {
  const units = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    units.push({ start: i, end: i + ch.length, cat: classify(cp) });
    i += ch.length;
  }
  const spans = [];
  const push = (startUnit, endUnit, presentation, hasVs) => spans.push({
    start: units[startUnit].start,
    end: units[endUnit - 1].end,
    presentation,
    hasVs,
  });
  const elementEnd = (at) => {
    if (at >= units.length || !isAnyEmoji(units[at].cat)) return at;
    if (at + 1 < units.length && units[at + 1].cat === "vs16") return at + 2;
    if (units[at].cat === "modifier-base" && at + 1 < units.length && units[at + 1].cat === "modifier") return at + 2;
    return at + 1;
  };
  let i = 0;
  while (i < units.length) {
    const c = units[i].cat;
    // VS15 tokens are ordered first in the Ragel scanner.
    if (isAnyEmoji(c) && i + 1 < units.length && units[i + 1].cat === "vs15") {
      let end = i + 2;
      if (c === "keycap" && end < units.length && units[end].cat === "keycap-mark") end++;
      push(i, end, "text", true); i = end; continue;
    }
    let end = 0;
    let hasVs = false;
    if (isAnyEmoji(c) && i + 1 < units.length && units[i + 1].cat === "vs16") {
      end = i + 2; hasVs = true;
      if (c === "keycap" && end < units.length && units[end].cat === "keycap-mark") end++;
    } else if (c === "modifier-base" && i + 1 < units.length && units[i + 1].cat === "modifier") {
      end = i + 2;
    } else if (c === "regional-indicator" && i + 1 < units.length && units[i + 1].cat === "regional-indicator") {
      end = i + 2;
    } else if (c === "tag-base") {
      let j = i + 1;
      while (j < units.length && units[j].cat === "tag-sequence") j++;
      if (j > i + 1 && j < units.length && units[j].cat === "tag-term") end = j + 1;
      else end = i + 1; // TAG_BASE alone has emoji presentation.
    } else if (isAnyEmoji(c) && i + 1 < units.length && units[i + 1].cat === "circle-backslash") {
      end = i + 2;
    } else if (c === "emoji-default" || c === "tag-base" || c === "modifier-base") {
      end = i + 1;
    }
    // A valid ZWJ sequence consumes whole emoji_zwj_element tokens.
    const firstElementEnd = elementEnd(i);
    if (firstElementEnd > i) {
      let j = firstElementEnd;
      let joined = false;
      while (j + 1 < units.length && units[j].cat === "zwj") {
        const nextEnd = elementEnd(j + 1);
        if (nextEnd === j + 1) break;
        joined = true;
        j = nextEnd;
      }
      if (joined) { end = j; hasVs = false; }
    }
    if (end > i) { push(i, end, "emoji", hasVs); i = end; continue; }
    i++;
  }
  return spans;
};

export const createEmojiDetect = () => {
  const rasterCandidates = (text, fontVariantEmoji = "normal") => {
    const spans = scanEmojiPresentation(text);
    if (fontVariantEmoji != null && fontVariantEmoji !== "normal" && fontVariantEmoji !== "unicode") {
    // Explicit selector tokens keep their source priority. For unselected
    // Emoji-property scalars, Blink's CSS property changes glyph lookup mode;
    // retain whole scanner tokens and add singleton candidates where needed.
    const covered = new Set();
    for (const span of spans) for (let i = span.start; i < span.end; i++) covered.add(i);
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const next = i + ch.length < text.length ? text.codePointAt(i + ch.length) : 0;
      if (!covered.has(i) && RE_EMOJI.test(ch) && next !== 0xFE0E && next !== 0xFE0F) {
        spans.push({ start: i, end: i + ch.length, presentation: fontVariantEmoji, hasVs: false });
      } else if (fontVariantEmoji === "text") {
        const span = spans.find((s) => s.start === i);
        if (span != null && !span.hasVs) span.presentation = "text";
      }
      i += ch.length;
    }
    }
    // Raster capability is not restricted to Emoji-property text: arbitrary
    // author fonts can put a symbol in COLR/CBDT/sbix/SVG. Return every
    // grapheme as a temporary candidate and let selectedGlyphRasterSpans prune
    // it after the real family/fallback walk. The scanner metadata remains on
    // matching tokens for priority tests and diagnostics.
    const byStart = new Map(spans.map((span) => [span.start, span]));
    const candidates = [];
    const segmenter = typeof Intl !== "undefined" && Intl.Segmenter != null
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
    if (segmenter != null) {
      for (const part of segmenter.segment(text)) {
        if (/^\s+$/u.test(part.segment)) continue;
        const source = byStart.get(part.index);
        candidates.push(source ?? { start: part.index, end: part.index + part.segment.length, presentation: "text", hasVs: false });
      }
    } else {
      for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        if (!/^\s+$/u.test(ch)) candidates.push(byStart.get(i) ?? { start: i, end: i + ch.length, presentation: "text", hasVs: false });
        i += ch.length;
      }
    }
    return candidates;
  };
  const textNeedsRaster = (text, _font = "", fontVariantEmoji = "normal") => {
    const spans = scanEmojiPresentation(text);
    if (fontVariantEmoji === "emoji") return spans.length > 0 || [...text].some((ch) => RE_EMOJI.test(ch));
    return spans.length > 0;
  };
  return { rasterCandidates, textNeedsRaster };
};
