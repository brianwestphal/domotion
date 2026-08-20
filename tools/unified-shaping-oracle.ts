#!/usr/bin/env tsx
/**
 * Unified face + shaping + painted-origin evidence (DM-2341).
 *
 * Blink keeps glyph ids, character indices, advances and offsets in
 * ShapeResultRun (`shape_result_run.h`), while CDP intentionally exposes only
 * the faces that reached paint plus DOM geometry. This joins those observations
 * in one record without claiming that CDP supplied glyph ids.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

export interface ExactRecord {
  environment: Record<string, unknown>;
  face: { key: string; path: string; member: number; postscriptName: string | null; localPostscriptName: string | null; namedInstance: string | null; axes: Record<string, number> | null };
  input: { text: string; utf16Span: [number, number]; direction: "ltr" | "rtl" | "ttb" | "btt"; fontSizePx: number; script: string; language: string; features: string[]; bufferFlags: number; clusterLevel: number };
  fallbackRuns: Array<{ utf16Span: [number, number]; face: string }>;
  glyphs: Array<{ id: number; cluster: number; sourceSpan: [number, number]; xAdvance: number; yAdvance: number; xOffset: number; yOffset: number; flags: number; unsafeToBreak: boolean }>;
}

interface ExactReport {
  schemaVersion: number;
  verdict: string;
  completeEnvironment: boolean;
  movementProven: boolean;
  pairs: number;
  controlHits: Record<string, number>;
  records: ExactRecord[];
}

export interface PaintedOrigin { utf16Span: [number, number]; left: number; top: number; right: number; bottom: number }
export interface PaintedFace { familyName: string; postScriptName: string; glyphCount: number; isCustomFont: boolean }
export type FaceObservation = "matched" | "css-unaddressable-after-candidate-walk";
type ControlRects = Record<string, Array<{ left: number; top: number; right: number; bottom: number }>>;

const output = (() => { const i = process.argv.indexOf("--json"); return i >= 0 ? process.argv[i + 1] : undefined; })();

function rectSignature(rects: Array<{ left: number; top: number; right: number; bottom: number }>): string {
  return JSON.stringify(rects.map((rect) => [rect.left, rect.top, rect.right, rect.bottom]));
}

export function joinShapingEvidence(record: ExactRecord, paintedFaces: PaintedFace[], paintedOrigins: PaintedOrigin[], faceObservation: FaceObservation = "matched"): Record<string, unknown> {
  const localPostscriptName = record.face.localPostscriptName;
  const faceAgreement = localPostscriptName != null
    && paintedFaces.some((face) => normalizeFace(face.postScriptName) === normalizeFace(localPostscriptName));
  return {
    environment: record.environment,
    input: record.input,
    chrome: {
      paintedFaces,
      paintedOrigins,
      glyphIds: { status: "not-exposed-by-cdp", owner: "Blink ShapeResultRun / HarfBuzzRunGlyphData" },
    },
    helper: { ...record.face, fallbackRuns: record.fallbackRuns },
    glyphs: record.glyphs,
    comparison: { faceAgreement, faceObservation, glyphIds: faceAgreement ? "source-equivalent-same-face" : "not-compared-across-different-faces", paintedOrigins: "recorded-not-inferred-from-pixels" },
  };
}

function normalizeFace(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

export function browserControlMovement(controls: Record<string, Array<{ left: number; top: number; right: number; bottom: number }>>): Record<string, boolean> {
  const base = rectSignature(controls.base ?? []);
  return Object.fromEntries(Object.entries(controls).filter(([name]) => name !== "base").map(([name, rects]) => [name, rectSignature(rects) !== base]));
}

async function main(): Promise<number> {
  const temp = mkdtempSync(resolve(tmpdir(), "unified-shaping-"));
  const exactPath = resolve(temp, "exact.json");
  const tsx = resolve("node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const exactRun = spawnSync(tsx, ["tools/exact-shaping-oracle.ts", "--json", exactPath], {
    stdio: "inherit", env: process.env, shell: process.platform === "win32",
  });
  try {
    const exact = JSON.parse(readFileSync(exactPath, "utf8")) as ExactReport;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const inputs = exact.records.map((record, index) => ({
        id: `run-${index}`,
        text: record.input.text,
        direction: record.input.direction,
        language: record.input.language,
        features: record.input.features,
        fontSizePx: record.input.fontSizePx,
        axes: record.face.axes,
        family: `oracle-face-${index}`,
        postscriptName: record.face.localPostscriptName,
      }));
      const faceRules = inputs.map((run) => run.postscriptName == null ? "" : `@font-face{font-family:"${run.family}";src:local("${run.postscriptName.replaceAll('"', "")}")}`).join("");
      await page.setContent(`<!doctype html><style>${faceRules}body{margin:0}.run{display:inline-block;margin:2px;font-size:16px}</style><main></main>`);
      await page.locator("main").evaluate((main, runs) => {
        for (const run of runs) {
          const span = document.createElement("span");
          span.id = run.id;
          span.className = "run";
          span.textContent = run.text;
          span.lang = run.language;
          span.style.fontFamily = `"${run.family.replaceAll('"', "")}"`;
          span.style.fontSize = `${run.fontSizePx}px`;
          span.style.fontVariationSettings = run.axes == null ? "normal" : Object.entries(run.axes).map(([tag, value]) => `"${tag}" ${value}`).join(",");
          span.style.direction = run.direction === "rtl" ? "rtl" : "ltr";
          span.style.writingMode = run.direction === "ttb" || run.direction === "btt" ? "vertical-rl" : "horizontal-tb";
          span.style.fontFeatureSettings = run.features.length === 0 ? "normal" : run.features.map((feature) => `"${feature.replace(/^[+-]/, "")}" ${feature.startsWith("-") ? 0 : 1}`).join(",");
          main.append(span);
        }
      }, inputs);
      await page.evaluate(() => document.fonts.ready);
      const { root } = await cdp.send("DOM.getDocument");
      const records = [];
      for (let index = 0; index < exact.records.length; index++) {
        const exactRecord = exact.records[index];
        let selector = `#run-${index}`;
        let { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        let { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        const targetPostscript = exactRecord.face.localPostscriptName;
        let faceObservation: FaceObservation = "matched";
        if (targetPostscript != null && !fonts.some((font) => normalizeFace(font.postScriptName) === normalizeFace(targetPostscript))) {
          const inferredFamily = targetPostscript.replace(/^\./, "").replace(/-(?:Regular|Italic|Light|Medium|Bold).*$/i, "");
          const keyFamily = exactRecord.face.key.replace(/^(?:sysfb|winfam):/, "").replace(/-(?:regular|italic|light|medium|bold).*$/i, "").replaceAll("-", " ");
          const candidates = [...new Set([inferredFamily, keyFamily, "system-ui", "-apple-system", "ui-monospace", "sans-serif", "serif", "monospace"])]
            .flatMap((family) => [300, 400, 500, 700].map((weight) => ({ family, weight, style: /italic/i.test(targetPostscript) ? "italic" : "normal" })));
          let winner: { selector: string; nodeId: number; fonts: typeof fonts } | undefined;
          for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            const candidate = candidates[candidateIndex];
            const id = `candidate-${index}-${candidateIndex}`;
            const generic = new Set(["system-ui", "-apple-system", "ui-monospace", "sans-serif", "serif", "monospace"]).has(candidate.family);
            const cssFamily = generic ? candidate.family : `"${candidate.family}"`;
            await page.evaluate(`(() => { const source=document.querySelector(${JSON.stringify(selector)}); const span=source.cloneNode(true); span.id=${JSON.stringify(id)}; span.style.fontFamily=${JSON.stringify(cssFamily)}; span.style.fontWeight=${JSON.stringify(String(candidate.weight))}; span.style.fontStyle=${JSON.stringify(candidate.style)}; document.body.append(span); })()`);
            await page.evaluate((candidateSelector) => document.querySelector(candidateSelector)?.getBoundingClientRect(), `#${id}`);
            const candidateNode = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
            const candidateFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: candidateNode.nodeId });
            if (candidateFonts.fonts.some((font) => normalizeFace(font.postScriptName) === normalizeFace(targetPostscript))) {
              winner = { selector: `#${id}`, nodeId: candidateNode.nodeId, fonts: candidateFonts.fonts };
              break;
            }
          }
          if (winner != null) {
            selector = winner.selector;
            nodeId = winner.nodeId;
            fonts = winner.fonts;
          } else {
            faceObservation = "css-unaddressable-after-candidate-walk";
          }
        }
        const paintedOrigins = await page.evaluate<PaintedOrigin[]>(`(() => {
          const span = document.querySelector(${JSON.stringify(selector)});
          const text = span && span.firstChild;
          if (!span || !text) return [];
          const result = []; let start = 0;
          for (const scalar of span.textContent || "") {
            const end = start + scalar.length; const range = document.createRange();
            range.setStart(text, start); range.setEnd(text, end);
            const rect = range.getBoundingClientRect();
            result.push({ utf16Span: [start, end], left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
            start = end;
          }
          return result;
        })()`);
        records.push(joinShapingEvidence(
          exactRecord,
          fonts.map((font) => ({ familyName: font.familyName, postScriptName: font.postScriptName, glyphCount: font.glyphCount, isCustomFont: font.isCustomFont })),
          paintedOrigins,
          faceObservation,
        ));
      }

      const controls = await page.evaluate<ControlRects>(`(() => {
        const probe = (family, direction, features, transform = "none") => {
          const span = document.createElement("span");
          span.textContent = "AVAVA"; span.style.cssText = "position:fixed;left:20px;top:20px;font:32px " + family + ";direction:" + direction + ";unicode-bidi:bidi-override;font-feature-settings:" + features + ";transform:" + transform;
          document.body.append(span);
          const text = span.firstChild; const rects = [];
          for (let i = 0; i < 5; i++) { const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1); const r = range.getBoundingClientRect(); rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }); }
          span.remove(); return rects;
        };
        return {
          base: probe("Arial", "ltr", '"kern" 1'),
          face: probe("Times New Roman", "ltr", '"kern" 1'),
          features: probe("Arial", "ltr", '"kern" 0'),
          direction: probe("Arial", "rtl", '"kern" 1'),
          origin: probe("Arial", "ltr", '"kern" 1', "translateX(20px)"),
        };
      })()`);
      const moved = browserControlMovement({ ...controls, paintedOrigins: controls.origin });
      const browserControls = { face: moved.face, features: moved.features, direction: moved.direction, paintedOrigins: moved.paintedOrigins };
      const movementProven = exact.movementProven && Object.values(browserControls).every(Boolean);
      const complete = exact.completeEnvironment && records.length === exact.pairs
        && records.every((record) => {
          const chrome = record.chrome as { paintedFaces: PaintedFace[]; paintedOrigins: unknown[] };
          const helper = record.helper as ExactRecord["face"];
          const comparison = record.comparison as { faceAgreement: boolean; faceObservation: FaceObservation };
          return helper.localPostscriptName != null && chrome.paintedOrigins.length > 0
            && (comparison.faceAgreement || comparison.faceObservation === "css-unaddressable-after-candidate-walk");
        });
      const report = {
        schemaVersion: 1,
        stage: "face-shaping-painted-origins",
        sourceRevision: "chromium:7d859f271cbda744098ac69f44978d4edfa62be3",
        verdict: complete && movementProven && exactRun.status === 0 ? "evidence-complete" : "verdict-withheld",
        boundary: "CDP exposes painted faces and DOM origins, not Blink glyph ids; glyph records come from the same concrete face shaped by Chromium-configured vendored HarfBuzz.",
        movementProven,
        controls: { helper: exact.controlHits, browser: browserControls },
        pairs: records.length,
        records,
      };
      if (output != null) writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`unified shaping evidence: ${records.length} records; controls ${JSON.stringify(report.controls)}`);
      return report.verdict === "evidence-complete" ? 0 : 1;
    } finally { await browser.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error); process.exitCode = 2; });
}
