/**
 * SHAPING conformance oracle — the sibling of `tools/font-conformance.ts`.
 *
 * The face oracle answers "which font paints this codepoint, and did we pick
 * the same?" and nothing else. It proves *which font*; it never proves *which
 * glyphs, where*. Ligatures, contextual forms, Indic reordering, Arabic
 * joining, mark attachment and cluster mapping are all invisible to it — a
 * mark placed 3px wrong scores as a clean pass, because the face was right.
 *
 * This asks the shaping question instead, of the same two parties:
 *
 *   Chrome's answer  CDP `CSS.getPlatformFontsForNode` glyph counts (how many
 *                    glyphs Chrome's HarfBuzz produced, per face) plus the
 *                    per-source-character geometry from `Range.getClientRects()`.
 *   Our answer       production selected-run provenance for logical glyph count
 *                    and identity, joined to the `<text x="…">` positions
 *                    `renderTextAsPath` actually paints.
 *
 * Neither side exposes glyph IDs: there is no glyph-level CDP domain, and
 * `getPlatformFontsForNode` carries only familyName / postScriptName /
 * isCustomFont / glyphCount. So this compares what both sides *do* expose, which
 * is strictly more than the face oracle and enough to catch the classes above:
 * a ligature that fails to form changes the glyph count, and a mark attached at
 * the wrong offset changes a position.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *
 *   npx tsx tools/shaping-conformance.ts                  # full derived corpus
 *   npx tsx tools/shaping-conformance.ts --extract-runs   # re-derive it and exit
 *   npx tsx tools/shaping-conformance.ts --max-runs 200   # a slice
 *
 *   --runs <file>        run corpus            (tools/shaping-conformance-runs.json)
 *   --extract-runs       re-derive it from the fixtures and exit
 *   --source a,b         fixture dirs to extract from
 *   --max-runs n         cap the corpus to the n most-used runs
 *   --split-words        (with --extract-runs) split EVERY text node on
 *                        whitespace, not just the axis- / feature-bearing ones.
 *                        An experiment switch, kept so the decision stays
 *                        reproducible: it grows the corpus 10.65x (2,454 ->
 *                        26,140) and the sweep 7.3s -> 55.8s, and 97.23% of the
 *                        added runs merely restate `agree-exact`. See docs/108,
 *                        "Universal whitespace splitting", for the tier diff.
 *   --tolerance px       per-glyph position tolerance (0.5)
 *   --allowlist <file>   accepted-divergence file
 *   --out <dir>          report directory (tests/output/shaping-conformance)
 *
 * Exit code: 0 when every run agrees or is allowlisted, 1 on any mismatch,
 * 2 on a harness error — same contract as the face oracle, so it can gate.
 */
import { chromium, type Browser } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderTextAsPath } from "../src/render/text-to-path.js";
import {
  clearFontResolutionCaches, registerWebfont,
} from "../src/render/font-resolution.js";
import { harfbuzzGlyphQuery } from "../src/render/harfbuzz-shaper.js";
import {
  parseFontFeatureSettings, parseFontVariationSettings, resolveFontVariantFeatures,
  mergeFeatureLists,
} from "../src/render/text.js";
import {
  getTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
  textRunProvenanceEnabled,
  type TextRunProvenanceDiagnostic,
} from "../src/render/text-run-provenance.js";
import { isHarfbuzzDefaultIgnorable } from "../src/render/unicode-classification.js";
import {
  exactWebfontFeatureRecord,
  resolvedFeatureValueList,
  serializeFontFeatureValues,
  type ExactFeatureValueRecord,
  type FontFeatureValueTables,
} from "./shaping-font-feature-values.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One (text run, font description) pair drawn from the fixture corpus. */
export interface RunSpec {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  /**
   * Computed `font-variation-settings` — the run's variable-axis location, or
   * `"normal"`. Part of the run's IDENTITY, not decoration: one variable face
   * at two axis locations is two different sets of outlines, so a corpus that
   * omits it sweeps a wght-700 run as though it were wght-400 and cannot
   * distinguish the two. Measured on `20-deep-font-palette.html`, whose
   * `.var-stack` runs resolve through an uninstalled "Inter Variable" to
   * macOS `system-ui`: stripping the axes moves Chrome's painted width by
   * 76.27px and 3.56px, so the axis is doing real work the sweep was blind to.
   *
   * Optional on read so a corpus file written before this field existed still
   * parses; the extractor always writes it.
   */
  fontVariationSettings?: string;
  /**
   * Computed `font-stretch` — always a percentage string out of Chrome
   * (`"100%"` = normal). Part of the run's identity for the same reason the
   * axis location is: on the macOS `system-ui` face the width IS the variable
   * `wdth` axis (133.52px at 50% to 272.70px at 200% for one 26px run —
   * measured while the renderer still dropped the property), and on a declared
   * family it selects the condensed / expanded cut.
   *
   * Optional on read so a corpus file written before this field existed still
   * parses (absent = `"100%"`, which is what every pre-existing run computed
   * to); the extractor always writes it.
   */
  fontStretch?: string;
  /**
   * Computed `font-feature-settings` (e.g. `"tnum" 1`, `"liga" 0, "dlig" 0`).
   *
   * This is the property whose consequence this oracle OWNS, and it was the one
   * the run corpus did not record. The face oracle (docs/107) deliberately
   * carries it without being able to adjudicate it: `feature_settings_` is
   * absent from `FontDescription::CacheKey`, so no feature setting can change
   * which face Chrome reports. What it changes is which GLYPHS that face
   * produces, which is exactly what this tool compares.
   *
   * The path, end to end: Blink appends every author setting verbatim onto the
   * HarfBuzz feature array with no resolution against the features it already
   * pushed from `font-variant-*` — `FontFeatureRange::FromFontDescription`,
   * `platform/fonts/shaping/font_features.cc:203-225`, whose own TODO at :205
   * notes the missing resolution (Chromium `7d859f27`). HarfBuzz then turns each
   * `hb_feature_t` into a lookup mask — `add_feature` (`hb-ot-shape.cc:392-398`
   * -> `hb-ot-map.cc:97`), a per-feature bit slice at compile
   * (`hb-ot-map.cc:312-322`) stamped onto every lookup the feature references
   * (`hb-ot-map.cc:160`), OR'd onto the buffer's glyph masks
   * (`hb-ot-shape.cc:753`) and gated per glyph by `cur.mask & c->lookup_mask`
   * (`hb-ot-layout.cc:1960`) — and a matching GSUB lookup rewrites the glyph
   * (`OT/Layout/GSUB/SingleSubstFormat1.hh:178`). HarfBuzz checkout `4de187d`.
   *
   * Measured on macOS `system-ui`, which is why an all-agree result here would
   * be suspicious rather than reassuring: `1/2 3/4` runs 97.86px by default and
   * 58.66px under `"frac" 1`; `hamburgefonstiv` runs 231.30px and 255.36px under
   * `"smcp" 1`; `0123456789` runs 188.64px and 197.50px under `"tnum" 1`. The
   * reported face is `.SFNS-Regular` throughout.
   *
   * Optional on read so a corpus file written before this field existed still
   * parses; the extractor always writes it.
   */
  fontFeatureSettings?: string;
  /**
   * Computed `font-variant-alternates` plus the effective family-scoped alias
   * storage that made its named functions meaningful in the fixture.
   *
   * The computed property alone is not enough: `stylistic(fancy)` is only an
   * author-facing token. Blink resolves it for the candidate family in
   * `CSSFontSelector::GetFontData`, using the document's fused
   * `FontFeatureValuesStorage`, and gives HarfBuzz `salt=<index>` (likewise
   * `ssNN`, `cvNN`, `swsh`+`cswh`, `ornm`, and `nalt`). The synthetic probe
   * page must carry the same storage or both sides silently shape with the
   * named feature disabled.
   */
  fontVariantAlternates?: string;
  fontFeatureValues?: FontFeatureValueTables;
  /** Exact alias-derived list, persisted to make stale/corrupt corpus rows fail. */
  resolvedFontFeatures?: string[];
  /**
   * A self-contained webfont face retained by the extractor. Only data-URL
   * sources are accepted: a local()/remote/file URL that cannot travel with
   * the probe remains excluded rather than being scored against a fallback.
   */
  webfont?: {
    family: string;
    mime: string;
    dataBase64: string;
    weightDescriptor: string;
    styleDescriptor: string;
    stretchDescriptor: string;
  };
  /**
   * The run's computed `letter-spacing` and `text-rendering` (DM-1983).
   *
   * Both are SHAPING inputs, not just layout ones. Blink's feature emission
   * disables `liga`/`clig`/`calt` whenever letter-spacing is non-zero or
   * `text-rendering` is `optimizeSpeed` — `FontFeatureRange::FromFontDescription`
   * (`platform/fonts/shaping/font_features.cc:52-86`, rev 7d859f27) — and the
   * first term of that disjunction outranks the author's `font-variant-ligatures`
   * keyword outright. A corpus without them sweeps a population in which neither
   * veto can fire, so a regression in either would not turn this red.
   *
   * The graded consequence is the GLYPH COUNT: "ffi" is one glyph ligated and
   * three unligated, and glyph count is what `mismatch-count` scores. The
   * POSITIONS of a letter-spaced run are expected to land in the non-gating
   * `agree-count` tier instead, because the renderer receives spacing as
   * captured per-character xOffsets and this probe supplies none — that is a
   * known limit of the instrument, not a disagreement about shaping.
   *
   * Optional on read so a corpus file written before these existed still parses;
   * the extractor always writes them.
   */
  letterSpacing?: string;
  textRendering?: string;
  /**
   * The run's computed `font-variant-ligatures` (DM-1983).
   *
   * Recorded for two reasons. It is a shaping input in its own right — the
   * keyword disables (`none`, `no-common-ligatures`, `no-contextual`) are the
   * path DM-1960 routed through HarfBuzz, and the corpus could previously see
   * them only where an author happened to spell the same thing as
   * `font-feature-settings: "liga" 0`.
   *
   * And without it the corpus cannot distinguish a letter-spaced run from a
   * letter-spaced run that ALSO asks for `common-ligatures` — the two dedupe to
   * one spec. That pair is the case worth having: letter-spacing is the first
   * term of Blink's disjunction, so the keyword does not survive it, and a model
   * that treated these properties as an overridable default would agree on every
   * other row and disagree only there.
   */
  fontVariantLigatures?: string;
  fixtures: number;
  example: string;
}

