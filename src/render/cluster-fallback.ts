// Font fallback at SHAPED-CLUSTER granularity — the default run splitter for
// BOTH render modes: the embedded-font pipeline (`splitTextIntoFontRuns`) and,
// via `ShapedSplitOptions.mode: "paths"`, the glyph-path emitter
// (`splitTextIntoGlyphPathRuns` → `textToPathMarkup`). Paths mode adds the
// emitter's raster-emoji terminal pin and per-run `decomposed` flags — see the
// option's doc below and docs/113-cluster-granularity-fallback.md.
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
// walk for an A/B. A decline (null return) falls back to the legacy path — so
// a face HarfBuzz cannot open degrades to the old behavior, never to a crash.
//
// Known deviations from Blink, kept deliberately (each is a calibrated Domotion
// behavior whose retirement needs its own A/B — docs/113 §4):
//   - the DM-1215 dotted-circle cluster runs (◌ + mark routed through real
//     HarfBuzz in the mark's own font) are pinned BEFORE the requeue loop, so
//     their font assignment and downstream hb positioning are unchanged;
//   - decomposed resolver answers (math-alpha base substitution, cross-font NFD)
//     commit the hint character directly with the substituted text, preserving
//     the per-codepoint calibration for those codepoints;
//   - the declared-family walk materializes fonts via our key chain rather than
//     Blink's FontFallbackList (same order, same members).

import {
  FontInstance, FontRun,
  getFontInstance, getFontSourceInfo, shapingFaceFor, webfontShapingFace,
  webfontVariantsInDeclarationOrder, unicodeRangeCovers,
  resolveFontForCodepoint, resolveDottedCircleHbRun,
  forcesEmojiPresentation, isEmojiCharCp, isEmojiCodepoint, isColorEmojiFontKey,
  glyphIdForCp, fallbackFontChain, harfbuzzShapedRunOverride,
  FontVariantEmojiOverride,
} from "./font-resolution.js";
import { harfbuzzShapeRun, harfbuzzGlyphQuery, mirrorPairedCharacters } from "./harfbuzz-shaper.js";
import { bidiLevelsFor, segmentForShaping } from "./script-segmentation.js";
import { SCRIPT_NAME_TO_ISO15924 } from "./script-iso15924.generated.js";

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
export function _clusterFallbackCounters(): { invoked: number; accepted: number } {
  return { invoked: _invoked, accepted: _accepted };
}
if (process.env.DOMOTION_CLUSTER_FALLBACK_DEBUG === "1") {
  process.on("exit", () => {
    console.error(`[cluster-fallback] invoked=${_invoked} accepted=${_accepted}`);
  });
}

interface QueueRange { start: number; end: number }
interface Assignment {
  start: number;
  end: number;
  key: string;
  font: FontInstance;
  isPrimary: boolean;
  /** Substituted run text (decomposed resolver answers); default = source slice. */
  emitText?: string;
  /** Mirrors `FontRun.decomposed` — a substituted-text commit or a pinned
   *  dotted-circle cluster. The glyph-path emitter renders such runs via its
   *  run-text branch; in "paths" mode runs never merge across a flag change. */
  decomposed?: boolean;
}

/** Which emitter the split feeds. The default ("embedded") is the contract the
 *  embedded-font pipeline shipped with. "paths" is the glyph-path emitter
 *  (`textToPathMarkup`), which adds two concerns of its own:
 *  - the raster-emoji terminal pin (`pinnedEmojiTerminalSpans` below) — emoji
 *    are painted by a captured raster overlay there, so an uncovered emoji must
 *    keep the calibrated per-codepoint terminal instead of the resolver's
 *    system answer;
 *  - per-run `decomposed` flags, and no merging across a flag boundary — the
 *    emitter picks its per-char vs run-text branch per run from the flag. */
export interface ShapedSplitOptions {
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
   * features, which is what every current caller passes; wiring a live value
   * through from the render call sites is a separate, additive follow-up.
   */
  features?: string[];
}

/** Common/Inherited have no "likely script" — `Character::HasLikelyScript` is
 *  `uscript_hasScript` beyond USCRIPT_COMMON/INHERITED; the practical test
 *  Blink's hint selection needs is exactly "not Common, not Inherited". */
