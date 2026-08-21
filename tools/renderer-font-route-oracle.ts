#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  clearEmbeddedFonts,
  clearGlyphDefs,
  getTextRunProvenance,
  renderTextAsPath,
  resetTextRunProvenance,
  selectedGlyphRasterSpans,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
  type RenderTextMode,
} from "../src/render/text-to-path.js";
import type { FontVariantEmojiOverride } from "../src/render/font-resolution.js";
import { parityEnvironment } from "./parity-environment.js";
import { bidiLevelsFor, segmentForShaping } from "../src/render/script-segmentation.js";
import bidiFactory from "bidi-js";

interface OracleCase {
  id: string;
  text: string;
  mode: RenderTextMode;
  features?: string[];
  clusterFallback?: boolean;
  fontFamily?: string;
  fontVariantEmoji?: FontVariantEmojiOverride;
  /** A deliberately disabled implementation arm proves activation, not parity. */
  gradeFaces?: boolean;
}

const cases: OracleCase[] = [
  { id: "declared-paths", text: "AV", mode: "paths" },
  { id: "system-cluster", text: "Aمرحبا", mode: "paths", fontFamily: "Helvetica" },
  { id: "emoji-priority", text: "©️", mode: "paths" },
  // DM-2387: prepass ownership controls. The orphan and explicit circle must
  // enter FontFallbackIterator as different source strings; the selected
  // HarfBuzz candidate owns whether a broken syllable inserts U+25CC.
  { id: "dotted-orphan", text: "\u0E48", mode: "paths", fontFamily: "Helvetica" },
  { id: "dotted-explicit", text: "\u25CC\u0E48", mode: "paths", fontFamily: "Helvetica" },
  // HarfBuzz normalization owns composition/decomposition inside the selected
  // face. Domotion must retain the authored source range rather than commit a
  // resolver-provided replacement string.
  { id: "canonical-composition", text: "\u03B1\u0345", mode: "paths", fontFamily: "Menlo" },
  // Broad cluster counterexamples: each defeats a codepoint-coverage walk and
  // records the final glyph ids, cluster spans, advances, and selected face.
  { id: "cluster-latin", text: "x\u0301", mode: "paths", fontFamily: "Helvetica" },
  { id: "cluster-arabic", text: "\u0644\u08F0", mode: "paths", fontFamily: "Arial" },
  { id: "cluster-devanagari", text: "\u0915\u094D\u0937", mode: "paths", fontFamily: "Helvetica" },
  { id: "cluster-bengali", text: "\u0995\u09BE", mode: "paths", fontFamily: "Helvetica" },
  { id: "cluster-thai", text: "\u0E01\u0301", mode: "paths", fontFamily: "Helvetica" },
  { id: "cluster-myanmar", text: "\u1000\u1039\u1000", mode: "paths", fontFamily: "Helvetica" },
  { id: "cluster-khmer", text: "\u1780\u17D2\u1780", mode: "paths", fontFamily: "Helvetica" },
  { id: "cluster-brahmi", text: "\u{11005}\u{11038}", mode: "paths", fontFamily: "Helvetica" },
  { id: "notdef-terminal", text: "𓑠", mode: "paths" },
  { id: "feature-on", text: "fi", mode: "paths", features: ["liga"] },
  { id: "feature-off", text: "fi", mode: "paths", features: ["-liga"] },
  { id: "embedded", text: "Hello", mode: "embedded-font" },
  { id: "legacy-disabled", text: "Legacy", mode: "paths", clusterFallback: false },
  // DM-2410: whole-sequence, not per-codepoint, evidence for the exact branch
  // that regressed. Explicit VS16 wins over `font-variant-emoji:text`, so both
  // emoji clusters select a raster representation while the suffix stays on
  // the declared/text face. The disabled twin is a negative activation arm:
  // it must traverse the legacy mechanism, proving the default record was not
  // produced by an unconditional/common path.
  { id: "emoji-sequence-text", text: "❤️ ⚡️ VS16 wins", mode: "paths", fontFamily: "Helvetica", fontVariantEmoji: "text" },
  { id: "emoji-sequence-text-disabled", text: "❤️ ⚡️ VS16 wins", mode: "paths", fontFamily: "Helvetica", fontVariantEmoji: "text", clusterFallback: false, gradeFaces: false },
  { id: "bidi-digits", text: "L אב 123 R", mode: "paths", fontFamily: "Arial" },
  { id: "bidi-digits-legacy", text: "L אב 123 R", mode: "paths", fontFamily: "Arial", clusterFallback: false },
  { id: "bidi-pointed-hebrew", text: "L שָׁלוֹם R", mode: "paths", fontFamily: "Arial" },
  { id: "bidi-pointed-hebrew-legacy", text: "L שָׁלוֹם R", mode: "paths", fontFamily: "Arial", clusterFallback: false },
  { id: "bidi-adjacent-scripts", text: "L אבمرحبا R", mode: "paths", fontFamily: "Arial" },
  { id: "bidi-adjacent-scripts-legacy", text: "L אבمرحبا R", mode: "paths", fontFamily: "Arial", clusterFallback: false },
  { id: "bidi-mirrored-brackets", text: "L אב(12) R", mode: "paths", fontFamily: "Arial" },
  { id: "bidi-mirrored-brackets-legacy", text: "L אב(12) R", mode: "paths", fontFamily: "Arial", clusterFallback: false },
];