export interface RunCorpus {
  generatedAt: string;
  sources: string[];
  /**
   * Whether the extractor split EVERY text node on whitespace rather than only
   * the axis- and feature-bearing ones. Recorded because it changes what the
   * corpus IS — a `--split-words` corpus and a default one are not two samples
   * of the same population, and a sweep summary that does not say which it read
   * invites comparing tallies across the two.
   *
   * Optional on read so a corpus file written before this field existed still
   * parses (absent = `false`, the default extraction).
   */
  splitWords?: boolean;
  runs: RunSpec[];
}

/** What Chrome did with a run. */
interface ChromeShaping {
  /** Total glyphs Chrome produced across every face it used. */
  glyphCount: number;
  /** Per-face `postScriptName × glyphCount`, in Chrome's own order. */
  faces: string[];
  /** Browser ownership proof for retained @font-face rows. */
  customFaces?: boolean[];
  /** Distinct x positions of the source characters, ascending. */
  xs: number[];
  /** Painted width of the run. */
  width: number;
}

/** What we did with the same run. */
export interface OurShaping {
  glyphCount: number;
  xs: number[];
  /** null when the renderer declined the run (no resolvable font). */
  ok: boolean;
  /** Exact final HarfBuzz feature list, including resolved named alternates. */
  featureList?: string[];
  /** Complete pre-raster logical record for a retained webfont run. */
  logicalRecord?: ExactFeatureValueRecord;
  /** The terminal production emitter's pre-paint glyph stream. Inkless glyphs
   * remain here even when final SVG paint correctly contains no outline. */
  logicalGlyphs: TextRunProvenanceDiagnostic["glyphs"];
  logicalRuns: TextRunProvenanceDiagnostic[];
}

/** Fail-closed source-equivalent control for the standalone default-ignorable
 * rows. CDP exposes the count and selected face but not gids; the gid oracle is
 * therefore the pinned HarfBuzz nominal-space lookup on those selected bytes. */
export function assertStandaloneDefaultIgnorableRecord(
  text: string,
  logicalRuns: TextRunProvenanceDiagnostic[],
): void {
  const scalars = [...text];
  if (scalars.length !== 1 || !isHarfbuzzDefaultIgnorable(scalars[0].codePointAt(0)!)) return;
  if (logicalRuns.length !== 1) throw new Error(`standalone default-ignorable produced ${logicalRuns.length} terminal runs`);
  const run = logicalRuns[0];
  if (run.sourceText !== text || run.emittedText !== text
      || JSON.stringify(run.sourceSpan) !== JSON.stringify([0, text.length])
      || JSON.stringify(run.sourceCodepointSpan) !== "[0,1]"
      || run.selected.shapesWithHarfbuzz !== true) {
    throw new Error(`standalone default-ignorable scalar/run record disagrees with source: ${JSON.stringify(run)}`);
  }
  const path = run.selected.sourcePath;
  const member = run.selected.faceIndex;
  if (path == null || member == null) throw new Error("standalone default-ignorable selected no source face");
  const expectedGid = harfbuzzGlyphQuery(path, member)?.nominalGlyph(0x20) ?? 0;
  // HarfBuzz deletes the ignorable when the selected face has no invisible or
  // U+0020 glyph. That is the other source-owned branch, not an omission.
  if (expectedGid === 0) {
    if (run.glyphs.length !== 0) throw new Error("standalone default-ignorable face lacks U+0020 but retained a glyph");
    return;
  }
  if (run.glyphs.length !== 1) throw new Error(`standalone default-ignorable produced ${run.glyphs.length} logical glyphs`);
  const glyph = run.glyphs[0];
  const expectedSpan: [number, number] = [0, text.length];
  if (glyph.id !== expectedGid
      || JSON.stringify(glyph.sourceSpan) !== JSON.stringify(expectedSpan)
      || JSON.stringify(glyph.sourceCodepointSpan) !== "[0,1]"
      || glyph.cluster !== 0
      || glyph.xAdvance !== 0 || glyph.yAdvance !== 0
      || glyph.xOffset !== 0 || glyph.yOffset !== 0
      || glyph.sourceOutline !== null) {
    throw new Error(`standalone default-ignorable logical record disagrees with HarfBuzz source: ${JSON.stringify(glyph)}`);
  }
}

