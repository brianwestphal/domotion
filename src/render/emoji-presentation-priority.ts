/**
 * Blink SymbolsIterator source-priority ranges (Chromium 7d859f27).
 *
 * The scanner owns source boundaries only. CSS font-variant-emoji is applied
 * afterward and must never erase or merge those boundaries; RunSegmenter
 * intersects them independently with script/orientation ranges.
 */
import { scanEmojiPresentation } from "../capture/script/emoji-detect.js";
import type { FontVariantEmojiOverride } from "./font-resolution.js";
import { ICU_BINARY, icuCodepointProperties } from "./icu-helper.js";

type EmojiCategory = ReturnType<NonNullable<Parameters<typeof scanEmojiPresentation>[1]>>;

export type SourceFallbackPriority = "text" | "emoji" | "text-vs" | "emoji-vs";

export interface SourcePriorityItem {
  /** UTF-16 code-unit index, inclusive. */
  start: number;
  /** UTF-16 code-unit index, exclusive. */
  end: number;
  text: string;
  priority: SourceFallbackPriority;
}

/** Chromium-pinned ICU input for the renderer-side emoji scanner. */
function pinnedEmojiCategory(cp: number): EmojiCategory {
  if (cp <= 0x7f) return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39) ? "keycap" : "other";
  if (cp === 0x20e3) return "keycap-mark";
  if (cp === 0x20e0) return "circle-backslash";
  if (cp === 0x200d) return "zwj";
  if (cp === 0xfe0e) return "vs15";
  if (cp === 0xfe0f) return "vs16";
  if (cp === 0x1f3f4) return "tag-base";
  if (cp >= 0xe0020 && cp <= 0xe007e) return "tag-sequence";
  if (cp === 0xe007f) return "tag-term";
  // Character::IsRegionalIndicator is a literal range, independent of ICU.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "regional-indicator";

  const row = icuCodepointProperties(cp);
  if (row == null) {
    // Helper-absent mode is intentionally best effort and non-fatal.
    const ch = String.fromCodePoint(cp);
    if (/\p{Emoji_Modifier_Base}/u.test(ch)) return "modifier-base";
    if (/\p{Emoji_Modifier}/u.test(ch)) return "modifier";
    if (/\p{Regional_Indicator}/u.test(ch)) return "regional-indicator";
    if (/\p{Emoji_Presentation}/u.test(ch)) return "emoji-default";
    return /\p{Emoji}/u.test(ch) ? "text-default" : "other";
  }

  const bits = row.binaryProperties;
  if ((bits & ICU_BINARY.EMOJI_MODIFIER_BASE) !== 0) return "modifier-base";
  if ((bits & ICU_BINARY.V2) !== 0 && (bits & ICU_BINARY.EMOJI_MODIFIER) !== 0) return "modifier";
  if ((bits & ICU_BINARY.V2) === 0 && /\p{Emoji_Modifier}/u.test(String.fromCodePoint(cp))) return "modifier";
  if ((bits & ICU_BINARY.EMOJI_PRESENTATION) !== 0) return "emoji-default";
  if ((bits & ICU_BINARY.EMOJI) !== 0) return "text-default";
  // U_UNASSIGNED is 0; Blink admits only reserved Extended_Pictographic here.
  if (row.generalCategory === 0 && (bits & ICU_BINARY.EXTENDED_PICTOGRAPHIC) !== 0) return "text-default";
  return "other";
}

/**
 * Maximal source-priority items, mirroring SymbolsIterator::Consume
 * (symbols_iterator.cc:23-76). Ordinary gaps are kText, and adjacent equal
 * source states coalesce before any CSS override is considered.
 */
export function sourcePriorityItems(text: string): SourcePriorityItem[] {
  if (text.length === 0) return [];
  const tokens = scanEmojiPresentation(text, pinnedEmojiCategory)
    .map((span) => ({
      ...span,
      priority: span.hasVs
        ? (span.presentation === "emoji" ? "emoji-vs" : "text-vs")
        : (span.presentation === "emoji" ? "emoji" : "text"),
    }))
    .sort((a, b) => a.start - b.start);
  const raw: Array<{ start: number; end: number; priority: SourceFallbackPriority }> = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) raw.push({ start: cursor, end: token.start, priority: "text" });
    raw.push({ start: token.start, end: token.end, priority: token.priority });
    cursor = Math.max(cursor, token.end);
  }
  if (cursor < text.length) raw.push({ start: cursor, end: text.length, priority: "text" });

  const merged: typeof raw = [];
  for (const item of raw) {
    const previous = merged[merged.length - 1];
    if (previous != null && previous.end === item.start && previous.priority === item.priority) {
      previous.end = item.end;
    } else {
      merged.push({ ...item });
    }
  }
  return merged.map((item) => ({ ...item, text: text.slice(item.start, item.end) }));
}

/**
 * ApplyFontVariantEmojiOnFallbackPriority (harfbuzz_shaper.cc:184-198).
 * Explicit selector priorities win. CSS changes the effective priority of a
 * complete source item, not whichever hint happens to be dequeued first.
 */
export function applyFontVariantEmojiToPriority(
  source: SourceFallbackPriority,
  fontVariantEmoji: FontVariantEmojiOverride | undefined,
): SourceFallbackPriority {
  if (source === "text-vs" || source === "emoji-vs") return source;
  if (fontVariantEmoji === "emoji") return "emoji";
  if (fontVariantEmoji === "text") return "text";
  return source;
}
