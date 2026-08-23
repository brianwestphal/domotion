// Font fallback at SHAPED-CLUSTER granularity — the default run splitter for
// BOTH render modes: the embedded-font pipeline (`splitTextIntoFontRuns`) and,
// via the glyph-path emitter (`splitTextIntoGlyphPathRuns` →
// `textToPathMarkup`). See docs/113-cluster-granularity-fallback.md.
//
// Blink does not decide fallback per codepoint. It shapes the whole segment
// with the current font and re-queues only the clusters whose glyphs came back
// `.notdef` (`ExtractShapeResults`, `platform/fonts/shaping/harfbuzz_shaper.cc:627-787`,
// rev 7d859f27). The next font for a re-queued cluster is chosen from ONE hint
// character of that cluster (`ChooseHintIndex`,
// `platform/fonts/font_fallback_iterator.cc:242-262`: the first hint character
// with a real script value, else the first; each hint character is asked of the
// system at most once, `:275-277`). The per-codepoint cmap walk this replaces
// (`splitTextIntoFontRuns`'s legacy body, `text-to-path.ts`) diverges from
// Chrome in both directions — measured with CDP `CSS.getPlatformFontsForNode`:
//
//   - "x" + U+0951 in Helvetica: Chrome paints BOTH glyphs from Helvetica (the
//     mark is Helvetica's .notdef tofu — the cluster's hint char is `x`,
//     CoreText answers Helvetica, the iterator refuses the duplicate, and the
//     terminal commits `.notdef`). The cmap walk painted a real mark from a
//     Devanagari fallback Chrome never consults.
//   - "ก" + U+0301 in Helvetica: Chrome paints BOTH glyphs from Thonburi (the
//     covered mark travels with its uncovered base and keeps its GPOS anchor).
//     The cmap walk split mid-cluster: base Thonburi, mark Helvetica, anchor lost.
//
// This module is Blink's mechanism ported at run-splitting granularity:
//
//   text → script itemization (`segmentForShaping` — Blink's RunSegmenter)
//        → per segment: shape-then-requeue with a FontFallbackIterator port
//          (kFontGroupFonts → kSegmentedFace → kSystemFonts → last-resort →
//           kFirstCandidateForNotdefGlyph), the hb buffer filled with the FULL
//          text + item bounds so re-queued ranges keep joining context, script /
//          direction / language set explicitly per segment.
//
// `resolveFontForCodepoint` serves as the kSystemFonts stage: "next font for
// this failing cluster", asked for the cluster's `ChooseHintIndex` character,
// asked at most once per hint. That keeps every calibrated stage (live
// resolver, static-chain net, PUA guard, emoji forcing) while changing WHAT
// QUESTION is asked.
//
// Enabled by default; `DOMOTION_CLUSTER_FALLBACK=0` restores the per-codepoint
// walk only as an explicit A/B mutation. The default route never changes its
// assignment algorithm because one candidate cannot be opened by our HarfBuzz
// bridge. Such a candidate stays in FontFallbackIterator order, its range stays
// queued, and the terminal still belongs to Blink's first candidate.
//
// Dotted-circle insertion and canonical decomposition deliberately have no
// prepass here. They are outcomes of shaping each selected candidate:
// `hb_syllabic_insert_dotted_circles` first requires a broken syllable AND that
// candidate's U+25CC glyph (`hb-ot-shaper-syllabic.cc:33-99`, rev 4de187d),
// while `decompose_current_character` tests the source scalar and canonical
// pieces in the same candidate (`hb-ot-shape-normalize.cc:108-200`). Committing
// either result before `ShapeRange` bypasses the state machine that owns it.

import {
  FontInstance, FontRun,
  getFontInstance, getFontSourceInfo, shapingFaceFor, webfontShapingFace,
  webfontVariantsInDeclarationOrder, unicodeRangeCovers,
  resolveColorEmojiKeyForCp, isEmojiCharCp, isEmojiPresentationCp,
  resolveFontForCodepoint,
  resolveSystemFallbackKeyForCp,
  fontHasSupportedColorTable,
  harfbuzzShapedRunOverride,
  FontVariantEmojiOverride,
  FontFallbackSemanticContext,
  createFontFallbackSemanticContext,
  registerFontEnvironmentInvalidator,
} from "./font-resolution.js";
import { harfbuzzShapeRun, harfbuzzGlyphQuery, mirrorPairedCharacters } from "./harfbuzz-shaper.js";
import { bidiLevelsFor, segmentForShaping } from "./script-segmentation.js";
import {
  applyFontVariantEmojiToPriority,
  type SourceFallbackPriority,
} from "./emoji-presentation-priority.js";
import { STANDARDIZED_VARIATION_SEQUENCES } from "./standardized-variation-sequences.generated.js";
import { SCRIPT_NAME_TO_ISO15924 } from "./script-iso15924.generated.js";
import { icuCodepointProperties } from "./icu-helper.js";
import { isHarfbuzzDefaultIgnorable } from "./unicode-classification.js";

/** Flag gate. Read per call so tests can toggle via env. Default ON;
 *  `DOMOTION_CLUSTER_FALLBACK=0` restores the legacy per-codepoint walk. */
export function clusterFallbackEnabled(): boolean {
  return process.env.DOMOTION_CLUSTER_FALLBACK !== "0";
}

// Armed-mechanism proof for A/B runs: a flag being on is not evidence the
// mechanism executed (the Windows live resolver shipped "default-on" and inert
// for months). `DOMOTION_CLUSTER_FALLBACK_DEBUG=1` prints the counters at exit
// so a zero-delta A/B can be distinguished from an A/B that never took the path.
let _invoked = 0;
let _accepted = 0;
let _priorityAsked = 0;
let _priorityAnswered = 0;
let _vsRequeued = 0;
let _vsResets = 0;
export function _clusterFallbackCounters(): {
  invoked: number; accepted: number; priorityAsked: number; priorityAnswered: number;
  vsRequeued: number; vsResets: number;
} {
  return {
    invoked: _invoked, accepted: _accepted,
    priorityAsked: _priorityAsked, priorityAnswered: _priorityAnswered,
    vsRequeued: _vsRequeued, vsResets: _vsResets,
  };
}
if (process.env.DOMOTION_CLUSTER_FALLBACK_DEBUG === "1") {
  process.on("exit", () => {
    console.error(`[cluster-fallback] invoked=${_invoked} accepted=${_accepted} priorityAsked=${_priorityAsked} priorityAnswered=${_priorityAnswered}`);
  });
}