export function assertStandaloneDefaultIgnorableFace(
  text: string,
  logicalRuns: TextRunProvenanceDiagnostic[],
  chromeFaces: string[],
): void {
  const scalars = [...text];
  if (scalars.length !== 1 || !isHarfbuzzDefaultIgnorable(scalars[0].codePointAt(0)!)) return;
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const selected = logicalRuns[0]?.selected.instantiatedPostscriptName
    ?? logicalRuns[0]?.selected.postscriptName;
  const chrome = chromeFaces.map((face) => face.replace(/×\d+$/, ""));
  if (selected == null || !chrome.some((face) => normalize(face) === normalize(selected))) {
    throw new Error(`standalone default-ignorable selected face ${selected ?? "(none)"} != Chromium ${chrome.join(",") || "(none)"}`);
  }
}

type Verdict =
  | "agree-exact"          // same glyph count AND every position within tolerance
  | "agree-count"          // same glyph count, comparable positions DIFFER
  | "agree-count-clustered" // same glyph count, positions NOT comparable (see below)
  | "mismatch-count"       // different glyph count — a shaping decision differs
  | "mismatch-unrendered"; // we produced nothing for a run Chrome painted

interface MismatchRow {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  verdict: Verdict;
  chromeGlyphs: number;
  ourGlyphs: number;
  chromeFaces: string[];
  chromeXs: number[];
  ourXs: number[];
  maxDelta: number | null;
}

// ---------------------------------------------------------------------------
// Corpus derivation — DERIVED from the fixtures, never authored.
// ---------------------------------------------------------------------------

const DEFAULT_RUNS_FILE = "tools/shaping-conformance-runs.json";

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
 * Harvest (text run, font description) pairs from the fixture corpus.
 *
 * Same reason the face oracle derives its stacks rather than listing them: a
 * hand-written list of "interesting" strings is the sampled artifact this tool
 * exists to replace, and it would inevitably contain the cases someone already
 * thought of. Runs come from what the fixtures actually render.
 */
