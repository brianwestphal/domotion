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

/**
 * Cheap test for any strong-RTL or bidi-control character.
 *
 * This is a FAST PATH, not the answer: everything it admits goes on to
 * `bidi-js`'s `getEmbeddingLevels`, which implements the real Unicode Bidi
 * Algorithm. So the only requirement is that it be **conservative** — a false
 * positive costs one extra call that returns all-zero levels, while a false
 * negative skips the UBA entirely and shapes the run left-to-right.
 *
 * It covered the BMP only, so every SMP RTL script was rejected here and never
 * reached bidi-js: Adlam, Kharoshthi, Sogdian, Old Uyghur, Garay, Mende
 * Kikakui, Yezidi, Chorasmian, Elymaic, Hanifi Rohingya, Manichaean, Old
 * Turkic, Old Hungarian, Phoenician, Nabataean, Palmyrene, Hatran, Lydian,
 * Meroitic, Avestan, the Pahlavi scripts, and the Arabic Mathematical
 * Alphabetic Symbols.
 *
 * The two added ranges are deliberately BROAD rather than a curated per-script
 * list. U+10800-10FFF and U+1E800-1EFFF bracket the SMP's RTL blocks, and
 * over-inclusion is free for the reason above — whereas a hand-listed set is
 * exactly what left the previous version short. Upstream asks
 * `hb_script_get_horizontal_direction` (`hb-ot-shape.cc:590`); we let bidi-js
 * answer that and use this only to decide whether to ask.
 */
const _RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿‏‫‮⁧\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

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
   *
   * **Applied the way Blink applies it**, which is not by special-casing the
   * levels. `InlineItemsBuilder::EnterBlock` maps the CSS value to a pair of
   * real Unicode formatting characters and appends them to the text
   * (`core/layout/inline/inline_items_builder.cc:1501-1505`, rev 7d859f27):
   *
   *     case UnicodeBidi::kBidiOverride:
   *     case UnicodeBidi::kIsolateOverride:
   *       EnterBidiContext(nullptr, style, uchar::kLeftToRightOverride,
   *                        uchar::kRightToLeftOverride,
   *                        uchar::kPopDirectionalFormatting);
   *
   * — i.e. U+202D LRO (or U+202E RLO when `direction: rtl`) before, U+202C PDF
   * after. Nothing downstream knows about `unicode-bidi` at all; the ordinary
   * algorithm sees the controls and does the rest. `normal` / `embed` /
   * `isolate` inject nothing (they are the algorithm's default behaviour, and
   * the block direction is carried as the paragraph level instead).
   *
   * So we do the same, rather than flattening the level array by hand. The
   * flattening version was an approximation that happens to agree on a
   * single-script run and stops agreeing the moment one doesn't: it would force
   * a level onto embedded LTR text inside an RTL override, onto neutrals, and
   * onto nested overrides — cases the real algorithm resolves and a fill() cannot.
   */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
): Uint8Array | undefined {
  if (text === "") return undefined;
  const ub = bidiOverride?.unicodeBidi;
  const isOverride = ub === "bidi-override" || ub === "isolate-override";
  if (isOverride) {
    // U+202D LRO / U+202E RLO … U+202C PDF — Blink's exact pair.
    // U+202E RIGHT-TO-LEFT OVERRIDE / U+202D LEFT-TO-RIGHT OVERRIDE.
    const enter = bidiOverride!.direction === "rtl" ? "\u202E" : "\u202D";
    try {
      const levels = _bidi.getEmbeddingLevels(enter + text + "\u202C", "ltr").levels;
      // Drop the level of the injected opener; the trailing PDF's level is past
      // the end of the slice already. What remains is one level per SOURCE
      // character, so every caller's indexing into `text` still lines up.
      return levels.slice(1, 1 + text.length);
    } catch {
      return undefined;
    }
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