interface QueueRange { start: number; end: number }
interface Assignment {
  start: number;
  end: number;
  key: string;
  font: FontInstance;
  isPrimary: boolean;
  mechanism: NonNullable<FontRun["routeMechanism"]>;
}

export interface ShapedSplitOptions {
  /** Retained for call-site compatibility. Face selection and shaping are now
   * identical for both emitters; neither mode owns a fallback prepass. */
  mode?: "embedded" | "paths";
  /** CSS bidi override captured from the live run. Blink applies this before
   * RunSegmenter, so fallback shaping must use the same forced direction as
   * the final glyph emitter. */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string };
  /**
   * The run's OpenType features (HarfBuzz feature strings), threaded into the
   * shape-then-requeue verdict below. Blink's `ShapeRange` passes the run's
   * `font_features` into the SAME shape call that decides `.notdef` cluster
   * membership (`platform/fonts/shaping/harfbuzz_shaper.cc:627-787`, rev
   * 7d859f27) — a `-liga` or letter-spacing veto can change which glyphs a
   * cluster maps to and therefore its coverage verdict. Omitted = default
   * features. Every production caller supplies the fully resolved feature list
   * assembled from the CSS longhands, variants, alternates, and explicit
   * `font-feature-settings` values.
   */
  features?: string[];
  /** Exact Blink FontSelectionRequest slope in CSS degrees, used by the
   * macOS ideograph CharacterFallbackKey (not by font-instance selection). */
  fallbackRawSlope?: number;
  /** Numeric Blink FontOrientation for CharacterFallbackKey identity. */
  fallbackOrientation?: number;
  semanticContext?: FontFallbackSemanticContext;
}

/** Blocks promoted by Blink's stable `ScriptBasedOnUnicodeBlock` feature when
 * `uscript_getScript` returns Common or Inherited. This is the complete switch
 * in `Character::GetScriptBasedOnUnicodeBlock` (`character.cc:321-351`, rev
 * 7d859f27); the feature is `status: "stable"` at
 * `runtime_enabled_features.json5:5267-5271` in that same revision. */
const LIKELY_SCRIPT_BLOCKS = new Set([
  "CJK_Symbols_And_Punctuation",
  "Hiragana",
  "Katakana",
  "Arabic",
  "Thai",
  "Greek_And_Coptic",
  "Devanagari",
  "Armenian",
  "Georgian",
  "Kannada",
  "Gothic",
]);

/** Exact `Character::HasLikelyScript` predicate (`character.cc:298-317`, rev
 * 7d859f27): Chromium's pinned ICU Script property first, then stable block
 * inference for Common/Inherited. The regex is helper-absent degradation only;
 * JavaScript Unicode tables can lag Chromium's pinned ICU and misclassify newly
 * assigned scripts. */
const RE_COMMON_OR_INHERITED = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
function hasLikelyScript(cp: number): boolean {
  const properties = icuCodepointProperties(cp);
  if (properties != null) {
    const script = properties.scriptLongName;
    if (script !== "Common" && script !== "Inherited") return true;
    return LIKELY_SCRIPT_BLOCKS.has(properties.blockName);
  }
  return !RE_COMMON_OR_INHERITED.test(String.fromCodePoint(cp));
}

/** `ChooseHintIndex` (`font_fallback_iterator.cc:242-262`, rev 7d859f27):
 *  first index >= 1 with a likely script, else 0. */
export function chooseHintIndex(hintList: number[]): number {
  if (hintList.length <= 1) return 0;
  for (let i = 1; i < hintList.length; i++) {
    if (hasLikelyScript(hintList[i])) return i;
  }
  return 0;
}

/** `CollectFallbackHintChars` (`harfbuzz_shaper.cc:789-845`): walk the queued
 *  ranges in order, pushing codepoints. With `needsFullList` false, stop as
 *  soon as one has a definite (non-Common/Inherited) script; a segmented
 *  webfont face needs the FULL list (Blink's `NeedsHintList`), since range
 *  contribution is checked against every hint character. */
export function collectHintChars(text: string, queue: QueueRange[], needsFullList = false): number[] {
  const hints: number[] = [];
  for (const r of queue) {
    let i = r.start;
    while (i < r.end) {
      const cp = text.codePointAt(i)!;
      hints.push(cp);
      if (!needsFullList && hasLikelyScript(cp)) return hints;
      i += String.fromCodePoint(cp).length;
    }
  }
  return hints;
}

interface HbFace { path: string; faceIndex: number | null; axes: Record<string, number> | null }

/** Resolve the on-disk (or in-buffer) face HarfBuzz can open for a font
 *  key/instance — the instance's own source file first (agreement with the
 *  outlines by construction), the key's base spec next, and the retained
 *  `@font-face` bytes last (`webfontShapingFace`, so webfont primaries and
 *  variants shape instead of declining). */
function hbFaceFor(
  inst: FontInstance | null, key: string, weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined,
): HbFace | null {
  const src = getFontSourceInfo(inst);
  if (src != null && src.nameMatched && src.faceIndex != null) {
    return { path: src.path, faceIndex: src.faceIndex, axes: src.variationAxes ?? null };
  }
  return shapingFaceFor(key, weight, fontSize, slant, variationSettings)
    ?? (inst != null ? webfontShapingFace(inst) : null);
}

