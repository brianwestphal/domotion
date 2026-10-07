/**
 * Font-resolution CONFORMANCE ORACLE.
 *
 * Asks Chrome and Domotion the same question — "which face paints this
 * codepoint, in this font stack?" — for EVERY assigned Unicode codepoint
 * crossed with every font stack the fixture corpus actually uses, and fails
 * when the two answers differ.
 *
 * Why this exists: a fixture suite cannot establish font parity. Fixtures
 * sample; a wrong-font bug lives happily in the codepoints no fixture happens
 * to cover, and several did. This is the instrument that makes "our font
 * selection matches Chromium's" a checkable claim rather than an aspiration.
 *
 *   Chrome's answer  CDP `CSS.getPlatformFontsForNode` — the face Chrome
 *                    ACTUALLY painted with, reported by the engine, not
 *                    inferred from pixels.
 *   Our answer       `resolveFontForCodepoint` against the same stack's key
 *                    chain, at the same size / weight / style.
 *
 * `tools/chrome-font-agreement.ts` is the single-shot diagnostic version of the
 * same idea (it prints `FONTAGREE:` lines into a CI log and never gates). This
 * is the exhaustive, gateable one.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *
 *   npx tsx tools/font-conformance.ts                       # full sweep
 *   npx tsx tools/font-conformance.ts --range 0000-2FFF     # a slice
 *   npx tsx tools/font-conformance.ts --shard 2/8           # one CI shard
 *   npx tsx tools/font-conformance.ts --extract-stacks      # re-derive the corpus stacks
 *
 *   --stacks <file>      stack corpus  (tools/font-conformance-stacks.<platform>.json)
 *   --extract-stacks     re-derive it and exit
 *   --allow-foreign-corpus  sweep a corpus extracted on another platform
 *   --source a,b         fixture dirs to extract from
 *   --range 0000-2FFF    restrict the codepoint universe (comma-separated, repeatable)
 *   --sample-byte 00     assigned codepoints whose low byte is 00 (00..FF)
 *   --no-pua             drop private-use codepoints (137k of 292k)
 *   --shard i/N          stride shard over codepoints
 *   --stack-shard i/N    stride shard over stacks (preferred for CI — warmer caches)
 *   --max-stacks n       cap the corpus to the n most-used stacks
 *   --stack-filter text  retain stacks whose full CSS signature contains text
 *   --batch n            codepoints per probe page (8000)
 *   --concurrency n      pipelined CDP calls in flight (128)
 *   --max-rows n         example mismatch rows kept in the report (20000)
 *   --reset-every n      drop the font-resolution memos every n batches (1);
 *                        0 disables. Bounds memory — see the loop for why.
 *   --strict-alias       treat the documented naming aliases as mismatches
 *   --allowlist <file>   accepted-divergence file
 *   --lang <tag>         default locale for BOTH sides — per-stack `lang`
 *                        overrides it on probe cells and resolver calls (en)
 *   --out <dir>          report directory (tests/output/font-conformance)
 *
 * Exit code: 0 when every comparison agrees (or is allowlisted), 1 on any
 * mismatch, 2 on a harness error. See `docs/107-font-conformance-oracle.md`.
 * ---------------------------------------------------------------------------
 */
import { createRequire } from "node:module";
import { type Browser, type CDPSession, type Page } from "@playwright/test";
import * as fontkit from "fontkit";
import { withBrowser } from "./lib/browser.js";
import { isMain, parseFlags, runMain } from "./lib/cli.js";
import { writeReport } from "./lib/report.js";
import { fontConformanceDataSchema } from "./conformance-report-schemas.js";
import { parityEnvironment } from "./parity-environment.js";
import { intFlag, parseShardSpec } from "./lib/conformance-args.js";

/**
 * Which machine produced this shard's answers.
 *
 * Recorded because the one thing a detected flip could not say was *where*. The
 * workflow shards one stack per shard, so a stack that flips wholesale flipped
 * on exactly one machine, and its name is the only handle on that machine
 * afterwards. Cheap enough to always record; useless to add after the fact.
 */
