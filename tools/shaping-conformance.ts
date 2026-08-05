#!/usr/bin/env node
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
 *   Our answer       the `<text x="…">` position list `renderTextAsPath` emits —
 *                    one entry per glyph we actually paint, at the x we paint it.
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
import { clearFontResolutionCaches } from "../src/render/font-resolution.js";
import {
  parseFontFeatureSettings, parseFontVariationSettings, resolveFontVariantFeatures, mergeFeatureLists,
} from "../src/render/text.js";

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
  /** Distinct x positions of the source characters, ascending. */
  xs: number[];
  /** Painted width of the run. */
  width: number;
}

/** What we did with the same run. */
interface OurShaping {
  glyphCount: number;
  xs: number[];
  /** null when the renderer declined the run (no resolvable font). */
  ok: boolean;
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
      // CANNOT be swept, because no `@font-face` rule travels with it: the probe
      // page re-declares the family name alone, so Chrome falls through the
      // stack to a system face and shapes something the fixture never painted.
      // Our side falls through too, so the two agree — and the agreement is
      // vacuous, which is worse than a mismatch because it reads as coverage.
      //
      // Measured on `20-font-face.html`, whose rules are `src: local(...)` only:
      // the fixture paints `TestSerif` as Georgia and `TestMono` as Menlo, while
      // the oracle's probe page paints them as Times and Courier. The runs scored
      // 28 agree-exact / 4 agree-count — a clean-looking result about the wrong
      // fonts.
      //
      // So they are EXCLUDED rather than swept, which is the same move the
      // whitespace rule makes: when the instrument cannot ask the question
      // faithfully, drop the question instead of recording a confident wrong
      // answer. Sweeping them properly means carrying the `@font-face` into the
      // probe page and registering the same face on our side; until then this
      // keeps the corpus honest about what it covers.
      const fontFaceFamilies = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try {
          rules = sheet.cssRules;
        } catch {
          // Cross-origin stylesheet — unreadable by design. Nothing to add.
          continue;
        }
        for (const rule of Array.from(rules ?? [])) {
          if (rule.constructor.name !== "CSSFontFaceRule") continue;
          const fam = (rule as CSSFontFaceRule).style.getPropertyValue("font-family").trim();
          if (fam !== "") fontFaceFamilies.add(fam.replace(/^["']|["']$/g, "").toLowerCase());
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
        if (cs.fontFamily.split(",").some((f) =>
          fontFaceFamilies.has(f.trim().replace(/^["']|["']$/g, "").toLowerCase()))) continue;
        const fvs = cs.fontVariationSettings === "" ? "normal" : cs.fontVariationSettings;
        const stretch = cs.fontStretch === "" ? "100%" : cs.fontStretch;
        const ffs = cs.fontFeatureSettings === "" ? "normal" : cs.fontFeatureSettings;
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
          const texts = splitEvery || fvs !== "normal" || ffs !== "normal" ? raw.split(/\s+/) : [raw];
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
      const hit = tally.get(s);
      if (hit == null) tally.set(s, { spec, fixtures: 1, example: label });
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

export async function chromeShaping(page: import("@playwright/test").Page, specs: RunSpec[]): Promise<ChromeShaping[]> {
  const html = `<html lang="en"><body style="margin:0">${
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
      fonts: Array<{ postScriptName?: string; familyName?: string; glyphCount: number }>;
    };
    res.push({
      glyphCount: fonts.reduce((a, f) => a + f.glyphCount, 0),
      faces: fonts.map((f) => `${f.postScriptName ?? f.familyName}×${f.glyphCount}`),
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

/**
 * The glyphs the renderer actually emits, read back off its own output.
 *
 * `renderTextAsPath` emits `<text x="x0 x1 x2 …">` with ONE entry per painted
 * glyph, so the list length is our glyph count and the entries are our glyph
 * positions. Reading the real output rather than re-running a shaping call is
 * deliberate: the face oracle's own instrument bug was asking a different
 * question than the renderer asks (`resolveFontSpec` vs `getFontInstance`).
 */
export function ourShaping(spec: RunSpec): OurShaping {
  const svg = renderTextAsPath(spec.text, 0, spec.fontSize * 2, {
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
    features: mergeFeatureLists(
      parseFontFeatureSettings(spec.fontFeatureSettings),
      resolveFontVariantFeatures(undefined, undefined, spec.fontVariantLigatures,
        spec.letterSpacing, spec.textRendering),
    ),
  });
  if (svg == null) return { glyphCount: 0, xs: [], ok: false };
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
  if (!found) return { glyphCount: 0, xs: [], ok: false };
  return { glyphCount: xs.length, xs, ok: true };
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
        .map((e) => `${e.text} ${e.fontFamily}`))
      : new Set();

    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    const counts: Record<Verdict, number> = {
      "agree-exact": 0, "agree-count": 0, "agree-count-clustered": 0,
      "mismatch-count": 0, "mismatch-unrendered": 0,
    };
    const rows: MismatchRow[] = [];
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
        const { verdict, maxDelta } = compareShaping(chrome[j], ours, opts.tolerance);
        if (verdict.startsWith("mismatch") && allow.has(`${spec.text} ${spec.fontFamily}`)) {
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
        sources: corpus.sources, splitWords: corpus.splitWords === true,
        tolerance: opts.tolerance, wallMs: Date.now() - t0,
      },
      summary: { ...counts, mismatchTotal, allowlisted, distinctRoutes: routes.size },
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
