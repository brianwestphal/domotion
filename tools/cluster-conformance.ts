#!/usr/bin/env node
/**
 * CLUSTER-GRANULARITY font-fallback conformance oracle (docs/113).
 *
 * The sibling of `tools/font-conformance.ts`, for the one question that tool is
 * structurally unable to ask. The per-codepoint oracle sweeps one codepoint per
 * cell and compares the single face Chrome reports; by construction it can never
 * contain a MID-CLUSTER case — a base+mark (or a partial conjunct) where the
 * font that covers the base differs from the font that covers the mark. That is
 * exactly where fallback at shaped-cluster granularity (docs/113,
 * `src/render/cluster-fallback.ts`) diverges from a per-codepoint cmap walk, and
 * neither the 819-block unicode fixtures (one codepoint per cell) nor the
 * per-codepoint oracle can grade it. Measured: a flag-on A/B over nine complex-
 * script unicode blocks was identical to five decimals of raw `diffPct` with the
 * mechanism proven armed — the corpus is blind to the unit. This instrument
 * closes that gap.
 *
 * The unit of comparison is the RUN/FACE ASSIGNMENT, not pixels — the wrong font
 * can win a pixel diff (docs/113 §2). For each multi-codepoint CELL (a primary
 * font stack + a short multi-codepoint text):
 *
 *   Chrome's answer  CDP `CSS.getPlatformFontsForNode` over a SINGLE inline-block
 *                    cell containing the whole text — the set of faces (with
 *                    per-face glyph counts) Chrome actually painted it with.
 *   Our answer       `splitTextIntoGlyphPathRuns` — the REAL production run split
 *                    the glyph-path emitter uses (Blink's shape-then-requeue
 *                    mechanism when `DOMOTION_CLUSTER_FALLBACK` is on, the legacy
 *                    per-codepoint walk when it is off). NOT `resolveFontForCodepoint`:
 *                    the whole point is to grade the multi-codepoint run
 *                    assignment, which the per-codepoint resolver cannot express.
 *
 * A cell AGREES iff the reconciled SET of faces matches on both sides: every
 * face Chrome used is reconciled (via the per-codepoint oracle's `identifyFace`)
 * by some run we emit, and every run we emit is reconciled by some Chrome face.
 * A wrong font on either side — a mark split onto a fallback Chrome never
 * consults, or tofu where Chrome paints — is an unmatched face and reads RED.
 * Per-face glyph/codepoint counts are reported beside the families for human
 * reading but are NOT gated: HarfBuzz composition (Menlo α+U+0345 → one glyph
 * from two codepoints) makes a raw count mismatch expected even where the font
 * assignment is correct, and glyph-count parity is the shaping oracle's remit
 * (docs/108). This gate is about which FONT paints which cluster.
 *
 * Discrimination (the requirement that makes the instrument worth its exit code):
 * the shaped-cluster mechanism is shipped default-on and agrees on every
 * currently comparable cell, so a DEFAULT run is GREEN. Toggling
 * `DOMOTION_CLUSTER_FALLBACK=0` restores the legacy per-codepoint walk and this
 * oracle then reads RED on exactly the
 * cells the mechanism fixes (x+U+0951, ก+U+0301, Arial ل+U+08F0, Menlo α+U+0345).
 * That A/B is the proof the instrument discriminates; see docs/113 §2 and the
 * per-cell table in the ticket notes.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *
 *   npx tsx tools/cluster-conformance.ts                 # all cells, default arm
 *   DOMOTION_CLUSTER_FALLBACK=0 npx tsx tools/cluster-conformance.ts   # legacy arm
 *   npx tsx tools/cluster-conformance.ts --only menlo    # one cell by id substring
 *   npx tsx tools/cluster-conformance.ts --out <dir>     # report dir
 *
 * Exit code: 0 when every non-skipped cell agrees, 1 on any mismatch, 2 on a
 * harness error. Run the tsx/Playwright path with the sandbox disabled.
 * ---------------------------------------------------------------------------
 */
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as fontkit from "fontkit";
import {
  beginCharacterFallbackDocument,
  clearWebfonts,
  endCharacterFallbackDocument,
  getFontSourceInfo,
  registerWebfont,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  stackPrimaryIsSystemUi,
} from "../src/render/font-resolution.js";
import { splitTextIntoGlyphPathRuns } from "../src/render/text-to-path.js";
import { hbSubsetRetainGids } from "../src/render/hb-subset.js";
// Reuse the per-codepoint oracle's face-identity reconciliation verbatim, so
// "same face" means the same thing in both instruments.
import { type ChromeFace, identifyFace, type OurFace } from "./font-conformance.js";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const WEIGHT = 400;
const SIZE = 32;
const SLANT = 0;