const outputAt = process.argv.indexOf("--json");
const output = outputAt >= 0 ? process.argv[outputAt + 1] : undefined;
const family = "Helvetica, Arial, sans-serif";
const bidi = bidiFactory();

function normalizeFace(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

function graphemeCandidates(text: string): Array<{ start: number; end: number }> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)]
    .filter((part) => !/^\s+$/u.test(part.segment))
    .map((part) => ({ start: part.index, end: part.index + part.segment.length }));
}

async function main(): Promise<number> {
  setTextRunProvenanceEnabled(true);
  const domotion = [];
  const previousCluster = process.env.DOMOTION_CLUSTER_FALLBACK;
  try {
    for (const item of cases) {
      clearEmbeddedFonts(); clearGlyphDefs(); resetTextRunProvenance(); setRenderTextMode(item.mode);
      if (item.clusterFallback === false) process.env.DOMOTION_CLUSTER_FALLBACK = "0";
      else delete process.env.DOMOTION_CLUSTER_FALLBACK;
      const markup = renderTextAsPath(item.text, 0, 0, {
        fontSize: 24, fontFamily: item.fontFamily ?? family, fontWeight: "400", fill: "#000", features: item.features,
        fontVariantEmoji: item.fontVariantEmoji,
      });
      const rasterSpans = selectedGlyphRasterSpans(item.text, graphemeCandidates(item.text), {
        fontSize: 24, fontFamily: item.fontFamily ?? family, fontWeight: "400",
        features: item.features, fontVariantEmoji: item.fontVariantEmoji,
      });
      domotion.push({ id: item.id, markupStatus: markup == null ? "declined" : "emitted", rasterSpans, ...getTextRunProvenance() });
    }
  } finally {
    setTextRunProvenanceEnabled(false);
    setRenderTextMode("paths");
    if (previousCluster == null) delete process.env.DOMOTION_CLUSTER_FALLBACK;
    else process.env.DOMOTION_CLUSTER_FALLBACK = previousCluster;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 500 } });
    const page = await context.newPage();
    await page.setContent("<!doctype html><main></main>");
    await page.locator("main").evaluate((main, input) => {
      for (const item of input) {
        const span = document.createElement("span");
        span.id = item.id; span.textContent = item.text;
        span.style.cssText = `display:inline-block;margin:3px;font-family:${item.family};font-size:24px`;
        span.style.fontFeatureSettings = item.features == null ? "normal"
          : item.features.map((feature) => `"${feature.replace(/^[+-]/, "")}" ${feature.startsWith("-") ? 0 : 1}`).join(",");
        if (item.fontVariantEmoji != null) {
          (span.style as CSSStyleDeclaration & { fontVariantEmoji: string }).fontVariantEmoji = item.fontVariantEmoji;
        }
        main.append(span);
      }
    }, cases.map((item) => ({ ...item, family: item.fontFamily ?? family })));
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const records = [];
    for (const item of cases) {
      const selector = `#${item.id}`;
      await page.locator(selector).evaluate((span) => span.getBoundingClientRect());
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const origins = await page.locator(selector).evaluate((span) => {
        const text = span.firstChild; if (text == null) return [];
        const result = []; let start = 0;
        for (const scalar of span.textContent ?? "") {
          const end = start + scalar.length; const range = document.createRange();
          range.setStart(text, start); range.setEnd(text, end); const rect = range.getBoundingClientRect();
          result.push({ utf16Span: [start, end], left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }); start = end;
        }
        return result;
      });
      const ours = domotion.find((entry) => entry.id === item.id)!;
      const levels = bidiLevelsFor(item.text);
      const segments = segmentForShaping(item.text, levels).map((segment) => ({
        sourceSpan: [segment.start, segment.end],
        bidiLevel: levels?.[segment.start] ?? 0,
        direction: segment.rtl ? "rtl" : "ltr",
        script: segment.script,
        capturedXOrigin: origins[segment.start]?.left ?? null,
        snappedBaseline: origins[segment.start] == null ? null : Math.floor(origins[segment.start].bottom + 0.5),
      }));
      const chromeNames = fonts.map((font) => font.postScriptName);
      const faceAgreement = ours.runs.map((run) => {
        const name = run.selected.instantiatedPostscriptName ?? run.selected.postscriptName;
        return name == null ? null : chromeNames.some((chrome) => normalizeFace(chrome) === normalizeFace(name));
      });
      records.push({ input: item, chrome: { fonts, origins }, domotion: ours, logical: { segments }, comparison: { faceAgreement, graded: item.gradeFaces !== false, rasterPhase: "separate-visual-oracle" } });
    }
    const byId = new Map(records.map((record) => [record.input.id, record]));
    const mechanisms = [...new Set(records.flatMap((record) => record.domotion.runs.map((run) => run.mechanism)))];
    const dm2387ExactRows = [
      "dotted-orphan", "dotted-explicit", "canonical-composition",
      "cluster-latin", "cluster-arabic", "cluster-devanagari",
      "cluster-bengali", "cluster-thai", "cluster-myanmar",
      "cluster-khmer", "cluster-brahmi",
    ];
    const hasExactGlyphRecord = (id: string): boolean => {
      const record = byId.get(id);
      return record != null && record.domotion.runs.length > 0
        && record.domotion.runs.every((run) => run.glyphs.length > 0
          && run.glyphs.every((glyph) => Number.isInteger(glyph.id)
            && Number.isInteger(glyph.cluster)
            && Number.isFinite(glyph.xAdvance)
            && Number.isFinite(glyph.yAdvance)
            && Number.isFinite(glyph.xOffset)
            && Number.isFinite(glyph.yOffset)
            && glyph.sourceSpan[0] >= run.sourceSpan[0]
            && glyph.sourceSpan[1] <= run.sourceSpan[1]));
    };
    const sourceIsUnsubstituted = (id: string): boolean => {
      const record = byId.get(id);
      return record != null && record.domotion.runs.every((run) =>
        run.emittedText === record.input.text.slice(run.sourceSpan[0], run.sourceSpan[1]));
    };
    const chromeGlyphCountsAgree = (id: string): boolean => {
      const record = byId.get(id);
      if (record == null) return false;
      const chrome = new Map<string, number>();
      for (const font of record.chrome.fonts) {
        const key = normalizeFace(font.postScriptName);
        chrome.set(key, (chrome.get(key) ?? 0) + font.glyphCount);
      }
      const ours = new Map<string, number>();
      for (const run of record.domotion.runs) {
        const name = run.selected.instantiatedPostscriptName ?? run.selected.postscriptName;
        if (name == null) return false;
        const key = normalizeFace(name);
        ours.set(key, (ours.get(key) ?? 0) + run.glyphs.length);
      }
      return chrome.size === ours.size
        && [...chrome].every(([key, count]) => ours.get(key) === count);
    };
    const controls = {
      emitter: byId.get("declared-paths")!.domotion.runs.some((run) => run.emitter === "paths")
        && byId.get("embedded")!.domotion.runs.some((run) => run.emitter === "embedded-font"),
      clusterFallback: byId.get("legacy-disabled")!.domotion.runs.some((run) => run.mechanism === "cluster-disabled-legacy"),
      emojiWholeSequence: byId.get("emoji-sequence-text")!.domotion.rasterSpans.length === 2
        && byId.get("emoji-sequence-text")!.domotion.rasterSpans[0]?.start === 0
        && byId.get("emoji-sequence-text")!.domotion.rasterSpans[0]?.end === 2
        && byId.get("emoji-sequence-text")!.domotion.rasterSpans[1]?.start === 3
        && byId.get("emoji-sequence-text")!.domotion.rasterSpans[1]?.end === 5
        && byId.get("emoji-sequence-text")!.domotion.runs.every((run) => run.request.fontVariantEmoji === "text"),
      emojiDisabledRoute: byId.get("emoji-sequence-text-disabled")!.domotion.runs
        .some((run) => run.mechanism === "cluster-disabled-legacy")
        && JSON.stringify(byId.get("emoji-sequence-text-disabled")!.domotion.rasterSpans)
          !== JSON.stringify(byId.get("emoji-sequence-text")!.domotion.rasterSpans),
      features: JSON.stringify(byId.get("feature-on")!.domotion.runs.flatMap((run) => run.glyphs.map((glyph) => glyph.id)))
        !== JSON.stringify(byId.get("feature-off")!.domotion.runs.flatMap((run) => run.glyphs.map((glyph) => glyph.id))),
      exactGlyphClusterAdvanceRecords: dm2387ExactRows.every(hasExactGlyphRecord),
      chromiumGlyphCountAgreement: dm2387ExactRows.every(chromeGlyphCountsAgree),
      sourceOwnedNormalization: dm2387ExactRows.every(sourceIsUnsubstituted),
      noImplicitLegacyRestart: cases.filter((item) => item.clusterFallback !== false).every((item) =>
        byId.get(item.id)!.domotion.runs.every((run) => run.mechanism !== "cluster-disabled-legacy")),
      dottedCircleSeparation: (() => {
        const orphan = byId.get("dotted-orphan")!;
        const explicit = byId.get("dotted-explicit")!;
        const signature = (record: typeof orphan) => JSON.stringify(record.domotion.runs.map((run) => ({
          face: run.selected.instantiatedPostscriptName ?? run.selected.postscriptName,
          glyphs: run.glyphs.map((glyph) => [glyph.id, glyph.cluster, glyph.xAdvance, glyph.xOffset]),
        })));
        return sourceIsUnsubstituted("dotted-orphan")
          && sourceIsUnsubstituted("dotted-explicit")
          && signature(orphan) !== signature(explicit);
      })(),
      broadScriptCounterexamples: [
        "cluster-latin", "cluster-arabic", "cluster-devanagari",
        "cluster-bengali", "cluster-thai", "cluster-myanmar",
        "cluster-khmer", "cluster-brahmi",
      ].every(hasExactGlyphRecord),
      paintedOrigins: records.every((record) => record.chrome.origins.length > 0),
      bidiBothFallbackModes: ["digits", "pointed-hebrew", "adjacent-scripts", "mirrored-brackets"].every((name) =>
        byId.get(`bidi-${name}`)!.domotion.runs.length > 0 && byId.get(`bidi-${name}-legacy`)!.domotion.runs.length > 0),
      bidiBoundaryMutation: (() => {
        const record = byId.get("bidi-adjacent-scripts")!;
        const original = JSON.stringify(record.logical.segments.map((segment) => [segment.sourceSpan, segment.bidiLevel, segment.direction, segment.script]));
        const coalesced = JSON.stringify([[[0, record.input.text.length], 0, "ltr", "Latin"]]);
        return original !== coalesced && record.logical.segments.length > 1;
      })(),
      pairedBracketMirroringMutation: (() => {
        const text = byId.get("bidi-mirrored-brackets")!.input.text;
        const levels = bidi.getEmbeddingLevels(text, "ltr").levels;
        let mirrored = "";
        for (let i = 0; i < text.length; i++) mirrored += levels[i] % 2 === 1 ? (bidi.getMirroredCharacter(text[i]) ?? text[i]) : text[i];
        return mirrored !== text;
      })(),
    };
    const complete = records.every((record) => record.domotion.runs.length > 0 || record.domotion.transitions.length > 0)
      && records.every((record) => !record.comparison.graded
        || record.comparison.faceAgreement.every((agreement) => agreement === true))
      && Object.values(controls).every(Boolean);
    const report = {
      schemaVersion: 3,
      stage: "production-text-run-provenance",
      sourceRevision: "chromium:7d859f271cbda744098ac69f44978d4edfa62be3",
      verdict: complete ? "evidence-complete" : "verdict-withheld",
      environment: parityEnvironment({ corpusIdentity: "renderer-font-route-v3", sampleIdentity: cases.map((item) => item.id).join(",") }),
      mechanisms,
      controls,
      records,
    };
    if (output != null) writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`renderer font-route evidence: ${records.length} cases; mechanisms ${mechanisms.join(", ")}; controls ${JSON.stringify(controls)}`);
    return complete ? 0 : 1;
  } finally { await browser.close(); }
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error); process.exitCode = 2; });