const RE_COMMON_OR_INHERITED = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
function hasLikelyScript(cp: number): boolean {
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
  const cacheKey = `${face.path}#${face.faceIndex}|${fontSize}|${axesKey}|${rtl ? "r" : "l"}|${scriptTag ?? ""}|${lang ?? ""}|${featuresKey}|${pre} ${item} ${post}`;
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
      verdicts.push({
        startRel: clStart - range.start,
        endRel: clEnd - range.start,
        allNonZero: ok.get(clStart)!,
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
// question, and the presentation rule for VS15/VS16 substitutes
// `isColorEmojiFontKey` for Blink's `TypefaceHasAnySupportedColorTable` — on
// the font inventories this project routes, the color-table faces are exactly
// the platform emoji fonts.
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
    if (isVariationSelectorCp(cp) && prevIndex >= 0 && !isVariationSelectorCp(prevCp)) {
      out.push({ index: prevIndex, base: prevCp, selector: cp });
    } else if (forcesEmojiPresentation(cp, fve)) {
      // Synthesized VS16, unless an explicit selector follows (explicit wins —
      // `HasVSFallbackPriority`, `harfbuzz_shaper.cc:184-198`).
      const nextCp = i + len < end ? text.codePointAt(i + len)! : 0;
      if (nextCp !== 0xFE0E && nextCp !== 0xFE0F) out.push({ index: i, base: cp, selector: 0xFE0F });
    }
    prevIndex = i;
    prevCp = cp;
    i += len;
  }
  return out;
}

/** Does (base, selector) read as UNMATCHED in this face — Blink's
 *  `kUnmatchedVSGlyphId` condition? */
function vsUnmatchedInFace(face: HbFace, fontKey: string, seq: VsSequence): boolean {
  const q = harfbuzzGlyphQuery(face.path, face.faceIndex);
  if (q == null) return false;
  if (q.variationGlyph(seq.base, seq.selector) !== 0) return false; // cmap-14 has it
  if (q.nominalGlyph(seq.base) === 0) return false; // base absent → plain .notdef path
  if (seq.selector === 0xFE0E || seq.selector === 0xFE0F) {
    // Presentation rule (`harfbuzz_face.cc:189-206`): unmatched only when the
    // face's presentation contradicts the request.
    const color = isColorEmojiFontKey(fontKey);
    return (color && seq.selector === 0xFE0E) || (!color && seq.selector === 0xFE0F);
  }
  return true; // non-emoji VS: base-only coverage is an unmatched sequence
}

// ── DM-1215 dotted-circle cluster runs (pinned prepass) ─────────────────────
//
// An orphaned complex-shaper mark (or an explicit ◌ + mark) routes through real
// HarfBuzz in the mark's own font, so the ◌ is inserted + GPOS-positioned like
// Chrome paints it. Transplanted from the legacy walk so the shaped splitter
// preserves the calibrated behavior; its retirement in favor of the requeue
// loop's native hb dotted circles is a separate A/B (docs/113 §4).
const RE_MARK = /\p{M}/u;
function pinnedDottedCircleSpans(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
): Assignment[] {
  // Cheap gate: no combining mark, no spans.
  if (!RE_MARK.test(text)) return [];
  const spans: Assignment[] = [];
  let hbRun: { key: string; font: FontInstance } | null = null;
  let clusterHasBase = false;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const nextCp = i + ch.length < text.length ? text.codePointAt(i + ch.length)! : 0;
    const chIsMark = RE_MARK.test(ch);
    let clusterRun: { key: string; font: FontInstance } | null = null;
    if (hbRun != null) {
      if (chIsMark) clusterRun = hbRun;
      else hbRun = null;
    }
    if (clusterRun == null) {
      const markForCluster = (cp === 0x25CC && nextCp !== 0 && RE_MARK.test(String.fromCodePoint(nextCp)))
        ? nextCp
        : (chIsMark && !clusterHasBase) ? cp
        : 0;
      if (markForCluster !== 0) {
        const run = resolveDottedCircleHbRun(markForCluster, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
        if (run != null) { hbRun = run; clusterRun = run; }
      }
    }
    if (/\s/.test(ch) && ch.length === 1) clusterHasBase = false;
    else if (!chIsMark) clusterHasBase = true;
    if (clusterRun != null) {
      const last = spans[spans.length - 1];
      if (last != null && last.end === i && last.key === clusterRun.key && last.font === clusterRun.font) {
        last.end = i + ch.length;
      } else {
        // `decomposed`: the glyph-path emitter must render this span via its
        // run-text branch (the whole ◌+mark cluster shapes as a unit).
        spans.push({ start: i, end: i + ch.length, key: clusterRun.key, font: clusterRun.font, isPrimary: false, decomposed: true });
      }
    }
    i += ch.length;
  }
  return spans;
}

// ── Glyph-path raster-emoji terminal (pinned prepass, "paths" mode only) ────
//
// The glyph-path emitter paints emoji through a captured raster `<image>`
// overlay and suppresses their path emission, so the underlying run exists only
// to hold the ADVANCE the overlay was aligned against. Its calibrated contract
// (transplanted from `textToPathMarkup`'s per-codepoint walk): an emoji the
// primary's cmap lacks is pinned to the LAST entry of the static fallback chain
// — that entry's stable `.notdef` advance keeps the overlay aligned — or to the
// primary itself when the chain is empty, grouping the suppressed tofu with the
// surrounding run. The resolver's system stage must never place it on a color
// font: that would split it out of the surrounding run and drift the rest of
// the line. (The embedded pipeline has no overlay and deliberately lets the
// resolver place emoji on the color font — hence the mode split.)
//
// A variation selector immediately following a pinned base is pinned with the
// legacy per-codepoint decision (the shared resolver's answer when covered,
// else the primary terminal): with its base carved out of the requeue queue,
// the cluster-level `kUnmatchedVSGlyphId` machinery can no longer see the
// sequence, and a stranded one-selector range would otherwise commit to
// whichever candidate shapes it first (measured: the live CoreText resolver
// answers `sysfb:.AppleColorEmojiUI` for a lone U+FE0F, which is what the
// legacy walk emits — the requeue loop's last-resort stage would emit Times).
//
// Not a Blink behavior — Blink has no raster overlay. This is a Domotion
// calibration the glyph-path emitter is built around; parity for these
// codepoints is carried by the overlay itself, not by the run split.
function pinnedEmojiTerminalSpans(
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
): Assignment[] {
  const spans: Assignment[] = [];
  let prevPinnedEmoji = false;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const nextCp = i + len < text.length ? text.codePointAt(i + len)! : 0;
    // An explicit VS15/VS16 after the codepoint wins over the property
    // (`HasVSFallbackPriority`, `harfbuzz_shaper.cc:184-198`, rev 7d859f27) —
    // the same guard the legacy walk applies before its terminal test.
    const effFve = (nextCp === 0xFE0E || nextCp === 0xFE0F) ? undefined : fontVariantEmoji;
    if (glyphIdForCp(primaryFont, cp) === 0 && isEmojiCodepoint(cp, nextCp) && effFve !== "text") {
      const chain = fallbackFontChain(cp, primaryFontKey, lang);
      const key = chain.length > 0 ? chain[chain.length - 1] : primaryFontKey;
      const font = key === primaryFontKey ? primaryFont : getFontInstance(key, weight, fontSize, slant);
      if (font == null) throw new DeclineError();
      spans.push({ start: i, end: i + len, key, font, isPrimary: key === primaryFontKey && font === primaryFont });
      prevPinnedEmoji = true;
    } else if (prevPinnedEmoji && isVariationSelectorCp(cp)) {
      const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, effFve, fontFamily);
      let key = primaryFontKey;
      let font: FontInstance | null = primaryFont;
      let decomposed = false;
      let emitText: string | undefined;
      if (res.covered) {
        key = res.key;
        font = res.fontOverride ?? (res.key === primaryFontKey ? primaryFont : getFontInstance(res.key, weight, fontSize, slant));
        decomposed = res.decomposed;
        if (res.emitCh !== text.slice(i, i + len)) emitText = res.emitCh;
      }
      if (font == null) throw new DeclineError();
      spans.push({
        start: i, end: i + len, key, font,
        isPrimary: key === primaryFontKey && font === primaryFont,
        ...(emitText != null ? { emitText } : {}),
        ...(decomposed ? { decomposed: true } : {}),
      });
      // Leave `prevPinnedEmoji` set: a multi-selector tail (rare but legal)
      // takes the same legacy decision per selector.
    } else {
      prevPinnedEmoji = false;
    }
    i += len;
  }
  return spans;
}