/**
 * One measurement cell: a primary font stack and a multi-codepoint text.
 *
 * `text` carries the actual code units; `note` records the ground-truth Chrome
 * answer from docs/113 §2 so a report reader can see what SHOULD happen without
 * opening the design doc. A cell whose `webfont` is set builds a partial subset
 * at runtime and registers it on BOTH sides (Domotion via `registerWebfont`,
 * Chrome via an embedded `@font-face` data URL), so the two shape the same
 * partially-covered face.
 */
interface Cell {
  id: string;
  /** The CSS `font-family` value declared on the cell. */
  fontFamily: string;
  text: string;
  note: string;
  /** Built at runtime for the partial-webfont conjunct case. */
  webfont?: WebfontBuild;
  /** A measured parity gap tracked outside this instrument. Kept visible in
   *  the corpus and report, but excluded from this gate until resolved. */
  knownSkipReason?: string;
}

interface WebfontBuild {
  /** The `@font-face` family name registered on both sides. */
  family: string;
  /** A collection file to subset. */
  sourcePath: string;
  /** Codepoints to RETAIN (everything else is dropped from the face). */
  retainCps: number[];
}

/** The seed corpus — docs/113 §2's ten CDP-probed cases plus fully-covered
 *  controls (so the oracle proves it stays GREEN where nothing diverges). */