// ── Shape-verdict cache (docs/113 §6) ────────────────────────────────────────
//
// Keyed on everything that can change the verdict: the face (path#index),
// ptem-relevant size, axis location, direction, script, language, and the item
// text WITH its joining context. HarfBuzz consults at most
// `hb_buffer_t::CONTEXT_LENGTH = 5` code units of out-of-item context per side
// (`hb-buffer.hh`, rev 4de187d), so five units each side make the key exact
// rather than approximate. The unicode-grid corpus (hundreds of one-char
// segments per fixture) hits the face cache hard and this one not at all; real
// paragraphs re-shape the same (font, run) pairs across fixtures and land here.
interface ClusterVerdict {
  /** Item-relative code-unit bounds. */
  startRel: number;
  endRel: number;
  /** Every glyph HarfBuzz mapped to the cluster is non-zero. */
  allNonZero: boolean;
  /** Some glyph in the cluster is the font's SPACE glyph sitting on a U+3000 —
   *  HarfBuzz synthesizing IDEOGRAPHIC SPACE (`harfbuzz_shaper.cc:684-691`). */
  ideoSpaceSynth: boolean;
}
const verdictCache = new Map<string, ClusterVerdict[] | null>();
const VERDICT_CACHE_CAP = 4096;
export function _clearClusterVerdictCache(): void { verdictCache.clear(); }
export function _clusterVerdictCacheSizeForTest(): number { return verdictCache.size; }
export function _seedClusterVerdictCacheForTest(): void { verdictCache.set("test", null); }
registerFontEnvironmentInvalidator(_clearClusterVerdictCache);

const CONTEXT_UNITS = 5;

function shapeVerdicts(
  face: HbFace,
  fullText: string,
  range: QueueRange,
  rtl: boolean,
  scriptTag: string | undefined,
  lang: string | undefined,
  fontSize: number,
  /** The run's OpenType features — see `ShapedSplitOptions.features`. */
  features?: string[],
): ClusterVerdict[] | null {
  const item = fullText.slice(range.start, range.end);
  const pre = fullText.slice(Math.max(0, range.start - CONTEXT_UNITS), range.start);
  const post = fullText.slice(range.end, range.end + CONTEXT_UNITS);
  const axesKey = face.axes == null ? "" : JSON.stringify(face.axes);
  const featuresKey = features == null || features.length === 0 ? "" : features.join(",");
  const cacheKey = `${face.path}#${face.faceIndex}|${fontSize}|${axesKey}|${rtl ? "r" : "l"}|${scriptTag ?? ""}|${lang ?? ""}|${featuresKey}|${pre}\0${item}\0${post}`;
  const cached = verdictCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const shaped = harfbuzzShapeRun(face.path, face.faceIndex, item, rtl ? "rtl" : "ltr", fontSize, face.axes, features, {
    context: { fullText, itemOffset: range.start, itemLength: range.end - range.start },
    script: scriptTag,
    language: lang,
    verdictOnly: true,
  });
  let verdicts: ClusterVerdict[] | null = null;
  if (shaped != null && shaped.glyphs.length > 0) {
    // The U+3000 space-glyph probe is only meaningful when the item contains
    // one; skip the extra face query otherwise.
    const hasIdeoSpace = item.includes("　");
    const spaceGlyph = hasIdeoSpace ? (harfbuzzGlyphQuery(face.path, face.faceIndex)?.nominalGlyph(0x20) ?? 0) : 0;
    // Per-cluster merge, `ExtractShapeResults`' rule: a cluster is shaped only
    // if EVERY glyph HarfBuzz mapped to it is non-zero. Cluster values are
    // absolute indices into `fullText` (the buffer carries the whole text with
    // item bounds), possibly in visual order — sort to recover text order.
    const ok = new Map<number, boolean>();
    const ideo = new Map<number, boolean>();
    for (let g = 0; g < shaped.glyphs.length; g++) {
      const cl = shaped.clusters[g];
      const gid = shaped.glyphs[g].id;
      ok.set(cl, (ok.get(cl) ?? true) && gid !== 0);
      if (hasIdeoSpace && gid === spaceGlyph && spaceGlyph !== 0 && fullText.codePointAt(cl) === 0x3000) {
        ideo.set(cl, true);
      }
    }
    const starts = [...ok.keys()].sort((a, b) => a - b);
    verdicts = [];
    for (let ci = 0; ci < starts.length; ci++) {
      const clStart = starts[ci];
      const clEnd = ci + 1 < starts.length ? starts[ci + 1] : range.end;
      let allNonZero = ok.get(clStart)!;
      if (!allNonZero) {
        // `hb_ot_hide_default_ignorables` turns an orphan default-ignorable
        // into an invisible zero glyph; Blink treats that as shaped, not as a
        // reason to ask another face. Valid base+VS sequences are adjudicated
        // separately below and therefore never enter this all-ignorable case.
        const clusterText = fullText.slice(clStart, clEnd);
        allNonZero = [...clusterText].every((ch) => isHarfbuzzDefaultIgnorable(ch.codePointAt(0)!));
      }
      verdicts.push({
        startRel: clStart - range.start,
        endRel: clEnd - range.start,
        allNonZero,
        ideoSpaceSynth: ideo.get(clStart) ?? false,
      });
    }
  }
  if (verdictCache.size >= VERDICT_CACHE_CAP) {
    // Drop the oldest entry (Map preserves insertion order) — cheap LRU-ish.
    const first = verdictCache.keys().next();
    if (!first.done) verdictCache.delete(first.value);
  }
  verdictCache.set(cacheKey, verdicts);
  return verdicts;
}

