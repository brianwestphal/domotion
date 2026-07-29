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
 *   --stacks <file>      stack corpus            (tools/font-conformance-stacks.json)
 *   --extract-stacks     re-derive it and exit
 *   --source a,b         fixture dirs to extract from
 *   --range 0000-2FFF    restrict the codepoint universe (comma-separated, repeatable)
 *   --no-pua             drop private-use codepoints (137k of 292k)
 *   --shard i/N          stride shard over codepoints
 *   --stack-shard i/N    stride shard over stacks (preferred for CI — warmer caches)
 *   --max-stacks n       cap the corpus to the n most-used stacks
 *   --batch n            codepoints per probe page (8000)
 *   --concurrency n      pipelined CDP calls in flight (128)
 *   --max-rows n         example mismatch rows kept in the report (20000)
 *   --strict-alias       treat the documented naming aliases as mismatches
 *   --allowlist <file>   accepted-divergence file
 *   --lang <tag>         <html lang> on the probe page (en)
 *   --out <dir>          report directory (tests/output/font-conformance)
 *
 * Exit code: 0 when every comparison agrees (or is allowlisted), 1 on any
 * mismatch, 2 on a harness error. See `docs/107-font-conformance-oracle.md`.
 * ---------------------------------------------------------------------------
 */
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ITALIC_SLNT,
  getFontInstance,
  opticalCutOpszFor,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
} from "../src/render/font-resolution.js";
import { resolveInstalledFont } from "../src/render/glyph-helper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One (family stack, size, weight, style) combination drawn from the corpus. */
export interface StackSpec {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  /** How many corpus fixtures contain at least one element with this combination. */
  fixtures: number;
  /**
   * A fixture that uses it, so a disagreement can be reproduced by hand.
   * Stored relative to its entry in `sources` — the corpus file is committed,
   * and an absolute path would pin it to one developer's checkout layout.
   */
  example: string;
}

