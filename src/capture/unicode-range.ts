// The CSS `@font-face` `unicode-range` descriptor parser, shared by the
// Node-side capture code and the bundled CAPTURE_SCRIPT (it has no imports and
// touches no Node or DOM API, so the capture-script bundle can inline it).
//
// Transcribed from Blink (Chromium checkout 7d859f27, 2026-06-27):
//
//  - Tokenizer: `CSSTokenizer::LetterU` + `CSSTokenizer::ConsumeUnicodeRange`
//    (`third_party/blink/renderer/core/css/parser/css_tokenizer.cc:117-123`,
//    `:437-468`). A `u`/`U` followed by `+` and a hex digit or `?` starts a
//    unicode-range token. Up to six hex digits are consumed, then either `?`
//    wildcards filling the remaining digit budget (each shifts start and end
//    one hex digit, end with `F`) or a `-` followed by one to six hex digits.
//    Input beyond that budget is NOT part of the token: `u+12345678` is the
//    token `U+123456` followed by a number token.
//  - Descriptor: `ConsumeFontFaceUnicodeRange`
//    (`third_party/blink/renderer/core/css/parser/at_rule_descriptor_parser.cc:63-82`)
//    takes a comma-separated list of exactly those tokens, rejecting the whole
//    descriptor when any entry is not one (an empty entry included) or has
//    `start > end || end > 0x10FFFF`; `ParseFontFaceDescriptor` (`:427`) also
//    rejects it when anything is left after the list.
//
// A rejected descriptor is dropped by the CSS parser, so the face keeps the
// initial value U+0-10FFFF. This parser therefore returns `undefined` both for
// an absent value and for an invalid one, and callers treat `undefined` as the
// default full coverage.

/** One inclusive `[start, end]` codepoint interval. */
export type UnicodeRangeInterval = [number, number];

const HEX_DIGIT = /^[0-9a-fA-F]$/;

/** Trim CSS whitespace only (space, tab, LF, CR, FF), not every Unicode space. */
function trimCssWhitespace(s: string): string {
  return s.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");
}

/**
 * Consume one unicode-range token from the start of `entry` (Blink's
 * `ConsumeUnicodeRange`). Returns the interval and the number of characters
 * consumed, or `null` when `entry` does not begin with a unicode-range token.
 */
function consumeUnicodeRangeToken(entry: string): { range: UnicodeRangeInterval; length: number } | null {
  if ((entry[0] !== "u" && entry[0] !== "U") || entry[1] !== "+") return null;
  const first = entry[2];
  if (first == null || (!HEX_DIGIT.test(first) && first !== "?")) return null;
  let i = 2;
  let lengthRemaining = 6;
  let start = 0;
  while (lengthRemaining > 0 && i < entry.length && HEX_DIGIT.test(entry[i])) {
    start = start * 16 + parseInt(entry[i], 16);
    i++;
    lengthRemaining--;
  }
  let end = start;
  if (lengthRemaining > 0 && entry[i] === "?") {
    do {
      start *= 16;
      end = end * 16 + 0xf;
      i++;
      lengthRemaining--;
    } while (lengthRemaining > 0 && entry[i] === "?");
  } else if (entry[i] === "-" && i + 1 < entry.length && HEX_DIGIT.test(entry[i + 1])) {
    i++;
    lengthRemaining = 6;
    end = 0;
    do {
      end = end * 16 + parseInt(entry[i], 16);
      i++;
      lengthRemaining--;
    } while (lengthRemaining > 0 && i < entry.length && HEX_DIGIT.test(entry[i]));
  }
  return { range: [start, end], length: i };
}

/**
 * Parse a CSS `unicode-range` descriptor value into inclusive intervals, or
 * `undefined` when the value is empty or invalid (see the module comment for
 * the Blink rules this follows).
 */
export function parseUnicodeRangeDescriptor(value: string): UnicodeRangeInterval[] | undefined {
  // CSS comments are not tokens; strip them the way the tokenizer skips them.
  const v = trimCssWhitespace(value.replace(/\/\*[\s\S]*?\*\//g, " "));
  if (v === "") return undefined;
  const out: UnicodeRangeInterval[] = [];
  for (const raw of v.split(",")) {
    const entry = trimCssWhitespace(raw);
    const token = consumeUnicodeRangeToken(entry);
    // Anything after the token (another token, a stray digit or `?`, an
    // identifier) leaves the stream short of a comma or the end: invalid.
    if (token == null || token.length !== entry.length) return undefined;
    const [start, end] = token.range;
    if (start > end || end > 0x10ffff) return undefined;
    out.push(token.range);
  }
  return out;
}

/** True when `cp` falls inside any interval of `ranges`. */
export function unicodeRangeIntervalsCover(ranges: readonly UnicodeRangeInterval[], cp: number): boolean {
  return ranges.some(([start, end]) => cp >= start && cp <= end);
}
