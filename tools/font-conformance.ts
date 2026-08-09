#!/usr/bin/env node
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
 *   --no-pua             drop private-use codepoints (137k of 292k)
 *   --shard i/N          stride shard over codepoints
 *   --stack-shard i/N    stride shard over stacks (preferred for CI — warmer caches)
 *   --max-stacks n       cap the corpus to the n most-used stacks
 *   --batch n            codepoints per probe page (8000)
 *   --concurrency n      pipelined CDP calls in flight (128)
 *   --max-rows n         example mismatch rows kept in the report (20000)
 *   --reset-every n      drop the font-resolution memos every n batches (1);
 *                        0 disables. Bounds memory — see the loop for why.
 *   --strict-alias       treat the documented naming aliases as mismatches
 *   --allowlist <file>   accepted-divergence file
 *   --lang <tag>         locale for BOTH sides — <html lang> on the probe page
 *                        and the `lang` the resolver routes Han with (en)
 *   --out <dir>          report directory (tests/output/font-conformance)
 *
 * Exit code: 0 when every comparison agrees (or is allowlisted), 1 on any
 * mismatch, 2 on a harness error. See `docs/107-font-conformance-oracle.md`.
 * ---------------------------------------------------------------------------
 */
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { hostname, cpus } from "node:os";
import { inventoryDocument } from "./font-inventory.mjs";

/**
 * Which machine produced this shard's answers.
 *
 * Recorded because the one thing a detected flip could not say was *where*. The
 * workflow shards one stack per shard, so a stack that flips wholesale flipped
 * on exactly one machine, and its name is the only handle on that machine
 * afterwards. Cheap enough to always record; useless to add after the fact.
 */
function hostIdentity(): { name: string; cpus: number; arch: string } {
  return { name: hostname(), cpus: cpus().length, arch: process.arch };
}

/**
 * This shard's own font inventory digest — not the run's.
 *
 * The answers are a function of the host's installed fonts, and with one stack
 * per shard those hosts are different machines. A run-level digest asserts a
 * uniformity nothing checks; a per-shard one makes two shards disagreeing about
 * the font set visible in the report instead of invisible.
 */
function shardFontInventory(): { digest: string; count: number; source: string } | null {
  try {
    const doc = inventoryDocument();
    return { digest: doc.digest, count: doc.count, source: doc.source };
  } catch {
    return null; // diagnostic metadata must never fail a sweep
  }
}
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ITALIC_SLNT,
  beginCharacterFallbackDocument,
  clearFontResolutionCaches,
  endCharacterFallbackDocument,
  type FontInstance,
  getFontInstance,
  getFontSourceInfo,
  opticalCutOpszFor,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  stackPrimaryIsSystemUi,
  stretchPercent,
} from "../src/render/font-resolution.js";
import { glyphHelperCodepointMemoSize, resolveInstalledFont } from "../src/render/glyph-helper.js";
import { PORTABLE_CORPUS_PLATFORM } from "./font-conformance-synthetic-stacks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One (family stack, size, weight, style) combination drawn from the corpus. */
export interface StackSpec {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
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
    .map((s) => JSON.stringify([
      s.fontFamily, s.fontSize, s.fontWeight, s.fontStyle,
      s.fontStretch ?? "", s.fontVariationSettings ?? "", s.fontFeatureSettings ?? "",
      s.fontVariantAlternates ?? "", s.fontVariantEmoji ?? "",
    ]))
    .sort();
  const h = createHash("sha256")
    .update(`harvested-stacks/v${HARVEST_IDENTITY_VERSION}\n`)
    .update(`${platform}\n`)
    .update(JSON.stringify(questions))
    .digest("hex")
    .slice(0, 16);
  return `harvested:v${HARVEST_IDENTITY_VERSION}:${h}`;
}