interface StackCorpus {
  generatedAt: string;
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

/** A face as we resolve it. */
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
 *     Caveat: a `.ttc` collection holds several faces behind one path, so this
 *     tier cannot distinguish Helvetica Regular from Helvetica Bold inside
 *     Helvetica.ttc. Weight/style parity is therefore only proven at tier 1.
 *  3. `agree-alias`     — a documented entry in FACE_ALIASES.
 */
export function identifyFace(chrome: ChromeFace, ours: OurFace, strictAlias: boolean): Verdict | null {
  const cName = norm(chrome.postScriptName ?? chrome.familyName);
  if (cName.length < 2) return null;
  if (ours.postscriptName != null && norm(ours.postscriptName) === cName) return "agree-exact";

  const cFile = chromeFaceFile(chrome);
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

interface ResolvedStack {
  spec: StackSpec;
  chain: string[];
  primaryKey: string;
  primary: NonNullable<ReturnType<typeof getFontInstance>>;
  slant: number;
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
function prepareStack(spec: StackSpec): ResolvedStack | null {
  const chain = resolveFontKeyChain(spec.fontFamily);
  const primaryKey = resolveFontKey(spec.fontFamily);
  const slant = slantForStyle(spec.fontStyle);
  // Mirror `resolveFont`'s opsz pin for an explicitly-named macOS optical cut,
  // so the instance we probe is the one the renderer would actually use.
  const cutOpsz = opticalCutOpszFor(spec.fontFamily);
  const variations = cutOpsz != null ? { opsz: cutOpsz } : undefined;
  const primary = getFontInstance(primaryKey, spec.fontWeight, spec.fontSize, slant, variations);
  if (primary == null) return null;
  return { spec, chain, primaryKey, primary, slant, notdefDonor: faceMeta(primaryKey, true) };
}

const ourPsCache = new Map<string, { path: string | null; postscriptName: string | null }>();

function faceMeta(key: string, covered: boolean): OurFace {
  let meta = ourPsCache.get(key);
  if (meta === undefined) {
    const spec = resolveFontSpec(key);
    // A `sysfb:` key carries the PostScript name the platform matcher returned.
    const fromKey = key.startsWith("sysfb:") ? key.slice("sysfb:".length) : null;
    meta = { path: spec?.path ?? null, postscriptName: spec?.postscriptName ?? fromKey };
    ourPsCache.set(key, meta);
  }
  return { key, path: meta.path, postscriptName: meta.postscriptName, covered };
}

function ourFaceFor(cp: number, rs: ResolvedStack): OurFace {
  const r = resolveFontForCodepoint(
    cp,
    rs.primary,
    rs.primaryKey,
    rs.spec.fontWeight,
    rs.spec.fontSize,
    rs.slant,
    undefined,
    undefined,
    rs.chain,
  );
  // An uncovered codepoint has no resolved face of its own — the renderer draws
  // the run primary's `.notdef`, so THAT is the face to compare against Chrome.
  return r.covered ? faceMeta(r.key, true) : { ...rs.notdefDonor, covered: false };
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

  async facesFor(cps: number[], spec: StackSpec): Promise<ChromeFace[][]> {
    const cells = cps
      .map((cp) => `<i class=c>&#x${cp.toString(16)};</i>`)
      .join("");
    // The computed `font-family` is already valid CSS and goes into a <style>
    // element, not an attribute — so it is embedded verbatim. Rewriting its
    // quotes would corrupt any family name that legitimately contains one.
    const family = spec.fontFamily;
    await this.page.setContent(
      `<!doctype html><html lang="${this.lang}"><head><meta charset="utf-8"><style>`
      + `body{margin:0}`
      + `#w{display:flex;flex-wrap:wrap;font-family:${family};font-size:${spec.fontSize}px;`
      + `font-weight:${spec.fontWeight};font-style:${spec.fontStyle}}`
      // `white-space:pre` is load-bearing: without it a cell holding U+0020 (or
      // any other space separator) collapses to nothing, Chrome paints no
      // glyph, and the oracle reports a mismatch that only exists because of
      // how the probe page was written.
      // `font-style:inherit` undoes the UA italic on `<i>` — the cell must be
      // rendered in the style the corpus entry declares, not in the tag's.
      + `.c{display:inline-block;width:${spec.fontSize + 8}px;height:${spec.fontSize + 8}px;`
      + `overflow:hidden;font-style:inherit;white-space:pre}`
      + `</style></head><body><div id=w>${cells}</div></body></html>`,
    );
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

const DEFAULT_STACKS_FILE = "tools/font-conformance-stacks.json";

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
async function extractStacks(browser: Browser, dirs: string[], outFile: string): Promise<StackCorpus> {
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
  const corpus: StackCorpus = { generatedAt: new Date().toISOString(), sources: dirs, stacks };
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
      process.stderr.write(`no stack corpus at ${opts.stacksFile} — run with --extract-stacks first\n`);
      return 2;
    }
    const corpus = JSON.parse(readFileSync(opts.stacksFile, "utf-8")) as StackCorpus;
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
    const classCounts = { "different-family": 0, "same-family-different-cut": 0 };
    let allowlistedCount = 0;
    let skippedStacks = 0;
    let chromeMs = 0;
    let oursMs = 0;
    const t0 = Date.now();

    for (const spec of stacks) {
      const rs = prepareStack(spec);
      if (rs == null) {
        skippedStacks++;
        process.stdout.write(`  SKIP (no resolvable primary): ${spec.fontFamily}\n`);
        continue;
      }
      process.stdout.write(
        `  stack ${spec.fontFamily} @${spec.fontSize}px/${spec.fontWeight}/${spec.fontStyle}`
        + ` → chain [${rs.chain.join(", ")}]\n`,
      );
      for (let i = 0; i < universe.length; i += opts.batch) {
        const cps = universe.slice(i, i + opts.batch);
        const tc = Date.now();
        const faces = await oracle.facesFor(cps, spec);
        chromeMs += Date.now() - tc;
        const to = Date.now();
        for (let j = 0; j < cps.length; j++) {
          const cp = cps[j];
          const chromeFaces = faces[j];
          const chrome = primaryChromeFace(chromeFaces);
          const ours = ourFaceFor(cp, rs);

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
              stackCounts.set(spec.fontFamily, (stackCounts.get(spec.fontFamily) ?? 0) + 1);
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
        process.stdout.write(
          `    ${done}/${universe.length}  mismatches=${mismatchRowsSeen}  `
          + `(${((Date.now() - t0) / 1000).toFixed(0)}s)\n`,
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
        stacksFile: opts.stacksFile,
        stackCorpusGeneratedAt: corpus.generatedAt,
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
    lines.push(`comparisons        ${comparisons.toLocaleString()}  (${universe.length.toLocaleString()} cps × ${stacks.length - skippedStacks} stacks)`);
    lines.push(`wall               ${(wallMs / 1000).toFixed(1)}s  (chrome ${(chromeMs / 1000).toFixed(1)}s, ours ${(oursMs / 1000).toFixed(1)}s)`);
    lines.push(`throughput         ${Math.round((comparisons / wallMs) * 1000).toLocaleString()} comparisons/s`);
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