export async function extractRuns(
  browser: Browser,
  dirs: string[],
  outFile: string,
  opts: { splitWords?: boolean } = {},
): Promise<RunCorpus> {
  const splitWords = opts.splitWords === true;
  const files: Array<{ path: string; label: string }> = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const p of walkHtml(d)) files.push({ path: p, label: `${d}/${p.slice(d.length).replace(/^\/+/, "")}` });
  }
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const tally = new Map<string, { spec: Omit<RunSpec, "fixtures" | "example">; fixtures: number; example: string }>();
  let n = 0;
  for (const { path: file, label } of files) {
    n++;
    if (n % 50 === 0) process.stderr.write(`  extract ${n}/${files.length}\n`);
    try {
      await page.goto(`file://${resolve(file)}`, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
    } catch {
      continue;
    }
    const found = await page.evaluate((splitEvery: boolean) => {
      const out: string[] = [];
      // Families this document defines with `@font-face`. A run in such a family
      // can only be swept when the exact bytes can travel with it. A retained
      // base64 data URL is self-contained; local(), file and remote URLs are not
      // and remain excluded rather than being scored against a fallback.
      //
      // Measured on `20-font-face.html`, whose rules are `src: local(...)` only:
      // the fixture paints `TestSerif` as Georgia and `TestMono` as Menlo, while
      // the oracle's probe page paints them as Times and Courier. The runs scored
      // 28 agree-exact / 4 agree-count — a clean-looking result about the wrong
      // fonts.
      //
      // This is the same refusal principle as the whitespace rule: when the
      // instrument cannot ask the fixture's question faithfully, drop it. The
      // data-URL exception is intentionally narrow and source-owned: the same
      // bytes are re-declared to Chrome and registered with Domotion.
      const fontFaceFamilies = new Set<string>();
      const harvestableFaces = new Map<string, {
        family: string; mime: string; dataBase64: string;
        weightDescriptor: string; styleDescriptor: string; stretchDescriptor: string;
      }>();
      const disqualifiedFaceFamilies = new Set<string>();
      // Layer order is not ordinary source order. Refuse an alternates-bearing
      // run whose family has a layered rule until the corpus models Blink's
      // FontFeatureValuesStorage layer-priority fusion exactly.
      const layeredFeatureValueFamilies = new Set<string>();
      const featureTables: Record<string, Record<string, Record<string, number[]>>> = {};
      const pendingRules: Array<{ rule: CSSRule; inLayer: boolean }> = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          pendingRules.push(...Array.from(sheet.cssRules).map((rule) => ({ rule, inLayer: false })));
        } catch {
          // Cross-origin stylesheet — unreadable by design. Nothing to add.
        }
      }
      while (pendingRules.length > 0) {
        const { rule, inLayer } = pendingRules.shift()!;
        if (rule.constructor.name === "CSSFontFaceRule") {
          const style = (rule as CSSFontFaceRule).style;
          const rawFamily = style.getPropertyValue("font-family").trim();
          const family = rawFamily.replace(/^["']|["']$/g, "");
          const key = family.toLowerCase();
          if (key === "") continue;
          fontFaceFamilies.add(key);
          const src = style.getPropertyValue("src");
          const data = /^\s*url\(\s*["']?(data:([^;,]+)?;base64,([A-Za-z0-9+/=]+))["']?\s*\)/i.exec(src);
          // Multiple declarations for one family involve Blink's descriptor
          // matching and source order. Do not pretend one retained face owns
          // that question; the dedicated fixture deliberately has one.
          if (data == null || harvestableFaces.has(key) || disqualifiedFaceFamilies.has(key)) {
            harvestableFaces.delete(key);
            disqualifiedFaceFamilies.add(key);
            continue;
          }
          harvestableFaces.set(key, {
            family,
            mime: data[2] || "font/otf",
            dataBase64: data[3],
            weightDescriptor: style.getPropertyValue("font-weight") || "400",
            styleDescriptor: style.getPropertyValue("font-style") || "normal",
            stretchDescriptor: style.getPropertyValue("font-stretch") || "100%",
          });
          continue;
        }
        const featureRule = rule as CSSRule & {
          fontFamily?: string;
          annotation?: Map<string, number[]>; ornaments?: Map<string, number[]>;
          stylistic?: Map<string, number[]>; swash?: Map<string, number[]>;
          characterVariant?: Map<string, number[]>; styleset?: Map<string, number[]>;
        };
        if (typeof featureRule.fontFamily === "string" && featureRule.stylistic != null) {
          const families = featureRule.fontFamily.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,])+/g) ?? [];
          for (const rawFamily of families) {
            const family = rawFamily.trim().replace(/^["']|["']$/g, "").toLowerCase();
            if (family === "") continue;
            if (inLayer) layeredFeatureValueFamilies.add(family);
            const table = featureTables[family] || (featureTables[family] = {});
            for (const category of ["annotation", "ornaments", "stylistic", "swash", "characterVariant", "styleset"] as const) {
              const map = featureRule[category];
              if (map == null) continue;
              const aliases = table[category] || (table[category] = {});
              for (const [name, values] of Array.from(map.entries())) aliases[name] = Array.from(values);
            }
          }
          continue;
        }
        const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
        if (nested != null) {
          const nestedInLayer = inLayer || rule.constructor.name === "CSSLayerBlockRule";
          pendingRules.unshift(...Array.from(nested).map((child) => ({ rule: child, inLayer: nestedInLayer })));
        }
      }
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const cs = getComputedStyle(el as Element);
        // Any family in the stack, not merely the first: a later entry only gets
        // used when the earlier ones fail to resolve, and which of them Chrome
        // lands on is exactly what differs between the fixture and the probe
        // page. Written inline rather than as a named helper on purpose — this
        // body is serialized into the page, where the `__name` wrapper that
        // tsx/esbuild emits for a named function binding does not exist.
        const stackFamilies = (cs.fontFamily.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,])+/g) ?? [])
          .map((family) => family.trim().replace(/^["']|["']$/g, "").toLowerCase());
        const declaredFaces = stackFamilies.filter((family) => fontFaceFamilies.has(family));
        if (declaredFaces.some((family) => !harvestableFaces.has(family))) continue;
        // More than one retained face would require preserving the complete
        // descriptor-selection set. Refuse it rather than pick a convenient one.
        if (declaredFaces.length > 1) continue;
        const webfont = declaredFaces.length === 1 ? harvestableFaces.get(declaredFaces[0]) : undefined;
        const fvs = cs.fontVariationSettings === "" ? "normal" : cs.fontVariationSettings;
        const stretch = cs.fontStretch === "" ? "100%" : cs.fontStretch;
        const ffs = cs.fontFeatureSettings === "" ? "normal" : cs.fontFeatureSettings;
        const fva = cs.fontVariantAlternates === "" ? "normal" : cs.fontVariantAlternates;
        if (fva !== "normal" && stackFamilies.some((family) => layeredFeatureValueFamilies.has(family))) continue;
        const relevantFeatureTables: Record<string, Record<string, Record<string, number[]>>> = {};
        if (fva !== "normal") {
          for (const family of stackFamilies) {
            if (featureTables[family] != null) relevantFeatureTables[family] = featureTables[family];
          }
        }
        const ls = cs.letterSpacing === "" ? "normal" : cs.letterSpacing;
        const tr = cs.textRendering === "" ? "auto" : cs.textRendering;
        const fvl = cs.fontVariantLigatures === "" ? "normal" : cs.fontVariantLigatures;
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType !== 3) continue;
          const raw = (node.textContent ?? "").trim();
          if (raw === "") continue;
          // Candidate texts for this node. Normally the node's whole trimmed
          // text, subject to the WHITESPACE-FREE rule below.
          //
          // The two sides count spaces differently: Chrome's `glyphCount`
          // includes the space glyphs HarfBuzz produced, while our renderer
          // usually emits no position for them (no ink) but DOES for some paths
          // (measured: the emoji path emits one per character, spaces included).
          // Normalizing by subtracting the whitespace count papers over that with
          // an assumption that is false in at least one path, so the corpus
          // excludes the question instead. Nothing is lost for shaping: ligatures,
          // contextual joining, Indic reordering and mark attachment are all
          // WITHIN-word phenomena, and a space is a word boundary.
          //
          // Runs carrying a non-normal axis get their text SPLIT on whitespace
          // instead of dropped. Whole-node filtering left the corpus with zero
          // axis-bearing runs — measured: every one of the 11 axis-declaring
          // text nodes in the fixture corpus contains a space, so recording the
          // axis without this would widen the schema and change nothing. Splitting
          // keeps the whitespace-free invariant exactly (each word has no space)
          // and is the same word-boundary argument the paragraph above makes.
          // It is applied ONLY to axis-bearing nodes on purpose: splitting every
          // node is a separate question about sweep breadth, not about axis
          // coverage, and it has now been measured and declined (see below).
          //
          // FEATURE-bearing nodes get the same treatment, for the identical
          // reason and with the identical hazard: the fixtures that declare
          // `font-feature-settings` demonstrate ligatures and numeral styles
          // with multi-word samples, so whole-node filtering would drop every
          // one of them and leave this field recorded-but-never-swept — a
          // vacuous extraction that reads as a stable, clean number.
          //
          // `--split-words` widens the split to EVERY node. Measured on this
          // machine against `external/html-test`: 2,454 -> 26,140 runs (10.65x,
          // a strict superset with every shared verdict unchanged), sweep 7.3s
          // -> 55.8s. DECLINED: 97.23% of the added runs merely restate
          // `agree-exact`, the new position tier is TIGHTER than the one already
          // reported (median 0.59px vs 0.88px), and all 6 added hard mismatches
          // are default-ignorable artifacts rather than defects — U+00AD and the
          // bidi controls, which HarfBuzz keeps as ZERO-ADVANCE invisible glyphs
          // (`hb_ot_hide_default_ignorables`, hb-ot-shape.cc:824-847, checkout
          // 4de187d) and Chrome therefore counts while we correctly paint none.
          // That is the very disagreement this whitespace rule exists to
          // exclude, leaking back in because /\s/ does not match an ignorable.
          // See docs/108, "Universal whitespace splitting", for the tier diff;
          // the switch exists so the measurement stays reproducible.
          const texts = splitEvery || fvs !== "normal" || ffs !== "normal" || fva !== "normal"
            ? raw.split(/\s+/) : [raw];
          for (const text of texts) {
            if (text === "" || text.length > 24 || /\s/.test(text)) continue;
            out.push(JSON.stringify({
              text,
              fontFamily: cs.fontFamily,
              fontSize: Math.round(parseFloat(cs.fontSize)),
              fontWeight: parseInt(cs.fontWeight, 10) || 400,
              fontStyle: cs.fontStyle,
              fontVariationSettings: fvs,
              fontStretch: stretch,
              fontFeatureSettings: ffs,
              fontVariantAlternates: fva,
              fontFeatureValues: Object.keys(relevantFeatureTables).length > 0 ? relevantFeatureTables : undefined,
              webfont,
              letterSpacing: ls,
              textRendering: tr,
              fontVariantLigatures: fvl,
            }));
          }
        }
      }
      return out;
    }, splitWords);
    for (const s of found) {
      const spec = JSON.parse(s) as Omit<RunSpec, "fixtures" | "example">;
      if (spec.fontVariantAlternates != null && spec.fontVariantAlternates !== "normal") {
        spec.resolvedFontFeatures = resolvedFeatureValueList(
          spec.fontVariantAlternates,
          spec.fontFamily,
          spec.fontFeatureValues,
        );
      }
      const key = JSON.stringify(spec);
      const hit = tally.get(key);
      if (hit == null) tally.set(key, { spec, fixtures: 1, example: label });
      else hit.fixtures++;
    }
  }
  await ctx.close();
  const runs: RunSpec[] = Array.from(tally.values())
    .map((v) => ({ ...v.spec, fixtures: v.fixtures, example: v.example }))
    .sort((a, b) => b.fixtures - a.fixtures || a.text.localeCompare(b.text));
  const corpus: RunCorpus = { generatedAt: new Date().toISOString(), sources: dirs, splitWords, runs };
  writeFileSync(outFile, `${JSON.stringify(corpus, null, 2)}\n`);
  return corpus;
}