function buildCells(): Cell[] {
  const cells: Cell[] = [
    {
      id: "helvetica-x-udev-grave",
      fontFamily: "Helvetica",
      text: "x॑", // x + DEVANAGARI STRESS SIGN UDATTA
      note: "docs/113 §2: base covered, mark not — Chrome paints Helvetica ×2 (the mark is Helvetica's .notdef tofu). Legacy walk splits the mark onto Kohinoor Devanagari, which Chrome never consults.",
    },
    {
      id: "helvetica-thai-ko-acute",
      fontFamily: "Helvetica",
      text: "ก́", // ก + COMBINING ACUTE ACCENT
      note: "docs/113 §2: base not covered, mark covered — Chrome paints Thonburi ×2 (the covered mark travels with its base, keeping its GPOS anchor). Legacy walk splits mid-cluster: base Thonburi, mark Helvetica.",
    },
    {
      id: "arial-lam-u08F0",
      fontFamily: "Arial",
      text: "لࣰ", // ل + ARABIC OPEN MARK BELOW
      note: "docs/113 §2: Chrome paints Arial ×2 (the mark is Arial's .notdef). Legacy walk splits the mark onto SF Arabic.",
    },
    {
      id: "menlo-alpha-ypogegrammeni",
      fontFamily: "Menlo",
      text: "ᾳ", // α + COMBINING GREEK YPOGEGRAMMENI (decomposed input)
      note: "docs/113 §2: Chrome paints Menlo ×1 — HarfBuzz COMPOSES the decomposed input to the precomposed ᾳ glyph. Legacy walk splits the mark onto Monaco.",
    },
    {
      id: "geneva-e-thai-mai-ek",
      fontFamily: "Geneva",
      text: "e่", // e + THAI CHARACTER MAI EK
      note: "docs/113 §2: Chrome paints Geneva + Thonburi — U+0E48 is Script=Thai (not Inherited), so RunSegmenter splits base and mark into separate script runs BEFORE shaping. Both mechanisms agree here (per-cp granularity agrees by accident); a control for script itemization.",
    },
    // Fully-covered controls — the primary covers the whole cluster, so both
    // mechanisms keep it on the primary and Chrome reports one face. These must
    // stay GREEN in BOTH arms; a red here would mean the oracle over-reports.
    {
      id: "control-helvetica-x-acute",
      fontFamily: "Helvetica",
      text: "x́", // x + COMBINING ACUTE — Helvetica covers both
      note: "control: fully-covered Latin cluster, Helvetica ×2 both arms.",
    },
    {
      id: "control-times-hebrew-shin-qamats",
      fontFamily: "Times New Roman",
      text: "שָ", // ש + HEBREW POINT QAMATS — Times covers both
      note: "control: fully-covered pointed-Hebrew cluster, one Times run both arms.",
    },
    {
      id: "control-helvetica-thai-cluster-plus-latin",
      fontFamily: "Helvetica",
      text: "ก่้x", // ก + mai ek + mai tho + x
      note: "docs/113 §2 mixed line: Chrome paints Thonburi ×1 (the 3-codepoint Thai cluster) + Helvetica ×1. A two-face cell whose partition both mechanisms should get right at the cluster boundary.",
    },
  ];

  // Partial-webfont conjunct (docs/113 §2, last row). Subset a Devanagari face
  // to क + ् only (ष dropped), then render क्ष: Chrome shapes क्ष with the
  // webfont, keeps the unligated ष in its own cluster, and re-queues EXACTLY
  // that cluster to the system Devanagari font (webfont ×2 + Kohinoor ×1).
  // A glyf-based Devanagari face is required: hb-subset drops the `CFF ` outline
  // table of a CFF face (macOS Kohinoor/ITF are CFF), so subsetting one yields a
  // face with no outlines. Devanagari Sangam MN is TrueType-outlined. The ष the
  // subset drops re-queues to the system Devanagari face either way.
  const devaSrc = "/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc";
  if (existsSync(devaSrc)) {
    cells.push({
      id: "webfont-partial-conjunct-ksha",
      fontFamily: '"DM Cluster Partial Deva"',
      text: "क्ष", // क ् ष
      note: "docs/113 §2: partial webfont (क ् retained, ष subset away). Chrome paints webfont ×2 (क + visible halant) + a system-Devanagari ×1 (ष only) — the requeue unit is the shaped cluster, so only ष is re-queued, not the whole syllable.",
      webfont: {
        family: "DM Cluster Partial Deva",
        sourcePath: devaSrc,
        retainCps: [0x0915, 0x094d],
      },
    });
  }
  return cells;
}

/** Build the partial subset bytes for a webfont cell, or null if the source
 *  face is missing / the retained codepoints are not covered. */
function buildWebfontSubset(wf: WebfontBuild): Buffer | null {
  if (!existsSync(wf.sourcePath)) return null;
  const f0 = fontkit.openSync(wf.sourcePath);
  const face = ("fonts" in f0 ? (f0 as unknown as { fonts: Array<typeof f0> }).fonts[0] : f0) as {
    glyphForCodePoint(cp: number): { id: number };
  };
  const gids = [0];
  for (const cp of wf.retainCps) {
    const gid = face.glyphForCodePoint(cp).id;
    if (gid === 0) return null;
    gids.push(gid);
  }
  return hbSubsetRetainGids(readFileSync(wf.sourcePath), gids, 0, true, null);
}

// ---------------------------------------------------------------------------
// Our side — the REAL production run split
// ---------------------------------------------------------------------------

/** The face the renderer would load for a run — mirrors `faceFor` in
 *  `tools/font-conformance.ts` at run granularity. */
function ourFaceForRun(fontKey: string, font: OurRunFont): OurFace {
  const src = getFontSourceInfo(font as never);
  const spec = resolveFontSpec(fontKey);
  const fromKey = fontKey.startsWith("sysfb:") ? fontKey.slice("sysfb:".length) : null;
  return {
    key: fontKey,
    path: src?.path ?? spec?.path ?? null,
    postscriptName:
      font.instantiatedPostscriptName ?? font.postscriptName ?? src?.postscriptName ?? spec?.postscriptName ?? fromKey,
    covered: true,
  };
}