interface StackCorpus {
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
export function buildUniverse(opts: { includePua: boolean; ranges: Array<[number, number]> | null }): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (opts.ranges != null && !opts.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
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
 * The one place where Chrome's name for a face and ours genuinely cannot be
 * reconciled mechanically. Keep this list SHORT and cite why — an entry here is
 * a claim that two differently-named things are the same face, and a wrong
 * claim silently converts a real defect into a pass.
 *
 * This is NOT the allowlist. The allowlist (`--allowlist`) records accepted
 * DIVERGENCES; these record naming, and every hit is counted and reported
 * separately (`agree-alias`) so its size stays visible. `--strict-alias`
 * re-classifies them as mismatches.
 */
export const FACE_ALIASES: Array<{ chrome: RegExp; ours: RegExp; reason: string }> = [
  {
    chrome: /^(sfprotext|sfprodisplay|sfpro|applesystemuifont|sfnstext|sfnsdisplay|sfns)/,
    ours: /(^|\s)(sfpro|sfns)/,
    reason:
      "macOS system font. Chrome reports the optical-cut display name (\"SF Pro Text\" / PostScript "
      + "SFProText-Regular) for text it paints out of /System/Library/Fonts/SFNS.ttf, whose own "
      + "PostScript name is .SFNS-Regular — so neither the name, the file, nor the font's internal "
      + "name lines up. Domotion routes the `sf-pro` key to SFNS.ttf deliberately, because SFNS is "
      + "the file whose outlines match Chrome's painted glyphs (src/render/font-resolution.ts, the "
      + "`sf-pro` / sfProCoverageOtfKey block). Treating the name difference as a mismatch would "
      + "bury every real mismatch under it.",
  },
];

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

// ---------------------------------------------------------------------------
// Our side
// ---------------------------------------------------------------------------

/** Mirrors `slantForStyle` in src/render/text-to-path.ts (not exported there). */
export function slantForStyle(style: string): number {
  const s = style.toLowerCase();
  return (s === "italic" || s.startsWith("oblique")) ? ITALIC_SLNT : 0;
}

export interface ResolvedStack {
  spec: StackSpec;
  chain: string[];
  primaryKey: string;
  primary: NonNullable<ReturnType<typeof getFontInstance>>;
  slant: number;
  /** Computed `font-stretch` as a percentage, 100 = `normal`. */
  stretch: number;
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
 * codepoints (src/render/text-to-path.ts): primary instance via `resolveFont`,
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
  // `lang` mirrors the probe page's `<html lang>`: the renderer resolves the
  // settings-mapped generics per content script (Playwright's forScripts
  // tables on mac/win), so the oracle must ask our side the same question the
  // probe page asks Chrome.
  const chain = resolveFontKeyChain(spec.fontFamily, lang);
  const primaryKey = resolveFontKey(spec.fontFamily, lang);
  const slant = slantForStyle(spec.fontStyle);
  // Mirror `resolveFont`'s opsz pin for an explicitly-named macOS optical cut,
  // so the instance we probe is the one the renderer would actually use.
  const cutOpsz = opticalCutOpszFor(spec.fontFamily, lang);
  // The author's own axis settings win over the opsz pin for any axis they name,
  // matching the renderer: `font-variation-settings` is the last word in CSS.
  const authorAxes = parseVariationSettings(spec.fontVariationSettings);
  const merged: Record<string, number> = {
    ...(cutOpsz != null ? { opsz: cutOpsz } : {}),
    ...(authorAxes ?? {}),
  };
  const variations = Object.keys(merged).length > 0 ? merged : undefined;
  const stretch = stretchPercent(spec.fontStretch);
  const primary = getFontInstance(primaryKey, spec.fontWeight, spec.fontSize, slant, variations, stretch);
  if (primary == null) return null;
  const rs: ResolvedStack = {
    spec, chain, primaryKey, primary, slant, stretch,
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
 * — src/render/text-to-path.ts) and its identity read back off the instance:
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
    key === rs.primaryKey ? rs.primary : getFontInstance(key, rs.spec.fontWeight, rs.spec.fontSize, rs.slant, undefined, rs.stretch);
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
    postscriptName: inst?.instantiatedPostscriptName ?? inst?.postscriptName ?? src?.postscriptName ?? spec?.postscriptName ?? fromKey,
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
    undefined,
    lang,
    rs.chain,
    // DM-1859: the oracle must ask the question the RENDERER asks, and the
    // renderer distinguishes a `system-ui` primary from an explicitly-named
    // "SF Pro" even though both share the `sf-pro` key. Omitting this would
    // measure a different code path than the one that paints — the exact
    // instrument defect this tool was corrected for once already.
    stackPrimaryIsSystemUi(rs.spec.fontFamily),
    rs.stretch,
  );
  // An uncovered codepoint has no resolved face of its own — the renderer draws
  // the run primary's `.notdef`, so THAT is the face to compare against Chrome.
  return r.covered ? faceFor(rs, r.key, true, r.fontOverride) : rs.notdefDonor;
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
 * awaited serially. Measured on an M1 Pro: ~11k codepoints/s end to end
 * (`setContent` dominates, which is why the cells are `inline-block` — a page
 * of block-level cells lays out several times slower).
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
  const cells = cps
    .map((cp) => `<i class=c>&#x${cp.toString(16)};</i>`)
    .join("");
  // The computed `font-family` is already valid CSS and goes into a <style>
  // element, not an attribute — so it is embedded verbatim. Rewriting its
  // quotes would corrupt any family name that legitimately contains one.
  const family = spec.fontFamily;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>`
    + `body{margin:0}`
    + `#w{display:flex;flex-wrap:wrap;font-family:${family};font-size:${spec.fontSize}px;`
    + `font-weight:${spec.fontWeight};font-style:${spec.fontStyle};`
    + `font-stretch:${spec.fontStretch ?? "normal"};`
    + `font-variation-settings:${spec.fontVariationSettings ?? "normal"};`
    // Declared even though Blink does NOT select a face on it — `feature_settings_`
    // is absent from `FontDescription::CacheKey` and is read only by
    // `FontFeatures::Initialize` at shaping time. It belongs here anyway,
    // because without it the probe page renders a fixture's text with the
    // features the fixture declares switched off, and a feature that
    // substitutes glyphs (`smcp`, `frac`, `tnum`) changes what Chrome paints
    // and therefore which faces it reports having used.
    + `font-feature-settings:${spec.fontFeatureSettings ?? "normal"};`
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
    + `font-variant-alternates:${spec.fontVariantAlternates ?? "normal"};`
    // This one genuinely selects a face — it overrides the run's
    // `FontFallbackPriority`, which is what picks a color-emoji face over a text
    // face — so omitting it would sweep an emoji-presentation question as its
    // opposite.
    + `font-variant-emoji:${spec.fontVariantEmoji ?? "normal"}}`
    // `white-space:pre` is load-bearing: without it a cell holding U+0020 (or
    // any other space separator) collapses to nothing, Chrome paints no
    // glyph, and the oracle reports a mismatch that only exists because of
    // how the probe page was written.
    // `font-style:inherit` undoes the UA italic on `<i>` — the cell must be
    // rendered in the style the corpus entry declares, not in the tag's.
    + `.c{display:inline-block;width:${spec.fontSize + 8}px;height:${spec.fontSize + 8}px;`
    + `overflow:hidden;font-style:inherit;white-space:pre}`
    + `</style></head><body><div id=w>${cells}</div></body></html>`;
}

/** See `layOutBatch`. Generous rather than tuned — it exists to distinguish a
 *  slow layout from a hung one, and only the second reading should fail a run. */
const SET_CONTENT_TIMEOUT_MS = 120_000;

class ChromeOracle {
  constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly concurrency: number,
    private readonly lang: string,
  ) {}

