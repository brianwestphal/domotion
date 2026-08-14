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
 * ## Common, Inherited, and Script_Extensions
 *
 * A naive "split whenever the script property changes" would shred ordinary
 * text, because spaces, digits and most punctuation are `Common` and combining
 * marks are `Inherited`. Blink resolves those into the surrounding script via
 * `uscript_getScriptExtensions` and a merge-set walk (`ICUScriptData::GetScripts`
 * + `ScriptRunIterator::MergeSets`, `script_run_iterator.cc:118-215`, `:491-565`).
 *
 * An earlier version of this module treated EVERY Common/Inherited character as
 * unconditionally neutral — always attaches to whatever segment is open, never
 * itself a boundary — on the theory that `getScript` (the `unicode-properties`
 * table fontkit's own shaper also consults) made segmentation and shaping
 * "agree by construction". **That claim is true only for the Script property in
 * isolation, and is FALSE the moment a Common character's Script_Extensions set
 * has more than one member.** `uscript_getScriptExtensions` for U+3001 (、,
 * IDEOGRAPHIC COMMA) returns {Bopomofo, Han, Hangul, Hiragana, Katakana,
 * Mongolian, Yi} — a real constraint, not a wildcard — so Blink starts a NEW
 * segment right before the 、 in `"ABC、漢"`, while unconditional neutrality
 * keeps it glued to `"ABC"`. A different segment means a different OpenType
 * script tag reaches GSUB/GPOS, so `palt` / kana-forms / Han features apply or
 * don't.
 *
 * `./script-extensions.generated.ts` (regenerate with
 * `node tools/generate-script-extensions.mjs`) holds the exceptions: every
 * codepoint whose Script_Extensions is NOT the trivial {Script} set, with its
 * exact member list. Per the Unicode Character Database's own design (UAX #24
 * "Script"), scx data only exists as an exception list for Common/Inherited
 * codepoints — confirmed empirically by the generator's own live sweep over
 * every assigned codepoint, not merely assumed — so the table only needs
 * those ~570 exceptions rather than a full per-codepoint enumeration.
 *
 * `scriptSetFor` and the merge-set walk in `segmentForShaping` mirror
 * `ICUScriptData::GetScripts` + `ScriptRunIterator::MergeSets` for the part
 * that affects run boundaries. Two details worth stating because they are
 * easy to get backwards from the algorithm's shape alone (both verified
 * against source, not inferred):
 *
 * - A Common character with EXACTLY ONE Script_Extensions member (a
 *   "preferred script", e.g. the Runic punctuation at U+16EB-16ED) is STILL a
 *   wildcard — Blink keeps Common at the head of the resolved set for that
 *   case (`:184-189`). Only two-or-more members drops Common from the set and
 *   requires real intersection (`:190-199`, "ignore common").
 * - An Inherited character's Script_Extensions can NEVER gate run membership,
 *   trivial or not — Blink's inherited branch always writes the Inherited
 *   sentinel itself back to the head of the resolved set (`:202-214`), so
 *   `MergeSets`' "next is Common/Inherited, always continue" fast path
 *   (`:504-510`) applies unconditionally to Inherited characters. (Not ported
 *   for that reason: it can never observably differ from treating Inherited
 *   as neutral, which is what this module already did.)
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
import { SCRIPT_EXTENSIONS_RANGES, type ScriptExtensionsRange } from "./script-extensions.generated.js";

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
 * `bidi-js`'s `getEmbeddingLevels` gives the wrong answer for every SMP
 * script — Adlam, Kharoshthi, Sogdian, and the rest — even though its OWN
 * character-type data classifies them correctly (`_bidi.getBidiCharType`
 * reports U+1E900 Adlam as `R`, U+10F30 Sogdian as `AL`, etc.). The data is
 * not the problem. `getEmbeddingLevels` builds its char-type array by
 * indexing the string **per UTF-16 code unit**
 * (`node_modules/bidi-js/src/embeddingLevels.js:58-61`,
 * `charTypes[i] = getBidiCharType(string[i])`), so an SMP character arrives
 * as two lone surrogate halves. `getBidiCharType`'s lookup keys on
 * `char.codePointAt(0)` and falls back to strong-`L` for anything unmapped
 * (`node_modules/bidi-js/src/charTypes.js:47-49`,
 * `map.get(char.codePointAt(0)) || TYPES.L`) — and a lone surrogate's
 * code-point value is never in the map, so both halves resolve to `L`. Two
 * strong-L stand-ins is why an all-Adlam run comes back with every level
 * even (LTR).
 *
 * The library published nothing past 1.0.3 (checked npm; last registry
 * activity 2023), so there is no version bump that fixes this, and
 * supplementing the character-type tables would be inert by construction —
 * they are already complete; `getEmbeddingLevels` never looks a full code
 * point up in them for a character outside the BMP.
 *
 * So the fix stays entirely on our side of the call: before handing text to
 * `getEmbeddingLevels`, replace each SMP codepoint's surrogate pair with TWO
 * BMP stand-ins carrying the SAME Bidi_Class — queried from bidi-js's own
 * `getBidiCharType`, so the library's data stays the single source of truth
 * for what class a codepoint is; only the per-code-unit iteration is worked
 * around. Doubling a stand-in one-for-one keeps the substituted string's
 * `.length` identical to the original text's, so the returned `levels`
 * array still indexes by the ORIGINAL text's code units — nothing
 * downstream needs to know the substitution happened. Verified the
 * mechanism works on a real (BMP) strong-R pair standing in for two
 * same-class code units: `getEmbeddingLevels("A<Hebrew Alef><Hebrew Alef>B")`
 * resolves both middle characters to the same odd level a single
 * doubled-width character would.
 *
 * Every Bidi_Class value bidi-js defines is realized by some BMP codepoint
 * — the format/control types (LRE, RLO, PDI, …) are BMP-native by
 * definition, and every other type (L, R, AL, EN, AN, NSM, ON, …) has
 * ordinary BMP members — so `bmpStandInForType` cannot fail to find one for
 * a type this library actually produces; brackets and isolate controls are
 * untouched by this substitution because Unicode defines them all in the
 * BMP, so N0 bracket-pairing and isolate-run matching see the real
 * characters exactly as before.
 */