interface OurRunFont {
  instantiatedPostscriptName?: string;
  postscriptName?: string;
}

interface OurRun {
  face: OurFace;
  text: string;
  /** Unicode scalar values in the run — the count reported beside the face. */
  cpCount: number;
}

/** Run the production glyph-path splitter for a cell and reduce it to
 *  (face, text, codepoint-count) runs. Honors `DOMOTION_CLUSTER_FALLBACK`. */
function ourRunsForCell(cell: Cell): OurRun[] {
  const key = resolveFontKey(cell.fontFamily);
  const chain = resolveFontKeyChain(cell.fontFamily);
  const primary = resolveFont(cell.fontFamily, WEIGHT, SIZE, SLANT);
  if (primary == null) throw new Error(`no resolvable primary for ${cell.fontFamily}`);
  const runs = splitTextIntoGlyphPathRuns(
    cell.text,
    primary,
    key,
    WEIGHT,
    SIZE,
    SLANT,
    undefined,
    undefined,
    chain,
    stackPrimaryIsSystemUi(cell.fontFamily),
    100,
    undefined,
    cell.fontFamily,
  );
  return runs.map((r) => ({
    face: ourFaceForRun(r.fontKey, r.font as unknown as OurRunFont),
    text: r.text,
    cpCount: [...r.text].length,
  }));
}

// ---------------------------------------------------------------------------
// Chrome side — one multi-codepoint cell, the faces it painted with
// ---------------------------------------------------------------------------

function probePageHtml(cell: Cell, subset: Buffer | null): string {
  const entities = [...cell.text].map((ch) => `&#x${ch.codePointAt(0)!.toString(16)};`).join("");
  const face =
    cell.webfont != null && subset != null
      ? `@font-face{font-family:"${cell.webfont.family}";src:url(data:font/ttf;base64,${subset.toString("base64")}) format("truetype")}`
      : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>`
    + `body{margin:0}${face}`
    + `#w{display:flex;flex-wrap:wrap;font-family:${cell.fontFamily};font-size:${SIZE}px;`
    + `font-weight:${WEIGHT};font-style:normal}`
    // One inline-block cell holding the WHOLE multi-codepoint text — its own
    // block formatting context, so shaping stays inside the cell. `white-space:pre`
    // so a space separator is not collapsed away (see docs/107).
    + `.c{display:inline-block;font-style:inherit;white-space:pre}`
    + `</style></head><body><div id=w><i class=c>${entities}</i></body></html>`
  );
}

class ChromeSide {
  constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async create(browser: Browser): Promise<ChromeSide> {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 400 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    return new ChromeSide(page, cdp);
  }