// ── Variation-selector handling (`kUnmatchedVSGlyphId`) ─────────────────────
//
// Blink installs a custom hb glyph callback (`HarfBuzzGetGlyph`,
// `shaping/harfbuzz_face.cc:120-207`, rev 7d859f27): for a variation sequence
// where the face has the base glyph but no cmap-14 entry for (base, selector) —
// or the WRONG presentation for a VS15/VS16 request — the glyph reads as the
// `kUnmatchedVSGlyphId` sentinel, which `ExtractShapeResults` treats as
// `.notdef` (`:692-694`), so the cluster re-queues in search of a face that has
// the sequence. When the fallback list is exhausted with unmatched sequences
// remaining, the queue RESETS and re-runs ignoring selectors
// (`kReshapeQueueReset`, `harfbuzz_shaper.cc:1009-1020`).
//
// We cannot install glyph callbacks on the wasm font, so the same verdict is
// computed OUTSIDE shaping: `variationGlyph` asks the identical cmap-14
// question, and the presentation rule for VS15/VS16 calls the shared
// `fontHasSupportedColorTable` transcription of Blink's
// `TypefaceHasAnySupportedColorTable` (including author webfonts).
interface VsSequence {
  /** Code-unit index of the base character. */
  index: number;
  base: number;
  /** The selector — explicit from the text, or the synthesized VS16 Blink's
   *  `font-variant-emoji: emoji`/`unicode` forcing implies
   *  (`UseFontVariantEmojiVariationSelector`, `harfbuzz_face.cc:137-140`). */
  selector: number;
}

function isVariationSelectorCp(cp: number): boolean {
  return (cp >= 0xFE00 && cp <= 0xFE0F)
    || (cp >= 0xE0100 && cp <= 0xE01EF)
    || (cp >= 0x180B && cp <= 0x180D) || cp === 0x180F; // Mongolian FVS1-4
}

function hasStandardizedVariationSequence(base: number, selector: number): boolean {
  const needle = base * 0x110000 + selector;
  let lo = 0;
  let hi = STANDARDIZED_VARIATION_SEQUENCES.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = STANDARDIZED_VARIATION_SEQUENCES[mid];
    if (value < needle) lo = mid + 1;
    else hi = mid;
  }
  return STANDARDIZED_VARIATION_SEQUENCES[lo] === needle;
}

/** Blink's `Character::IsVariationSequence` transcription
 * (`character_variation_sequences.cc`, Chromium rev 7d859f27). */
export function _isBlinkVariationSequenceForTest(base: number, selector: number): boolean {
  if ((selector === 0xfe0e || selector === 0xfe0f) && isEmojiCharCp(base)) return true;
  if (hasStandardizedVariationSequence(base, selector)) return true;
  if (selector < 0xe0100 || selector > 0xe01ef) return false;
  const ch = String.fromCodePoint(base);
  return /\p{Ideographic}/u.test(ch) && ch.normalize("NFD") === ch && ch.normalize("NFKD") === ch;
}

function collectVsSequences(
  text: string, start: number, end: number, fve: FontVariantEmojiOverride | undefined,
): VsSequence[] {
  const out: VsSequence[] = [];
  let prevIndex = -1;
  let prevCp = 0;
  let i = start;
  while (i < end) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    if (isVariationSelectorCp(cp) && prevIndex >= 0 && !isVariationSelectorCp(prevCp)
      && _isBlinkVariationSequenceForTest(prevCp, cp)) {
      out.push({ index: prevIndex, base: prevCp, selector: cp });
    } else if (fve != null && isEmojiCharCp(cp)) {
      // `GetVariationSelectorModeFromFontVariantEmoji`: text synthesizes VS15,
      // emoji VS16, and unicode selects VS15/VS16 from the codepoint's default.
      // An explicit selector follows wins (`HasVSFallbackPriority`).
      const nextCp = i + len < end ? text.codePointAt(i + len)! : 0;
      if (nextCp !== 0xFE0E && nextCp !== 0xFE0F) {
        const selector = fve === "text" || (fve === "unicode" && !isEmojiPresentationCp(cp))
          ? 0xFE0E : 0xFE0F;
        out.push({ index: i, base: cp, selector });
      }
    }
    prevIndex = i;
    prevCp = cp;
    i += len;
  }
  return out;
}

/** Does (base, selector) read as UNMATCHED in this face — Blink's
 *  `kUnmatchedVSGlyphId` condition? */
function vsUnmatchedInFace(face: HbFace, font: FontInstance, fontKey: string, seq: VsSequence): boolean {
  const q = harfbuzzGlyphQuery(face.path, face.faceIndex);
  if (q == null) return false;
  if (q.variationGlyph(seq.base, seq.selector) !== 0) return false; // cmap-14 has it
  if (q.nominalGlyph(seq.base) === 0) return false; // base absent → plain .notdef path
  if (seq.selector === 0xFE0E || seq.selector === 0xFE0F) {
    // Presentation rule (`harfbuzz_face.cc:189-206`): unmatched only when the
    // face's presentation contradicts the request.
    const color = fontHasSupportedColorTable(font, fontKey);
    return (color && seq.selector === 0xFE0E) || (!color && seq.selector === 0xFE0F);
  }
  return true; // non-emoji VS: base-only coverage is an unmatched sequence
}

// ── The FontFallbackIterator port ───────────────────────────────────────────

type Stage = "family" | "priority" | "system" | "lastResort" | "firstCandidate" | "outOfLuck";

/** ApplyFontVariantEmojiOnFallbackPriority, exported as a pure test seam. */
export function _effectiveFallbackPriorityForTest(
  sourcePriority: SourceFallbackPriority,
  fontVariantEmoji: FontVariantEmojiOverride | undefined,
): SourceFallbackPriority {
  return applyFontVariantEmojiToPriority(sourcePriority, fontVariantEmoji);
}

interface Candidate {
  key: string;
  font: FontInstance;
  /** Null means Domotion cannot open the selected platform face through its
   * HarfBuzz bridge. This is candidate-local evidence, not permission to
   * restart the whole run with per-codepoint fallback. */
  face: HbFace | null;
  isPrimary: boolean;
  mechanism: NonNullable<FontRun["routeMechanism"]>;
  /** Segmented-webfont range set — clusters containing an out-of-range
   *  character read `.notdef` with this face (Blink passes the face's range
   *  set into `ShapeRange`, `harfbuzz_shaper.cc:1119`). */
  clampRanges: Array<[number, number]> | null;
}