let _typeToBmpStandIn: Map<number, number> | undefined;
function bmpStandInForType(type: number): number {
  if (_typeToBmpStandIn === undefined) {
    const map = new Map<number, number>();
    for (let cp = 0; cp <= 0xffff; cp++) {
      // Lone surrogate code units carry no character of their own — they
      // are exactly the case this substitution exists to route around, so
      // they can't be used as a stand-in source.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const t = _bidi.getBidiCharType(String.fromCharCode(cp));
      if (!map.has(t)) map.set(t, cp);
    }
    _typeToBmpStandIn = map;
  }
  // Falls back to 'A' (L) rather than throw if some future bidi-js version
  // ever defined a type with no BMP member — see the doc comment above for
  // why that can't happen for the current data.
  return _typeToBmpStandIn.get(type) ?? 0x0041;
}

/**
 * `text` with every SMP codepoint's surrogate pair replaced by two BMP
 * stand-ins of the same Bidi_Class, for feeding to `getEmbeddingLevels`. See
 * `bmpStandInForType`'s doc comment for why this is necessary and sound.
 * A malformed lone surrogate (unpaired) is left untouched — this targets
 * valid SMP codepoints, not encoding errors.
 */
function withBmpStandIns(text: string): string {
  let out: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const high = text.charCodeAt(i);
    const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      const cp = text.codePointAt(i)!;
      const type = _bidi.getBidiCharType(String.fromCodePoint(cp));
      const standIn = String.fromCharCode(bmpStandInForType(type));
      if (out === undefined) out = text.slice(0, i);
      out += standIn + standIn;
      i++; // consumed the low surrogate too
      continue;
    }
    if (out !== undefined) out += text[i];
  }
  return out ?? text;
}

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
      // withBmpStandIns is 1-for-1 on code units, so the composed string's
      // length \u2014 and therefore the slice offsets below \u2014 are unaffected by
      // the substitution.
      const levels = _bidi.getEmbeddingLevels(withBmpStandIns(enter + text + "\u202C"), "ltr").levels;
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
    // withBmpStandIns is 1-for-1 on code units, so the returned `levels`
    // array still indexes by `text`'s own code units.
    return _bidi.getEmbeddingLevels(withBmpStandIns(text), "ltr").levels;
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