  async facesFor(cell: Cell, subset: Buffer | null): Promise<ChromeFace[]> {
    await this.page.setContent(probePageHtml(cell, subset), { timeout: 60_000 });
    if (subset != null) await this.page.evaluate(() => document.fonts.ready);
    const { root } = await this.cdp.send("DOM.getDocument");
    const { nodeIds } = await this.cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".c" });
    if (nodeIds.length !== 1) throw new Error(`expected 1 cell, got ${nodeIds.length}`);
    const r = await this.cdp.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[0] });
    return r.fonts as ChromeFace[];
  }

  async close(): Promise<void> {
    await this.page.context().close();
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface FaceBucket {
  label: string;
  count: number;
}

/** Does this Domotion run's face reconcile with this Chrome face? The
 *  per-codepoint oracle's `identifyFace` for the ordinary case, plus a
 *  webfont-aware tier: `identifyFace` cannot reconcile a synthetic webfont
 *  instance (no PostScript name, no on-disk file), so a `webfont:` run matches a
 *  Chrome face that is a custom font or shares the registered family name. */
function reconciles(cf: ChromeFace, of: OurFace, webfontFamily: string | null): boolean {
  if (identifyFace(cf, of, false) != null) return true;
  if (of.key.startsWith("webfont:") && webfontFamily != null) {
    if (cf.isCustomFont === true) return true;
    if (norm(cf.familyName) === norm(webfontFamily)) return true;
  }
  return false;
}

interface CellResult {
  id: string;
  fontFamily: string;
  textHex: string;
  note: string;
  verdict: "agree" | "mismatch" | "skip";
  skipReason?: string;
  chromeFaces: FaceBucket[];
  ourFaces: FaceBucket[];
  ourRuns: Array<{ key: string; text: string; cpCount: number; postscriptName: string | null }>;
  unmatchedChrome: string[];
  unmatchedOurs: string[];
}

function chromeLabel(cf: ChromeFace): string {
  return cf.postScriptName ?? cf.familyName;
}
function ourLabel(of: OurFace): string {
  return of.postscriptName ?? of.key;
}

function judgeCell(cell: Cell, chromeFaces: ChromeFace[], ourRuns: OurRun[]): CellResult {
  const webfontFamily = cell.webfont?.family ?? null;

  // Distinct faces on each side, with aggregate counts (glyphCount for Chrome,
  // codepoint count for us) — reported, not gated.
  const chromeByLabel = new Map<string, { face: ChromeFace; count: number }>();
  for (const cf of chromeFaces) {
    const l = chromeLabel(cf);
    const hit = chromeByLabel.get(l);
    if (hit == null) chromeByLabel.set(l, { face: cf, count: cf.glyphCount });
    else hit.count += cf.glyphCount;
  }
  const ourByLabel = new Map<string, { face: OurFace; count: number }>();
  for (const r of ourRuns) {
    const l = ourLabel(r.face);
    const hit = ourByLabel.get(l);
    if (hit == null) ourByLabel.set(l, { face: r.face, count: r.cpCount });
    else hit.count += r.cpCount;
  }

  const chromeList = [...chromeByLabel.values()];
  const ourList = [...ourByLabel.values()];

  const unmatchedChrome = chromeList
    .filter((c) => !ourList.some((o) => reconciles(c.face, o.face, webfontFamily)))
    .map((c) => chromeLabel(c.face));
  const unmatchedOurs = ourList
    .filter((o) => !chromeList.some((c) => reconciles(c.face, o.face, webfontFamily)))
    .map((o) => ourLabel(o.face));

  const agree = unmatchedChrome.length === 0 && unmatchedOurs.length === 0 && chromeList.length > 0;

  return {
    id: cell.id,
    fontFamily: cell.fontFamily,
    textHex: [...cell.text].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" "),
    note: cell.note,
    verdict: agree ? "agree" : "mismatch",
    chromeFaces: chromeList.map((c) => ({ label: chromeLabel(c.face), count: c.count })),
    ourFaces: ourList.map((o) => ({ label: ourLabel(o.face), count: o.count })),
    ourRuns: ourRuns.map((r) => ({ key: r.face.key, text: r.text, cpCount: r.cpCount, postscriptName: r.face.postscriptName })),
    unmatchedChrome,
    unmatchedOurs,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Options {
  only: string | null;
  outDir: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { only: null, outDir: "tests/output/cluster-conformance" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") o.only = argv[++i] ?? null;
    else if (a === "--out") o.outDir = argv[++i] ?? o.outDir;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(readFileSync(new URL(import.meta.url).pathname, "utf-8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  let cells = buildCells();
  if (opts.only != null) cells = cells.filter((c) => c.id.includes(opts.only!));

  const clusterFlag = process.env.DOMOTION_CLUSTER_FALLBACK === "0" ? "legacy-per-codepoint" : "shaped-cluster (default)";
  const browser = await chromium.launch();
  const results: CellResult[] = [];
  beginCharacterFallbackDocument();
  try {
    const chrome = await ChromeSide.create(browser);
    for (const cell of cells) {
      if (cell.knownSkipReason != null) {
        results.push({
          id: cell.id, fontFamily: cell.fontFamily,
          textHex: [...cell.text].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).join(" "),
          note: cell.note, verdict: "skip", skipReason: cell.knownSkipReason,
          chromeFaces: [], ourFaces: [], ourRuns: [], unmatchedChrome: [], unmatchedOurs: [],
        });
        continue;
      }
      let subset: Buffer | null = null;
      if (cell.webfont != null) {
        subset = buildWebfontSubset(cell.webfont);
        if (subset == null) {
          results.push({
            id: cell.id, fontFamily: cell.fontFamily,
            textHex: [...cell.text].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).join(" "),
            note: cell.note, verdict: "skip", skipReason: `webfont source unavailable: ${cell.webfont.sourcePath}`,
            chromeFaces: [], ourFaces: [], ourRuns: [], unmatchedChrome: [], unmatchedOurs: [],
          });
          continue;
        }
        registerWebfont(cell.webfont.family, WEIGHT, "normal", subset);
      }
      try {
        const chromeFaces = await chrome.facesFor(cell, subset);
        const ourRuns = ourRunsForCell(cell);
        results.push(judgeCell(cell, chromeFaces, ourRuns));
      } finally {
        if (cell.webfont != null) clearWebfonts();
      }
    }
    await chrome.close();
  } finally {
    endCharacterFallbackDocument();
    await browser.close();
  }

  const agreed = results.filter((r) => r.verdict === "agree").length;
  const mismatched = results.filter((r) => r.verdict === "mismatch").length;
  const skipped = results.filter((r) => r.verdict === "skip").length;

  // ---- report -------------------------------------------------------------
  mkdirSync(opts.outDir, { recursive: true });
  const report = {
    meta: {
      contract: "docs/120-same-machine-text-parity-contract.md",
      verdictStage: "shaping-face-boundaries",
      verdict: mismatched === 0 ? "exact-logical-agreement" : "logical-mismatch",
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      chromium: browser.version(),
      clusterFallback: clusterFlag,
      cells: results.length,
      agreed,
      mismatched,
      skipped,
    },
    results,
  };
  writeFileSync(join(opts.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines: string[] = [];
  lines.push(`cluster-conformance — ${process.platform} ${process.arch}, ${browser.version()}`);
  lines.push(`mechanism          ${clusterFlag}  (DOMOTION_CLUSTER_FALLBACK=${process.env.DOMOTION_CLUSTER_FALLBACK ?? "unset"})`);
  lines.push(`cells              ${results.length}   agree ${agreed}   MISMATCH ${mismatched}   skip ${skipped}`);
  lines.push("");
  for (const r of results) {
    const mark = r.verdict === "agree" ? "OK  " : r.verdict === "skip" ? "SKIP" : "FAIL";
    lines.push(`${mark}  ${r.id}   [${r.fontFamily}]  ${r.textHex}`);
    if (r.verdict === "skip") {
      lines.push(`        (${r.skipReason})`);
      continue;
    }
    lines.push(`        chrome:  ${r.chromeFaces.map((f) => `${f.label}×${f.count}`).join("  +  ") || "(none)"}`);
    lines.push(`        ours:    ${r.ourRuns.map((f) => `${f.key} "${f.text}"×${f.cpCount}`).join("  +  ") || "(none)"}`);
    if (r.verdict === "mismatch") {
      if (r.unmatchedChrome.length > 0) lines.push(`        chrome faces we never assigned: ${r.unmatchedChrome.join(", ")}`);
      if (r.unmatchedOurs.length > 0) lines.push(`        our faces chrome never used:    ${r.unmatchedOurs.join(", ")}`);
    }
  }
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(opts.outDir, "summary.txt"), text);
  process.stdout.write(`\n${text}`);
  process.stdout.write(`report → ${join(opts.outDir, "report.json")}\n`);

  return mismatched > 0 ? 1 : 0;
}

// Only sweep when run as a script — the pure pieces (`buildCells`, `judgeCell`,
// `reconciles`, `ourFaceForRun`) are imported by the unit test without launching
// a browser.
const invokedDirectly =
  process.argv[1] != null && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`cluster-conformance failed: ${String(err instanceof Error ? err.stack : err)}\n`);
      process.exitCode = 2;
    },
  );
}

export { buildCells, buildWebfontSubset, judgeCell, ourFaceForRun, ourRunsForCell, reconciles };
export type { Cell, CellResult, OurRun };