  static async create(browser: Browser, concurrency: number, lang: string): Promise<ChromeOracle> {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    return new ChromeOracle(page, cdp, concurrency, lang);
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
    const f = primaryChromeFace(faces[0] ?? []);
    return f == null ? null : (f.postScriptName ?? f.familyName);
  }

  /**
   * Lay out one batch's probe page, with a raised budget and exactly one retry.
   *
   * `setContent`'s 30-second default is a limit on how long Blink may take to
   * lay out 8,000 inline-block cells whose codepoints drag in fonts from all
   * over the host — on a loaded runner that is a plausible amount of work, not
   * evidence of a hang. One shard of the full-corpus macOS sweep died on exactly
   * this, 47 minutes into a job whose surviving siblings ran for two hours.
   *
   * The retry is bounded at one and re-throws on the second failure. It must
   * never degrade into skipping the batch: a skipped batch would leave a hole in
   * a sweep that reports a codepoint count, and the count would still look right.
   */
  private async layOutBatch(cps: number[], spec: StackSpec): Promise<void> {
    const html = probePageHtml(cps, spec, this.lang);
    try {
      await this.page.setContent(html, { timeout: SET_CONTENT_TIMEOUT_MS });
    } catch (e) {
      process.stdout.write(`    (setContent slow — retrying this batch once: ${(e as Error).message})\n`);
      await this.page.setContent(html, { timeout: SET_CONTENT_TIMEOUT_MS });
    }
  }

