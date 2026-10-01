/** Blink HanKerning's character and adjacent-pair decision (rev 7d859f271c). */
import { getEastAsianWidth } from "unicode-properties";
import type { FontInstance } from "./font-instance.js";
import { icuCodepointProperties } from "./icu-helper.js";
import { glyphInkXRange, haltInfoFor } from "./shaping-route.js";

export type HanCharType = "other" | "open" | "close" | "middle" | "open-narrow" | "close-narrow";
type InkGlyph = Parameters<typeof glyphInkXRange>[0] & { id: number; advanceWidth?: number };

/** `CharTypeFromBounds` in Blink's `han_kerning.cc:55-80`. */
export function hanCharTypeFromBounds(advance: number, min: number, max: number): HanCharType {
  const half = advance / 2;
  if (max <= half) return "close";
  if (min >= half) return "open";
  if (max - min <= half && min >= half / 2) return "middle";
  return "other";
}

function glyphType(font: FontInstance, cp: number): { type: HanCharType; advance: number } {
  const layout = font.layout(String.fromCodePoint(cp));
  if (layout.glyphs.length !== 1 || layout.positions.length !== 1 || layout.glyphs[0].id === 0) {
    return { type: "other", advance: 0 };
  }
  const glyph = layout.glyphs[0];
  const ink = glyphInkXRange(glyph);
  const advance = layout.positions[0].xAdvance;
  if (ink == null || advance <= 0) return { type: "other", advance };
  return {
    type: hanCharTypeFromBounds(advance, ink.min + layout.positions[0].xOffset, ink.max + layout.positions[0].xOffset),
    advance,
  };
}

function sameGroupType(font: FontInstance, codepoints: readonly number[]): HanCharType {
  const first = glyphType(font, codepoints[0]);
  if (first.advance <= 0) return "other";
  for (const cp of codepoints.slice(1)) {
    const next = glyphType(font, cp);
    if (next.advance !== first.advance || next.type !== first.type) return "other";
  }
  return first.type;
}

function baseType(cp: number): HanCharType | "dot" | "colon" | "semicolon" | "open-quote" | "close-quote" {
  if (cp === 0x2018 || cp === 0x201c) return "open-quote";
  if (cp === 0x2019 || cp === 0x201d) return "close-quote";
  if (cp === 0x3000 || cp === 0x00b7 || cp === 0x2027 || cp === 0x30fb) return "middle";
  if (cp === 0x3001 || cp === 0x3002 || cp === 0xff0c || cp === 0xff0e) return "dot";
  if (cp === 0xff1a) return "colon";
  if (cp === 0xff1b) return "semicolon";
  const row = icuCodepointProperties(cp);
  const ch = String.fromCodePoint(cp);
  const open = row != null ? row.generalCategory === 20 : /\p{Ps}/u.test(ch);
  const close = row != null ? row.generalCategory === 21 : /\p{Pe}/u.test(ch);
  if (!open && !close) return "other";
  const cjkSymbols = cp >= 0x3000 && cp <= 0x303f;
  const fullwidth = row != null ? row.eastAsianWidth === 3 : getEastAsianWidth(cp) === "F";
  if (cjkSymbols || fullwidth) return open ? "open" : "close";
  if (!cjkSymbols && !fullwidth) return open ? "open-narrow" : "close-narrow";
  return "other";
}

const fontTypes = new WeakMap<FontInstance, Map<number, HanCharType>>();

/** `HanKerning::GetCharType` with selected-face dot, colon, and quote types. */
export function hanCharType(font: FontInstance, cp: number): HanCharType {
  let cache = fontTypes.get(font);
  if (cache?.has(cp)) return cache.get(cp)!;
  const base = baseType(cp);
  let type: HanCharType;
  switch (base) {
    case "dot":
      type = sameGroupType(font, [0x3001, 0x3002, 0xff0c, 0xff0e]);
      break;
    case "colon":
    case "semicolon":
      type = glyphType(font, cp).type;
      break;
    case "open-quote":
    case "close-quote": {
      const open = sameGroupType(font, [0x201c, 0x2018]);
      const close = sameGroupType(font, [0x201d, 0x2019]);
      const fullwidth = open === "open" && close === "close";
      type = base === "open-quote" ? (fullwidth ? "open" : "open-narrow") : fullwidth ? "close" : "close-narrow";
      break;
    }
    default:
      type = base;
  }
  if (cache == null) {
    cache = new Map();
    fontTypes.set(font, cache);
  }
  cache.set(cp, type);
  return type;
}

/** `HanKerning::ShouldKern` and `ShouldKernLast`, including their precedence. */
export function hanShouldTrimAt(font: FontInstance, text: string, index: number, textSpacingTrim = "normal"): boolean {
  if (textSpacingTrim === "space-all") return false;
  const cp = text.codePointAt(index);
  if (cp == null) return false;
  const type = hanCharType(font, cp);
  const prev = index > 0 ? text.codePointAt(index - 1) : undefined;
  const nextIndex = index + (cp > 0xffff ? 2 : 1);
  const next = nextIndex < text.length ? text.codePointAt(nextIndex) : undefined;
  if (type === "close" && next != null) {
    // `ShouldKernLast`: a close is trimmed before another close, middle,
    // or narrow close. Blink's separate line-break-end request is not inferred
    // from the end of a captured text segment.
    const nextType = hanCharType(font, next);
    if (nextType === "close" || nextType === "middle" || nextType === "close-narrow") return true;
  }
  if (type !== "open") return false;
  if (prev == null) return textSpacingTrim === "trim-start";
  const previousType = hanCharType(font, prev);
  return (
    previousType === "open" || previousType === "middle" || previousType === "close" || previousType === "open-narrow"
  );
}

/** Offset of the `halt` form Blink selects for this source character. */
export function hanTrimInkShift(
  font: FontInstance,
  fontKey: string,
  glyph: InkGlyph,
  text: string,
  index: number,
  textSpacingTrim = "normal",
): number {
  const cp = text.codePointAt(index);
  if (cp == null || glyph.id === 0 || !hanShouldTrimAt(font, text, index, textSpacingTrim)) return 0;
  const halt = haltInfoFor(font, fontKey, cp);
  return halt.halved ? halt.xOffset : 0;
}
