/**
 * Split a text run into the segments Chromium shapes separately.
 *
 * ## Why this exists
 *
 * We used to shape a whole run in one `layout()` call, splitting runs only when
 * the FONT changed. When one face covers several scripts, a mixed-script line
 * therefore stayed a single run, and the shaper picked one script and one
 * direction for all of it. Measured on a dual-script face:
 *
 *     layout("مرحبا")        → script arab, dir rtl, ids 6510,6514,6531,6542,6595
 *     layout("Hello مرحبا ") → script latn, dir ltr, arabic ids 6595,…,6510
 *
 * The contextual forms are right either way — joining is applied. What breaks is
 * ORDER: the mixed run hands the Arabic back in logical order under an LTR run,
 * and the caller lays glyphs out left-to-right, so the word paints mirrored and
 * its connecting strokes point away from their neighbours. At normal sizes that
 * reads as "isolated letterforms", which is how it was first misdiagnosed.
 *
 * Note this was LATENT on macOS rather than absent: there Arabic resolves to a
 * different face than Latin, so a font boundary existed and split the run for
 * the wrong reason with the right result. It surfaced on Windows only because
 * one face covers both.
 *
 * ## What Chromium does (`external/chromium`, rev 7d859f27)
 *
 * Two nested levels:
 *
 * 1. **Direction is per bidi run.** `HarfBuzzShaper::Shape(font, direction,
 *    start, end)` takes direction as a parameter
 *    (`platform/fonts/shaping/harfbuzz_shaper.cc:1145-1148`) and passes it
 *    straight to `hb_buffer_set_direction` (`:341`). The caller supplies it from
 *    the bidi paragraph — the shaper never infers it from content.
 *
 * 2. **Script is per segment within that.** `Shape` runs a `RunSegmenter` over
 *    the text and shapes each consumed range separately (`:1168-1177`).
 *    `RunSegmenter` combines `ScriptRunIterator`, `OrientationIterator` and
 *    `SymbolsIterator` (`shaping/run_segmenter.h:24-26`), so a segment is a
 *    maximal span of one script × one orientation × one fallback priority.
 *
 * We mirror both: split on a change of bidi embedding level OR of script.
 * Orientation is horizontal-only here (vertical text takes the raster path —
 * see the raster-fallback index), and font-fallback-priority is already handled
 * upstream by per-codepoint font resolution, which is what produces the runs fed
 * to this function.
 *
 * ## Common and Inherited
 *
 * A naive "split whenever the script property changes" would shred ordinary
 * text, because spaces, digits and most punctuation are `Common` and combining
 * marks are `Inherited`. Blink resolves those into the surrounding script via
 * script extensions and a merge-set walk (`script_run_iterator.cc:143`, `:263`).
 *
 * We get the same outcome from the same data: `getScript` here is
 * `unicode-properties`' — *the very table fontkit's own shaper consults* to pick
 * a script (see its `layout()`, which skips Common/Inherited/Unknown and takes
 * the first real script). So segmentation and shaping agree by construction
 * rather than by two tables being kept in sync, and the source is Unicode data
 * rather than a hand-listed range set.
 *
 * The one behaviour worth stating: a Common/Inherited character extends the
 * CURRENT segment, so an inter-script space attaches to the run before it, and
 * leading neutrals attach to the first real script that follows. That matches
 * the merge-set walk, which carries the resolved script forward until a
 * genuinely conflicting script appears.
 *
 * Not ported: Blink's paired-bracket tracking (`OpenBracket`/`CloseBracket`,
 * `script_run_iterator.cc:431-450`), which reuses an opening bracket's resolved
 * script for its match. Bracket mirroring for RTL is already handled upstream by
 * `applyBidi`, and a bracket that merely lands in a neighbouring segment shapes
 * identically in practice. Stated rather than left implicit, since it is a known
 * gap against the transcription.
 */
import bidiFactory from "bidi-js";
import { getScript } from "unicode-properties";

const _bidi = bidiFactory();

/** Cheap test for any strong-RTL or bidi-control character. */
const _RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿‏‫‮⁧]/;

/**
 * Per-code-unit bidi embedding levels for `text`, or `undefined` when the text
 * cannot contain a direction boundary.
 *
 * Returning `undefined` for the overwhelmingly common all-LTR case is what keeps
 * this off the hot path: bidi resolution is not free, and text with no RTL
 * character has a single level by definition.
 */