  async facesFor(cps: number[], spec: StackSpec): Promise<ChromeFace[][]> {
    await this.layOutBatch(cps, spec);
    const { root } = await this.cdp.send("DOM.getDocument");
    const { nodeIds } = await this.cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".c" });
    if (nodeIds.length !== cps.length) {
      throw new Error(`oracle: asked for ${cps.length} cells, page produced ${nodeIds.length}`);
    }
    const out: ChromeFace[][] = [];
    for (let i = 0; i < nodeIds.length; i += this.concurrency) {
      const slice = nodeIds.slice(i, i + this.concurrency);
      const rs = await Promise.all(
        slice.map((nodeId) => this.cdp.send("CSS.getPlatformFontsForNode", { nodeId })),
      );
      for (const r of rs) out.push(r.fonts as ChromeFace[]);
    }
    return out;
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
          if (node.nodeType === 3 && (node.textContent ?? "").trim() !== "") { hasText = true; break; }
        }
        if (!hasText) continue;
        const cs = getComputedStyle(el);
        seen.add(JSON.stringify({
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
        }));
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
      throw new Error(`allowlist entry ${i} (${e.cp}) has no usable \`reason\`. Every accepted divergence must say why.`);
    }
    const m = /^\s*(0x[0-9a-fA-F]+)\s*(?:-\s*(0x[0-9a-fA-F]+))?\s*$/.exec(e.cp);
    if (m == null) throw new Error(`allowlist entry ${i}: \`cp\` must be "0xNNNN" or "0xNNNN-0xNNNN", got ${JSON.stringify(e.cp)}`);
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
  includePua: boolean;
  shard: [number, number] | null;
  stackShard: [number, number] | null;
  batch: number;
  concurrency: number;
  outDir: string;
  allowlistFile: string;
  strictAlias: boolean;
  maxStacks: number | null;
  maxRows: number;
  lang: string;
  resetEvery: number;
  /** Sweep a corpus whose recorded platform is not this one. See `StackCorpus.platform`. */
  allowForeignCorpus: boolean;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    stacksFile: DEFAULT_STACKS_FILE,
    extractStacks: false,
    sources: ["external/html-test", "../html-test/unicode"],
    ranges: null,
    includePua: true,
    shard: null,
    stackShard: null,
    batch: 8000,
    concurrency: 128,
    outDir: "tests/output/font-conformance",
    allowlistFile: "tools/font-conformance-allowlist.json",
    strictAlias: false,
    maxStacks: null,
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
      case "--stacks": o.stacksFile = next(); break;
      case "--extract-stacks": o.extractStacks = true; break;
      case "--source": o.sources = next().split(",").map((s) => s.trim()); break;
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
      case "--no-pua": o.includePua = false; break;
      case "--shard": {
        const m = /^(\d+)\/(\d+)$/.exec(next());
        if (m == null) throw new Error("--shard wants i/N");
        o.shard = [parseInt(m[1], 10), parseInt(m[2], 10)];
        break;
      }
      case "--stack-shard": {
        const m = /^(\d+)\/(\d+)$/.exec(next());
        if (m == null) throw new Error("--stack-shard wants i/N");
        o.stackShard = [parseInt(m[1], 10), parseInt(m[2], 10)];
        break;
      }
      case "--batch": o.batch = parseInt(next(), 10); break;
      case "--concurrency": o.concurrency = parseInt(next(), 10); break;
      case "--out": o.outDir = next(); break;
      case "--allowlist": o.allowlistFile = next(); break;
      case "--strict-alias": o.strictAlias = true; break;
      case "--max-stacks": o.maxStacks = parseInt(next(), 10); break;
      case "--max-rows": o.maxRows = parseInt(next(), 10); break;
      case "--reset-every": o.resetEvery = parseInt(next(), 10); break;
      case "--allow-foreign-corpus": o.allowForeignCorpus = true; break;
      case "--lang": o.lang = next(); break;
      case "-h":
      case "--help":
        process.stdout.write(readFileSync(new URL(import.meta.url).pathname, "utf-8").split("*/")[0]);
        process.exit(0);
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch();
  try {
    if (opts.extractStacks) {
      const dirs = opts.sources.filter((d) => existsSync(d));
      if (dirs.length === 0) {
        process.stderr.write(`none of the fixture sources exist: ${opts.sources.join(", ")}\n`);
        return 2;
      }
      const corpus = await extractStacks(browser, dirs, opts.stacksFile);
      process.stdout.write(`wrote ${corpus.stacks.length} distinct stacks to ${opts.stacksFile}\n`);
      return 0;
    }

    if (!existsSync(opts.stacksFile)) {
      process.stderr.write(
        `no stack corpus at ${opts.stacksFile} — run with --extract-stacks first `
        + `(the corpus is per-platform; see --allow-foreign-corpus)\n`,
      );
      return 2;
    }
    const corpus = JSON.parse(readFileSync(opts.stacksFile, "utf-8")) as StackCorpus;
    // A corpus from another platform describes stacks this platform's Chrome
    // never computes, so a sweep over it measures the wrong question rather
    // than measuring badly. Refuse by default; the escape hatch is explicit and
    // is recorded in the report's `meta`.
    // A corpus that declares itself PORTABLE is exempt, and the exemption is
    // narrow by construction. The guard exists because a HARVESTED corpus
    // records computed style, and one computed value — the default font-family
    // — is a per-platform preference. A rule-derived corpus (see
    // `tools/font-conformance-synthetic-stacks.ts`) contains only literal CSS
    // keywords, written the same on every platform; what each keyword resolves
    // to differs per platform, which is the question it asks rather than a
    // reason it cannot be asked. Only the generator writes this marker.
    if (corpus.platform !== process.platform && corpus.platform !== PORTABLE_CORPUS_PLATFORM) {
      const what = corpus.platform ?? "(unrecorded)";
      if (!opts.allowForeignCorpus) {
        process.stderr.write(
          `stack corpus ${opts.stacksFile} was extracted on ${what}, this host is ${process.platform}.\n`
          + `A corpus is not portable: the computed font-family of an element that declares none is\n`
          + `Chrome's per-platform default-font preference (macOS "Times" vs Linux "Times New Roman"),\n`
          + `so sweeping it here would ask about stacks no page on this platform renders.\n`
          + `Re-extract with --extract-stacks, or pass --allow-foreign-corpus to sweep it anyway.\n`,
        );
        return 2;
      }
      process.stderr.write(`WARNING: sweeping a ${what} corpus on ${process.platform} (--allow-foreign-corpus)\n`);
    }
    let stacks = corpus.stacks;
    if (opts.maxStacks != null) stacks = stacks.slice(0, opts.maxStacks);
    // Two independent stride shards. `--stack-shard` splits the corpus across
    // CI runners (the cheap axis: each runner reuses one warm resolver cache
    // per stack); `--shard` splits the codepoint universe within a stack.
    if (opts.stackShard != null) {
      const [i, n] = opts.stackShard;
      stacks = stacks.filter((_, idx) => idx % n === i - 1);
    }

    const allowlist = loadAllowlist(opts.allowlistFile);

    let universe = buildUniverse({ includePua: opts.includePua, ranges: opts.ranges });
    if (opts.shard != null) {
      const [i, n] = opts.shard;
      universe = universe.filter((_, idx) => idx % n === i - 1);
    }

    process.stdout.write(
      `font-conformance: ${universe.length.toLocaleString()} codepoints × ${stacks.length} stacks `
      + `= ${(universe.length * stacks.length).toLocaleString()} comparisons\n`,
    );

    // One document scope for the macOS ideograph fallback cache, spanning the
    // WHOLE sweep — because that is the scope Chrome's own cache has on the
    // other side of the comparison: the oracle uses a single page (one renderer
    // process) for every stack and batch, and Blink's character_fallback_cache_
    // lives on that renderer's FontCache, surviving each `setContent`
    // navigation. Both sides then see the identical ask sequence (stacks in
    // corpus order, codepoints ascending), so the first-ideograph-under-a-key
    // entries agree by construction. Deliberately NOT reset at the periodic
    // `clearFontResolutionCaches()` memory trims — Chrome's cache is not
    // dropped there either. Closed in the outer `finally` beside browser.close.
    beginCharacterFallbackDocument();
    const oracle = await ChromeOracle.create(browser, opts.concurrency, opts.lang);
    const counts: Record<Verdict, number> = {
      "agree-exact": 0,
      "agree-same-file": 0,
      "agree-alias": 0,
      "agree-tofu": 0,
      "agree-not-painted": 0,
      "mismatch": 0,
      "mismatch-we-paint": 0,
      "mismatch-we-tofu": 0,
    };
    // Aggregates are accumulated INCREMENTALLY, and only `--max-rows` example
    // rows are retained. A wrong primary face makes every uncovered codepoint
    // in the stack a mismatch — one defect, ~200k rows — so keeping them all
    // both exhausts memory mid-sweep and writes a report too large to be a
    // useful CI artifact (a real run produced 224 MB before this cap). The
    // COUNTS stay exact; only the per-row detail is sampled, and the report
    // says so.
    const mismatches: MismatchRow[] = [];
    let mismatchRowsSeen = 0;
    const pairCounts = new Map<string, number>();
    const stackCounts = new Map<string, number>();
    /**
     * The per-stack tally's key.
     *
     * The whole spec, not just the family: the corpus holds three separate
     * `system-ui, -apple-system, sans-serif` entries (13/400/normal,
     * 13/400/italic, 20/700/normal) that resolve to different faces and can
     * regress independently. Keying on the family alone collapses them into one
     * number, where one stack getting worse and another getting better cancel
     * out — and a baseline built on that key cannot see either.
     */
    const stackKey = (s: StackSpec): string =>
      `${s.fontFamily} @${s.fontSize}/${s.fontWeight}/${s.fontStyle}`
      + (s.fontStretch != null && s.fontStretch !== "100%" ? `/${s.fontStretch}` : "")
      + (s.fontVariationSettings != null && s.fontVariationSettings !== "normal" ? `/${s.fontVariationSettings}` : "")
      + (s.fontFeatureSettings != null && s.fontFeatureSettings !== "normal" ? `/${s.fontFeatureSettings}` : "")
      + (s.fontVariantAlternates != null && s.fontVariantAlternates !== "normal" ? `/${s.fontVariantAlternates}` : "")
      + (s.fontVariantEmoji != null && s.fontVariantEmoji !== "normal" ? `/${s.fontVariantEmoji}` : "");
    /**
     * Every distinct face Chrome named during the sweep, with how often.
     *
     * This is the sweep's own record of the host's font inventory — the thing
     * the answers actually depend on. A runner image that rotates its font set
     * changes this list, which is what makes a stale per-platform baseline
     * visible as a changed inventory rather than as an unexplained score move.
     */
    const chromeFaceTally = new Map<string, number>();
    /** Per stack: the primary Chrome resolved, beside the key we resolved. */
    const stackPrimaries: Array<{ fontFamily: string; fontSize: number; fontWeight: number; fontStyle: string;
                                  chromePrimary: string | null; ourPrimaryKey: string }> = [];
    const classCounts = { "different-family": 0, "same-family-different-cut": 0 };
    let allowlistedCount = 0;
    let skippedStacks = 0;
    let chromeMs = 0;
    let oursMs = 0;
    let peakRssMb = 0;
    let peakMemoEntries = 0;
    const t0 = Date.now();

    for (const spec of stacks) {
      let rs = prepareStack(spec, opts.lang);
      if (rs == null) {
        skippedStacks++;
        process.stdout.write(`  SKIP (no resolvable primary): ${spec.fontFamily}\n`);
        continue;
      }
      process.stdout.write(
        `  stack ${spec.fontFamily} @${spec.fontSize}px/${spec.fontWeight}/${spec.fontStyle}`
        + ` → chain [${rs.chain.join(", ")}]\n`,
      );
      // Ask Chrome for this stack's primary before sweeping it, and record it.
      // See `resolvedPrimary` — this is the quantity that flips, and inferring
      // it from the tally afterwards is what made the last occurrence
      // unattributable.
      const chromePrimary = await oracle.resolvedPrimary(spec);
      stackPrimaries.push({ fontFamily: spec.fontFamily, fontSize: spec.fontSize, fontWeight: spec.fontWeight,
                            fontStyle: spec.fontStyle, chromePrimary, ourPrimaryKey: rs.primaryKey });
      process.stdout.write(`    chrome primary: ${chromePrimary ?? "(none)"}   ours: ${rs.primaryKey}\n`);
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
        if (opts.resetEvery > 0 && batchNo > 0 && batchNo % opts.resetEvery === 0) {
          clearFontResolutionCaches();
          const again = prepareStack(spec, opts.lang);
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
        chromeMs += Date.now() - tc;
        const to = Date.now();
        for (let j = 0; j < cps.length; j++) {
          const cp = cps[j];
          const chromeFaces = faces[j];
          const chrome = primaryChromeFace(chromeFaces);
          if (chrome != null) {
            const cf = chrome.postScriptName ?? chrome.familyName;
            chromeFaceTally.set(cf, (chromeFaceTally.get(cf) ?? 0) + 1);
          }
          // Same `lang` both sides: it goes on the probe page's <html> element
          // AND into `fallbackFontChain`, which routes Han by locale (zh-TW →
          // PingFang TC, ja → Hiragino). Passing it to only one side would make
          // `--lang ja` move Chrome's answer and not ours.
          const ours = ourFaceFor(cp, rs, opts.lang);

          let verdict: Verdict;
          if (chrome == null) {
            verdict = ours.covered ? "mismatch-we-paint" : "agree-not-painted";
          } else {
            // `getPlatformFontsForNode` reports the face Chrome SELECTED, which
            // for an uncovered codepoint is the face whose `.notdef` it painted.
            // So the same face-identity test answers both questions: covered →
            // "did we pick the same font?", uncovered → "do we tofu out of the
            // same font?".
            const id = identifyFace(chrome, ours, opts.strictAlias);
            if (ours.covered) verdict = id ?? "mismatch";
            else verdict = id != null ? "agree-tofu" : "mismatch-we-tofu";
          }
          counts[verdict]++;
          if (verdict.startsWith("mismatch")) {
            if (allowlisted(allowlist, cp, spec.fontFamily)) {
              allowlistedCount++;
              counts[verdict]--;
            } else {
              const chromeName = chrome?.postScriptName ?? chrome?.familyName ?? "(none)";
              const ourName = ours.postscriptName ?? ours.key;
              const cls = mismatchClass(chromeName, ourName);
              mismatchRowsSeen++;
              classCounts[cls]++;
              const pair = `${chromeName} → ${ourName}`;
              pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
              const sk = stackKey(spec);
              stackCounts.set(sk, (stackCounts.get(sk) ?? 0) + 1);
              if (mismatches.length < opts.maxRows) {
                mismatches.push({
                  cp,
                  cpHex: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
                  stack: spec.fontFamily,
                  fontSize: spec.fontSize,
                  fontWeight: spec.fontWeight,
                  fontStyle: spec.fontStyle,
                  verdict,
                  class: cls,
                  chrome: chromeName,
                  chromeFamily: chrome?.familyName ?? "(none)",
                  chromeAllFaces: chromeFaces.map((f) => `${f.postScriptName ?? f.familyName}×${f.glyphCount}`).join("+"),
                  chromeFile: chrome != null ? chromeFaceFile(chrome) : null,
                  ourKey: ours.key,
                  ourPostscript: ours.postscriptName,
                  ourFile: ours.path,
                  ourCovered: ours.covered,
                });
              }
            }
          }
        }
        oursMs += Date.now() - to;
        const done = Math.min(i + opts.batch, universe.length);
        // Report resident memory per batch. A sweep that OOMs reports a PREFIX
        // of the universe as though it were the answer (DM-1860), so the trend
        // here is what tells you a long run is actually bounded rather than
        // merely not dead yet.
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        if (rssMb > peakRssMb) peakRssMb = rssMb;
        // …and the size of the per-codepoint fallback memos, which is the
        // quantity RSS could not answer. Resident size is dominated by transient
        // allocation and swings by hundreds of MB between batches, so a memo
        // growing without bound hid inside the noise for four stacks and only
        // became visible on CI, two hours and eight stacks later, as an OOM.
        // This number is retained state: bounded by the batch when the reset
        // reaches it, and monotonically rising when it does not.
        const memoEntries = glyphHelperCodepointMemoSize();
        if (memoEntries > peakMemoEntries) peakMemoEntries = memoEntries;
        process.stdout.write(
          `    ${done}/${universe.length}  mismatches=${mismatchRowsSeen}  `
          + `rss=${rssMb}MB  memo=${memoEntries}  (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`,
        );
      }
    }
    await oracle.close();

    const wallMs = Date.now() - t0;
    const comparisons = Object.values(counts).reduce((a, b) => a + b, 0) + allowlistedCount;
    const mismatchTotal = counts.mismatch + counts["mismatch-we-paint"] + counts["mismatch-we-tofu"];

    // ---- report -------------------------------------------------------------
    mkdirSync(opts.outDir, { recursive: true });
    const topPairs = Array.from(pairCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topStacks = Array.from(stackCounts.entries()).sort((a, b) => b[1] - a[1]);

    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        unicode: process.versions.unicode,
        icu: process.versions.icu,
        // The build that produced every answer on the CHROME side, and the most
        // load-bearing field in this block — Blink's font selection is what is
        // being measured, so a different browser is a different oracle.
        //
        // It was missing until a `font-variant-emoji` divergence read as
        // Windows-specific for a week and turned out to be a version
        // difference: ©/™/‼/☺ move to the colour font under the CSS property in
        // 147.0.7727.15 and stay on the primary in 148.0.7778.96, measured on
        // ONE host with the platform held constant. Nothing recorded here could
        // have shown that, while `image`, `fontInventory` and `icu` all matched.
        //
        // Read from the launched browser, never inferred from the Playwright
        // revision directory: the Windows VM launches a 148 build out of a
        // folder named `chromium-1217`, which is where the confusion started.
        chromium: browser.version(),
        stacksFile: opts.stacksFile,
        stackCorpusGeneratedAt: corpus.generatedAt,
        stackCorpusPlatform: corpus.platform ?? null,
        allowForeignCorpus: opts.allowForeignCorpus,
        codepoints: universe.length,
        stacks: stacks.length - skippedStacks,
        skippedStacks,
        includePua: opts.includePua,
        ranges: opts.ranges,
        shard: opts.shard,
        stackShard: opts.stackShard,
        strictAlias: opts.strictAlias,
        maxRows: opts.maxRows,
        lang: opts.lang,
        resetEvery: opts.resetEvery,
        // DM-1922. Attribution fields for an intermittent, Chrome-side flip of
        // the `sans-serif` generic's primary, seen four times in real runs and
        // never once in ~2,000 probe samples across 32 runner allocations. The
        // detector catches it; nothing recorded where it happened.
        //
        // `host` and `fontInventory` are per-SHARD, deliberately. This workflow
        // shards one stack per shard, so the flipping stack sweeps alone on one
        // machine — a run-level record cannot name it, and cannot show two
        // shards disagreeing about the font set.
        host: hostIdentity(),
        fontInventory: shardFontInventory(),
        stackPrimaries,
        peakRssMb,
        wallMs,
        chromeMs,
        oursMs,
        comparisonsPerSecond: Math.round((comparisons / wallMs) * 1000),
      },
      summary: {
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
    writeFileSync(join(opts.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

    const lines: string[] = [];
    const pct = (n: number): string => `${((n / Math.max(1, comparisons)) * 100).toFixed(3)}%`;
    lines.push(`font-conformance — ${process.platform} ${process.arch}, Unicode ${process.versions.unicode}`);
    lines.push(`corpus             ${opts.stacksFile} (extracted on ${corpus.platform ?? "?"})`);
    lines.push(`chrome faces seen  ${chromeFaceTally.size}`);
    lines.push(`comparisons        ${comparisons.toLocaleString()}  (${universe.length.toLocaleString()} cps × ${stacks.length - skippedStacks} stacks)`);
    lines.push(`wall               ${(wallMs / 1000).toFixed(1)}s  (chrome ${(chromeMs / 1000).toFixed(1)}s, ours ${(oursMs / 1000).toFixed(1)}s)`);
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
    lines.push(`MISMATCH we paint, Chrome doesn't  ${counts["mismatch-we-paint"].toLocaleString()}  ${pct(counts["mismatch-we-paint"])}`);
    lines.push(`MISMATCH we tofu, Chrome paints    ${counts["mismatch-we-tofu"].toLocaleString()}  ${pct(counts["mismatch-we-tofu"])}`);
    lines.push(`MISMATCH total     ${mismatchTotal.toLocaleString()}  ${pct(mismatchTotal)}`);
    lines.push(`  of which different family       ${classCounts["different-family"].toLocaleString()}`);
    lines.push(`  of which same family, other cut ${classCounts["same-family-different-cut"].toLocaleString()}`);
    lines.push(`  distinct disagreeing routes     ${pairCounts.size.toLocaleString()}`);
    lines.push(
      `example rows in report.json     ${mismatches.length.toLocaleString()}`
      + (mismatchRowsSeen > mismatches.length ? ` (${(mismatchRowsSeen - mismatches.length).toLocaleString()} more not kept — raise --max-rows)` : ""),
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
    const text = `${lines.join("\n")}\n`;
    writeFileSync(join(opts.outDir, "summary.txt"), text);
    process.stdout.write(`\n${text}`);
    process.stdout.write(`report → ${join(opts.outDir, "report.json")}\n`);

    return mismatchTotal > 0 ? 1 : 0;
  } finally {
    // Safe no-op when the early-exit paths returned before the sweep began.
    endCharacterFallbackDocument();
    await browser.close();
  }
}

// Only sweep when run as a script. The pure pieces above (`buildUniverse`,
// `identifyFace`, `mismatchClass`, `loadAllowlist`, …) are imported by
// `tests/font-conformance.test.ts`, which must not launch a browser.
const invokedDirectly = process.argv[1] != null
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      process.stderr.write(`font-conformance failed: ${String(err instanceof Error ? err.stack : err)}\n`);
      process.exitCode = 2;
    },
  );
}