/**
 * Binary search over `SCRIPT_EXTENSIONS_RANGES` (sorted, non-overlapping,
 * generated by `tools/generate-script-extensions.mjs`) for the exceptional
 * Script_Extensions entry covering `cp`, if any. Returns `undefined` for the
 * overwhelming majority of codepoints, whose Script_Extensions is trivially
 * `{Script}` and needs no table lookup.
 */
function scriptExtensionsEntry(cp: number): ScriptExtensionsRange | undefined {
  let lo = 0;
  let hi = SCRIPT_EXTENSIONS_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = SCRIPT_EXTENSIONS_RANGES[mid];
    if (cp < r.lo) hi = mid - 1;
    else if (cp > r.hi) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/**
 * The wildcard sentinel: a character whose resolved script set starts with
 * Common/Inherited (`dst.at(0) <= USCRIPT_INHERITED` in Blink's terms), which
 * `MergeSets` always treats as "continue the run, don't touch the accumulated
 * set" (`script_run_iterator.cc:504-516`). See the module docstring for which
 * characters land here.
 */
const ANY_SCRIPT = "any";
type ScriptSet = typeof ANY_SCRIPT | ReadonlySet<string>;

/**
 * The compatible-script SET for `cp`, mirroring Blink's `ICUScriptData::GetScripts`
 * (`script_run_iterator.cc:118-215`, rev 7d859f27) to the extent it affects run
 * boundaries — bracket handling and the Han/Hiragana/Bopomofo priority pick are
 * intentionally not ported (see the module docstring).
 *
 * `"Unknown"` (an unassigned/unrecognized codepoint) is kept as a wildcard —
 * a conservative simplification against Blink's actual USCRIPT_UNKNOWN
 * ordinal, preserved from this module's pre-existing behavior rather than
 * introduced by this change, since a genuinely unassigned codepoint reaching
 * here is not the case this ticket is about.
 */
function scriptSetFor(cp: number, primary: string): ScriptSet {
  if (primary === "Inherited" || primary === "Unknown") return ANY_SCRIPT;
  if (primary !== "Common") return new Set([primary]);
  const entry = scriptExtensionsEntry(cp);
  // A single Script_Extensions member is a "preferred script", not a real
  // constraint — Blink keeps Common at the head of the set for that case too
  // (`:184-189`). Only two-or-more members drops Common and requires genuine
  // intersection (`:190-199`).
  if (entry == null || entry.scripts.length <= 1) return ANY_SCRIPT;
  return new Set(entry.scripts);
}

function preferredNeutralScript(cp: number, primary: string): string | undefined {
  if (primary !== "Common" && primary !== "Inherited") return undefined;
  const entry = scriptExtensionsEntry(cp);
  return entry?.scripts.length === 1 ? entry.scripts[0] : undefined;
}

/**
 * Intersect the run's accumulated script constraint with a new character's
 * set, mirroring `ScriptRunIterator::MergeSets` (`script_run_iterator.cc:491-565`)
 * for the piece that decides run continuation. `next` must already be a real
 * (non-wildcard) set — callers check `charSet !== ANY_SCRIPT` first, since a
 * wildcard next character never touches `current` at all.
 *
 * Returns `null` when the sets are disjoint (a genuine script boundary), the
 * intersection otherwise. An `ANY_SCRIPT` current set has no constraint yet,
 * so it simply adopts `next` — the "current is common/inherited, use next
 * set" branch (`:512-516`).
 */
function mergeScriptSets(current: ScriptSet, next: ReadonlySet<string>): ReadonlySet<string> | null {
  if (current === ANY_SCRIPT) return next;
  const intersection = new Set<string>();
  for (const s of next) if (current.has(s)) intersection.add(s);
  return intersection.size > 0 ? intersection : null;
}

/**
 * The label reported on an emitted `ShapingSegment`. It is converted to an ISO
 * 15924 tag at the shaping call site, matching Blink's explicit
 * `hb_buffer_set_script`; it is therefore part of the shaping decision.
 */
function resolveSegmentScript(openSet: ScriptSet, preferred?: string): string {
  if (openSet === ANY_SCRIPT) return preferred ?? "Common";
  let best: string | undefined;
  for (const s of openSet) if (best === undefined || s < best) best = s;
  return best ?? "Common";
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
  // The run's accumulated script constraint — the wildcard sentinel while the
  // segment has seen only neutrals (plain Common/Inherited, or a Common
  // character with one preferred-script extension), which is how leading
  // neutrals attach to the first real script that follows.
  let openSet: ScriptSet = ANY_SCRIPT;
  let preferred: string | undefined;
  let segLevel = levels?.[0] ?? 0;

  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const level = levels?.[i] ?? 0;
    const primary = getScript(cp);
    const charSet = scriptSetFor(cp, primary);
    if (openSet === ANY_SCRIPT) preferred ??= preferredNeutralScript(cp, primary);

    // A level change is a bidi-run boundary and always splits, even mid-script:
    // Blink shapes each bidi run with its own direction, so a script spanning
    // two levels is two shaping calls.
    const levelChanged = level !== segLevel;
    // A wildcard character never conflicts — it extends whatever is open. A
    // real constraint set conflicts only when it fails to intersect the run's
    // accumulated set, which is the Script_Extensions-aware replacement for
    // the old "any non-neutral script differs from segScript" check — see the
    // module docstring for why a plain Script-equality test was wrong.
    const merged: ScriptSet | null = charSet === ANY_SCRIPT ? openSet : mergeScriptSets(openSet, charSet);
    const scriptChanged = charSet !== ANY_SCRIPT && merged === null;

    if (i > segStart && (levelChanged || scriptChanged)) {
      segments.push({ start: segStart, end: i, script: resolveSegmentScript(openSet, preferred), rtl: (segLevel & 1) === 1 });
      segStart = i;
      openSet = charSet;
      preferred = preferredNeutralScript(cp, primary);
      segLevel = level;
    } else {
      openSet = merged ?? charSet;
    }

    i += width;
  }

  segments.push({ start: segStart, end: text.length, script: resolveSegmentScript(openSet, preferred), rtl: (segLevel & 1) === 1 });
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
 *
 * Mirrors the same merge-set walk as `segmentForShaping` (not a separate,
 * looser approximation of it) — a Common character with a multi-member
 * Script_Extensions set (e.g. CJK punctuation) can force a boundary on its
 * own, even against a SINGLE surrounding real script, so a plain
 * "two different real scripts seen" check would miss it and silently keep
 * the old broken behavior for exactly the case this module now fixes.
 */
export function needsSegmentation(text: string, levels?: ArrayLike<number>): boolean {
  const level0 = levels?.[0] ?? 0;
  let openSet: ScriptSet = ANY_SCRIPT;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    if ((levels?.[i] ?? 0) !== level0) return true;
    const charSet = scriptSetFor(cp, getScript(cp));
    if (charSet !== ANY_SCRIPT) {
      const merged = mergeScriptSets(openSet, charSet);
      if (merged === null) return true;
      openSet = merged;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}