export function bidiLevelsFor(
  text: string,
  /**
   * The element's `direction` + `unicode-bidi`. Only the OVERRIDE values change
   * anything: CSS `unicode-bidi: bidi-override` / `isolate-override` is defined
   * as treating every character as strong in the embedding direction, i.e. as
   * suppressing the algorithm's inspection of the characters' own bidi types
   * (css-writing-modes-4 §2.2). Since this function derives levels by running
   * that very inspection, an override has to be applied here or it is lost.
   *
   * Concretely: `bidi-override; direction: ltr` around Hebrew or Arabic makes
   * Chrome lay the letters out left-to-right in logical order, while the
   * unmodified algorithm reports level 1 for them and the shaper reverses each
   * run. The letters come out backwards — a fully unreadable line that moves
   * the pixel diff by four hundredths of a percent, because the two words are
   * about the same width.
   */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
): Uint8Array | undefined {
  if (text === "") return undefined;
  const ub = bidiOverride?.unicodeBidi;
  if (ub === "bidi-override" || ub === "isolate-override") {
    // Uniform level: even for ltr, odd for rtl. Every character strong in the
    // embedding direction is exactly what a flat level array expresses, and it
    // reaches both consumers (`needsSegmentation`, which then sees no direction
    // boundary, and `segmentForShaping`'s per-segment `rtl` flag).
    const level = bidiOverride!.direction === "rtl" ? 1 : 0;
    return new Uint8Array(text.length).fill(level);
  }
  if (!_RTL_RE.test(text)) return undefined;
  try {
    return _bidi.getEmbeddingLevels(text, "ltr").levels;
  } catch {
    // Never fail a render over bidi analysis — without levels the segmenter
    // still splits by script, which is the larger half of the fix.
    return undefined;
  }
}

export interface ShapingSegment {
  /** Code-unit index into the run text, inclusive. */
  start: number;
  /** Code-unit index into the run text, exclusive. */
  end: number;
  /** Resolved script name, or "Common" for a run with no strong script. */
  script: string;
  /** Whether this segment shapes right-to-left (odd bidi embedding level). */
  rtl: boolean;
}

/** Scripts that carry no direction or script identity of their own. */
function isNeutralScript(script: string): boolean {
  return script === "Common" || script === "Inherited" || script === "Unknown";
}

/**
 * Segment `text` for shaping.
 *
 * `levels` is the per-code-unit bidi embedding level array (bidi-js'
 * `getEmbeddingLevels().levels`), optional: without it every segment is treated
 * as left-to-right, which is the correct degradation for text the caller already
 * knows is unidirectional.
 *
 * Always returns at least one segment for non-empty text, so callers can shape
 * unconditionally rather than special-casing.
 */
export function segmentForShaping(text: string, levels?: ArrayLike<number>): ShapingSegment[] {
  if (text.length === 0) return [];

  const segments: ShapingSegment[] = [];
  let segStart = 0;
  // The segment's resolved script — null while it has seen only neutrals, which
  // is how leading spaces attach to the first real script rather than forming a
  // segment of their own.
  let segScript: string | null = null;
  let segLevel = levels?.[0] ?? 0;

  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const level = levels?.[i] ?? 0;
    const script = getScript(cp);

    // A level change is a bidi-run boundary and always splits, even mid-script:
    // Blink shapes each bidi run with its own direction, so a script spanning
    // two levels is two shaping calls.
    const levelChanged = level !== segLevel;
    // A neutral never conflicts — it extends whatever segment is open.
    const scriptChanged = !isNeutralScript(script) && segScript != null && script !== segScript;

    if (i > segStart && (levelChanged || scriptChanged)) {
      segments.push({ start: segStart, end: i, script: segScript ?? "Common", rtl: (segLevel & 1) === 1 });
      segStart = i;
      segScript = isNeutralScript(script) ? null : script;
      segLevel = level;
    } else if (segScript == null && !isNeutralScript(script)) {
      segScript = script;
      // Adopt this character's level too: a segment that has so far held only
      // neutrals has no direction of its own, and the neutrals belong with the
      // strong character that resolves them.
      if (i === segStart) segLevel = level;
    }

    i += width;
  }

  segments.push({ start: segStart, end: text.length, script: segScript ?? "Common", rtl: (segLevel & 1) === 1 });
  return segments;
}

/**
 * True when `text` needs more than one shaping call.
 *
 * The fast path, and it mirrors one Blink has: `HarfBuzzShaper::Shape` skips
 * segmentation entirely for 8-bit text, shaping it as a single `USCRIPT_LATIN`
 * range (`harfbuzz_shaper.cc:1157-1161`), because Latin-1 cannot contain a
 * script or direction boundary. Most runs answer false here and cost one
 * `getScript` per character and nothing else.
 */
export function needsSegmentation(text: string, levels?: ArrayLike<number>): boolean {
  let seen: string | null = null;
  const level0 = levels?.[0] ?? 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    if ((levels?.[i] ?? 0) !== level0) return true;
    const script = getScript(cp);
    if (!isNeutralScript(script)) {
      if (seen != null && script !== seen) return true;
      seen = script;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}
