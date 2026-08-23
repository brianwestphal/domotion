import {
  GRAPHEME_EXTEND_RANGES,
  MIXED_VERTICAL_UPRIGHT_RANGES,
} from "./capture/script/vertical-orientation.generated.js";

export type VerticalGlyphOrientation = "upright" | "rotated";

export interface VerticalOrientationRun {
  /** UTF-16 offsets, matching Blink's `OrientationIterator::Consume`. */
  start: number;
  end: number;
  orientation: VerticalGlyphOrientation;
}

function rangeContains(ranges: readonly (readonly number[])[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Blink `Character::IsUprightInMixedVertical` at Chromium 7d859f271c:
 * ICU U/Tu/Tr stay upright and only `U_VO_ROTATED` rotates. */
export function isMixedVerticalUpright(cp: number | undefined): boolean {
  return cp != null && rangeContains(MIXED_VERTICAL_UPRIGHT_RANGES, cp);
}

/** Blink `Character::IsGraphemeExtended` at Chromium 7d859f271c. */
export function isBlinkGraphemeExtend(cp: number): boolean {
  return rangeContains(GRAPHEME_EXTEND_RANGES, cp);
}

function blinkCodePointAt(text: string, offset: number): { cp: number; length: 1 | 2 } {
  const first = text.charCodeAt(offset);
  if (first >= 0xd800 && first <= 0xdbff && offset + 1 < text.length) {
    const second = text.charCodeAt(offset + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { cp: ((first - 0xd800) << 10) + second - 0xdc00 + 0x10000, length: 2 };
    }
  }
  // UTF16TextIterator substitutes U+FFFD for either kind of unpaired
  // surrogate before asking ICU for its properties.
  if (first >= 0xd800 && first <= 0xdfff) return { cp: 0xfffd, length: 1 };
  return { cp: first, length: 1 };
}

/**
 * Blink `OrientationIterator` transcribed from
 * `platform/fonts/orientation_iterator.cc` at Chromium 7d859f271c.
 *
 * In mixed text the first scalar chooses an orientation. A later scalar may
 * change it only when that scalar is not `Grapheme_Extend`; marks and
 * variation selectors therefore stay with their base. Upright/sideways are
 * single-orientation routes and never consult the Unicode tables.
 */
export function blinkVerticalOrientationRuns(
  text: string,
  textOrientation: string | undefined,
): VerticalOrientationRun[] {
  if (text === "") return [];
  if (textOrientation === "upright") {
    return [{ start: 0, end: text.length, orientation: "upright" }];
  }
  if (textOrientation === "sideways") {
    return [{ start: 0, end: text.length, orientation: "rotated" }];
  }

  const runs: VerticalOrientationRun[] = [];
  let current: VerticalGlyphOrientation | undefined;
  let runStart = 0;
  for (let offset = 0; offset < text.length;) {
    const { cp, length } = blinkCodePointAt(text, offset);
    const next = current == null || !isBlinkGraphemeExtend(cp)
      ? (isMixedVerticalUpright(cp) ? "upright" : "rotated")
      : current;
    if (current != null && next !== current) {
      runs.push({ start: runStart, end: offset, orientation: current });
      runStart = offset;
    }
    current = next;
    offset += length;
  }
  runs.push({ start: runStart, end: text.length, orientation: current! });
  return runs;
}

/** One orientation entry per UTF-16 code unit, matching captured text arrays. */
export function resolveVerticalOrientations(
  text: string,
  textOrientation: string | undefined,
): VerticalGlyphOrientation[] {
  const result = new Array<VerticalGlyphOrientation>(text.length);
  for (const run of blinkVerticalOrientationRuns(text, textOrientation)) {
    result.fill(run.orientation, run.start, run.end);
  }
  return result;
}

/** Compatibility helper for owners that classify a one-scalar record. */
export function resolveCharOrientation(
  text: string,
  textOrientation: string | undefined,
): VerticalGlyphOrientation {
  return resolveVerticalOrientations(text, textOrientation)[0] ?? "rotated";
}

/**
 * Blink `LayoutTextCombine::IsSupportedMode`: text combine is owned only by
 * vertical typographic modes. `sideways-*` are horizontal typographic modes,
 * so an authored `all` declaration remains ordinary sideways text there.
 */
export function blinkUsesTextCombine(
  writingMode: string | undefined,
  textCombine: string | undefined,
): boolean {
  return textCombine === "all"
    && (writingMode === "vertical-rl" || writingMode === "vertical-lr");
}