export function helperImplementationDigest(platform: NodeJS.Platform = process.platform, root = "."): string | null {
  // Locally-built executables are not reproducible artifacts: PE/COFF embeds a
  // linker timestamp (and other toolchains may carry build IDs), so hashing the
  // binary made identical source builds disagree across CI shards. Hash the
  // native implementation and the build recipe that defines it instead. The OS
  // and architecture remain separate fields in the parity fingerprint.
  const relative =
    platform === "darwin"
      ? [
          "packages/text-engine/tools/macos-glyph-extractor/Package.swift",
          "packages/text-engine/tools/macos-glyph-extractor/Sources/DomotionGlyphPaths/main.swift",
        ]
      : platform === "linux"
        ? [
            "packages/text-engine/tools/linux-glyph-extractor/CMakeLists.txt",
            "packages/text-engine/tools/linux-glyph-extractor/src/main.cpp",
          ]
        : platform === "win32"
          ? [
              "packages/text-engine/tools/win32-glyph-extractor/build-msvc-direct.bat",
              "packages/text-engine/tools/win32-glyph-extractor/src/main.cpp",
            ]
          : [];
  if (relative.length === 0) return null;
  try {
    const digest = createHash("sha256");
    for (const file of relative) {
      digest
        .update(file)
        .update("\0")
        .update(readFileSync(join(root, file)))
        .update("\0");
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

/** Inputs that define whether two same-machine oracle measurements are comparable. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getFontInstance, resolveFontKey } from "../src/render/font-resolution.js";
import { PORTABLE_CORPUS_PLATFORM } from "./font-conformance-synthetic-stacks.js";
import { probeSessionGenericFamilies } from "../src/capture/generic-font-probe.js";
import {
  ITALIC_SLNT,
  beginCharacterFallbackDocument,
  collectDarwinFontDataAfterOracleGc,
  clearPrimaryNotdefShapesAfterOracleGc,
  darwinFontDataIdentity,
  selectCharacterFallbackRendererScope,
  clearFontResolutionCaches,
  endCharacterFallbackDocument,
  hasPrimaryNotdefShape,
  primaryNotdefShapeKey,
  recordPrimaryNotdefShape,
  recordDarwinFontDataUse,
  type FontInstance,
  getFontSourceInfo,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKeyChain,
  resolveFontSpec,
  setSessionGenericFamilyOverrides,
  stackPrimaryIsSystemUi,
  stretchPercent,
  glyphHelperCodepointMemoSize,
  resolveInstalledFont,
  isHarfbuzzDefaultIgnorable,
  glyphIdForCp,
  queryIcuCodepoints,
} from "@domotion/text-engine/testing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One (family stack, size, weight, style) combination drawn from the corpus. */
export interface StackSpec {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  /** Per-stack content language. When present it overrides the CLI-wide language. */
  lang?: string;
  /** Computed `font-stretch` (e.g. "100%", "75%"). Chrome's CSS font matching
   *  selects on stretch BEFORE weight, so a condensed face is a different
   *  matching decision, not a variation on the same one. Optional so a corpus
   *  file written before DM-1858 still parses; absent is read as normal. */
  fontStretch?: string;
  /** Computed `font-variation-settings` (e.g. `"wght" 350`). An explicit axis
   *  location the author asked for, which the resolver must honor and which
   *  changes the face we instance (docs/99). */
  fontVariationSettings?: string;
  /**
   * Computed `font-feature-settings` (e.g. `"smcp" 1, "liga" 0`).
   *
   * Recorded for a different reason than its two siblings above, and the
   * difference is the whole point of the field. Stretch and variation settings
   * are face-SELECTION inputs — Blink hashes `variation_settings_` into
   * `FontDescription::CacheKey` (`platform/fonts/font_description.cc:308-338`),
   * so two descriptions differing in them resolve to different font data.
   * `feature_settings_` is deliberately absent from that key; its only consumer
   * in the whole tree is `FontFeatures::Initialize`
   * (`platform/fonts/shaping/font_features.cc:203-216`), which appends the
   * settings to the HarfBuzz feature array at SHAPING time. (Chromium checkout
   * `7d859f27`, 2026-06-27.)
   *
   * So this is not a question this oracle can answer — it is a question it must
   * stop suppressing. Without the property the probe page renders a fixture's
   * text with features off while the fixture renders it with them on, which is
   * a difference in what Chrome is being asked about even when the reported
   * face is the same. Recording it also carries the information forward to the
   * shaping oracle (docs/108), which is where the consequence lives.
   *
   * Optional so a corpus file extracted before this landed still parses;
   * absent is read as `normal`, i.e. exactly the old behavior.
   */
  fontFeatureSettings?: string;
  /**
   * Computed `font-variant-alternates` (e.g. `historical-forms`,
   * `stylistic(fancy)`).
   *
   * Blink hashes `font_variant_alternates_` into `FontDescription::CacheKey`
   * directly (`platform/fonts/font_description.cc:331`, and it is a real
   * discriminator — `FontCacheKey::GetHash` index 9 and `operator==`,
   * `platform/fonts/font_cache_key.h:104` and `:126-127`). So two descriptions
   * differing in it genuinely resolve to different font DATA.
   *
   * That is not the same as resolving to a different FACE, and the distinction
   * is what this comment exists to record. The thing that differs between those
   * two font-data objects is the resolved FEATURE list:
   * `FontDescription::ResolveFontFeatures` merges
   * `alternates->GetResolvedFontFeatures()` ahead of the `@font-face`
   * descriptor's own settings (`font_description.cc:559-578`), and
   * `FontFallbackList::ComputeFontFeatures` notes in as many words that
   * "Features for `font-variant-alternates` is set in `GetFontData`"
   * (`font_fallback_list.cc:238-239`). Measured accordingly on macOS across
   * `system-ui` / Georgia / Times: the reported face does not move.
   *
   * So this is recorded for the same reason as `fontFeatureSettings` above —
   * without it the probe page renders a fixture's text with alternates switched
   * off — and its consequence belongs to the shaping oracle (docs/108), not
   * here. (Chromium checkout `7d859f27`, 2026-06-27.)
   *
   * Optional so a corpus file extracted before this landed still parses.
   */
  fontVariantAlternates?: string;
  /**
   * Computed `font-variant-emoji` (`normal` / `text` / `emoji` / `unicode`).
   *
   * Unlike every other late addition to this key, this one IS a face-selection
   * input in the ordinary sense, and the face oracle can adjudicate it. Blink
   * packs `variant_emoji_` into the cache key's `options` word
   * (`platform/fonts/font_description.cc:312`), and the mechanism is
   * `ApplyFontVariantEmojiOnFallbackPriority`
   * (`platform/fonts/shaping/harfbuzz_shaper.cc:184-198`), which overrides the
   * run's `FontFallbackPriority` to `kEmojiEmoji` or `kText` before the fallback
   * iterator is built (`:983-984`) — i.e. it steers the color-emoji-vs-text
   * choice directly.
   *
   * Measured on macOS, and the face really does move:
   *
   *   U+2764   normal -> ZapfDingbatsITC      emoji -> AppleColorEmoji
   *   U+263A   normal -> Helvetica            emoji -> AppleColorEmoji
   *   U+1F600  normal -> AppleColorEmoji      text  -> .AppleColorEmojiUI
   *
   * Recorded here even though no fixture in the corpus declares it today, so a
   * fixture that starts to is swept under the question it actually asks rather
   * than silently as `normal`. Note the renderer does NOT yet honor it: our
   * `isEmojiPresentationCp` derives presentation from the codepoint's Unicode
   * properties alone and has no path for the CSS override.
   *
   * Optional so a corpus file extracted before this landed still parses.
   */
  fontVariantEmoji?: string;
  /** How many corpus fixtures contain at least one element with this combination. */
  fixtures: number;
  /**
   * A fixture that uses it, so a disagreement can be reproduced by hand.
   * Stored relative to its entry in `sources` — the corpus file is committed,
   * and an absolute path would pin it to one developer's checkout layout.
   */
  example: string;
}

/**
 * Bumped only when the digest's INPUTS change — see `harvestedCorpusIdentity`.
 *
 * v2 added `font-variant-alternates` and `font-variant-emoji` to the question
 * set, so every corpus's identity moves once and the three committed baselines
 * are owed a re-seed on their own runners.
 */
const HARVEST_IDENTITY_VERSION = 2;

/**
 * The corpus's identity, in the field the baseline comparator keys on.
 *
 * This used to be a wall-clock `generatedAt`, on the reasoning that re-extracting
 * can genuinely produce a different corpus and the comparator must refuse to
 * compare across that. The reasoning is right; the timestamp is a bad proxy for
 * it. A timestamp moves on EVERY re-extraction, including one that produces a
 * byte-identical corpus — so a routine re-extract silently withheld the gate on
 * all three platforms until someone spent three CI sweeps re-seeding baselines
 * that were never actually stale.
 *
 * So the identity is a digest of the QUESTIONS the corpus asks, mirroring what
 * `font-conformance-synthetic-stacks.ts` already does for the rule-derived
 * corpus. Two properties are deliberately excluded from it:
 *
 *   - `fixtures`, the count of corpus files using a stack. Adding a fixture that
 *     uses an existing stack changes no question the sweep asks.
 *   - `example`, which fixture is cited for reproduction. Pure provenance.
 *
 * and the keys are sorted independently of the corpus's own ordering, which is
 * by fixture count and therefore moves when those counts do. Without that sort
 * a single new fixture would reorder the array and change the digest — exactly
 * the false invalidation this replaces.
 *
 * What still moves it, correctly: a stack appearing or disappearing, or any
 * property of one changing. That is the discrimination the comparator wants.
 *
 * The PLATFORM is in the digest too, and that is deliberate rather than
 * defensive bookkeeping. Measured after this landed: the Linux and Windows
 * corpora harvest a byte-identical question set (both compute
 * `"Times New Roman"` where macOS computes `Times`), so without the platform
 * they would share an identity. They are still not interchangeable — the same
 * question gets a different answer on each — and the comparator's other guards
 * (runner image, font-inventory digest) do separate them today. But those are
 * both skipped when either side omits the field, which an older baseline does,
 * leaving the corpus identity as the only discriminator in exactly the case
 * where it would wrongly match. Folding the platform in removes the
 * dependency instead of relying on it.
 */
export function harvestedCorpusIdentity(stacks: StackSpec[], platform: string = process.platform): string {
  const questions = stacks
    .map((s) =>
      JSON.stringify([
        s.fontFamily,
        s.fontSize,
        s.fontWeight,
        s.fontStyle,
        s.fontStretch ?? "",
        s.fontVariationSettings ?? "",
        s.fontFeatureSettings ?? "",
        s.fontVariantAlternates ?? "",
        s.fontVariantEmoji ?? "",
      ]),
    )
    .sort();
  const h = createHash("sha256")
    .update(`harvested-stacks/v${HARVEST_IDENTITY_VERSION}\n`)
    .update(`${platform}\n`)
    .update(JSON.stringify(questions))
    .digest("hex")
    .slice(0, 16);
  return `harvested:v${HARVEST_IDENTITY_VERSION}:${h}`;
}

export interface StackCorpus {
  /**
   * A digest of the stacks, NOT a timestamp. See `harvestedCorpusIdentity`.
   * Older corpus files carry an ISO timestamp here; both compare by equality,
   * so a pre-digest baseline simply stays incomparable until re-seeded once.
   */
  generatedAt: string;
  /**
   * The platform the corpus was extracted on. Load-bearing, not bookkeeping:
   * a stack corpus is NOT portable between platforms, because the computed
   * `font-family` of an element that declares none is Chrome's per-platform
   * default-font preference. The corpus's single largest entry — 1,114 of the
   * 1,115 fixtures — computes as `Times` on macOS, `"Times New Roman"` on
   * Linux, and could differ again on Windows. Sweeping a macOS corpus on Linux
   * therefore asks Chrome about a stack no Linux page ever renders, which is
   * a different question than the one the renderer faces. Optional so a corpus
   * file written before the split still parses; absent is treated as unknown
   * and warned about rather than silently trusted.
   *
   * The one exempt value is `"any"` (`PORTABLE_CORPUS_PLATFORM`), which the
   * synthetic generator writes: a rule-derived corpus holds literal CSS
   * keywords rather than computed values, so it IS portable. See the guard in
   * `main` for the full reasoning.
   */
  platform?: string;
  sources: string[];
  stacks: StackSpec[];
}

/** A face as Chrome reports it. */
export interface ChromeFace {
  familyName: string;
  postScriptName?: string;
  glyphCount: number;
  isCustomFont?: boolean;
}

/**
 * A face as we resolve it.
 *
 * `path` / `postscriptName` describe the face the RENDERER WOULD LOAD — the
 * concrete cut, not the family's base table entry. `key` stays the logical
 * routing key (`helvetica`, `hiragino-jp`), because that is what the resolver
 * decided and what a fix would be made against; the cut is a second decision
 * `getFontInstance` makes on top of it, and both have to be right for the pixels
 * to match. See `faceFor`.
 */
export interface OurFace {
  key: string;
  path: string | null;
  postscriptName: string | null;
  /** False → no font covers the codepoint; the renderer draws the primary's `.notdef`. */
  covered: boolean;
}

type Verdict =
  /** Chrome's face and ours are the same face. */
  | "agree-exact"
  /** Same font FILE, reported under different PostScript names (see `identifyFace`). */
  | "agree-same-file"
  /** Different names, different files, reconciled by a documented alias (see FACE_ALIASES). */
  | "agree-alias"
  /**
   * Both sides draw tofu from the same face. No font covers the codepoint, so
   * we draw the run primary's `.notdef` — and Chrome, which reports the face it
   * SELECTED rather than the face that covered the character, names that same
   * primary. Agreement, and a large bucket: most of Unicode is uncovered in any
   * given stack.
   */
  | "agree-tofu"
  /** Neither Chrome nor we paint anything. */
  | "agree-not-painted"
  /** Chrome painted face A, we resolve face B. */
  | "mismatch"
  /** Chrome painted nothing; we would paint ink. */
  | "mismatch-we-paint"
  /** Chrome selected a face we did not find — we would tofu where Chrome paints. */
  | "mismatch-we-tofu";

interface MismatchRow {
  cp: number;
  cpHex: string;
  stack: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  lang: string;
  verdict: Verdict;
  /** Triage hint — see `mismatchClass`. Never an exemption, only a label. */
  class: "different-family" | "same-family-different-cut";
  chrome: string;
  chromeFamily: string;
  chromeAllFaces: string;
  chromeFile: string | null;
  ourKey: string;
  ourPostscript: string | null;
  ourFile: string | null;
  ourCovered: boolean;
}

export interface AllowlistEntry {
  /** Hex codepoint (`"0x20BF"`) or inclusive range (`"0x1F000-0x1F0FF"`). */
  cp: string;
  /** Exact `font-family` string the entry applies to; omit for "any stack". */
  stack?: string;
  /** Required. An entry without a reason is a harness error, not an exemption. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Codepoint universe
//
// Derived from the ICU tables compiled into this Node build (Unicode 16.0 on
// Node 22 / ICU 76), NOT from a list transcribed here — a hand-rolled list is
// exactly the kind of sampled artifact this tool exists to eliminate.
// ---------------------------------------------------------------------------

const RE_ASSIGNED = /\p{Assigned}/u;
const RE_NONCHARACTER = /\p{Noncharacter_Code_Point}/u;
const RE_CONTROL = /\p{Cc}/u;
const RE_PRIVATE_USE = /\p{Private_Use}/u;
const RE_MARK = /\p{M}/u;
const RE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Every codepoint the oracle is willing to ask about.
 *
 * Excluded, each for a mechanical reason rather than convenience:
 *  - **unassigned** (`\P{Assigned}`) — no character to paint.
 *  - **surrogates** (U+D800–DFFF) — `\p{Assigned}` counts them (gc=Cs) but they
 *    cannot appear as scalar values in text.
 *  - **noncharacters** (`\p{Noncharacter_Code_Point}`) — permanently reserved.
 *  - **C0/C1 controls** (`\p{Cc}`) — the HTML parser rewrites U+0000 to U+FFFD
 *    and treats CR/LF/TAB as whitespace, so Chrome's answer for these would
 *    describe a different codepoint than the one we asked about. Excluding them
 *    keeps every remaining row a true statement.
 *
 * Private-use codepoints ARE included by default (Chrome does paint some of
 * them — Apple's U+F8FF logo, for one) but they are 137k of the 292k total, so
 * `--no-pua` exists for a faster local run. It is a SUBSET, and the report says so.
 */
export function buildUniverse(opts: {
  includePua: boolean;
  ranges: Array<[number, number]> | null;
  sampleByte?: number | null;
}): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (opts.ranges != null && !opts.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
    // A low-byte bucket is a deterministic 1/256 stratified sample across the
    // entire Unicode space: bucket 00 contains U+0000, U+0100, U+0200, … rather
    // than one contiguous Latin-only page. Walking 00 through FF therefore
    // covers the exhaustive universe exactly once, with no random gaps or
    // duplicate rows between buckets.
    if (opts.sampleByte != null && (cp & 0xff) !== opts.sampleByte) continue;
    const ch = String.fromCodePoint(cp);
    if (!RE_ASSIGNED.test(ch)) continue;
    if (RE_NONCHARACTER.test(ch)) continue;
    if (RE_CONTROL.test(ch)) continue;
    if (!opts.includePua && RE_PRIVATE_USE.test(ch)) continue;
    out.push(cp);
  }
  return out;
}

/**
 * Codepoints that must be asked about ONE AT A TIME rather than in a shared
 * aggregation. Not used by the current per-node query path (which is already
 * one node per codepoint), but retained as the gate for the grouped fast path:
 * a combining mark or a default-ignorable can contribute zero or two glyphs to
 * a cell, which breaks the "N cells ⇒ N glyphs" invariant an aggregate query
 * would rely on.
 */
export function needsIsolatedQuery(cp: number): boolean {
  const ch = String.fromCodePoint(cp);
  return RE_MARK.test(ch) || RE_DEFAULT_IGNORABLE.test(ch);
}

// ---------------------------------------------------------------------------
// Face identity
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Exceptional cases where Chrome's name for a face and ours genuinely cannot
 * be reconciled mechanically. Keep this list SHORT and cite why — an entry here is
 * a claim that two differently-named things are the same face, and a wrong
 * claim silently converts a real defect into a pass.
 *
 * This is NOT the allowlist. The allowlist (`--allowlist`) records accepted
 * DIVERGENCES; these record naming, and every hit is counted and reported
 * separately (`agree-alias`) so its size stays visible. `--strict-alias`
 * re-classifies them as mismatches.
 */
export const FACE_ALIASES: Array<{ chrome: RegExp; ours: RegExp; reason: string }> = [];

/**
 * Triage label for a mismatch. PostScript names are conventionally
 * `Family-Cut` (`Arimo-Bold`, `.SFArabic-Regular`), and the two kinds of
 * disagreement want very different fixes:
 *
 *  - `different-family` — we routed the codepoint to a different typeface
 *    entirely (Chrome: SF Devanagari, us: Kohinoor Devanagari). A routing bug.
 *  - `same-family-different-cut` — right typeface, wrong weight/optical cut
 *    (Chrome: `Arimo-Bold`, us: `Arimo-Regular`). A cut-selection bug — or, for
 *    a variable face we instance along `wght` rather than naming a static cut,
 *    a name the oracle cannot prove either way. Both are reported; the label
 *    just says which pile to look in.
 */
export function mismatchClass(chrome: string, ours: string): "different-family" | "same-family-different-cut" {
  const stem = (s: string): string => norm(s.replace(/^\./, "").split("-")[0]);
  return stem(chrome) !== "" && stem(chrome) === stem(ours) ? "same-family-different-cut" : "different-family";
}

/** Cache for CoreText/DirectWrite name→file lookups of Chrome's reported faces. */
const chromeFileCache = new Map<string, string | null>();

/**
 * The file the platform font matcher resolves Chrome's reported face name to.
 *
 * Two guards, both of which exist because CoreText answers a bad name with a
 * plausible-looking wrong one rather than an error:
 *
 *  - Names beginning with `.` are Apple's hidden system faces (`.SFNS-Bold`,
 *    `.SFArabic-Regular`, `.ThonburiUI-Regular`). CoreText refuses to look them
 *    up by name ("Client requested name X, it will get TimesNewRomanPSMT rather
 *    than the intended font") and hands back Times New Roman, so a lookup here
 *    would manufacture agreement with any face that happens to be Times.
 *  - For every other name, the resolved face's own PostScript name must match
 *    what we asked for. Anything else is a substitution, not a resolution.
 */
function chromeFaceFile(face: ChromeFace): string | null {
  const name = face.postScriptName ?? face.familyName;
  if (name === "" || name.startsWith(".")) return null;
  const hit = chromeFileCache.get(name);
  if (hit !== undefined) return hit;
  let path: string | null = null;
  try {
    const found = resolveInstalledFont(name);
    if (found != null && norm(found.postscriptName) === norm(name)) path = found.path;
  } catch {
    path = null;
  }
  chromeFileCache.set(name, path);
  return path;
}

/**
 * Are Chrome's face and ours the same face?
 *
 * Three tiers, strongest first, each reported separately so the summary shows
 * how much of the agreement rests on the weaker ones:
 *
 *  1. `agree-exact`     — same PostScript name.
 *  2. `agree-same-file` — Chrome's PostScript name resolves (through the same
 *     platform font matcher Chrome used) to the file we picked. This covers
 *     entries in our path tables that carry no PostScript name of their own.
 *
 *     Only consulted when at least one side is NAMELESS, because a `.ttc`
 *     collection holds several faces behind one path: Helvetica Regular and
 *     Helvetica Bold are both `/System/Library/Fonts/Helvetica.ttc`, so a
 *     file match between two faces we can both NAME, whose names differ, is
 *     evidence of a shared collection and not of a shared face. Letting it pass
 *     is how a wrong-cut pick hides — it is exactly what concealed the family
 *     base-vs-cut defect this tier used to paper over.
 *  3. `agree-alias`     — a documented entry in FACE_ALIASES.
 */
export function identifyFace(chrome: ChromeFace, ours: OurFace, strictAlias: boolean): Verdict | null {
  const cName = norm(chrome.postScriptName ?? chrome.familyName);
  if (cName.length < 2) return null;
  if (ours.postscriptName != null && norm(ours.postscriptName) === cName) return "agree-exact";

  // Both sides named, and the names differ ⇒ the shared file below cannot be
  // read as a shared face. `chrome.postScriptName` specifically: when Chrome
  // reports only a family name we are not comparing two PostScript names, and
  // the file resolution is still the best evidence available.
  const bothNamed = chrome.postScriptName != null && ours.postscriptName != null;
  const cFile = bothNamed ? null : chromeFaceFile(chrome);
  if (cFile != null && ours.path != null && cFile === ours.path) return "agree-same-file";

  if (!strictAlias) {
    const mine = `${norm(ours.key)} ${norm(ours.path != null ? basename(ours.path) : "")} ${norm(ours.postscriptName ?? "")}`;
    for (const a of FACE_ALIASES) {
      if (a.chrome.test(cName) && a.ours.test(` ${mine}`)) return "agree-alias";
    }
  }
  return null;
}

/** Grade one single-codepoint face-selection result. */
export function verdictForCodepoint(
  cp: number,
  chrome: ChromeFace | null,
  ours: OurFace,
  strictAlias: boolean,
): Verdict {
  // HarfBuzz replaces default-ignorables with the current font's space glyph
  // at zero advance, or deletes them (`hb_ot_hide_default_ignorables`,
  // hb-ot-shape.cc:824-846, rev 4de187d). CDP still reports the selected run
  // face, so comparing that bookkeeping face would manufacture a mismatch for
  // output neither Chromium nor Domotion paints.
  if (isHarfbuzzDefaultIgnorable(cp)) return "agree-not-painted";
  if (chrome == null) return ours.covered ? "mismatch-we-paint" : "agree-not-painted";
  const id = identifyFace(chrome, ours, strictAlias);
  if (ours.covered) return id ?? "mismatch";
  return id != null ? "agree-tofu" : "mismatch-we-tofu";
}

// ---------------------------------------------------------------------------
// Our side
// ---------------------------------------------------------------------------

/** Mirrors `slantForStyle` in packages/text-engine/src/render/text-to-path.ts (not exported there). */
export function slantForStyle(style: string): number {
  const s = style.toLowerCase();
  return s === "italic" || s.startsWith("oblique") ? ITALIC_SLNT : 0;
}

export interface ResolvedStack {
  spec: StackSpec;
  chain: string[];
  primaryKey: string;
  primary: NonNullable<ReturnType<typeof getFontInstance>>;
  slant: number;
  /** Computed `font-stretch` as a percentage, 100 = `normal`. */
  stretch: number;
  variationSettings: Record<string, number> | undefined;
  /**
   * key → face, memoized for the life of this stack.
   *
   * Scoped to the stack rather than the process because the answer DEPENDS on
   * the stack's weight / size / style: `helvetica` is Helvetica-Bold at 700 and
   * Helvetica-Light at 300. A process-global cache keyed on the font key alone
   * would serve the first stack's cut to every later one.
   */
  faceCache: Map<string, { path: string | null; postscriptName: string | null }>;
  /** The face whose `.notdef` the renderer draws when nothing covers a codepoint. */
  notdefDonor: OurFace;
}

/**
 * Reproduce exactly what `renderTextAsPath` does before it starts resolving
 * codepoints (packages/text-engine/src/render/text-to-path.ts): primary instance via `resolveFont`,
 * primary KEY via `resolveFontKey` — which falls back to `times` when nothing
 * in the stack is recognized, where `resolveFontKeyChain` returns an empty
 * list — and the full declared chain via `resolveFontKeyChain`. Taking the
 * primary key from `chain[0]` instead would silently drop every stack whose
 * families we don't recognize, which is precisely the population most likely
 * to disagree with Chrome.
 */
/**
 * Parse a computed `font-variation-settings` into the axis map `getFontInstance`
 * takes. `"wght" 350, "wdth" 87` → `{ wght: 350, wdth: 87 }`; `normal` → null.
 *
 * DM-1858: previously the oracle never read this property at all, so an author
 * axis location swept as though it were the default — our side was asked a
 * different question than the probe page rendered.
 */
export function parseVariationSettings(value: string | undefined): Record<string, number> | null {
  if (value == null || value.trim() === "" || value.trim() === "normal") return null;
  const out: Record<string, number> = {};
  for (const m of value.matchAll(/["']([A-Za-z0-9]{4})["']\s*([-\d.]+)/g)) {
    const n = Number(m[2]);
    if (Number.isFinite(n)) out[m[1]] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function prepareStack(spec: StackSpec, lang?: string): ResolvedStack | null {
  // A per-stack language mirrors each probe cell's `lang`; otherwise the CLI
  // default mirrors the probe page's `<html lang>`. The renderer resolves the
  // settings-mapped generics per content script (Playwright's forScripts
  // tables on mac/win), so the oracle must ask our side the same question the
  // probe page asks Chrome.
  lang = spec.lang ?? lang;
  const slant = slantForStyle(spec.fontStyle);
  const stretch = stretchPercent(spec.fontStretch);
  const variationSettings = parseVariationSettings(spec.fontVariationSettings) ?? undefined;
  const description = { weight: spec.fontWeight, size: spec.fontSize, slant, stretch, variationSettings };
  const chain = resolveFontKeyChain(spec.fontFamily, lang, description);
  const primaryKey = resolveFontKey(spec.fontFamily, lang, description);
  // The renderer opens its primary through `resolveFont`, which retains the
  // winning family's route (notably `system-ui` versus an explicitly named SF
  // family), applies named optical-cut pins, and lets author axes win. Opening
  // only `primaryKey` loses that provenance and omits the CSS `wght` axis on
  // macOS system-ui, making the oracle compare a different font instance.
  const primary = resolveFont(spec.fontFamily, spec.fontWeight, spec.fontSize, slant, variationSettings, stretch, lang);
  if (primary == null) return null;
  const rs: ResolvedStack = {
    spec,
    chain,
    primaryKey,
    primary,
    slant,
    stretch,
    variationSettings,
    faceCache: new Map(),
    // Placeholder — `faceFor` needs the stack, so the real donor is filled in
    // immediately below.
    notdefDonor: { key: primaryKey, path: null, postscriptName: null, covered: false },
  };
  rs.notdefDonor = faceFor(rs, primaryKey, false, primary);
  return rs;
}

/**
 * The face the RENDERER would load for `key` in this stack.
 *
 * This is deliberately NOT `resolveFontSpec(key)`. That returns the family's
 * BASE entry, and `getFontInstance` makes a second, weight- and slant-dependent
 * decision on top of the key — `-bold` / `-italic` / `-bold-italic` siblings,
 * the sub-bold cut (`helvetica-light` below 300), the Hiragino Sans W0…W9
 * ladder, `cjk-bold`, `korean-bold`, `lucida-grande-bold`, the PingFang Medium
 * subfont. Comparing the base entry against Chrome's answer, which IS
 * weight-selected, is wrong in both directions: it invents mismatches where we
 * would have rendered the right cut, and — worse — hides real ones behind the
 * `agree-same-file` tier, since every cut of a `.ttc` family shares one path.
 *
 * So the instance is materialized exactly the way the renderer materializes it
 * (`res.fontOverride ?? (key === primaryKey ? primaryFont : getFontInstance(…))`
 * — packages/text-engine/src/render/text-to-path.ts) and its identity read back off the instance:
 * the CoreText-style instantiated name first when the darwin helper path
 * cloned the face at a non-default axis location (Chrome names such clones
 * with the coordinates baked in — `.SFDevanagari-Regular_opsz110000_wght`,
 * hex 16.16 — and `instantiatedPostscriptName` is composed from the
 * coordinates the renderer actually applied, so a genuine axis divergence
 * still reads as a mismatch), then fontkit's own `postscriptName` (the face
 * actually opened, including the resolved member of a `.ttc`), then the path
 * table's declared name, then the `sysfb:` key's embedded name.
 */
export function faceFor(rs: ResolvedStack, key: string, covered: boolean, override: FontInstance | null): OurFace {
  // A per-codepoint override (webfont partition, decomposition-shaping instance)
  // is not a property of the key, so it must not populate or read the cache.
  const cacheable = override == null;
  const hit = cacheable ? rs.faceCache.get(key) : undefined;
  if (hit !== undefined) return { key, path: hit.path, postscriptName: hit.postscriptName, covered };

  const materialize = (): FontInstance | null =>
    key === rs.primaryKey
      ? rs.primary
      : getFontInstance(key, rs.spec.fontWeight, rs.spec.fontSize, rs.slant, undefined, rs.stretch);
  let inst = override ?? materialize();
  let src = getFontSourceInfo(inst);
  // An override with no identity of its own (a synthetic shaping wrapper) tells
  // us nothing about which file was used — fall back to the key's own instance
  // rather than reporting a nameless face.
  if (src == null && inst?.postscriptName == null && override != null) {
    inst = materialize();
    src = getFontSourceInfo(inst);
  }
  const spec = resolveFontSpec(key);
  // A `sysfb:` key carries the PostScript name the platform matcher returned.
  const fromKey = key.startsWith("sysfb:") ? key.slice("sysfb:".length) : null;
  const meta = {
    path: src?.path ?? spec?.path ?? null,
    postscriptName:
      inst?.instantiatedPostscriptName ??
      inst?.postscriptName ??
      src?.postscriptName ??
      spec?.postscriptName ??
      fromKey,
  };
  if (cacheable) rs.faceCache.set(key, meta);
  return { key, path: meta.path, postscriptName: meta.postscriptName, covered };
}

export function ourFaceFor(cp: number, rs: ResolvedStack, lang: string | undefined): OurFace {
  const r = resolveFontForCodepoint(
    cp,
    rs.primary,
    rs.primaryKey,
    rs.spec.fontWeight,
    rs.spec.fontSize,
    rs.slant,
    rs.variationSettings,
    lang,
    rs.chain,
    // DM-1859: the oracle must ask the question the RENDERER asks, and the
    // renderer distinguishes a `system-ui` primary from an explicitly-named
    // "SF Pro" even though both share the `sf-pro` key. Omitting this would
    // measure a different code path than the one that paints — the exact
    // instrument defect this tool was corrected for once already.
    stackPrimaryIsSystemUi(rs.spec.fontFamily, lang, {
      weight: rs.spec.fontWeight,
      size: rs.spec.fontSize,
      slant: rs.slant,
      stretch: rs.stretch,
      variationSettings: rs.variationSettings,
    }),
    rs.stretch,
    undefined,
    // The renderer passes the raw declaration because Blink's standard-style
    // retry reopens the first declared family, not whichever fallback key the
    // stack walk happened to resolve. Omitting it made the oracle bypass the
    // Windows/Linux retry while claiming to measure the production question.
    rs.spec.fontFamily,
  );
  // An uncovered codepoint has no resolved face of its own — the renderer draws
  // the run primary's `.notdef`, so THAT is the face to compare against Chrome.
  return r.covered ? faceFor(rs, r.key, true, r.fontOverride) : rs.notdefDonor;
}

/** The one-scalar canonical form for a CJK compatibility ideograph. */
export function cjkCanonicalSingleton(cp: number): number | null {
  if (!((cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f))) return null;
  const source = String.fromCodePoint(cp);
  const nfd = source.normalize("NFD");
  return nfd !== source && [...nfd].length === 1 ? nfd.codePointAt(0)! : null;
}

/** The face the renderer paints a CJK compatibility ideograph in. Blink walks
 * the declared families in order and shapes the cell with each; HarfBuzz's
 * normalizer decomposes a codepoint the font lacks into its canonical form and
 * keeps the font when that form is covered (`decompose_current_character`,
 * `hb-ot-shape-normalize.cc`, rev 4de187d). The renderer's shape-first splitter
 * reproduces that, so a declared family that covers only the canonical scalar
 * still owns the cell — while the oracle's fast per-codepoint seam leaves
 * decomposition to shaping and walks on to system fallback.
 *
 * Applied to EVERY such cell, never only to cells that disagree with Chrome:
 * an oracle that re-routes only after seeing a mismatch can remove
 * disagreements but never reveal one. Invoking the full splitter per cell
 * exhausts its WASM lifetime in a long sweep, hence this bounded coverage walk;
 * `tests/font-conformance.test.ts` pins it against the real splitter. */
export function cjkCanonicalRendererFace(cp: number, rs: ResolvedStack, ours: OurFace): OurFace {
  // Windows remains gated until its native shaped splitter can be compared
  // with Chromium for locale-specific compatibility ideographs. The fast seam
  // alone disagrees with Chrome on several zh-Hans cells.
  if (process.platform === "win32" || process.env.DOMOTION_CLUSTER_FALLBACK === "0") return ours;
  const canonical = cjkCanonicalSingleton(cp);
  if (canonical == null) return ours;
  const shapeKey = primaryNotdefShapeKey(
    String.fromCodePoint(cp),
    `${rs.spec.fontFamily}|${rs.primaryKey}`,
    rs.spec.fontWeight,
    rs.spec.fontSize,
    rs.slant,
    rs.stretch,
    parseVariationSettings(rs.spec.fontVariationSettings) ?? undefined,
    undefined,
  );
  if (hasPrimaryNotdefShape(shapeKey)) return rs.notdefDonor;
  for (const key of new Set([rs.primaryKey, ...rs.chain])) {
    const inst =
      key === rs.primaryKey
        ? rs.primary
        : getFontInstance(key, rs.spec.fontWeight, rs.spec.fontSize, rs.slant, undefined, rs.stretch);
    if (inst == null) continue;
    if (glyphIdForCp(inst, cp) !== 0 || glyphIdForCp(inst, canonical) !== 0) {
      return faceFor(rs, key, true, inst);
    }
  }
  if (!ours.covered) recordPrimaryNotdefShape(shapeKey);
  return ours;
}

// ---------------------------------------------------------------------------
// Chrome side
// ---------------------------------------------------------------------------

/**
 * Ask Chrome which face it painted, one cell per codepoint.
 *
 * Batching: each page holds `batch` cells; the whole batch's node ids come back
 * in ONE `DOM.querySelectorAll`, and the per-cell `CSS.getPlatformFontsForNode`
 * calls are pipelined `concurrency`-at-a-time over the CDP session rather than
 * awaited serially. A page of block-level cells lays out several times slower
 * than these `inline-block` cells.
 *
 * Each cell is its own inline-block, which establishes its own block formatting
 * context. That is what keeps the answers honest: shaping cannot cross the
 * boundary, so a combining mark in one cell can neither attach to nor change
 * the font selected for its neighbor.
 */
/**
 * The probe page for one batch of codepoints in one stack.
 *
 * Its own function, and exported, so the declaration list can be asserted
 * without a browser. Every property the corpus records has to reach this
 * markup: a property extracted but not declared here is a property the oracle
 * still sweeps as though it were absent, which is precisely the failure mode
 * that hid `font-stretch`, `font-variation-settings` and `font-feature-settings`
 * for as long as it did — the answer looked stable because the question was
 * never asked.
 */
export function probePageHtml(cps: number[], spec: StackSpec, lang: string): string {
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style id="oracle-probe-style">` +
    probePageCss(spec) +
    `</style></head><body><div id=w>${probeCellsHtml(cps, spec.lang ?? lang)}</div></body></html>`
  );
}

function probeCellsHtml(cps: number[], lang: string): string {
  return cps.map((cp) => `<i class=c lang="${lang}">&#x${cp.toString(16)};</i>`).join("");
}

function probePageCss(spec: StackSpec): string {
  // The computed `font-family` is already valid CSS and goes into a <style>
  // element, not an attribute — so it is embedded verbatim. Rewriting its
  // quotes would corrupt any family name that legitimately contains one.
  const family = spec.fontFamily;
  return (
    `body{margin:0}` +
    `#w{display:flex;flex-wrap:wrap;font-family:${family};font-size:${spec.fontSize}px;` +
    `font-weight:${spec.fontWeight};font-style:${spec.fontStyle};` +
    `font-stretch:${spec.fontStretch ?? "normal"};` +
    `font-variation-settings:${spec.fontVariationSettings ?? "normal"};` +
    // Declared even though Blink does NOT select a face on it — `feature_settings_`
    // is absent from `FontDescription::CacheKey` and is read only by
    // `FontFeatures::Initialize` at shaping time. It belongs here anyway,
    // because without it the probe page renders a fixture's text with the
    // features the fixture declares switched off, and a feature that
    // substitutes glyphs (`smcp`, `frac`, `tnum`) changes what Chrome paints
    // and therefore which faces it reports having used.
    `font-feature-settings:${spec.fontFeatureSettings ?? "normal"};` +
    // Declared for the same reason as `font-feature-settings` above: it resolves
    // to OpenType features rather than to a different face, so it does not move
    // the reported face — but leaving it out renders the fixture's text with the
    // alternates it declares switched off.
    //
    // Fidelity limit worth stating rather than eliding: the NAMED forms
    // (`stylistic(fancy)`, `styleset(display)`, `swash(ornate)`, …) only resolve
    // against an `@font-feature-values` rule, which the corpus does not harvest
    // and this page therefore does not carry. Those values round-trip as
    // computed values and activate no feature here. `historical-forms` needs no
    // at-rule and is fully faithful.
    `font-variant-alternates:${spec.fontVariantAlternates ?? "normal"};` +
    // This one genuinely selects a face — it overrides the run's
    // `FontFallbackPriority`, which is what picks a color-emoji face over a text
    // face — so omitting it would sweep an emoji-presentation question as its
    // opposite.
    `font-variant-emoji:${spec.fontVariantEmoji ?? "normal"}}` +
    // `white-space:pre` is load-bearing: without it a cell holding U+0020 (or
    // any other space separator) collapses to nothing, Chrome paints no
    // glyph, and the oracle reports a mismatch that only exists because of
    // how the probe page was written.
    // `font-style:inherit` undoes the UA italic on `<i>` — the cell must be
    // rendered in the style the corpus entry declares, not in the tag's.
    `.c{display:inline-block;width:${spec.fontSize + 8}px;height:${spec.fontSize + 8}px;` +
    `overflow:hidden;font-style:inherit;white-space:pre}`
  );
}

/** See `layOutBatch`. Generous rather than tuned — it exists to distinguish a
 *  slow layout from a hung one, and only the second reading should fail a run. */
const PROBE_LAYOUT_TIMEOUT_MS = 120_000;

/** A noncharacter forces Blink to report the generic's `.notdef` donor,
 * without asking the platform fallback cache about an assigned codepoint.
 * That exposes the Page's configured family even when an ordinary probe glyph
 * would paint through a different fallback face. */
const ORACLE_CONTROL_CODEPOINT = String.fromCodePoint(0x10ffff);
const ORACLE_CONTROL_FAMILIES = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "math"] as const;

export async function probeOracleControlSignature(page: Page, cdp: CDPSession, lang = "en"): Promise<string[]> {
  // Keep the measured document and its renderer state intact. setContent here
  // would introduce an extra navigation between every two sweep batches.
  await page.evaluate(
    ({ families, codepoint, lang }) => {
      const container = document.createElement("div");
      container.id = "font-conformance-oracle-controls";
      container.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
      for (const family of families) {
        const cell = document.createElement("span");
        cell.className = "font-conformance-oracle-control";
        cell.lang = lang;
        cell.style.cssText = `display:inline-block;font:normal 400 16px ${family}`;
        cell.textContent = codepoint;
        container.append(cell);
      }
      (document.body ?? document.documentElement).append(container);
      container.getBoundingClientRect();
    },
    { families: [...ORACLE_CONTROL_FAMILIES], codepoint: ORACLE_CONTROL_CODEPOINT, lang },
  );
  try {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "#font-conformance-oracle-controls .font-conformance-oracle-control",
    });
    if (nodeIds.length !== ORACLE_CONTROL_FAMILIES.length) {
      throw new Error(`oracle controls: expected ${ORACLE_CONTROL_FAMILIES.length} cells, got ${nodeIds.length}`);
    }
    const results = await Promise.all(nodeIds.map((nodeId) => cdp.send("CSS.getPlatformFontsForNode", { nodeId })));
    return results.map((result, index) => {
      const face = primaryChromeFace(result.fonts as ChromeFace[]);
      if (face == null) throw new Error(`oracle control ${ORACLE_CONTROL_FAMILIES[index]} painted no face`);
      return `${ORACLE_CONTROL_FAMILIES[index]}=${face.postScriptName ?? face.familyName}`;
    });
  } finally {
    await page.evaluate(() => document.getElementById("font-conformance-oracle-controls")?.remove());
  }
}

interface PlaywrightFontFamilies {
  fontFamilies: Record<string, string>;
  forScripts?: Array<{ script: string; fontFamilies: Record<string, string> }>;
}

let playwrightMacFontFamilies: PlaywrightFontFamilies | null = null;

function configuredPlaywrightMacFontFamilies(): PlaywrightFontFamilies {
  if (playwrightMacFontFamilies != null) return playwrightMacFontFamilies;
  // Read the exact table used by this installed Playwright version. Copying
  // family names here would quietly diverge when Playwright changes its
  // Common or script-specific preferences in a later dependency update.
  const require = createRequire(import.meta.url);
  const playwrightRoot = dirname(require.resolve("playwright-core/package.json"));
  const internal = require(join(playwrightRoot, "lib/server/chromium/defaultFontFamilies.js")) as {
    platformToFontFamilies: { mac?: PlaywrightFontFamilies };
  };
  const families = internal.platformToFontFamilies.mac;
  if (families == null) throw new Error("oracle: installed Playwright has no macOS font preference table");
  playwrightMacFontFamilies = families;
  return families;
}

/** Reassert the exact headless Page preference table through a one-use agent.
 * InspectorPageAgent rejects a second `Page.setFontFamilies` on one session;
 * detaching this fresh session retains Settings on the measured Page. */
export async function reassertPlaywrightMacFontFamilies(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Page.setFontFamilies", configuredPlaywrightMacFontFamilies());
  } finally {
    await session.detach();
  }
}

/** Abort a sweep when the same browser Page changes font settings mid-run.
 * Such a report describes two different Chrome oracles and cannot be compared
 * to one resolver answer or ratified as a baseline. */
export class OracleStabilityGuard {
  private expected: string[] | null = null;

  initialSignature(): string[] | null {
    return this.expected == null ? null : [...this.expected];
  }

  observe(actual: readonly string[], at = "oracle control"): void {
    if (this.expected == null) {
      this.expected = [...actual];
      return;
    }
    if (actual.length !== this.expected.length || actual.some((face, index) => face !== this.expected![index])) {
      throw new OracleDriftError(at, this.expected, actual);
    }
  }
}

export class OracleDriftError extends Error {
  constructor(
    readonly at: string,
    readonly expected: readonly string[],
    readonly actual: readonly string[],
    readonly kind: "generic-control" | "supplementary-pua" = "generic-control",
    readonly codepoint: number | null = null,
  ) {
    super(
      (kind === "supplementary-pua"
        ? `oracle supplementary PUA face diverged from the stack primary at ${at}: `
        : `oracle font settings changed during sweep at ${at}: `) +
        `expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
}

/** Resolve the browser-reported cut and ask its own cmap whether the PUA
 * codepoint is a real glyph. A covered PUA belongs in conformance scoring;
 * an unreadable or ambiguous file also stays a mismatch rather than being
 * mislabeled as instability. */
const chromeCoverageFontCache = new Map<string, ReturnType<typeof fontkit.openSync> | null>();

function chromeFaceCoversCodepoint(face: ChromeFace, cp: number): boolean | null {
  const path = chromeFaceFile(face);
  if (path == null) return null;
  try {
    let opened = chromeCoverageFontCache.get(path);
    if (opened === undefined) {
      try {
        opened = fontkit.openSync(path);
      } catch {
        opened = null;
      }
      chromeCoverageFontCache.set(path, opened);
    }
    if (opened == null) return null;
    if (norm(opened.postscriptName ?? "") !== norm(face.postScriptName ?? face.familyName)) return null;
    return opened.hasGlyphForCodePoint(cp);
  } catch {
    return null;
  }
}

/** The fixed-image macOS sans-serif/32/700 route that flipped from Helvetica
 * to Arial in the middle of Plane 16 PUA. Restricting the check to this route
 * avoids treating a different stack's intentional PUA font as oracle drift. */
export function assertSupplementaryPuaOracleFace(
  spec: StackSpec,
  cp: number,
  faces: ChromeFace[],
  ours: OurFace,
  chromePrimary: string | null,
  at: string,
  platform: NodeJS.Platform = process.platform,
  coversCodepoint: (face: ChromeFace, cp: number) => boolean | null = chromeFaceCoversCodepoint,
): void {
  if (
    platform !== "darwin" ||
    spec.fontFamily.trim().toLowerCase() !== "sans-serif" ||
    spec.fontSize !== 32 ||
    spec.fontWeight !== 700 ||
    spec.fontStyle !== "normal" ||
    cp < 0xf0000 ||
    cp > 0x10fffd ||
    ours.covered ||
    chromePrimary == null
  ) {
    return;
  }
  const face = primaryChromeFace(faces);
  if (face == null) return;
  const actual = face.postScriptName ?? face.familyName;
  if (actual !== chromePrimary && coversCodepoint(face, cp) === false) {
    throw new OracleDriftError(at, [chromePrimary], [actual], "supplementary-pua", cp);
  }
}

export class ChromeOracle {
  private readonly stability = new OracleStabilityGuard();
  private readonly preferenceRepairs: Array<{ at: string; expected: string[]; actual: string[] }> = [];
  private readonly maxPreferenceRepairs = 3;
  private probeCss: string | null = null;
  private documentMarker: string | null = null;
  private initialDocumentTimeOrigin: number | null = null;
  private initialLoaderId: string | null = null;
  constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly concurrency: number,
    private readonly lang: string,
    private readonly reuseDocument = process.platform === "darwin",
    private readonly preferenceReplay: ((page: Page) => Promise<void>) | null = null,
  ) {}

  static async create(browser: Browser, concurrency: number, lang: string): Promise<ChromeOracle> {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    // Resolve settings-backed families from the exact Chromium context whose
    // answers this oracle compares. Browser launch shape and Playwright's
    // Page.setFontFamilies override are runtime inputs to Blink, not constants
    // that can be transcribed from the Chromium checkout.
    const generics = await probeSessionGenericFamilies(ctx);
    if (generics == null) {
      throw new Error("oracle: Chromium session-family probe did not stabilize");
    }
    setSessionGenericFamilyOverrides(generics);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    return new ChromeOracle(
      page,
      cdp,
      concurrency,
      lang,
      process.platform === "darwin",
      process.platform === "darwin" ? reassertPlaywrightMacFontFamilies : null,
    );
  }

  /**
   * The face Chrome resolves this stack's PRIMARY to, asked once and directly.
   *
   * Worth having as its own field rather than reading it off the per-codepoint
   * tally, because the tally is dominated by it and that hid where a defect
   * lived. Unassigned, private-use and noncharacter codepoints — most of the
   * universe — terminate on the primary's `.notdef`, so Chrome reports the
   * PRIMARY for them; only codepoints something else covers report a fallback.
   * A `sans-serif` stack therefore tallies ~108k "Helvetica" answers that are
   * really one answer repeated, and when the primary flips they all move at
   * once. Two runs of one commit did exactly that (`Helvetica-Bold -108,466`,
   * `Arial-BoldMT +108,466`, exactly balanced), and the tally could not say
   * whether one stack had moved wholesale or many had drifted.
   *
   * Uses `A` — covered by every primary in the corpus — so the answer is the
   * primary itself and not a fallback decision.
   */
  async resolvedPrimary(spec: StackSpec): Promise<string | null> {
    const faces = await this.facesFor([0x41], spec);
    if (this.preferenceReplay != null) {
      await this.assertStable(
        `after primary ${spec.fontFamily} @${spec.fontSize}/${spec.fontWeight}/${spec.fontStyle}`,
      );
    }
    const f = primaryChromeFace(faces[0] ?? []);
    return f == null ? null : (f.postScriptName ?? f.familyName);
  }

  /** Establish an independent weak shape-cache epoch for each synthetic stack.
   * The Page/renderer and Blink's strong character-fallback map persist. A new
   * document plus dropped CDP node bindings makes old ShapeResults unreachable;
   * Chromium GC then clears weak entries before the next stack is shaped. */
  async clearWeakShapeResultsForNextStack(): Promise<void> {
    if (this.probeCss == null) return;
    await this.page.locator("#w").evaluate((wrapper) => wrapper.replaceChildren());
    await this.page.goto("about:blank");
    this.probeCss = null;
    this.documentMarker = null;
    this.initialDocumentTimeOrigin = null;
    this.initialLoaderId = null;
    // CDP's DOM agent may retain inspected node ids even after removal. Drop
    // those frontend bindings so the old ShapeResults are actually weak.
    await this.cdp.send("DOM.disable");
    await this.cdp.send("DOM.enable");
    await this.cdp.send("HeapProfiler.collectGarbage");
  }

  /** Keep one document per stack and one renderer/font-setting authority for
   * the sweep.
   * `setContent` on every batch rewrote the document thousands of times; on
   * native macOS full slices the six generic donors sometimes changed from
   * Playwright's Page settings to Blink constructor defaults mid-stack. Replace
   * only the measured cells and change the CSS when the stack changes. The
   * sequence of font questions stays stack order then ascending codepoint.
   * One bounded retry handles an overloaded 8,000-cell layout. */
  private async layOutBatch(cps: number[], spec: StackSpec): Promise<void> {
    const css = probePageCss(spec);
    const firstBatch = this.probeCss == null;
    const render = async () => {
      if (firstBatch || !this.reuseDocument) {
        await this.page.setContent(probePageHtml(cps, spec, this.lang), { timeout: PROBE_LAYOUT_TIMEOUT_MS });
        if (this.reuseDocument && firstBatch) {
          this.documentMarker = randomUUID();
          this.initialDocumentTimeOrigin = await this.page.evaluate((marker) => {
            (window as typeof window & { domotionOracleDocumentMarker?: string }).domotionOracleDocumentMarker = marker;
            return performance.timeOrigin;
          }, this.documentMarker);
          const { frameTree } = await this.cdp.send("Page.getFrameTree");
          this.initialLoaderId = frameTree.frame.loaderId;
        }
      } else {
        await this.page.locator("#w").evaluate(
          (wrapper, { cells, css, changeCss }) => {
            // Remove the old cells before changing styles so they cannot cause
            // an extra font query under the next stack's CSS.
            wrapper.replaceChildren();
            if (changeCss) {
              const style = document.getElementById("oracle-probe-style");
              if (style == null) throw new Error("oracle: missing probe style");
              style.textContent = css;
            }
            wrapper.innerHTML = cells;
            wrapper.getBoundingClientRect();
          },
          { cells: probeCellsHtml(cps, spec.lang ?? this.lang), css, changeCss: css !== this.probeCss },
          { timeout: PROBE_LAYOUT_TIMEOUT_MS },
        );
      }
    };
    try {
      await render();
    } catch (e) {
      process.stdout.write(`    (oracle layout slow — retrying this batch once: ${(e as Error).message})\n`);
      await render();
    }
    this.probeCss = css;
  }

  async facesFor(cps: number[], spec: StackSpec): Promise<ChromeFace[][]> {
    if (this.preferenceReplay != null) {
      await this.prepareMeasurement(
        `before macOS Page preference replay ${spec.fontFamily} @${spec.fontSize}/${spec.fontWeight}/${spec.fontStyle}` +
          ` U+${(cps[0] ?? 0).toString(16).toUpperCase().padStart(6, "0")}`,
      );
      await this.preferenceReplay(this.page);
      await this.assertStable("after macOS Page preference replay");
    }
    await this.layOutBatch(cps, spec);
    const { root } = await this.cdp.send("DOM.getDocument");
    const { nodeIds } = await this.cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".c" });
    if (nodeIds.length !== cps.length) {
      throw new Error(`oracle: asked for ${cps.length} cells, page produced ${nodeIds.length}`);
    }
    const out: ChromeFace[][] = [];
    for (let i = 0; i < nodeIds.length; i += this.concurrency) {
      const slice = nodeIds.slice(i, i + this.concurrency);
      const rs = await Promise.all(slice.map((nodeId) => this.cdp.send("CSS.getPlatformFontsForNode", { nodeId })));
      for (const r of rs) out.push(r.fonts as ChromeFace[]);
    }
    return out;
  }

  async assertStable(at: string): Promise<void> {
    this.stability.observe(await probeOracleControlSignature(this.page, this.cdp, this.lang), at);
  }

  controlSignature(): string[] | null {
    return this.stability.initialSignature();
  }

  /** Restore an idle-interval macOS Page setting reset before asking the next
   * measured question. A flip during a batch still fails the strict post-batch
   * check, and an unrecoverable or repeatedly resetting Page still aborts. */
  async prepareMeasurement(at: string): Promise<void> {
    try {
      await this.assertStable(at);
    } catch (error) {
      if (
        !(error instanceof OracleDriftError) ||
        error.kind !== "generic-control" ||
        this.preferenceReplay == null ||
        this.preferenceRepairs.length >= this.maxPreferenceRepairs
      ) {
        throw error;
      }
      if (this.documentMarker != null) {
        const identity = await this.page.evaluate(() => ({
          marker: (window as typeof window & { domotionOracleDocumentMarker?: string }).domotionOracleDocumentMarker,
          timeOrigin: performance.timeOrigin,
        }));
        const { frameTree } = await this.cdp.send("Page.getFrameTree");
        if (
          identity.marker !== this.documentMarker ||
          identity.timeOrigin !== this.initialDocumentTimeOrigin ||
          frameTree.frame.loaderId !== this.initialLoaderId
        ) {
          throw error;
        }
      }
      try {
        await this.preferenceReplay(this.page);
      } catch {
        // Preserve the diagnosed donor change and its artifact if CDP cannot
        // restore the Page; the failed replay cannot validate any report.
        throw error;
      }
      await this.assertStable(`after macOS Page preference repair at ${at}`);
      this.preferenceRepairs.push({ at, expected: [...error.expected], actual: [...error.actual] });
    }
  }

  preferenceRepairEvents(): ReadonlyArray<{ at: string; expected: string[]; actual: string[] }> {
    return this.preferenceRepairs;
  }

  /** Abort-only inspection: never called while a report could still pass. */
  async diagnoseDrift(): Promise<Record<string, unknown>> {
    const document = await this.page.evaluate(() => ({
      marker:
        (window as typeof window & { domotionOracleDocumentMarker?: string }).domotionOracleDocumentMarker ?? null,
      timeOrigin: performance.timeOrigin,
    }));
    const { frameTree } = await this.cdp.send("Page.getFrameTree");
    const beforeReplay = await probeOracleControlSignature(this.page, this.cdp, this.lang);
    await reassertPlaywrightMacFontFamilies(this.page);
    const afterReplay = await probeOracleControlSignature(this.page, this.cdp, this.lang);
    return {
      expectedDocumentMarker: this.documentMarker,
      actualDocumentMarker: document.marker,
      expectedTimeOrigin: this.initialDocumentTimeOrigin,
      actualTimeOrigin: document.timeOrigin,
      expectedLoaderId: this.initialLoaderId,
      actualLoaderId: frameTree.frame.loaderId,
      beforeReplay,
      afterReplay,
    };
  }

  async close(): Promise<void> {
    await this.page.context().close();
  }
}

/**
 * The face that paints most of a cell.
 *
 * Blink accumulates platform-font usage into a hash map keyed by face and then
 * serializes it, so the protocol array's ORDER is not a documented ranking —
 * picking the highest glyph count is the only stable reading. For a one-
 * codepoint cell there is normally exactly one entry anyway; more than one
 * means the codepoint decomposed across faces, which the report records in
 * `chromeAllFaces`.
 */
export function primaryChromeFace(faces: ChromeFace[]): ChromeFace | null {
  let best: ChromeFace | null = null;
  for (const f of faces) {
    if (best == null || f.glyphCount > best.glyphCount) best = f;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Stack corpus extraction
// ---------------------------------------------------------------------------

/**
 * The stack corpus for a platform.
 *
 * One file per platform rather than one shared file — see `StackCorpus.platform`
 * for why they genuinely differ. The name uses `process.platform`'s own spelling
 * (`darwin` / `linux` / `win32`) so the file and the guard can never drift.
 */
export function stacksFileFor(platform: string): string {
  return `tools/font-conformance-stacks.${platform}.json`;
}

const DEFAULT_STACKS_FILE = stacksFileFor(process.platform);

function walkHtml(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".html")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Derive the font stacks to sweep from the fixture corpus rather than inventing
 * them: load every fixture and collect the COMPUTED `font-family` / size /
 * weight / style of every element that directly contains text. Inventing the
 * list would reintroduce the sampling problem one level up.
 */
export async function extractStacks(browser: Browser, dirs: string[], outFile: string): Promise<StackCorpus> {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const tally = new Map<string, { spec: Omit<StackSpec, "fixtures" | "example">; fixtures: number; example: string }>();
  const files: Array<{ path: string; label: string }> = [];
  for (const d of dirs) {
    for (const p of walkHtml(d)) files.push({ path: p, label: `${d}/${p.slice(d.length).replace(/^\/+/, "")}` });
  }
  let n = 0;
  for (const { path: file, label } of files) {
    n++;
    if (n % 50 === 0) process.stderr.write(`  extract ${n}/${files.length}\n`);
    try {
      await page.goto(`file://${resolve(file)}`, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
    } catch {
      continue; // a fixture that won't load contributes no stacks
    }
    const found = await page.evaluate(() => {
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll("*"))) {
        let hasText = false;
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === 3 && (node.textContent ?? "").trim() !== "") {
            hasText = true;
            break;
          }
        }
        if (!hasText) continue;
        const cs = getComputedStyle(el);
        seen.add(
          JSON.stringify({
            fontFamily: cs.fontFamily,
            fontSize: Math.round(parseFloat(cs.fontSize)),
            fontWeight: parseInt(cs.fontWeight, 10) || 400,
            fontStyle: cs.fontStyle,
            // DM-1858: previously absent from the key, so every condensed face and
            // every explicit axis location swept as though it were the default.
            fontStretch: cs.fontStretch,
            fontVariationSettings: cs.fontVariationSettings,
            // Not a face-selection input in Blink (see `StackSpec`), but leaving
            // it out meant the probe page rendered a fixture's text with the
            // features the fixture declares switched off.
            fontFeatureSettings: cs.fontFeatureSettings,
            // Resolves to features rather than to a face, like the line above.
            fontVariantAlternates: cs.fontVariantAlternates,
            // This one DOES select a face: it overrides the run's fallback
            // priority, which is what chooses a color-emoji face over a text one.
            fontVariantEmoji: cs.fontVariantEmoji,
          }),
        );
      }
      return Array.from(seen);
    });
    for (const s of found) {
      const spec = JSON.parse(s) as Omit<StackSpec, "fixtures" | "example">;
      const hit = tally.get(s);
      if (hit == null) tally.set(s, { spec, fixtures: 1, example: label });
      else hit.fixtures++;
    }
  }
  await ctx.close();
  const stacks: StackSpec[] = Array.from(tally.values())
    .map((v) => ({ ...v.spec, fixtures: v.fixtures, example: v.example }))
    .sort((a, b) => b.fixtures - a.fixtures || a.fontFamily.localeCompare(b.fontFamily));
  const corpus: StackCorpus = {
    // A digest of the stacks, not the wall clock: re-extracting a corpus that
    // asks the same questions must stay comparable to its baseline.
    generatedAt: harvestedCorpusIdentity(stacks),
    platform: process.platform,
    sources: dirs,
    stacks,
  };
  writeFileSync(outFile, `${JSON.stringify(corpus, null, 2)}\n`);
  return corpus;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface CompiledAllowlist {
  entries: Array<{ lo: number; hi: number; stack?: string; reason: string }>;
  hits: number[];
}

