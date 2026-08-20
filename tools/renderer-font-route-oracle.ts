#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  clearEmbeddedFonts,
  clearGlyphDefs,
  getTextRunProvenance,
  renderTextAsPath,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
  type RenderTextMode,
} from "../src/render/text-to-path.js";
import { parityEnvironment } from "./parity-environment.js";

interface OracleCase {
  id: string;
  text: string;
  mode: RenderTextMode;
  features?: string[];
  clusterFallback?: boolean;
  fontFamily?: string;
}

const cases: OracleCase[] = [
  { id: "declared-paths", text: "AV", mode: "paths" },
  { id: "system-cluster", text: "Aمرحبا", mode: "paths", fontFamily: "Helvetica" },
  { id: "emoji-priority", text: "©️", mode: "paths" },
  { id: "orphan-mark", text: "𑀸", mode: "paths" },
  { id: "notdef-terminal", text: "𓑠", mode: "paths" },
  { id: "feature-on", text: "fi", mode: "paths", features: ["liga"] },
  { id: "feature-off", text: "fi", mode: "paths", features: ["-liga"] },
  { id: "embedded", text: "Hello", mode: "embedded-font" },
  { id: "legacy-disabled", text: "Legacy", mode: "paths", clusterFallback: false },
];

const outputAt = process.argv.indexOf("--json");
const output = outputAt >= 0 ? process.argv[outputAt + 1] : undefined;
const family = "Helvetica, Arial, sans-serif";

function normalizeFace(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

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
      });
      domotion.push({ id: item.id, markupStatus: markup == null ? "declined" : "emitted", ...getTextRunProvenance() });
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
      const chromeNames = fonts.map((font) => font.postScriptName);
      const faceAgreement = ours.runs.map((run) => {
        const name = run.selected.instantiatedPostscriptName ?? run.selected.postscriptName;
        return name == null ? null : chromeNames.some((chrome) => normalizeFace(chrome) === normalizeFace(name));
      });
      records.push({ input: item, chrome: { fonts, origins }, domotion: ours, comparison: { faceAgreement } });
    }
    const byId = new Map(records.map((record) => [record.input.id, record]));
    const mechanisms = [...new Set(records.flatMap((record) => record.domotion.runs.map((run) => run.mechanism)))];
    const controls = {
      emitter: byId.get("declared-paths")!.domotion.runs.some((run) => run.emitter === "paths")
        && byId.get("embedded")!.domotion.runs.some((run) => run.emitter === "embedded-font"),
      clusterFallback: byId.get("legacy-disabled")!.domotion.runs.some((run) => run.mechanism === "cluster-disabled-legacy"),
      features: JSON.stringify(byId.get("feature-on")!.domotion.runs.flatMap((run) => run.glyphs.map((glyph) => glyph.id)))
        !== JSON.stringify(byId.get("feature-off")!.domotion.runs.flatMap((run) => run.glyphs.map((glyph) => glyph.id))),
      paintedOrigins: records.every((record) => record.chrome.origins.length > 0),
    };
    const complete = records.every((record) => record.domotion.runs.length > 0 || record.domotion.transitions.length > 0)
      && records.every((record) => record.comparison.faceAgreement.every((agreement) => agreement === true))
      && Object.values(controls).every(Boolean);
    const report = {
      schemaVersion: 1,
      stage: "production-text-run-provenance",
      sourceRevision: "chromium:7d859f271cbda744098ac69f44978d4edfa62be3",
      verdict: complete ? "evidence-complete" : "verdict-withheld",
      environment: parityEnvironment({ corpusIdentity: "renderer-font-route-v1", sampleIdentity: cases.map((item) => item.id).join(",") }),
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