// ---------------------------------------------------------------------------
// Chrome's side
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function probeEnvironmentKey(spec: RunSpec): string {
  return JSON.stringify([spec.webfont ?? null, spec.fontFeatureValues ?? null]);
}

export function resolvedFeaturesForRun(spec: RunSpec): string[] {
  const resolved = resolvedFeatureValueList(
    spec.fontVariantAlternates,
    spec.fontFamily,
    spec.fontFeatureValues,
  );
  if (spec.resolvedFontFeatures != null
      && JSON.stringify(spec.resolvedFontFeatures) !== JSON.stringify(resolved)) {
    throw new Error(`stale font-feature-values row for ${spec.fontFamily}: expected `
      + `${JSON.stringify(spec.resolvedFontFeatures)}, resolved ${JSON.stringify(resolved)}`);
  }
  return resolved;
}

function webfontFaceCss(spec: RunSpec): string {
  const face = spec.webfont;
  if (face == null) return "";
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(face.mime)
      || !/^[A-Za-z0-9+/=]+$/.test(face.dataBase64)) {
    throw new Error(`invalid retained webfont data for ${face.family}`);
  }
  return `@font-face{font-family:${JSON.stringify(face.family)};`
    + `src:url(data:${face.mime};base64,${face.dataBase64});`
    + `font-weight:${face.weightDescriptor};font-style:${face.styleDescriptor};`
    + `font-stretch:${face.stretchDescriptor};}`;
}

/** Serialize the exact document-scoped environment used by one probe batch. */
export function shapingProbePageHtml(specs: RunSpec[]): string {
  if (new Set(specs.map(probeEnvironmentKey)).size > 1) {
    throw new Error("shaping probe batch mixes distinct font-feature-values environments");
  }
  for (const spec of specs) resolvedFeaturesForRun(spec);
  const prelude = specs.length === 0 ? "" : webfontFaceCss(specs[0])
    + serializeFontFeatureValues(specs[0].fontFeatureValues);
  return `<html lang="en"><head><meta charset="utf-8"><style>${prelude}</style></head><body style="margin:0">${
    specs.map((s, i) =>
      `<div id="r${i}" style="font-family:${esc(s.fontFamily)};font-size:${s.fontSize}px;`
      + `font-weight:${s.fontWeight};font-style:${s.fontStyle};white-space:pre`
      // Re-declare the run's variable-axis location. Without it the probe page
      // paints the face's DEFAULT instance while the fixture painted an
      // instanced one, so Chrome's side of the comparison answers a different
      // question than the corpus asked.
      + `${s.fontVariationSettings != null && s.fontVariationSettings !== "normal"
        ? `;font-variation-settings:${esc(s.fontVariationSettings)}` : ""}`
      // Re-declare the run's width for the same reason as the axis location
      // above: on the macOS system-ui face `font-stretch` drives the `wdth`
      // variation, so a probe page that omits it paints the default width
      // where the fixture painted a condensed / expanded one.
      + `${s.fontStretch != null && s.fontStretch !== "100%"
        ? `;font-stretch:${esc(s.fontStretch)}` : ""}`
      // Re-declare the run's OpenType features. This is the property this
      // oracle exists to adjudicate, so a probe page that omits it shapes the
      // run with the fixture's features switched OFF — and then compares that
      // against our side, which is also shaping without them, producing
      // agreement that says nothing. `esc` matters here rather than being
      // cosmetic: a feature tag is double-quoted CSS, and an unescaped `"`
      // terminates the style attribute and silently drops the declaration.
      + `${s.fontFeatureSettings != null && s.fontFeatureSettings !== "normal"
        ? `;font-feature-settings:${esc(s.fontFeatureSettings)}` : ""}`
      // A named alternate is inert without the document-scoped alias table in
      // the <style> prelude above. Carry both halves of Blink's question.
      + `${s.fontVariantAlternates != null && s.fontVariantAlternates !== "normal"
        ? `;font-variant-alternates:${esc(s.fontVariantAlternates)}` : ""}`
      // Re-declare letter-spacing and text-rendering (DM-1983). Both change
      // which FEATURES Chrome shapes with, so a probe page that omits them
      // shapes a ligature the fixture did not have — and then compares that
      // against our side, which is also being told nothing, producing agreement
      // that says nothing. Same failure mode as omitting the feature list above.
      + `${s.letterSpacing != null && s.letterSpacing !== "normal"
        ? `;letter-spacing:${esc(s.letterSpacing)}` : ""}`
      + `${s.textRendering != null && s.textRendering !== "auto"
        ? `;text-rendering:${esc(s.textRendering)}` : ""}`
      + `${s.fontVariantLigatures != null && s.fontVariantLigatures !== "normal"
        ? `;font-variant-ligatures:${esc(s.fontVariantLigatures)}` : ""}`
      + `">${esc(s.text)}</div>`).join("")
  }</body></html>`;
}

export async function chromeShaping(page: import("@playwright/test").Page, specs: RunSpec[]): Promise<ChromeShaping[]> {
  const groups = new Map<string, Array<{ index: number; spec: RunSpec }>>();
  for (let index = 0; index < specs.length; index++) {
    const key = probeEnvironmentKey(specs[index]);
    const group = groups.get(key) ?? [];
    group.push({ index, spec: specs[index] });
    groups.set(key, group);
  }
  if (groups.size > 1) {
    const ordered = new Array<ChromeShaping>(specs.length);
    for (const group of groups.values()) {
      const rows = await chromeShaping(page, group.map((entry) => entry.spec));
      for (let i = 0; i < group.length; i++) ordered[group[i].index] = rows[i];
    }
    return ordered;
  }
  const html = shapingProbePageHtml(specs);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument") as { root: { nodeId: number } };

  const geom = await page.evaluate((count: number) => {
    const out: Array<{ xs: number[]; width: number }> = [];
    for (let i = 0; i < count; i++) {
      const el = document.getElementById(`r${i}`);
      const tn = el?.firstChild;
      if (el == null || tn == null) { out.push({ xs: [], width: 0 }); continue; }
      const seen = new Set<number>();
      const data = (tn as Text).data;
      for (let j = 0; j < data.length; j++) {
        const r = document.createRange();
        r.setStart(tn, j); r.setEnd(tn, j + 1);
        const cr = r.getClientRects();
        if (cr.length > 0) seen.add(Math.round(cr[0].x * 100) / 100);
      }
      out.push({ xs: Array.from(seen).sort((a, b) => a - b), width: Math.round(el.getBoundingClientRect().width * 100) / 100 });
    }
    return out;
  }, specs.length);

  const res: ChromeShaping[] = [];
  for (let i = 0; i < specs.length; i++) {
    const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#r${i}` }) as { nodeId: number };
    const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId }) as {
      fonts: Array<{ postScriptName?: string; familyName?: string; glyphCount: number; isCustomFont: boolean }>;
    };
    res.push({
      glyphCount: fonts.reduce((a, f) => a + f.glyphCount, 0),
      faces: fonts.map((f) => `${f.postScriptName ?? f.familyName}×${f.glyphCount}`),
      customFaces: fonts.map((f) => f.isCustomFont),
      xs: geom[i].xs,
      width: geom[i].width,
    });
  }
  await client.detach();
  return res;
}