function candidateIdentity(candidate: Candidate): string {
  if (candidate.face != null) return `${candidate.face.path}#${candidate.face.faceIndex}`;
  const source = getFontSourceInfo(candidate.font);
  return `${candidate.key}|${source?.path ?? ""}#${source?.faceIndex ?? "?"}|${source?.postscriptName ?? candidate.font.postscriptName ?? ""}`;
}

/** Blink's last-resort face, per platform:
 *  - macOS: Times, else Lucida Grande (`mac/font_cache_mac.mm:376-394`);
 *  - Linux/Windows: `GetFallbackFontFamily` (a CSS generic only when the
 *    description carries one — ours never does) → "Sans" → "Arial"
 *    (`skia/font_cache_skia.cc:146-175`). On the calibrated noble image "Sans"
 *    resolves to Liberation Sans (our `helvetica` key); on win32 the Arial
 *    stage is the first that exists. */
function lastResortKeys(): string[] {
  if (process.platform === "darwin") return ["times", "lucida-grande"];
  if (process.platform === "win32") return ["arial"];
  return ["helvetica"];
}

/**
 * Shape-then-requeue split: Blink's `ShapeSegment` loop
 * (`harfbuzz_shaper.cc:965-1144`) ported to run-splitting granularity. Returns
 * the per-font run assignment Blink's mechanism produces. An unopenable local
 * face remains an unshaped candidate in that iterator; it never changes the
 * algorithm to the legacy per-codepoint walk.
 *
 * The output contract matches `splitTextIntoFontRuns`: contiguous runs in
 * source order covering all of `text`.
 */
export function splitTextIntoFontRunsShaped(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  systemUiPrimary: boolean = false,
  stretch: number = 100,
  fontVariantEmoji?: FontVariantEmojiOverride,
  /** The run's RAW CSS `font-family` stack — threaded to the resolver's
   *  `declaredFamily` param (the Linux standard-style retry). */
  fontFamily?: string,
  /** Emitter-contract options — see `ShapedSplitOptions`. Default: embedded. */
  opts?: ShapedSplitOptions,
): FontRun[] {
  if (text.length === 0) return [];
  const semanticContext = opts?.semanticContext ?? createFontFallbackSemanticContext(fontFamily);
  _invoked++;
  const runs = splitShapedInner(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji, fontFamily, { ...opts, semanticContext });
  _accepted++;
  return runs;
}