export function loadAllowlist(file: string): CompiledAllowlist {
  if (!existsSync(file)) return { entries: [], hits: [] };
  const raw = JSON.parse(readFileSync(file, "utf-8")) as { entries?: AllowlistEntry[] };
  const entries = (raw.entries ?? []).map((e, i) => {
    if (typeof e.reason !== "string" || e.reason.trim().length < 10) {
      throw new Error(
        `allowlist entry ${i} (${e.cp}) has no usable \`reason\`. Every accepted divergence must say why.`,
      );
    }
    const m = /^\s*(0x[0-9a-fA-F]+)\s*(?:-\s*(0x[0-9a-fA-F]+))?\s*$/.exec(e.cp);
    if (m == null)
      throw new Error(`allowlist entry ${i}: \`cp\` must be "0xNNNN" or "0xNNNN-0xNNNN", got ${JSON.stringify(e.cp)}`);
    const lo = parseInt(m[1], 16);
    const hi = m[2] != null ? parseInt(m[2], 16) : lo;
    return { lo, hi, stack: e.stack, reason: e.reason };
  });
  return { entries, hits: entries.map(() => 0) };
}

export function allowlisted(al: CompiledAllowlist, cp: number, stack: string): boolean {
  for (let i = 0; i < al.entries.length; i++) {
    const e = al.entries[i];
    if (cp < e.lo || cp > e.hi) continue;
    if (e.stack != null && e.stack !== stack) continue;
    al.hits[i]++;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface Options {
  stacksFile: string;
  extractStacks: boolean;
  sources: string[];
  ranges: Array<[number, number]> | null;
  /** Low byte (00..FF) selected across the whole assigned Unicode universe. */
  sampleByte: number | null;
  includePua: boolean;
  shard: [number, number] | null;
  stackShard: [number, number] | null;
  batch: number;
  concurrency: number;
  outDir: string;
  allowlistFile: string;
  strictAlias: boolean;
  maxStacks: number | null;
  stackFilter: string | null;
  maxRows: number;
  lang: string;
  resetEvery: number;
  /** Sweep a corpus whose recorded platform is not this one. See `StackCorpus.platform`. */
  allowForeignCorpus: boolean;
}

export function parseArgs(argv: string[]): Options {
  try {
    parseFlags(argv, {
      stacks: { type: "string" },
      "extract-stacks": { type: "boolean" },
      source: { type: "string" },
      range: { type: "string", multiple: true },
      "sample-byte": { type: "string" },
      "no-pua": { type: "boolean" },
      shard: { type: "string" },
      "stack-shard": { type: "string" },
      batch: { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string" },
      allowlist: { type: "string" },
      "strict-alias": { type: "boolean" },
      "max-stacks": { type: "string" },
      "stack-filter": { type: "string" },
      "max-rows": { type: "string" },
      "reset-every": { type: "string" },
      "allow-foreign-corpus": { type: "boolean" },
      lang: { type: "string" },
      h: { type: "boolean" },
      help: { type: "boolean" },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown option"))
      throw new Error(`unknown option${error.message.slice("Unknown option".length)}`);
    throw error;
  }
  const o: Options = {
    stacksFile: DEFAULT_STACKS_FILE,
    extractStacks: false,
    sources: ["external/html-test", "../html-test/unicode"],
    ranges: null,
    sampleByte: null,
    includePua: true,
    shard: null,
    stackShard: null,
    batch: 8000,
    concurrency: 128,
    outDir: "tests/output/font-conformance",
    allowlistFile: "tools/font-conformance-allowlist.json",
    strictAlias: false,
    maxStacks: null,
    stackFilter: null,
    maxRows: 20_000,
    lang: "en",
    resetEvery: 1,
    allowForeignCorpus: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--stacks":
        o.stacksFile = next();
        break;
      case "--extract-stacks":
        o.extractStacks = true;
        break;
      case "--source":
        o.sources = next()
          .split(",")
          .map((s) => s.trim());
        break;
      case "--range": {
        o.ranges ??= [];
        for (const part of next().split(",")) {
          const m = /^\s*([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?\s*$/.exec(part);
          if (m == null) throw new Error(`--range wants hex like 0000-2FFF, got ${part}`);
          const lo = parseInt(m[1], 16);
          o.ranges.push([lo, m[2] != null ? parseInt(m[2], 16) : lo]);
        }
        break;
      }
      case "--sample-byte": {
        const value = next();
        if (!/^[0-9a-fA-F]{2}$/.test(value)) {
          throw new Error(`--sample-byte wants exactly two hex digits from 00 to FF, got ${value}`);
        }
        o.sampleByte = parseInt(value, 16);
        break;
      }
      case "--no-pua":
        o.includePua = false;
        break;
      case "--shard": {
        const shard = parseShardSpec(next());
        if (shard == null) throw new Error("--shard wants i/N");
        o.shard = [shard.index, shard.total];
        break;
      }
      case "--stack-shard": {
        const shard = parseShardSpec(next());
        if (shard == null) throw new Error("--stack-shard wants i/N");
        o.stackShard = [shard.index, shard.total];
        break;
      }
      case "--batch":
        o.batch = intFlag(a, next());
        break;
      case "--concurrency":
        o.concurrency = intFlag(a, next());
        break;
      case "--out":
        o.outDir = next();
        break;
      case "--allowlist":
        o.allowlistFile = next();
        break;
      case "--strict-alias":
        o.strictAlias = true;
        break;
      case "--max-stacks":
        o.maxStacks = intFlag(a, next());
        break;
      case "--stack-filter":
        o.stackFilter = next();
        break;
      case "--max-rows":
        o.maxRows = intFlag(a, next());
        break;
      case "--reset-every":
        o.resetEvery = intFlag(a, next(), 0);
        break;
      case "--allow-foreign-corpus":
        o.allowForeignCorpus = true;
        break;
      case "--lang":
        o.lang = next();
        break;
      case "-h":
      case "--help":
        process.stdout.write(readFileSync(new URL(import.meta.url).pathname, "utf-8").split("*/")[0]);
        process.exit(0);
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  if (o.sampleByte != null && o.ranges != null) {
    throw new Error("--sample-byte and --range select different sampling schemes; use only one");
  }
  return o;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** The complete CSS signature is the unit of per-stack comparison. */
export function stackKey(spec: StackSpec, defaultLang: string): string {
  return (
    `${spec.fontFamily} @${spec.fontSize}/${spec.fontWeight}/${spec.fontStyle}` +
    (spec.fontStretch != null && spec.fontStretch !== "100%" ? `/${spec.fontStretch}` : "") +
    (spec.fontVariationSettings != null && spec.fontVariationSettings !== "normal"
      ? `/${spec.fontVariationSettings}`
      : "") +
    (spec.fontFeatureSettings != null && spec.fontFeatureSettings !== "normal" ? `/${spec.fontFeatureSettings}` : "") +
    (spec.fontVariantAlternates != null && spec.fontVariantAlternates !== "normal"
      ? `/${spec.fontVariantAlternates}`
      : "") +
    (spec.fontVariantEmoji != null && spec.fontVariantEmoji !== "normal" ? `/${spec.fontVariantEmoji}` : "") +
    ` lang=${spec.lang ?? defaultLang}`
  );
}

export function oracleScopeKey(platform: NodeJS.Platform, lang: string): string {
  return platform === "linux" ? lang : "shared";
}

export function shouldResetBatch(resetEvery: number, batchNo: number): boolean {
  return resetEvery > 0 && batchNo > 0 && batchNo % resetEvery === 0;
}

/** Read and validate a corpus before opening a browser. */
export function loadCorpus(
  opts: Pick<Options, "stacksFile" | "allowForeignCorpus">,
  platform: NodeJS.Platform = process.platform,
): { corpus: StackCorpus | null; message: string | null; warning: string | null } {
  if (!existsSync(opts.stacksFile)) {
    return {
      corpus: null,
      message:
        `no stack corpus at ${opts.stacksFile} — run with --extract-stacks first ` +
        `(the corpus is per-platform; see --allow-foreign-corpus)\n`,
      warning: null,
    };
  }
  const corpus = JSON.parse(readFileSync(opts.stacksFile, "utf-8")) as StackCorpus;
  if (corpus.platform !== platform && corpus.platform !== PORTABLE_CORPUS_PLATFORM) {
    const what = corpus.platform ?? "(unrecorded)";
    if (!opts.allowForeignCorpus) {
      return {
        corpus: null,
        message:
          `stack corpus ${opts.stacksFile} was extracted on ${what}, this host is ${platform}.\n` +
          `A corpus is not portable: the computed font-family of an element that declares none is\n` +
          `Chrome's per-platform default-font preference (macOS "Times" vs Linux "Times New Roman"),\n` +
          `so sweeping it here would ask about stacks no page on this platform renders.\n` +
          `Re-extract with --extract-stacks, or pass --allow-foreign-corpus to sweep it anyway.\n`,
        warning: null,
      };
    }
    return {
      corpus,
      message: null,
      warning: `WARNING: sweeping a ${what} corpus on ${platform} (--allow-foreign-corpus)\n`,
    };
  }
  return { corpus, message: null, warning: null };
}

/** Apply the two independent stride shards after filtering the full corpus. */
export function selectStacksAndUniverse(
  corpus: StackCorpus,
  opts: Options,
): {
  stacks: StackSpec[];
  universe: number[];
} {
  let stacks = corpus.stacks;
  if (opts.stackFilter != null) {
    const needle = opts.stackFilter.toLocaleLowerCase("en-US");
    stacks = stacks.filter((s) => JSON.stringify(s).toLocaleLowerCase("en-US").includes(needle));
    if (stacks.length === 0) throw new Error(`--stack-filter matched no stacks: ${opts.stackFilter}`);
  }
  if (opts.maxStacks != null) stacks = stacks.slice(0, opts.maxStacks);
  if (opts.stackShard != null) {
    const [i, n] = opts.stackShard;
    stacks = stacks.filter((_, idx) => idx % n === i - 1);
  }
  let universe = buildUniverse({
    includePua: opts.includePua,
    ranges: opts.ranges,
    sampleByte: opts.sampleByte,
  });
  if (opts.shard != null) {
    const [i, n] = opts.shard;
    universe = universe.filter((_, idx) => idx % n === i - 1);
  }
  return { stacks, universe };
}

/** Reuse one Chromium renderer per locale on Linux and one shared renderer elsewhere. */
export class OracleRegistry<T extends { close(): Promise<void> }> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly create: (lang: string) => Promise<T>,
  ) {}

  forLang(lang: string): Promise<T> {
    const key = oracleScopeKey(this.platform, lang);
    const hit = this.entries.get(key);
    if (hit != null) return hit;
    const pending = this.create(lang).catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    return pending;
  }

  async close(): Promise<void> {
    try {
      await Promise.all([...this.entries.values()].map(async (entry) => (await entry).close()));
    } finally {
      this.entries.clear();
    }
  }
}

/** Bounded row retention with exact counts and an ordered resolver digest. */
export class SweepTally {
  readonly counts: Record<Verdict, number> = {
    "agree-exact": 0,
    "agree-same-file": 0,
    "agree-alias": 0,
    "agree-tofu": 0,
    "agree-not-painted": 0,
    mismatch: 0,
    "mismatch-we-paint": 0,
    "mismatch-we-tofu": 0,
  };
  readonly mismatches: MismatchRow[] = [];
  readonly pairCounts = new Map<string, number>();
  readonly stackCounts = new Map<string, number>();
  readonly chromeFaceTally = new Map<string, number>();
  readonly classCounts = { "different-family": 0, "same-family-different-cut": 0 };
  readonly stackPrimaries: Array<{
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    fontStyle: string;
    chromePrimary: string | null;
    ourPrimaryKey: string;
  }> = [];
  readonly resolverAnswerHash = createHash("sha256");
  mismatchRowsSeen = 0;
  allowlistedCount = 0;
  skippedStacks = 0;
  chromeMs = 0;
  oursMs = 0;
  peakRssMb = 0;
  peakMemoEntries = 0;

  constructor(
    readonly maxRows: number,
    readonly defaultLang: string,
    readonly strictAlias: boolean,
    readonly allowlist: CompiledAllowlist,
  ) {}

  record(spec: StackSpec, cp: number, chromeFaces: ChromeFace[], ours: OurFace): void {
    const chrome = primaryChromeFace(chromeFaces);
    if (chrome != null) {
      const face = chrome.postScriptName ?? chrome.familyName;
      this.chromeFaceTally.set(face, (this.chromeFaceTally.get(face) ?? 0) + 1);
    }
    this.resolverAnswerHash.update(
      `${JSON.stringify([stackKey(spec, this.defaultLang), cp, ours.key, ours.postscriptName, ours.path, ours.covered])}\n`,
    );
    const verdict = verdictForCodepoint(cp, chrome, ours, this.strictAlias);
    this.counts[verdict]++;
    if (!verdict.startsWith("mismatch")) return;
    if (allowlisted(this.allowlist, cp, spec.fontFamily)) {
      this.allowlistedCount++;
      this.counts[verdict]--;
      return;
    }
    const chromeName = chrome?.postScriptName ?? chrome?.familyName ?? "(none)";
    const ourName = ours.postscriptName ?? ours.key;
    const cls = mismatchClass(chromeName, ourName);
    this.mismatchRowsSeen++;
    this.classCounts[cls]++;
    const pair = `${chromeName} → ${ourName}`;
    this.pairCounts.set(pair, (this.pairCounts.get(pair) ?? 0) + 1);
    const key = stackKey(spec, this.defaultLang);
    this.stackCounts.set(key, (this.stackCounts.get(key) ?? 0) + 1);
    if (this.mismatches.length >= this.maxRows) return;
    this.mismatches.push({
      cp,
      cpHex: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      stack: spec.fontFamily,
      fontSize: spec.fontSize,
      fontWeight: spec.fontWeight,
      fontStyle: spec.fontStyle,
      lang: spec.lang ?? this.defaultLang,
      verdict,
      class: cls,
      chrome: chromeName,
      chromeFamily: chrome?.familyName ?? "(none)",
      chromeAllFaces: chromeFaces
        .map((face) => `${face.postScriptName ?? face.familyName}×${face.glyphCount}`)
        .join("+"),
      chromeFile: chrome != null ? chromeFaceFile(chrome) : null,
      ourKey: ours.key,
      ourPostscript: ours.postscriptName,
      ourFile: ours.path,
      ourCovered: ours.covered,
    });
  }
}

export interface FontConformanceReportInput {
  opts: Options;
  corpus: StackCorpus;
  universeLength: number;
  stackLength: number;
  oracleIsolation: string;
  oracleDonorSignatures: ReadonlyArray<{ scope: string; lang: string; faces: readonly string[] }>;
  oraclePreferenceRepairs?: ReadonlyArray<{ at: string; expected: string[]; actual: string[] }>;
  resolverAnswerDigest: string;
  tally: SweepTally;
  wallMs: number;
  generatedAt: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  unicode: string | undefined;
  icu: string | undefined;
  chromiumVersion: string;
  parityEnv: Record<string, unknown>;
  rotationRevision: string | null;
  rotationOrdinal: string | null;
  rotationStackBucket: string | null;
  host: Record<string, unknown>;
  fontInventory: Record<string, unknown> | null;
}

/** Compose a report from completed sweep evidence; no browser or filesystem access. */
export function buildReport(input: FontConformanceReportInput) {
  const {
    opts,
    corpus,
    universeLength,
    stackLength,
    oracleIsolation,
    oracleDonorSignatures,
    oraclePreferenceRepairs,
    resolverAnswerDigest,
    tally,
    wallMs,
    generatedAt,
    platform,
    arch,
    nodeVersion,
    unicode,
    icu,
    chromiumVersion,
    parityEnv,
    rotationRevision,
    rotationOrdinal,
    rotationStackBucket,
    host,
    fontInventory,
  } = input;
  const {
    counts,
    mismatches,
    pairCounts,
    stackCounts,
    chromeFaceTally,
    classCounts,
    stackPrimaries,
    mismatchRowsSeen,
    allowlistedCount,
    skippedStacks,
    chromeMs,
    oursMs,
    peakRssMb,
    allowlist,
  } = tally;
  const comparisons = Object.values(counts).reduce((a, b) => a + b, 0) + allowlistedCount;
  const mismatchTotal = counts.mismatch + counts["mismatch-we-paint"] + counts["mismatch-we-tofu"];
  const topPairs = Array.from(pairCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topStacks = Array.from(stackCounts.entries()).sort((a, b) => b[1] - a[1]);

  return {
    meta: {
      generatedAt: generatedAt,
      platform: platform,
      arch: arch,
      node: nodeVersion,
      unicode: unicode,
      icu: icu,
      // The build that produced every answer on the CHROME side, and the most
      // load-bearing field in this block — Blink's font selection is what is
      // being measured, so a different browser is a different oracle.
      //
      // It was missing until a `font-variant-emoji` divergence read as
      // Windows-specific for a week and turned out to be a version
      // difference: ©/™/‼/☺ move to the color font under the CSS property in
      // 147.0.7727.15 and stay on the primary in 148.0.7778.96, measured on
      // ONE host with the platform held constant. Nothing recorded here could
      // have shown that, while `image`, `fontInventory` and `icu` all matched.
      //
      // Read from the launched browser, never inferred from the Playwright
      // revision directory: the Windows VM launches a 148 build out of a
      // folder named `chromium-1217`, which is where the confusion started.
      chromium: chromiumVersion,
      parityEnvironment: parityEnv,
      rotationRevision: rotationRevision,
      rotationOrdinal: rotationOrdinal,
      rotationStackBucket: rotationStackBucket,
      stacksFile: opts.stacksFile,
      stackCorpusGeneratedAt: corpus.generatedAt,
      stackCorpusPlatform: corpus.platform ?? null,
      stackFilter: opts.stackFilter,
      allowForeignCorpus: opts.allowForeignCorpus,
      codepoints: universeLength,
      stacks: stackLength - skippedStacks,
      skippedStacks,
      includePua: opts.includePua,
      ranges: opts.ranges,
      sampleByte: opts.sampleByte,
      shard: opts.shard,
      stackShard: opts.stackShard,
      strictAlias: opts.strictAlias,
      maxRows: opts.maxRows,
      lang: opts.lang,
      resetEvery: opts.resetEvery,
      oracleIsolation,
      oracleDonorSignatures,
      ...(oraclePreferenceRepairs == null
        ? {}
        : { oraclePreferenceRepairs: { count: oraclePreferenceRepairs.length, events: oraclePreferenceRepairs } }),
      resolverAnswerDigest,
      // DM-1922. Attribution fields for an intermittent, Chrome-side flip of
      // the `sans-serif` generic's primary, seen four times in real runs and
      // never once in ~2,000 probe samples across 32 runner allocations. The
      // detector catches it; nothing recorded where it happened.
      //
      // `host` and `fontInventory` are per-SHARD, deliberately. This workflow
      // shards one stack per shard, so the flipping stack sweeps alone on one
      // machine — a run-level record cannot name it, and cannot show two
      // shards disagreeing about the font set.
      host: host,
      fontInventory: fontInventory,
      stackPrimaries,
      peakRssMb,
      wallMs,
      chromeMs,
      oursMs,
      comparisonsPerSecond: Math.round((comparisons / wallMs) * 1000),
    },
    summary: {
      verdictStage: "face-selection",
      comparisons,
      ...counts,
      allowlisted: allowlistedCount,
      mismatchTotal,
      mismatchDifferentFamily: classCounts["different-family"],
      mismatchSameFamilyDifferentCut: classCounts["same-family-different-cut"],
      /**
       * How many DISTINCT (chrome face → our face) routes disagree. A single
       * wrong primary turns every uncovered codepoint in a stack into a
       * mismatch, so the raw count measures blast radius while this measures
       * how many decisions are actually wrong.
       */
      distinctMismatchPairs: pairCounts.size,
      verdict: mismatchTotal === 0 ? "exact-logical-agreement" : "logical-mismatch",
    },
    rowsRetained: mismatches.length,
    rowsTruncated: mismatchRowsSeen - mismatches.length,
    mismatchesByStack: topStacks.map(([stack, count]) => ({ stack, count })),
    chromeFaces: Array.from(chromeFaceTally.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([face, count]) => ({ face, count })),
    topMismatchPairs: topPairs.map(([pair, count]) => ({ pair, count })),
    allowlist: allowlist.entries.map((e, i) => ({
      cp: e.lo === e.hi ? `0x${e.lo.toString(16)}` : `0x${e.lo.toString(16)}-0x${e.hi.toString(16)}`,
      stack: e.stack ?? null,
      reason: e.reason,
      hits: allowlist.hits[i],
    })),
    mismatches,
  };
}

/** Format only completed report evidence; writing the summary stays with main. */
export function formatSummary(
  report: ReturnType<typeof buildReport>,
  opts: Options,
  corpus: StackCorpus,
  tally: SweepTally,
  universeLength: number,
  stackLength: number,
): string {
  const {
    counts,
    mismatches,
    pairCounts,
    stackCounts,
    chromeFaceTally,
    classCounts,
    mismatchRowsSeen,
    allowlistedCount,
    skippedStacks,
    chromeMs,
    oursMs,
    peakRssMb,
    peakMemoEntries,
  } = tally;
  const comparisons = report.summary.comparisons;
  const mismatchTotal = report.summary.mismatchTotal;
  const wallMs = report.meta.wallMs;
  const topPairs = Array.from(pairCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topStacks = Array.from(stackCounts.entries()).sort((a, b) => b[1] - a[1]);
  const lines: string[] = [];
  const pct = (n: number): string => `${((n / Math.max(1, comparisons)) * 100).toFixed(3)}%`;
  lines.push(`font-conformance — ${report.meta.platform} ${report.meta.arch}, Unicode ${report.meta.unicode}`);
  lines.push(`corpus             ${opts.stacksFile} (extracted on ${corpus.platform ?? "?"})`);
  lines.push(`chrome faces seen  ${chromeFaceTally.size}`);
  lines.push(
    `comparisons        ${comparisons.toLocaleString()}  (${universeLength.toLocaleString()} cps × ${stackLength - skippedStacks} stacks)`,
  );
  lines.push(
    `wall               ${(wallMs / 1000).toFixed(1)}s  (chrome ${(chromeMs / 1000).toFixed(1)}s, ours ${(oursMs / 1000).toFixed(1)}s)`,
  );
  lines.push(`throughput         ${Math.round((comparisons / wallMs) * 1000).toLocaleString()} comparisons/s`);
  lines.push(`peak rss           ${peakRssMb} MB  (memo reset every ${opts.resetEvery || "never"} batches)`);
  // Retained, not transient. A figure near the batch size means the reset is
  // reaching the per-codepoint memos; one near `codepoints × stacks` means it
  // is not, and the run is on its way to the heap limit however healthy the
  // peak RSS above looks.
  lines.push(`peak fallback memo ${peakMemoEntries.toLocaleString()} entries  (batch ${opts.batch.toLocaleString()})`);
  lines.push("");
  lines.push(`agree exact        ${counts["agree-exact"].toLocaleString()}  ${pct(counts["agree-exact"])}`);
  lines.push(`agree same-file    ${counts["agree-same-file"].toLocaleString()}  ${pct(counts["agree-same-file"])}`);
  lines.push(`agree alias        ${counts["agree-alias"].toLocaleString()}  ${pct(counts["agree-alias"])}`);
  lines.push(`agree tofu         ${counts["agree-tofu"].toLocaleString()}  ${pct(counts["agree-tofu"])}`);
  lines.push(`agree not-painted  ${counts["agree-not-painted"].toLocaleString()}  ${pct(counts["agree-not-painted"])}`);
  lines.push(`allowlisted        ${allowlistedCount.toLocaleString()}`);
  lines.push("");
  lines.push(`MISMATCH wrong face      ${counts.mismatch.toLocaleString()}  ${pct(counts.mismatch)}`);
  lines.push(
    `MISMATCH we paint, Chrome doesn't  ${counts["mismatch-we-paint"].toLocaleString()}  ${pct(counts["mismatch-we-paint"])}`,
  );
  lines.push(
    `MISMATCH we tofu, Chrome paints    ${counts["mismatch-we-tofu"].toLocaleString()}  ${pct(counts["mismatch-we-tofu"])}`,
  );
  lines.push(`MISMATCH total     ${mismatchTotal.toLocaleString()}  ${pct(mismatchTotal)}`);
  lines.push(`  of which different family       ${classCounts["different-family"].toLocaleString()}`);
  lines.push(`  of which same family, other cut ${classCounts["same-family-different-cut"].toLocaleString()}`);
  lines.push(`  distinct disagreeing routes     ${pairCounts.size.toLocaleString()}`);
  lines.push(
    `example rows in report.json     ${mismatches.length.toLocaleString()}` +
      (mismatchRowsSeen > mismatches.length
        ? ` (${(mismatchRowsSeen - mismatches.length).toLocaleString()} more not kept — raise --max-rows)`
        : ""),
  );
  if (topStacks.length > 0) {
    lines.push("");
    lines.push("mismatches by stack:");
    for (const [stack, count] of topStacks) lines.push(`  ${String(count).padStart(8)}  ${stack}`);
  }
  if (topPairs.length > 0) {
    lines.push("");
    lines.push("top disagreeing pairs (chrome → ours):");
    for (const [pair, count] of topPairs.slice(0, 40)) lines.push(`  ${String(count).padStart(8)}  ${pair}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Sweep one CSS stack, preserving its resolver reset and locale scope. */
export interface SweepOperations {
  platform: NodeJS.Platform;
  selectScope: typeof selectCharacterFallbackRendererScope;
  prepare: typeof prepareStack;
  reset: typeof clearFontResolutionCaches;
  faceFor: typeof ourFaceFor;
  cjkCanonicalFace?: typeof cjkCanonicalRendererFace;
  primeCodepoints: (codepoints: readonly number[]) => void;
  chromeFaceCoversCodepoint?: (face: ChromeFace, cp: number) => boolean | null;
  memoSize: typeof glyphHelperCodepointMemoSize;
  rssMb: () => number;
  write: (message: string) => void;
}

const sweepOperations: SweepOperations = {
  platform: process.platform,
  selectScope: selectCharacterFallbackRendererScope,
  prepare: prepareStack,
  reset: clearFontResolutionCaches,
  faceFor: ourFaceFor,
  cjkCanonicalFace: cjkCanonicalRendererFace,
  // A low-byte sample touches one codepoint in each 256-codepoint ICU page.
  // Scalar queries would expand and evict entire pages, then repeat that work
  // for every stack. Fetch the exact batch once so native classification keeps
  // its answers while the per-codepoint walk reads a bounded memo.
  primeCodepoints: (codepoints) => {
    queryIcuCodepoints(codepoints);
  },
  memoSize: glyphHelperCodepointMemoSize,
  rssMb: () => Math.round(process.memoryUsage().rss / 1024 / 1024),
  write: (message) => process.stdout.write(message),
};

export async function sweepStack(
  spec: StackSpec,
  stackIndex: number,
  stackCount: number,
  universe: number[],
  opts: Options,
  oracle: Pick<ChromeOracle, "resolvedPrimary" | "facesFor"> &
    Partial<Pick<ChromeOracle, "assertStable" | "clearWeakShapeResultsForNextStack" | "controlSignature">>,
  tally: SweepTally,
  t0: number,
  operations: SweepOperations = sweepOperations,
): Promise<void> {
  if (operations.platform === "darwin" || operations.platform === "win32") {
    await oracle.clearWeakShapeResultsForNextStack?.();
    collectDarwinFontDataAfterOracleGc();
    clearPrimaryNotdefShapesAfterOracleGc();
  }
  if (operations.platform === "linux") operations.selectScope(spec.lang ?? opts.lang);
  let rs = operations.prepare(spec, opts.lang);
  if (rs == null) {
    tally.skippedStacks++;
    operations.write(`  SKIP (no resolvable primary): ${spec.fontFamily}\n`);
    return;
  }
  operations.write(
    `  stack ${stackIndex + 1}/${stackCount}: ${spec.fontFamily} @${spec.fontSize}px/${spec.fontWeight}/${spec.fontStyle}` +
      ` lang=${spec.lang ?? opts.lang} → chain [${rs.chain.join(", ")}]\n`,
  );
  // Ask Chrome for this stack's primary before sweeping it, and record it.
  // See `resolvedPrimary` — this is the quantity that flips, and inferring
  // it from the tally afterwards is what made the last occurrence
  // unattributable.
  const chromePrimary = await oracle.resolvedPrimary(spec);
  tally.stackPrimaries.push({
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    fontWeight: spec.fontWeight,
    fontStyle: spec.fontStyle,
    chromePrimary,
    ourPrimaryKey: rs.primaryKey,
  });
  operations.write(`    chrome primary: ${chromePrimary ?? "(none)"}   ours: ${rs.primaryKey}\n`);
  let batchNo = 0;
  for (let i = 0; i < universe.length; i += opts.batch) {
    // Bound memory (DM-1860). The font-resolution memos are unbounded in the
    // codepoint universe, and each retained fontkit `Font` holds a memoized
    // `Glyph` for every codepoint probed through it — so a full sweep OOMed
    // partway and reported its prefix as the answer. Rebuilding the stack is
    // part of the reset, not an extra: `rs` owns the primary `FontInstance`,
    // so dropping the caches while holding `rs` would keep the largest glyph
    // memo of all alive. Every cleared entry is a pure function of its key,
    // so this costs re-reads, never a different answer.
    if (shouldResetBatch(opts.resetEvery, batchNo)) {
      operations.reset();
      const again = operations.prepare(spec, opts.lang);
      if (again == null) throw new Error(`stack stopped resolving after cache reset: ${spec.fontFamily}`);
      rs = again;
    }
    batchNo++;
    const cps = universe.slice(i, i + opts.batch);
    // A DOMOTION_FC_WARM-gated batch pre-warm of the platform fallback
    // helper sat here (DM-1889) and was deleted (DM-1893). It was blamed
    // for moving macOS answers between runs, but the movement decomposed
    // entirely as CHROME's answers flipping among CJK cousin faces — the
    // oracle's own run-to-run instability, which the `chromeFaceCounts`
    // baseline comparison now detects. With the persistent helper channel
    // on every platform the batch saved ~0.05 ms/codepoint on macOS, so it
    // was deleted rather than re-validated: our side resolves per codepoint
    // below, the same ask pattern Blink itself uses.
    const tc = Date.now();
    const faces = await oracle.facesFor(cps, spec);
    tally.chromeMs += Date.now() - tc;
    await oracle.assertStable?.(
      `stack ${stackIndex + 1}/${stackCount} ${spec.fontFamily} @${spec.fontSize}/${spec.fontWeight}/${spec.fontStyle}` +
        ` batch ${batchNo} codepoints ${i + 1}-${i + cps.length}/${universe.length}`,
    );
    if (operations.platform === "darwin") {
      // The stability probe itself asks Blink for six generic donors through
      // FontDataCache::Get. Those entries occupy the same 64-slot strong LRU
      // even though none belongs to a measured glyph cell.
      for (const donor of oracle.controlSignature?.() ?? []) {
        const face = donor.slice(donor.indexOf("=") + 1);
        recordDarwinFontDataUse(darwinFontDataIdentity(face, 400, 16, 0, 100));
      }
    }
    const to = Date.now();
    operations.primeCodepoints(cps);
    for (let j = 0; j < cps.length; j++) {
      const cp = cps[j];
      const provisional = operations.faceFor(cp, rs, spec.lang ?? opts.lang);
      const ours = operations.cjkCanonicalFace?.(cp, rs, provisional) ?? provisional;
      assertSupplementaryPuaOracleFace(
        spec,
        cp,
        faces[j],
        ours,
        chromePrimary,
        `stack ${stackIndex + 1}/${stackCount} ${spec.fontFamily} @${spec.fontSize}/${spec.fontWeight}/${spec.fontStyle}` +
          ` batch ${batchNo} U+${cp.toString(16).toUpperCase().padStart(6, "0")}`,
        operations.platform,
        operations.chromeFaceCoversCodepoint,
      );
      tally.record(spec, cp, faces[j], ours);
    }
    tally.oursMs += Date.now() - to;
    const done = Math.min(i + opts.batch, universe.length);
    // Report resident memory per batch. A sweep that OOMs reports a PREFIX
    // of the universe as though it were the answer (DM-1860), so the trend
    // here is what tells you a long run is actually bounded rather than
    // merely not dead yet.
    const rssMb = operations.rssMb();
    if (rssMb > tally.peakRssMb) tally.peakRssMb = rssMb;
    // …and the size of the per-codepoint fallback memos, which is the
    // quantity RSS could not answer. Resident size is dominated by transient
    // allocation and swings by hundreds of MB between batches, so a memo
    // growing without bound hid inside the noise for four stacks and only
    // became visible on CI, two hours and eight stacks later, as an OOM.
    // This number is retained state: bounded by the batch when the reset
    // reaches it, and monotonically rising when it does not.
    const memoEntries = operations.memoSize();
    if (memoEntries > tally.peakMemoEntries) tally.peakMemoEntries = memoEntries;
    operations.write(
      `    ${done}/${universe.length}  mismatches=${tally.mismatchRowsSeen}  ` +
        `rss=${rssMb}MB  memo=${memoEntries}  (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`,
    );
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  try {
    if (opts.extractStacks) {
      const dirs = opts.sources.filter((d) => existsSync(d));
      if (dirs.length === 0) {
        process.stderr.write(`none of the fixture sources exist: ${opts.sources.join(", ")}\n`);
        return 2;
      }
      return await withBrowser(async (browser) => {
        const corpus = await extractStacks(browser, dirs, opts.stacksFile);
        process.stdout.write(`wrote ${corpus.stacks.length} distinct stacks to ${opts.stacksFile}\n`);
        return 0;
      });
    }

    const loaded = loadCorpus(opts);
    if (loaded.message != null) {
      process.stderr.write(loaded.message);
      return 2;
    }
    if (loaded.warning != null) process.stderr.write(loaded.warning);
    const corpus = loaded.corpus!;
    const { stacks, universe } = selectStacksAndUniverse(corpus, opts);
    const allowlist = loadAllowlist(opts.allowlistFile);

    if (stacks.length === 0 || universe.length === 0) {
      process.stderr.write(
        `font-conformance: selected ${universe.length} codepoints and ${stacks.length} stacks; refusing an empty sweep\n`,
      );
      return 2;
    }
    return await withBrowser(async (browser) => {
      process.stdout.write(
        `font-conformance: ${universe.length.toLocaleString()} codepoints × ${stacks.length} stacks ` +
          `= ${(universe.length * stacks.length).toLocaleString()} comparisons\n`,
      );

      // One scope for the macOS ideograph fallback cache spans the WHOLE
      // sweep: Blink's strong character_fallback_cache_ lives on FontCache in
      // the shared renderer, even as the oracle opens a new document per stack.
      // Both sides see stacks in corpus order and codepoints ascending. Only
      // the separate weak primary-.notdef shape state is cleared at each stack
      // boundary after the browser's explicit GC. Neither cache is reset by
      // periodic font-resolution memory trims.
      beginCharacterFallbackDocument();
      // Chromium's Linux sandbox proxy caches fallback by codepoint ONLY
      // (`content/child/child_process_sandbox_support_impl_linux.{h,cc}`), even
      // though the browser-side miss path is locale-sensitive. Reusing one
      // renderer across synthetic language arms therefore makes the first locale
      // to ask for a character contaminate every later arm. Keep one Chromium
      // renderer scope per locale on Linux so the authoritative per-locale oracle asks
      // the same isolated question as Domotion. Other platforms retain the one-
      // process sweep they have always used.
      const oracleIsolation =
        process.platform === "linux"
          ? "renderer-per-locale"
          : process.platform === "darwin"
            ? "shared-renderer-fresh-stack-document-repaired-prefs"
            : process.platform === "win32"
              ? "shared-renderer-fresh-stack-document"
              : "shared-renderer";
      // ChromeOracle.create makes a fresh BrowserContext. Chromium never puts
      // documents from different BrowserContexts in one renderer process, so
      // each locale gets a distinct WebSandboxSupportLinux cache without the
      // cost of keeping eight complete browser processes alive.
      const activeBrowser = browser;
      const oracles = new OracleRegistry(process.platform, (lang) =>
        ChromeOracle.create(activeBrowser, opts.concurrency, lang),
      );
      const tally = new SweepTally(opts.maxRows, opts.lang, opts.strictAlias, allowlist);
      const oracleDonorSignatures = new Map<string, { scope: string; lang: string; faces: string[] }>();
      const t0 = Date.now();
      let measuredOracle: ChromeOracle | null = null;

      try {
        for (const [stackIndex, spec] of stacks.entries()) {
          const oracle = await oracles.forLang(spec.lang ?? opts.lang);
          measuredOracle = oracle;
          await oracle.prepareMeasurement(`before stack ${stackIndex + 1}/${stacks.length}`);
          const lang = spec.lang ?? opts.lang;
          const scope = oracleScopeKey(process.platform, lang);
          if (!oracleDonorSignatures.has(scope)) {
            const faces = oracle.controlSignature();
            if (faces == null) throw new Error(`oracle: missing control signature for scope ${scope}`);
            oracleDonorSignatures.set(scope, { scope, lang, faces });
          }
          await sweepStack(spec, stackIndex, stacks.length, universe, opts, oracle, tally, t0);
        }
      } catch (error) {
        if (error instanceof OracleDriftError) {
          let diagnostic: Record<string, unknown> | { error: string } | null = null;
          if (process.platform === "darwin" && measuredOracle != null) {
            try {
              diagnostic = await measuredOracle.diagnoseDrift();
            } catch (diagnosticError) {
              diagnostic = { error: (diagnosticError as Error).message };
            }
          }
          mkdirSync(opts.outDir, { recursive: true });
          writeFileSync(
            join(opts.outDir, "oracle-drift.json"),
            JSON.stringify(
              {
                kind: error.kind,
                at: error.at,
                codepoint: error.codepoint,
                expected: error.expected,
                actual: error.actual,
                comparisonsBeforeDrift: Object.values(tally.counts).reduce((a, b) => a + b, 0),
                preferenceRepairs: {
                  count: measuredOracle?.preferenceRepairEvents().length ?? 0,
                  events: measuredOracle?.preferenceRepairEvents() ?? [],
                },
                diagnostic,
                note: "Partial sweep invalid; no conformance report was written.",
              },
              null,
              2,
            ) + "\n",
          );
        }
        throw error;
      }
      await oracles.close();

      const wallMs = Date.now() - t0;
      const resolverAnswerDigest = tally.resolverAnswerHash.digest("hex");
      mkdirSync(opts.outDir, { recursive: true });
      const environment = parityEnvironment({
        chromium: browser.version(),
        corpusIdentity: "font-conformance",
        sampleIdentity: `${opts.stacksFile}:${opts.stackFilter ?? "all"}`,
      });
      environment.helper = {
        ...(environment.helper as Record<string, unknown>),
        systemFallbackEnabled: process.env.DOMOTION_SYSTEM_FALLBACK !== "0",
        version: process.env.DOMOTION_HELPER_VERSION ?? helperImplementationDigest(),
      };
      const report = buildReport({
        opts,
        corpus,
        universeLength: universe.length,
        stackLength: stacks.length,
        oracleIsolation,
        oracleDonorSignatures: [...oracleDonorSignatures.values()],
        oraclePreferenceRepairs: process.platform === "darwin" ? measuredOracle?.preferenceRepairEvents() : undefined,
        resolverAnswerDigest,
        tally,
        wallMs,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        unicode: process.versions.unicode,
        icu: process.versions.icu,
        chromiumVersion: browser.version(),
        parityEnv: environment,
        rotationRevision: process.env.FONT_CONFORMANCE_REVISION ?? null,
        rotationOrdinal: process.env.FONT_CONFORMANCE_ROTATION_ORDINAL ?? null,
        rotationStackBucket: process.env.FONT_CONFORMANCE_STACK_BUCKET ?? null,
        host: { platform: environment.platform, arch: environment.arch, osRelease: environment.osRelease },
        fontInventory: (environment.fontInventory as Record<string, unknown> | null) ?? null,
      });
      const reportData = fontConformanceDataSchema.parse({
        ...report,
        outcome: report.summary.comparisons === 0 ? "skip" : report.summary.mismatchTotal === 0 ? "pass" : "fail",
      });
      writeReport(join(opts.outDir, "report.json"), "font-conformance", reportData, {
        schemaVersion: 1,
        generatedAt: report.meta.generatedAt,
        env: report.meta.parityEnvironment,
      });
      const text = formatSummary(report, opts, corpus, tally, universe.length, stacks.length);
      writeFileSync(join(opts.outDir, "summary.txt"), text);
      process.stdout.write(`\n${text}`);
      process.stdout.write(`report → ${join(opts.outDir, "report.json")}\n`);

      return report.summary.mismatchTotal > 0 ? 1 : 0;
    });
  } finally {
    // Safe no-op when the early-exit paths returned before the sweep began.
    endCharacterFallbackDocument();
  }
}

// Only sweep when run as a script. The pure pieces above (`buildUniverse`,
// `identifyFace`, `mismatchClass`, `loadAllowlist`, …) are imported by
// `tests/font-conformance.test.ts`, which must not launch a browser.
if (isMain(import.meta.url)) await runMain(() => main());