// ---------------------------------------------------------------------------
// Our side
// ---------------------------------------------------------------------------

/** Registration is modeled state; keep one retained face per exact declaration. */
const installedRunWebfonts = new Set<string>();

/** The renderer's production-selected logical glyphs plus its painted origins.
 * The split is intentional: HarfBuzz retains hidden default-ignorables as
 * zero-advance space glyphs, while SVG correctly emits no ink for them. */
export function ourShaping(spec: RunSpec): OurShaping {
  if (spec.webfont != null) {
    const face = spec.webfont;
    const key = JSON.stringify(face);
    if (!installedRunWebfonts.has(key)) {
      const weight = parseInt(face.weightDescriptor, 10) || 400;
      registerWebfont(
        face.family,
        weight,
        face.styleDescriptor,
        Buffer.from(face.dataBase64, "base64"),
        undefined,
        face.stretchDescriptor,
        face.weightDescriptor,
        face.styleDescriptor,
      );
      installedRunWebfonts.add(key);
    }
  }
  const alternateFeatures = resolvedFeaturesForRun(spec);
  const features = mergeFeatureLists(
    mergeFeatureLists(alternateFeatures, parseFontFeatureSettings(spec.fontFeatureSettings)),
    resolveFontVariantFeatures(
      undefined,
      undefined,
      spec.fontVariantLigatures,
      spec.letterSpacing,
      spec.textRendering,
    ),
  );
  const featureList = features ?? [];
  const logicalRecord = spec.webfont == null ? undefined : exactWebfontFeatureRecord(
    Buffer.from(spec.webfont.dataBase64, "base64"),
    spec.text,
    featureList,
    spec.fontSize,
  );
  const provenanceWasEnabled = textRunProvenanceEnabled();
  resetTextRunProvenance();
  setTextRunProvenanceEnabled(true);
  let svg: string | null;
  let provenance: ReturnType<typeof getTextRunProvenance>;
  try {
    svg = renderTextAsPath(spec.text, 0, spec.fontSize * 2, {
      fontSize: spec.fontSize, fontFamily: spec.fontFamily,
      fontWeight: String(spec.fontWeight), fill: "#000", fontStyle: spec.fontStyle,
    // The run's axis location, parsed with the SAME function the renderer uses
    // on a real capture (`src/render/text.ts`), so the oracle exercises the
    // shipped parse rather than a second one that could drift from it.
    variationSettings: parseFontVariationSettings(spec.fontVariationSettings),
    fontStretch: spec.fontStretch,
    // Parsed with the SAME function the renderer uses on a real capture
    // (`src/render/text.ts`), for the same reason as the axis location above:
    // the oracle must exercise the shipped parse, not a second one that can
    // drift from it. That matters more than usual here, because the shipped
    // parse has a KNOWN divergence from Chrome it would otherwise hide —
    // fontkit takes an enable-only feature list, so `"liga" 0` is dropped
    // rather than disabling a default-on feature. The fixture corpus declares
    // exactly that (`"liga" 0, "dlig" 0`), so this is a disagreement the sweep
    // should now be able to see rather than one it silently reproduces.
    // DM-1983: merged through the SHIPPED `mergeFeatureLists`, and derived by
    // the shipped `resolveFontVariantFeatures`, so the oracle exercises the real
    // derivation rather than a second one that can drift from it. This is where
    // the letter-spacing / optimizeSpeed vetoes enter: they push `-liga`,
    // `-clig` and `-calt`, which is what stops a ligature from forming and
    // therefore what the glyph-count comparison can see.
      features,
    });
    provenance = getTextRunProvenance();
  } finally {
    setTextRunProvenanceEnabled(provenanceWasEnabled);
    resetTextRunProvenance();
  }
  // A classified embedded decline retries the same selected runs through the
  // paths emitter. Count only that terminal attempt; otherwise every fallback
  // would duplicate the logical glyph stream. This is the renderer's real
  // selected/shaped record, captured before the paint-only inkless filter.
  const terminalEmitter = provenance.runs.some((run) => run.emitter === "paths")
    ? "paths" : "embedded-font";
  const logicalGlyphs = provenance.runs
    .filter((run) => run.emitter === terminalEmitter)
    .flatMap((run) => run.glyphs);
  const logicalRuns = provenance.runs.filter((run) => run.emitter === terminalEmitter);
  assertStandaloneDefaultIgnorableRecord(spec.text, logicalRuns);
  if (svg == null) return { glyphCount: logicalGlyphs.length, xs: [], ok: logicalGlyphs.length > 0, featureList, logicalRecord, logicalGlyphs, logicalRuns };
  // EVERY `<text>` element, not the first: a run spanning more than one font
  // emits one element per font (`font-family="dmf0"`, `dmf1`, …). Reading only
  // the first made a mixed-font run look truncated — measured on "FIXED → trapped"
  // (Helvetica-Bold + LucidaGrande-Bold), where our 5 positions were exactly
  // Chrome's first 5 and the other 8 were in the second element.
  const xs: number[] = [];
  let found = false;
  for (const m of svg.matchAll(/<text[^>]*\sx="([^"]*)"/g)) {
    found = true;
    for (const tok of m[1].trim().split(/\s+/)) {
      const v = Number(tok);
      if (tok !== "" && Number.isFinite(v)) xs.push(v);
    }
  }
  // Blink/CDP counts hidden default-ignorables as logical glyphs even though
  // HarfBuzz gives them no ink and zero advance. When the complete terminal
  // stream is such a zero vector, its exact origins are all the run origin;
  // retain those logical positions without forcing empty glyphs into SVG.
  const logicalXs = logicalGlyphs.length > 0
    && logicalGlyphs.every((glyph) => glyph.xAdvance === 0 && glyph.yAdvance === 0
      && glyph.xOffset === 0 && glyph.yOffset === 0)
    ? logicalGlyphs.map(() => 0)
    : xs;
  return {
    glyphCount: logicalGlyphs.length,
    xs: logicalXs,
    ok: found || logicalGlyphs.length > 0,
    featureList,
    logicalRecord,
    logicalGlyphs,
    logicalRuns,
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export function compareShaping(c: ChromeShaping, o: OurShaping, tolerance: number): { verdict: Verdict; maxDelta: number | null } {
  if (!o.ok) return { verdict: "mismatch-unrendered", maxDelta: null };
  if (c.glyphCount !== o.glyphCount) return { verdict: "mismatch-count", maxDelta: null };
  // Positions: compare the sorted position sets pairwise. Chrome reports one x
  // per SOURCE character and we report one per GLYPH, so the sets only line up
  // when the counts already agree — which the check above has established.
  const cs = [...c.xs].sort((a, b) => a - b);
  const os = [...o.xs].sort((a, b) => a - b);
  // A STRUCTURAL blind spot, reported as its own tier rather than folded into
  // "positions differ". Chrome gives one x per SOURCE CHARACTER; we give one per
  // GLYPH. Whenever shaping is not 1:1 — any ligature, any Indic or Arabic
  // cluster — the two lists have different lengths and cannot be compared
  // pairwise at all, even though the glyph COUNTS agree. Scoring those as a
  // position disagreement would invent findings; scoring them as "exact" would
  // hide the fact that positions went unchecked. Neither is acceptable, so they
  // get a tier that stays visible in the summary.
  if (cs.length !== os.length) return { verdict: "agree-count-clustered", maxDelta: null };
  let maxDelta = 0;
  for (let i = 0; i < cs.length; i++) maxDelta = Math.max(maxDelta, Math.abs(cs[i] - os[i]));
  return maxDelta <= tolerance
    ? { verdict: "agree-exact", maxDelta }
    : { verdict: "agree-count", maxDelta };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface Options {
  runsFile: string;
  extractRuns: boolean;
  sources: string[];
  maxRuns: number | null;
  splitWords: boolean;
  tolerance: number;
  allowlistFile: string;
  outDir: string;
  batch: number;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    runsFile: DEFAULT_RUNS_FILE,
    extractRuns: false,
    // `tests/fixtures/shaping` is the in-repo corpus for cases the two broad
    // checkouts cannot express — the first occupant is the feature-disable
    // fixture: every `"liga" 0` run in the broad corpus resolves to Georgia,
    // whose ligatures never fire, so a dropped disable was invisible until a
    // fixture used a face (Times / Helvetica) where they do.
    sources: ["external/html-test", "../html-test/unicode", "tests/fixtures/shaping"],
    maxRuns: null,
    splitWords: false,
    tolerance: 0.5,
    allowlistFile: "tools/shaping-conformance-allowlist.json",
    outDir: "tests/output/shaping-conformance",
    batch: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v == null) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--runs": o.runsFile = next(); break;
      case "--extract-runs": o.extractRuns = true; break;
      case "--source": o.sources = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--max-runs": o.maxRuns = parseInt(next(), 10); break;
      case "--split-words": o.splitWords = true; break;
      case "--tolerance": o.tolerance = parseFloat(next()); break;
      case "--allowlist": o.allowlistFile = next(); break;
      case "--out": o.outDir = next(); break;
      case "--batch": o.batch = parseInt(next(), 10); break;
      case "-h":
      case "--help":
        process.stdout.write(readFileSync(new URL(import.meta.url), "utf-8").split("*/")[0] + "*/\n");
        process.exit(0);
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch();
  try {
    if (opts.extractRuns) {
      const dirs = opts.sources.filter((d) => existsSync(d));
      if (dirs.length === 0) {
        process.stderr.write(`no fixture dirs found (${opts.sources.join(", ")})\n`);
        return 2;
      }
      const corpus = await extractRuns(browser, dirs, opts.runsFile, { splitWords: opts.splitWords });
      process.stdout.write(`extracted ${corpus.runs.length} runs -> ${opts.runsFile}\n`);
      return 0;
    }

    if (!existsSync(opts.runsFile)) {
      process.stderr.write(`no run corpus at ${opts.runsFile} — run --extract-runs first\n`);
      return 2;
    }
    const corpus = JSON.parse(readFileSync(opts.runsFile, "utf-8")) as RunCorpus;
    let runs = corpus.runs;
    if (opts.maxRuns != null) runs = runs.slice(0, opts.maxRuns);

    const allow: Set<string> = existsSync(opts.allowlistFile)
      ? new Set((JSON.parse(readFileSync(opts.allowlistFile, "utf-8")) as Array<{ text: string; fontFamily: string }>)
        .map((e) => `${e.text}\0${e.fontFamily}`))
      : new Set();

    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    const counts: Record<Verdict, number> = {
      "agree-exact": 0, "agree-count": 0, "agree-count-clustered": 0,
      "mismatch-count": 0, "mismatch-unrendered": 0,
    };
    const rows: MismatchRow[] = [];
    const featureValueRecords: Array<{
      text: string;
      fontFamily: string;
      fontVariantAlternates: string;
      featureList: string[];
      chromeFaces: string[];
      chromeCustomFaces: boolean[];
      logicalRecord: ExactFeatureValueRecord | null;
    }> = [];
    const defaultIgnorableRecords: Array<{
      scalars: number[];
      utf16Span: [number, number];
      chromeGlyphs: number;
      chromeFaces: string[];
      logicalRuns: TextRunProvenanceDiagnostic[];
    }> = [];
    const routes = new Map<string, number>();
    let allowlisted = 0;
    const posDeltas: number[] = [];
    const t0 = Date.now();

    for (let i = 0; i < runs.length; i += opts.batch) {
      const batch = runs.slice(i, i + opts.batch);
      const chrome = await chromeShaping(page, batch);
      for (let j = 0; j < batch.length; j++) {
        const spec = batch[j];
        const ours = ourShaping(spec);
        assertStandaloneDefaultIgnorableFace(spec.text, ours.logicalRuns, chrome[j].faces);
        const { verdict, maxDelta } = compareShaping(chrome[j], ours, opts.tolerance);
        const scalars = [...spec.text].map((character) => character.codePointAt(0)!);
        if (scalars.length > 0 && scalars.every(isHarfbuzzDefaultIgnorable)) {
          defaultIgnorableRecords.push({
            scalars,
            utf16Span: [0, spec.text.length],
            chromeGlyphs: chrome[j].glyphCount,
            chromeFaces: chrome[j].faces,
            logicalRuns: ours.logicalRuns,
          });
        }
        if (spec.fontVariantAlternates != null && spec.fontVariantAlternates !== "normal") {
          featureValueRecords.push({
            text: spec.text,
            fontFamily: spec.fontFamily,
            fontVariantAlternates: spec.fontVariantAlternates,
            featureList: ours.featureList ?? [],
            chromeFaces: chrome[j].faces,
            chromeCustomFaces: chrome[j].customFaces ?? [],
            logicalRecord: ours.logicalRecord ?? null,
          });
        }
        if (verdict.startsWith("mismatch") && allow.has(`${spec.text}\0${spec.fontFamily}`)) {
          allowlisted++;
          continue;
        }
        counts[verdict]++;
        // `agree-count` is the tier a mark attached 3px wrong lands in (DM-1197's
        // real defect), so it needs DETAIL, not just a tally — a tier you can
        // only see the size of is a tier nobody will act on. Recorded alongside
        // the hard mismatches, tagged by verdict so the two never blur.
        if (verdict === "agree-count" && rows.length < 5000) {
          rows.push({
            text: spec.text, fontFamily: spec.fontFamily, fontSize: spec.fontSize,
            fontWeight: spec.fontWeight, fontStyle: spec.fontStyle, verdict,
            chromeGlyphs: chrome[j].glyphCount, ourGlyphs: ours.glyphCount,
            chromeFaces: chrome[j].faces, chromeXs: chrome[j].xs, ourXs: ours.xs, maxDelta,
          });
          if (maxDelta != null) posDeltas.push(maxDelta);
        }
        if (verdict.startsWith("mismatch")) {
          const route = `${chrome[j].faces.join("+") || "(none)"} ${chrome[j].glyphCount}g -> ours ${ours.glyphCount}g`;
          routes.set(route, (routes.get(route) ?? 0) + 1);
          if (rows.length < 5000) {
            rows.push({
              text: spec.text, fontFamily: spec.fontFamily, fontSize: spec.fontSize,
              fontWeight: spec.fontWeight, fontStyle: spec.fontStyle, verdict,
              chromeGlyphs: chrome[j].glyphCount, ourGlyphs: ours.glyphCount,
              chromeFaces: chrome[j].faces, chromeXs: chrome[j].xs, ourXs: ours.xs, maxDelta,
            });
          }
        }
      }
      // Bounded memory over a long sweep, same reason as the face oracle (DM-1860).
      clearFontResolutionCaches();
      process.stdout.write(`    ${Math.min(i + opts.batch, runs.length)}/${runs.length}  `
        + `mismatches=${counts["mismatch-count"] + counts["mismatch-unrendered"]}  `
        + `rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB\n`);
    }
    await ctx.close();

    const total = runs.length;
    const mismatchTotal = counts["mismatch-count"] + counts["mismatch-unrendered"];
    const pct = (n: number): string => `${((n / Math.max(1, total)) * 100).toFixed(3)}%`;
    const lines: string[] = [];
    lines.push(`shaping-conformance — ${process.platform} ${process.arch}`);
    lines.push(`runs               ${total.toLocaleString()}  (corpus ${corpus.runs.length.toLocaleString()}, from ${corpus.sources.join(", ")})`);
    // Which extraction produced the corpus. A `--split-words` corpus is a
    // different population, not a bigger sample of the same one, so a summary
    // that omits this invites comparing its tallies against the default's.
    lines.push(`node splitting     ${corpus.splitWords === true ? "EVERY node on whitespace (--split-words)" : "axis- / feature-bearing nodes only (default)"}`);
    lines.push(`wall               ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    lines.push(`tolerance          ${opts.tolerance}px`);
    lines.push(`feature values     ${featureValueRecords.length.toLocaleString()} runs; `
      + `${featureValueRecords.filter((row) => row.logicalRecord != null).length.toLocaleString()} exact webfont records`);
    lines.push("");
    lines.push(`agree exact        ${counts["agree-exact"].toLocaleString()}  ${pct(counts["agree-exact"])}`);
    lines.push(`agree count-only   ${counts["agree-count"].toLocaleString()}  ${pct(counts["agree-count"])}   (same glyph count, comparable positions DIFFER)`);
    lines.push(`agree clustered    ${counts["agree-count-clustered"].toLocaleString()}  ${pct(counts["agree-count-clustered"])}   (same glyph count, positions NOT comparable — Chrome per-char vs our per-glyph)`);
    lines.push(`allowlisted        ${allowlisted.toLocaleString()}`);
    lines.push("");
    lines.push(`MISMATCH count     ${counts["mismatch-count"].toLocaleString()}  ${pct(counts["mismatch-count"])}`);
    lines.push(`MISMATCH unrendered ${counts["mismatch-unrendered"].toLocaleString()}  ${pct(counts["mismatch-unrendered"])}`);
    lines.push(`MISMATCH total     ${mismatchTotal.toLocaleString()}  ${pct(mismatchTotal)}`);
    lines.push(`  distinct disagreeing routes  ${routes.size.toLocaleString()}`);
    if (posDeltas.length > 0) {
      const sorted = [...posDeltas].sort((a, b) => a - b);
      const q = (f: number): string => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))].toFixed(2);
      lines.push("");
      lines.push(`position deltas (the ${posDeltas.length} runs whose comparable positions differ, px):`);
      lines.push(`  median ${q(0.5)}   p90 ${q(0.9)}   max ${sorted[sorted.length - 1].toFixed(2)}`);
    }
    lines.push("");
    lines.push("top disagreeing routes:");
    for (const [r, c] of [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      lines.push(`  ${String(c).padStart(6)}  ${r}`);
    }
    const summary = lines.join("\n") + "\n";

    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, "summary.txt"), summary);
    writeFileSync(join(opts.outDir, "report.json"), `${JSON.stringify({
      meta: {
        platform: process.platform, runs: total, corpusRuns: corpus.runs.length,
        // The build that produced Chrome's side of every comparison. Recorded
        // for the same reason the face oracle records it (doc 107): Blink's
        // behaviour is what is being graded, so two runs under different
        // browsers are two different oracles, and every other field here can
        // match while that is true. Read from the launched binary — Playwright's
        // declared revision is not a promise about what runs.
        chromium: browser.version(),
        sources: corpus.sources, splitWords: corpus.splitWords === true,
        tolerance: opts.tolerance, wallMs: Date.now() - t0,
      },
      summary: {
        ...counts,
        mismatchTotal,
        allowlisted,
        distinctRoutes: routes.size,
        featureValueRuns: featureValueRecords.length,
        exactFeatureValueRecords: featureValueRecords.filter((row) => row.logicalRecord != null).length,
      },
      featureValueRecords,
      defaultIgnorableRecords,
      topRoutes: [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([route, count]) => ({ route, count })),
      mismatches: rows,
    }, null, 2)}\n`);
    process.stdout.write(`\n${summary}\nreport → ${join(opts.outDir, "report.json")}\n`);
    return mismatchTotal === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("shaping-conformance.ts")) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`shaping-conformance failed: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 2;
  });
}