function splitShapedInner(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  systemUiPrimary: boolean,
  stretch: number,
  fontVariantEmoji: FontVariantEmojiOverride | undefined,
  fontFamily: string | undefined,
  opts: ShapedSplitOptions | undefined,
): FontRun[] {
  const primaryFace = hbFaceFor(primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings);

  const levels = bidiLevelsFor(text, opts?.bidiOverride);

  // Mirror-domain adjustment for the shaping-side questions (RTL only, and
  // only when the text carries a mirrorable character at all — the two
  // derived strings are `text` itself otherwise, so the common case allocates
  // nothing). The text reaching this splitter is the renderer's PAINT-domain
  // text: `applyBidi` already substituted the Bidi_Mirroring_Glyph counterpart
  // at odd embedding levels. Blink's shaping and hint questions are asked of
  // the LOGICAL text — HarfBuzz mirrors RTL buffers itself, coverage-gated
  // (`hb_ot_rotate_chars`, `hb-ot-shape.cc:657-668`, rev 4de187d), so the
  // `.notdef` verdict for a bracket in an RTL buffer tests the MIRRORED
  // glyph's coverage. Hence:
  //   - an RTL segment's shape verdicts use `rtlVerdictText` (every mirrorable
  //     character mapped through the BMG involution — restoring the logical
  //     char at odd levels, which hb then re-mirrors under its has_glyph gate);
  //   - hint characters are collected from `logicalText` (odd-level characters
  //     mapped back), matching `CollectFallbackHintChars`, which reads Blink's
  //     un-premirrored source text.
  // Assignments and the returned runs keep slicing `text` — the paint-domain
  // emitters (and the hb proxies' own mirror-domain adapter) consume that.
  const rtlVerdictText = levels == null ? text : mirrorPairedCharacters(text);
  const logicalText = levels == null || rtlVerdictText === text ? text : mirrorPairedCharacters(text, levels);

  // RunSegmenter itemization FIRST: independent bidi/script and source emoji-
  // priority ranges are intersected before any FontFallbackIterator exists.
  // Use logical text for SymbolsIterator; its UTF-16 offsets remain identical
  // to the paint-domain string returned to emitters.
  const segments = segmentForShaping(logicalText, levels);

  const assignments: Assignment[] = [];

  for (const seg of segments) {
    let queue: QueueRange[] = [{ start: seg.start, end: seg.end }];

    const scriptTag = SCRIPT_NAME_TO_ISO15924[seg.script];
    const segVsSequences = collectVsSequences(text, seg.start, seg.end, fontVariantEmoji);
    // Chromium applies CSS after SymbolsIterator has fixed this source range;
    // even equal effective priorities retain distinct iterator instances.
    const effectivePriority = applyFontVariantEmojiToPriority(seg.sourcePriority, fontVariantEmoji);

    // ── FontFallbackIterator state (one iterator per segment, as Blink) ──
    // kFontGroupFonts: the primary, then the remaining declared families. The
    // primary entry carries the CALLER'S resolved instance (axes, optical-cut
    // opsz, webfont variant already applied) rather than re-deriving one — the
    // embedded-font pipeline keys its @font-face entries on that instance's
    // identity, so a re-pick would collapse distinct axis tuples into one face.
    // A range-partitioned webfont primary gets a SECOND entry for its remaining
    // unicode-range partitions (kSegmentedFace walks every face of the family;
    // the primary instance is just the first).
    const familyCycle: Array<{ key: string; inst: FontInstance | null }> = primaryFontKey.startsWith("webfont:")
      ? [{ key: primaryFontKey, inst: null }]
      : [{ key: primaryFontKey, inst: primaryFont }];
    for (const key of fontKeyChain) {
      if (key === primaryFontKey) continue;
      familyCycle.push({ key, inst: null });
    }
    let familyIndex = 0;
    /** `unique_font_data_for_range_sets_returned_` — face identity of every
     *  entire-range candidate the iterator returned (`UniqueOrNext`); range-
     *  subsetted webfont faces are exempt ("We don't want to skip subsetted
     *  ranges because HarfBuzzShaper's behavior depends on the subsetting"). */
    const returnedFaces = new Set<string>();
    /** `previously_asked_for_hint_` — each hint char asked of the system once. */
    const previouslyAskedHints = new Set<number>();
    /** Per-family segmented-face arrays and cursors. Blink builds the array in
     * reverse declaration order, then advances it once while filtering each
     * face against the current hint list. */
    const segmentedWebfonts = new Map<string, { faces: FontInstance[]; index: number }>();
    // Wrapped in an object so TypeScript does not narrow the union across the
    // closure mutations in `nextFont` (the loop below reads it after each call).
    const iter = { stage: "family" as Stage };
    let firstCandidate: Candidate | null = null;
    /** kIntermediateWithVS: an unmatched variation sequence was seen. */
    let vsSeen = false;
    /** kIgnoreVariationSelector: the post-reset second pass. */
    let ignoreVS = false;

    const needsFullHints = familyCycle.some((f) => f.key.startsWith("webfont:"));

    const candidateFor = (key: string, font: FontInstance, isPrimary: boolean, clampRanges: Array<[number, number]> | null, mechanism: NonNullable<FontRun["routeMechanism"]>, vs?: Record<string, number>): Candidate => {
      const face = isPrimary ? primaryFace : hbFaceFor(font, key, weight, fontSize, slant, vs);
      return { key, font, face, isPrimary, mechanism, clampRanges };
    };

    type Picked = Candidate | null;

    /** `FontFallbackIterator::Next` + `UniqueOrNext`, as one loop. */
    const nextFont = (hints: number[]): Picked => {
      for (;;) {
        switch (iter.stage) {
          case "family": {
            if (familyIndex >= familyCycle.length) {
              iter.stage = effectivePriority !== "text" ? "priority" : "system";
              break;
            }
            const entry = familyCycle[familyIndex];
            if (entry.inst == null && entry.key.startsWith("webfont:")) {
              // kSegmentedFace: a webfont family's unicode-range partitions.
              // Walk EVERY declaration in reverse source order and apply
              // `RangeSetContributesForHint` to the current hint list. Scoring
              // each hint independently loses the next overlapping face.
              const family = entry.key.slice("webfont:".length);
              let state = segmentedWebfonts.get(entry.key);
              if (state == null) {
                state = { faces: webfontVariantsInDeclarationOrder(family, weight, fontSize, slant,
                  entry.key === primaryFontKey ? variationSettings : undefined, stretch), index: 0 };
                segmentedWebfonts.set(entry.key, state);
              }
              while (state.index < state.faces.length) {
                let v = state.faces[state.index++];
                const ranges = v.webfontUnicodeRange;
                if (ranges != null && !hints.some((cp) => unicodeRangeCovers(ranges, cp))) continue;
                const isPrimaryInstance = entry.key === primaryFontKey
                  && v.webfontDeclarationOrder === primaryFont.webfontDeclarationOrder;
                if (isPrimaryInstance) v = primaryFont;
                const face = hbFaceFor(v, entry.key, weight, fontSize, slant, undefined);
                const cand: Candidate = { key: entry.key, font: v, face, isPrimary: entry.key === primaryFontKey, mechanism: "declared-family", clampRanges: ranges ?? null };
                const identity = candidateIdentity(cand);
                const subsetted = v.webfontUnicodeRange != null;
                if (!subsetted) {
                  if (returnedFaces.has(identity)) continue;
                  returnedFaces.add(identity);
                }
                // Every contributing partition of the declared webfont family
                // remains primary for CSS axis/feature application. The
                // concrete-instance check above is narrower: it only decides
                // when the caller's already-instanced Font object can be reused.
                if (firstCandidate == null) firstCandidate = cand;
                return cand;
              }
              familyIndex++; // no (further) contributing variant for these hints
              break;
            }
            familyIndex++;
            const inst = entry.inst ?? getFontInstance(entry.key, weight, fontSize, slant);
            if (inst == null) break;
            const isPrimary = entry.key === primaryFontKey && inst === primaryFont;
            const cand = candidateFor(entry.key, inst, isPrimary, inst.webfontUnicodeRange ?? null, "declared-family", isPrimary ? variationSettings : undefined);
            const identity = candidateIdentity(cand);
            if (cand.clampRanges == null) {
              if (returnedFaces.has(identity)) break;
              returnedFaces.add(identity);
            }
            if (firstCandidate == null) firstCandidate = cand;
            return cand;
          }
          case "priority": {
            // `kFallbackPriorityFonts` is one-shot and owns the first hint,
            // ahead of `UniqueSystemFontForHintList`. A miss proceeds to the
            // ordinary system stage; it never retries another priority face.
            iter.stage = "system";
            _priorityAsked++;
            const hint = hints[0];
            const key = effectivePriority === "emoji" || effectivePriority === "emoji-vs"
              ? resolveColorEmojiKeyForCp(hint, weight, fontSize, slant, lang)
              : resolveSystemFallbackKeyForCp(
                  hint, weight, slant, fontSize, primaryFontKey,
                  systemUiPrimary, lang, stretch, "text", opts?.semanticContext?.declaredFamily,
                  opts?.fallbackRawSlope, opts?.fallbackOrientation,
                );
            if (key == null) break;
            const font = getFontInstance(key, weight, fontSize, slant);
            if (font == null) break;
            const cand = candidateFor(key, font, false, null, "priority-emoji");
            const identity = candidateIdentity(cand);
            if (returnedFaces.has(identity)) break;
            returnedFaces.add(identity);
            if (firstCandidate == null) firstCandidate = cand;
            _priorityAnswered++;
            return cand;
          }
          case "system": {
            // kSystemFonts = `UniqueSystemFontForHintList`: ONE hint character,
            // asked at most once. A duplicate answer recurses into Next with
            // the same (now-consumed) hint, which returns nothing — so both
            // "already asked" and "duplicate answer" advance to last-resort.
            if (hints.length === 0) { iter.stage = "lastResort"; break; }
            const hint = hints[chooseHintIndex(hints)];
            if (hint === 0 || previouslyAskedHints.has(hint)) { iter.stage = "lastResort"; break; }
            previouslyAskedHints.add(hint);
            // Explicit VS source priorities win over CSS for the whole item.
            // The post-reset pass ignores the selector during glyph lookup but
            // preserves this iterator's source/effective priority, as Blink's
            // FontFallbackIterator::Reset does.
            const effFve: FontVariantEmojiOverride | undefined = ignoreVS ? undefined
              : seg.sourcePriority === "emoji-vs" ? "emoji"
              : seg.sourcePriority === "text-vs" ? "text"
              : fontVariantEmoji;
            const res = resolveFontForCodepoint(
              hint, primaryFont, primaryFontKey, weight, fontSize, slant,
              variationSettings, lang, fontKeyChain, systemUiPrimary, stretch,
              effFve, fontFamily, opts?.fallbackRawSlope, opts?.fallbackOrientation,
              opts?.semanticContext,
            );
            if (!res.covered) { iter.stage = "lastResort"; break; }
            const font = res.fontOverride ?? (res.key === primaryFontKey ? primaryFont : getFontInstance(res.key, weight, fontSize, slant));
            if (font == null) { iter.stage = "lastResort"; break; }
            // `res.decomposed` is coverage evidence for the selected face, not
            // an alternate commit operation. HarfBuzz shapes the ORIGINAL
            // queued source range below and owns whether canonical pieces are
            // emitted (`hb-ot-shape-normalize.cc:108-200`).
            const cand = candidateFor(res.key, font, false, null, "system-resolver");
            const identity = candidateIdentity(cand);
            if (returnedFaces.has(identity)) { iter.stage = "lastResort"; break; }
            returnedFaces.add(identity);
            if (firstCandidate == null) firstCandidate = cand;
            return cand;
          }
          case "lastResort": {
            // "we only have the last resort font left" —
            // `font_fallback_iterator.cc:143-157`: the stage advances to
            // kFirstCandidateForNotdefGlyph BEFORE the last-resort face is
            // returned, and the face is still deduped (a Times primary skips
            // straight to the first candidate).
            iter.stage = "firstCandidate";
            for (const key of lastResortKeys()) {
              const inst = getFontInstance(key, weight, fontSize, slant);
              if (inst == null) continue;
              const cand = candidateFor(key, inst, false, null, "last-resort");
              const identity = candidateIdentity(cand);
              if (returnedFaces.has(identity)) break; // duplicate → first candidate
              returnedFaces.add(identity);
              if (firstCandidate == null) firstCandidate = cand;
              return cand;
            }
            break;
          }
          case "firstCandidate": {
            // kFirstCandidateForNotdefGlyph: re-return the FIRST candidate so
            // ITS `.notdef` paints (`font_fallback_iterator.cc:159-164`).
            iter.stage = "outOfLuck";
            return firstCandidate == null ? null : { ...firstCandidate, mechanism: "first-candidate-notdef" };
          }
          case "outOfLuck":
            return null;
        }
      }
    };

    // ── the reshape queue loop ──
    // Defensive bound only: every cycle consumes monotone state (family index,
    // tried variants, asked hints, stage), so the loop terminates. A violation
    // is an implementation bug; silently switching assignment algorithms would
    // hide it and produce a plausible but non-Blink result.
    let guard = familyCycle.length + text.length * 2 + 64;
    while (queue.length > 0) {
      if (--guard < 0) throw new Error("cluster fallback iterator did not converge");
      const hints = collectHintChars(logicalText, queue, needsFullHints);
      if (hints.length === 0) break;
      const picked = nextFont(hints);
      if (picked == null) break;
      // `ChangeStageToLast` fires when the iterator has nothing further
      // (`!fallback_iterator.HasNext()`, `harfbuzz_shaper.cc:1041-1043`) —
      // with the kLastWithVS exception: unmatched variation sequences keep the
      // requeue open so the queue can RESET for the ignore-VS pass.
      const isLast = iter.stage === "outOfLuck" && !(vsSeen && !ignoreVS);

      const current: Candidate = picked;
      const rangeVs = ignoreVS ? [] : segVsSequences;
      const nextQueue: QueueRange[] = [];
      for (const range of queue) {
        // RTL segments shape the mirror-domain-mapped text — see the
        // `rtlVerdictText` note above. Cluster indices are unaffected (the BMG
        // map is 1:1 in code units). Features are passed because Blink shapes
        // fallback passes WITH the run's features (`ShapeRange(buffer,
        // font_features, …)`), and a `-liga`/letter-spacing veto can flip a
        // cluster's coverage verdict.
        const verdicts = current.face == null ? null : shapeVerdicts(current.face, seg.rtl ? rtlVerdictText : text, range, seg.rtl, scriptTag, lang, fontSize, opts?.features);
        if (verdicts == null) {
          // Unshapeable with this font — the whole range stays queued (or
          // terminally commits to the first candidate below when isLast).
          if (isLast) assignments.push({ start: range.start, end: range.end, key: current.key, font: current.font, isPrimary: current.isPrimary, mechanism: current.mechanism });
          else nextQueue.push(range);
          continue;
        }
        for (const v of verdicts) {
          const abs = { start: range.start + v.startRel, end: range.start + v.endRel };
          let ok = v.allNonZero;
          // U+3000 synthesized from the space glyph reads `.notdef` unless
          // shaping with the last font (`harfbuzz_shaper.cc:684-691`).
          if (ok && v.ideoSpaceSynth && !isLast) ok = false;
          // Segmented-webfont range clamp: an out-of-range character in the
          // cluster reads `.notdef` with this face.
          if (ok && current.clampRanges != null) {
            for (let i = abs.start; i < abs.end;) {
              const cp = text.codePointAt(i)!;
              const selectorBelongsToPreviousBase = rangeVs.some((seq) =>
                seq.index + String.fromCodePoint(seq.base).length === i && seq.selector === cp);
              // HarfBuzz's variation-glyph callback receives (base, selector)
              // together and Blink applies unicode-range to `unicode` (the
              // base), not independently to `variation_selector`.
              if (!selectorBelongsToPreviousBase && !unicodeRangeCovers(current.clampRanges, cp)) {
                ok = false;
                break;
              }
              i += cp > 0xffff ? 2 : 1;
            }
          }
          // kUnmatchedVSGlyphId: an unmatched variation sequence re-queues.
          if (ok && rangeVs.length > 0) {
            for (const seq of rangeVs) {
              if (seq.index < abs.start || seq.index >= abs.end) continue;
              if (current.face != null && vsUnmatchedInFace(current.face, current.font, current.key, seq)) {
                ok = false;
                vsSeen = true;
                _vsRequeued++;
                break;
              }
            }
          }
          if (ok || isLast) {
            assignments.push({ ...abs, key: current.key, font: current.font, isPrimary: current.isPrimary, mechanism: current.mechanism });
          } else {
            nextQueue.push(abs);
          }
        }
      }
      // Coalesce adjacent requeued ranges so the next cycle shapes maximal
      // stretches (Blink requeues maximal same-state slices by construction).
      nextQueue.sort((a, b) => a.start - b.start);
      queue = [];
      for (const r of nextQueue) {
        const last = queue[queue.length - 1];
        if (last != null && last.end === r.start) last.end = r.end;
        else queue.push({ ...r });
      }

      if (iter.stage === "outOfLuck" && queue.length > 0 && vsSeen && !ignoreVS) {
        // kReshapeQueueReset (`harfbuzz_shaper.cc:1009-1020`): restart the
        // iterator and re-run ignoring variation selectors.
        familyIndex = 0;
        returnedFaces.clear();
        previouslyAskedHints.clear();
        segmentedWebfonts.clear();
        firstCandidate = null;
        iter.stage = "family";
        ignoreVS = true;
        _vsResets++;
      }
    }
    // Anything still queued after a defensive break paints the FIRST
    // candidate's `.notdef` (kFirstCandidateForNotdefGlyph's terminal).
    for (const r of queue) {
      const fc = firstCandidate ?? { key: primaryFontKey, font: primaryFont, isPrimary: true };
      assignments.push({ start: r.start, end: r.end, key: fc.key, font: fc.font, isPrimary: fc.isPrimary, mechanism: "first-candidate-notdef" });
    }
  }

  // Assemble contiguous, source-ordered runs; merge adjacent same-font spans
  // only INSIDE one shaping item. Blink resolves bidi first and splits an
  // InlineItem whenever a logical bidi run ends (`InlineNode::SegmentBidiRuns`,
  // inline_node.cc:1411-1435, Chromium rev 7d859f27). Its shaping scan then
  // refuses to cross an item whose resolved direction or RunSegmenter data
  // differs (`ShouldBreakShapingBeforeText`, :470-490). `segments` is our
  // combined mirror of those bidi + script + source-priority items. Dropping that identity here
  // made adjacent items that selected the same face become one FontRun; the
  // downstream embedded shaper consequently applied only the first item's
  // direction to the whole merged text.
  assignments.sort((a, b) => a.start - b.start);
  // Contract check: the assignment must tile [0, text.length) exactly.
  let cursor = 0;
  for (const a of assignments) {
    if (a.start !== cursor) throw new Error(`cluster assignments do not tile source at ${cursor}`);
    cursor = a.end;
  }
  if (cursor !== text.length) throw new Error(`cluster assignments end at ${cursor}, expected ${text.length}`);

  const runs: FontRun[] = [];
  let segmentIndex = 0;
  let lastRunSegmentIndex = -1;
  for (const a of assignments) {
    while (segmentIndex < segments.length && segments[segmentIndex].end <= a.start) segmentIndex++;
    const segment = segments[segmentIndex];
    // Every assignment is produced while processing one item. Refuse a split
    // that would erase/cross an item boundary instead of guessing which
    // direction should own it.
    if (segment == null || a.start < segment.start || a.end > segment.end) {
      throw new Error(`cluster assignment [${a.start}, ${a.end}) crosses a shaping item`);
    }
    const aText = text.slice(a.start, a.end);
    const shapingDirection = segment.rtl ? "rtl" : "ltr";
    const shapingScript = SCRIPT_NAME_TO_ISO15924[segment.script];
    const last = runs[runs.length - 1];
    if (last != null && lastRunSegmentIndex === segmentIndex
        && last.fontKey === a.key && last.font === a.font && last.endIdx === a.start
        && last.routeMechanism === a.mechanism) {
      last.endIdx = a.end;
      last.text += aText;
    } else {
      runs.push({ fontKey: a.key, font: a.font, text: aText, startIdx: a.start, endIdx: a.end, isPrimary: a.isPrimary, shapingDirection, shapingScript, routeMechanism: a.mechanism });
      lastRunSegmentIndex = segmentIndex;
    }
  }
  // Production shaping is consolidated on the Chromium-configured HarfBuzz
  // build after face selection and fallback assignment. Applied AFTER merging
  // so the wrap sees whole runs; the proxy
  // is memoized per (base instance, args), so identical bases keep a stable
  // identity — the renderer's run-grouping invariant. Native/fontkit objects
  // remain outline and metric providers only; they no longer decide glyphs.
  for (const run of runs) {
    run.font = harfbuzzShapedRunOverride(run.font, run.fontKey, weight, fontSize, slant, run.isPrimary ? variationSettings : undefined, run.text, opts?.features);
  }
  return runs;
}