// ── The FontFallbackIterator port ───────────────────────────────────────────

type Stage = "family" | "system" | "lastResort" | "firstCandidate" | "outOfLuck";

interface Candidate {
  key: string;
  font: FontInstance;
  face: HbFace;
  isPrimary: boolean;
  /** Segmented-webfont range set — clusters containing an out-of-range
   *  character read `.notdef` with this face (Blink passes the face's range
   *  set into `ShapeRange`, `harfbuzz_shaper.cc:1119`). */
  clampRanges: Array<[number, number]> | null;
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

class DeclineError extends Error {}

/**
 * Shape-then-requeue split: Blink's `ShapeSegment` loop
 * (`harfbuzz_shaper.cc:965-1144`) ported to run-splitting granularity. Returns
 * the per-font run assignment Blink's mechanism produces, or null to decline
 * (caller uses the legacy per-codepoint path).
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
): FontRun[] | null {
  if (text.length === 0) return null;
  _invoked++;
  try {
    const runs = splitShapedInner(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji, fontFamily, opts);
    if (runs != null) _accepted++;
    return runs;
  } catch {
    // A decline, never a crash: the legacy path takes over.
    return null;
  }
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
): FontRun[] | null {
  const pathsMode = opts?.mode === "paths";
  const primaryFace = hbFaceFor(primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings);
  if (primaryFace == null || primaryFace.faceIndex == null) return null;

  // DM-1215 dotted-circle cluster runs, pinned before the requeue loop.
  const pinned = pinnedDottedCircleSpans(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
  if (pathsMode) {
    // The glyph-path emitter's raster-emoji terminal, pinned the same way. No
    // overlap with the dotted-circle spans is possible: those cover marks and
    // an explicit ◌, and an emoji base is neither (a variation selector IS
    // category Mn, but it only pins here when the preceding emoji base — a
    // non-mark — just closed any dotted-circle cluster).
    pinned.push(...pinnedEmojiTerminalSpans(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji, fontFamily));
    pinned.sort((a, b) => a.start - b.start);
  }

  // Script itemization FIRST — Blink's RunSegmenter runs before any shaping,
  // so a Thai-script mark (U+0E48, Script=Thai, not Inherited) never joins a
  // Latin base's fallback context: Chrome splits Geneva "e"+U+0E48 into
  // Geneva + Thonburi because the segments never shared a shaping call.
  const levels = bidiLevelsFor(text, opts?.bidiOverride);
  const segments = segmentForShaping(text, levels);

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

  const assignments: Assignment[] = [...pinned];

  for (const seg of segments) {
    // Initial queue: the segment minus any pinned span.
    let queue: QueueRange[] = [];
    {
      let cursor = seg.start;
      for (const p of pinned) {
        if (p.end <= seg.start || p.start >= seg.end) continue;
        if (p.start > cursor) queue.push({ start: cursor, end: Math.min(p.start, seg.end) });
        cursor = Math.max(cursor, p.end);
      }
      if (cursor < seg.end) queue.push({ start: cursor, end: seg.end });
    }
    if (queue.length === 0) continue;

    const scriptTag = SCRIPT_NAME_TO_ISO15924[seg.script];
    const segVsSequences = collectVsSequences(text, seg.start, seg.end, fontVariantEmoji);

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

    const candidateFor = (key: string, font: FontInstance, isPrimary: boolean, clampRanges: Array<[number, number]> | null, vs?: Record<string, number>): Candidate => {
      const face = isPrimary ? primaryFace : hbFaceFor(font, key, weight, fontSize, slant, vs);
      // A candidate HarfBuzz cannot open cannot take this mechanism at all —
      // decline the whole split so the legacy path (which can consult the
      // native helper's coverage) keeps its behavior.
      if (face == null || face.faceIndex == null) throw new DeclineError();
      return { key, font, face, isPrimary, clampRanges };
    };

    type Picked = Candidate | { decomposedCommit: { hint: number; key: string; font: FontInstance; emitCh: string } } | null;

    /** `FontFallbackIterator::Next` + `UniqueOrNext`, as one loop. */
    const nextFont = (hints: number[]): Picked => {
      for (;;) {
        switch (iter.stage) {
          case "family": {
            if (familyIndex >= familyCycle.length) { iter.stage = "system"; break; }
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
                const isPrimary = entry.key === primaryFontKey
                  && v.webfontDeclarationOrder === primaryFont.webfontDeclarationOrder;
                if (isPrimary) v = primaryFont;
                const face = hbFaceFor(v, entry.key, weight, fontSize, slant, undefined);
                if (face == null || face.faceIndex == null) throw new DeclineError();
                const identity = `${face.path}#${face.faceIndex}`;
                const subsetted = v.webfontUnicodeRange != null;
                if (!subsetted) {
                  if (returnedFaces.has(identity)) continue;
                  returnedFaces.add(identity);
                }
                const cand: Candidate = { key: entry.key, font: v, face, isPrimary, clampRanges: ranges ?? null };
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
            const cand = candidateFor(entry.key, inst, isPrimary, inst.webfontUnicodeRange ?? null, isPrimary ? variationSettings : undefined);
            const identity = `${cand.face.path}#${cand.face.faceIndex}`;
            if (cand.clampRanges == null) {
              if (returnedFaces.has(identity)) break;
              returnedFaces.add(identity);
            }
            if (firstCandidate == null) firstCandidate = cand;
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
            // The hint's effective `font-variant-emoji`: an explicit VS15/VS16
            // after the hint wins over the property (`HasVSFallbackPriority`) —
            // and itself implies the presentation the ask must carry, which is
            // Blink's per-VS fallback priority (`kEmojiEmoji` / `kText`)
            // reaching `FallbackPriorityFont`. Suppressed entirely on the
            // post-reset ignore-VS pass.
            const hintPos = findCodepoint(logicalText, queue, hint);
            const nextCp = hintPos >= 0 && hintPos + String.fromCodePoint(hint).length < logicalText.length
              ? logicalText.codePointAt(hintPos + String.fromCodePoint(hint).length)! : 0;
            const effFve: FontVariantEmojiOverride | undefined = ignoreVS ? undefined
              : nextCp === 0xFE0F ? (isEmojiCharCp(hint) ? "emoji" : undefined)
              : nextCp === 0xFE0E ? (isEmojiCharCp(hint) ? "text" : undefined)
              : fontVariantEmoji;
            const res = resolveFontForCodepoint(hint, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, effFve, fontFamily);
            if (!res.covered) { iter.stage = "lastResort"; break; }
            const font = res.fontOverride ?? (res.key === primaryFontKey ? primaryFont : getFontInstance(res.key, weight, fontSize, slant));
            if (font == null) { iter.stage = "lastResort"; break; }
            if (res.decomposed) {
              // A calibrated per-codepoint substitution (math-alpha base,
              // cross-font NFD): commit the hint character itself with the
              // substituted text. Not a Blink stage — see the module header.
              return { decomposedCommit: { hint, key: res.key, font, emitCh: res.emitCh } };
            }
            const cand = candidateFor(res.key, font, false, null);
            const identity = `${cand.face.path}#${cand.face.faceIndex}`;
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
              const cand = candidateFor(key, inst, false, null);
              const identity = `${cand.face.path}#${cand.face.faceIndex}`;
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
            return firstCandidate;
          }
          case "outOfLuck":
            return null;
        }
      }
    };

