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
  fixtures: number;
  example: string;
}

export interface RunCorpus {
  generatedAt: string;
  sources: string[];
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
export async function extractRuns(browser: Browser, dirs: string[], outFile: string): Promise<RunCorpus> {
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
    const found = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType !== 3) continue;
          const raw = (node.textContent ?? "").trim();
          // Non-empty, short enough that a disagreement points at a shaping
          // decision rather than at line breaking, and — deliberately —
          // WHITESPACE-FREE.
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
          if (raw === "" || raw.length > 24 || /\s/.test(raw)) continue;
          const cs = getComputedStyle(el as Element);
          out.push(JSON.stringify({
            text: raw,
            fontFamily: cs.fontFamily,
            fontSize: Math.round(parseFloat(cs.fontSize)),
            fontWeight: parseInt(cs.fontWeight, 10) || 400,
            fontStyle: cs.fontStyle,
          }));
        }
      }
      return out;
    });
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
  const corpus: RunCorpus = { generatedAt: new Date().toISOString(), sources: dirs, runs };
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
      + `font-weight:${s.fontWeight};font-style:${s.fontStyle};white-space:pre">${esc(s.text)}</div>`).join("")
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
  const svg = renderTextAsPath(
    spec.text, 0, spec.fontSize * 2, spec.fontSize, spec.fontFamily,
    String(spec.fontWeight), "#000", undefined, undefined, undefined, spec.fontStyle,
  );
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
  tolerance: number;
  allowlistFile: string;
  outDir: string;
  batch: number;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    runsFile: DEFAULT_RUNS_FILE,
    extractRuns: false,
    sources: ["external/html-test", "../html-test/unicode"],
    maxRuns: null,
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
      const corpus = await extractRuns(browser, dirs, opts.runsFile);
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
        sources: corpus.sources, tolerance: opts.tolerance, wallMs: Date.now() - t0,
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