    // ── the reshape queue loop ──
    // Defensive bound only: every cycle consumes monotone state (family index,
    // tried variants, asked hints, stage), so the loop terminates; the cap
    // turns a logic bug into a decline instead of a hang.
    let guard = familyCycle.length + text.length * 2 + 64;
    while (queue.length > 0) {
      if (--guard < 0) throw new DeclineError();
      const hints = collectHintChars(logicalText, queue, needsFullHints);
      if (hints.length === 0) break;
      const picked = nextFont(hints);
      if (picked == null) break;
      if ("decomposedCommit" in picked) {
        const { hint, key, font, emitCh } = picked.decomposedCommit;
        const chLen = String.fromCodePoint(hint).length;
        const nextQueue: QueueRange[] = [];
        for (const r of queue) {
          let cursor = r.start;
          let i = r.start;
          while (i < r.end) {
            // `logicalText`, because that is where the hint came from — the
            // two differ only at mirrorable brackets, which the resolver never
            // answers with a decomposition, so this is consistency, not a
            // behavior change.
            const cp = logicalText.codePointAt(i)!;
            const len = cp > 0xffff ? 2 : 1;
            if (cp === hint) {
              if (i > cursor) nextQueue.push({ start: cursor, end: i });
              assignments.push({ start: i, end: i + chLen, key, font, isPrimary: false, emitText: emitCh, decomposed: true });
              cursor = i + chLen;
            }
            i += len;
          }
          if (cursor < r.end) nextQueue.push({ start: cursor, end: r.end });
        }
        queue = nextQueue;
        continue;
      }

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
        const verdicts = shapeVerdicts(current.face, seg.rtl ? rtlVerdictText : text, range, seg.rtl, scriptTag, lang, fontSize, opts?.features);
        if (verdicts == null) {
          // Unshapeable with this font — the whole range stays queued (or
          // terminally commits to the first candidate below when isLast).
          if (isLast) assignments.push({ start: range.start, end: range.end, key: current.key, font: current.font, isPrimary: current.isPrimary });
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
              if (!unicodeRangeCovers(current.clampRanges, cp)) { ok = false; break; }
              i += cp > 0xffff ? 2 : 1;
            }
          }
          // kUnmatchedVSGlyphId: an unmatched variation sequence re-queues.
          if (ok && rangeVs.length > 0) {
            for (const seq of rangeVs) {
              if (seq.index < abs.start || seq.index >= abs.end) continue;
              if (vsUnmatchedInFace(current.face, current.key, seq)) { ok = false; vsSeen = true; break; }
            }
          }
          if (ok || isLast) {
            assignments.push({ ...abs, key: current.key, font: current.font, isPrimary: current.isPrimary });
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
      }
    }
    // Anything still queued after a defensive break paints the FIRST
    // candidate's `.notdef` (kFirstCandidateForNotdefGlyph's terminal).
    for (const r of queue) {
      const fc = firstCandidate ?? { key: primaryFontKey, font: primaryFont, isPrimary: true } as { key: string; font: FontInstance; isPrimary: boolean };
      assignments.push({ start: r.start, end: r.end, key: fc.key, font: fc.font, isPrimary: fc.isPrimary });
    }
  }

  // Assemble contiguous, source-ordered runs; merge adjacent same-font spans.
  assignments.sort((a, b) => a.start - b.start);
  // Contract check: the assignment must tile [0, text.length) exactly.
  let cursor = 0;
  for (const a of assignments) {
    if (a.start !== cursor) return null;
    cursor = a.end;
  }
  if (cursor !== text.length) return null;

  const runs: FontRun[] = [];
  for (const a of assignments) {
    const aText = a.emitText ?? text.slice(a.start, a.end);
    const last = runs[runs.length - 1];
    const aDecomposed = a.decomposed === true;
    // In "paths" mode a run never merges across a `decomposed` boundary — the
    // glyph-path emitter picks its per-char vs run-text branch PER RUN, so a
    // merged mixed run would index the source text with substituted characters.
    // Embedded keeps its shipped merge (it always renders `run.text`).
    if (last != null && last.fontKey === a.key && last.font === a.font && last.endIdx === a.start
        && (!pathsMode || (last.decomposed === true) === aDecomposed)) {
      last.endIdx = a.end;
      last.text += aText;
      if (aDecomposed) last.decomposed = true;
    } else {
      runs.push({ fontKey: a.key, font: a.font, text: aText, startIdx: a.start, endIdx: a.end, isPrimary: a.isPrimary, ...(aDecomposed ? { decomposed: true } : {}) });
    }
  }
  // Run-level HarfBuzz script reroute — the shaped splitter's counterpart of
  // the per-codepoint `harfbuzzShapedScriptOverride` inside
  // `resolveFontForCodepoint`. The system stage above already returns hb
  // proxies through the resolver, but the primary and declared-family stages
  // never call it, so a `HARFBUZZ_SHAPED_RANGES` script covered by the primary
  // or a declared family kept the base engine's shaping while the legacy walk
  // rerouted it. Applied AFTER merging so the wrap sees whole runs; the proxy
  // is memoized per (base instance, args), so identical bases keep a stable
  // identity — the renderer's run-grouping invariant. A run with no routed
  // codepoint, or whose font already shapes via hb (system-stage proxies,
  // pinned dotted-circle runs), comes back unchanged.
  for (const run of runs) {
    run.font = harfbuzzShapedRunOverride(run.font, run.fontKey, weight, fontSize, slant, run.isPrimary ? variationSettings : undefined, run.text);
  }
  return runs;
}

/** First position of `cp` within the queued ranges, or -1. */
function findCodepoint(text: string, queue: QueueRange[], cp: number): number {
  for (const r of queue) {
    let i = r.start;
    while (i < r.end) {
      const c = text.codePointAt(i)!;
      if (c === cp) return i;
      i += c > 0xffff ? 2 : 1;
    }
  }
  return -1;
}
