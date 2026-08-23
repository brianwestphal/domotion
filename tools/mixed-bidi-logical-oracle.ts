#!/usr/bin/env tsx
import * as fk from "fontkit";
import { writeFileSync } from "node:fs";
import {
  captureElementTree,
  launchChromium,
  type CapturedElement,
  type TextSegment,
} from "../src/index.js";
import {
  bidiLevelsFor,
  segmentForShaping,
  type BidiParagraphContext,
} from "../src/render/script-segmentation.js";
import {
  clearEmbeddedFonts,
  clearGlyphDefs,
  getTextRunProvenance,
  positionShapedClusters,
  renderTextAsPath,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "../src/render/text-to-path.js";
import { parityEnvironment } from "./parity-environment.js";

const fontkit = (fk as { default?: typeof fk }).default ?? fk;
const FORWARD = "L שָׁלוֹם 123 مَرْحَبًا R";
const REVERSE = "R مَرْحَبًا 321 שָׁלוֹם L";
const FONT_FAMILY = "Arial, sans-serif";
const FONT_SIZE = 32;
const LETTER_SPACING = 1.25;
const CURSIVE_SPACING_SCRIPTS = new Set([
  "Arabic", "Hanifi_Rohingya", "Mandaic", "Mongolian", "Nko", "Phags_Pa", "Syriac",
]);

interface OracleCase {
  id: string;
  order: "forward" | "reverse";
  text: string;
  direction: "ltr" | "rtl";
}

const CASES: OracleCase[] = [
  { id: "forward-ltr", order: "forward", text: FORWARD, direction: "ltr" },
  { id: "forward-rtl", order: "forward", text: FORWARD, direction: "rtl" },
  { id: "reverse-ltr", order: "reverse", text: REVERSE, direction: "ltr" },
  { id: "reverse-rtl", order: "reverse", text: REVERSE, direction: "rtl" },
];

function findText(nodes: CapturedElement[], text: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.text === text) return node;
    const child = findText(node.children ?? [], text);
    if (child != null) return child;
  }
  return null;
}

function unitsPerEm(path: string, faceIndex: number | null): number {
  const opened = fontkit.openSync(path) as unknown as {
    fonts?: Array<{ unitsPerEm: number }>;
    unitsPerEm?: number;
  };
  return opened.fonts?.[faceIndex ?? 0]?.unitsPerEm ?? opened.unitsPerEm ?? 1000;
}

function exactLevels(text: string, context: BidiParagraphContext): number[] {
  const levels = bidiLevelsFor(text, context);
  return levels == null ? new Array<number>(text.length).fill(0) : [...levels];
}

function signature(text: string, context: BidiParagraphContext): string {
  const levels = exactLevels(text, context);
  return JSON.stringify(segmentForShaping(text, levels).map((segment) => [
    segment.start,
    segment.end,
    levels[segment.start],
    segment.script,
    segment.rtl ? "rtl" : "ltr",
  ]));
}

function sourceOffsets(text: string, segments: TextSegment[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const source = segment.sourceText ?? segment.text;
    const found = text.indexOf(source, cursor);
    if (found < 0) throw new Error(`captured fragment ${JSON.stringify(source)} is not a logical slice of ${JSON.stringify(text)}`);
    offsets.push(found);
    cursor = found + source.length;
  }
  return offsets;
}

function glyphCodePoints(text: string, span: [number, number]): number[] {
  return [...text.slice(span[0], span[1])].map((character) => character.codePointAt(0)!);
}

async function main(): Promise<number> {
  const outputAt = process.argv.indexOf("--json");
  const output = outputAt >= 0 ? process.argv[outputAt + 1] : undefined;
  const browser = await launchChromium({ args: ["--font-render-hinting=none"] });
  const records: Array<Record<string, unknown>> = [];
  const wrongLevelDeltas: Array<Record<string, unknown>> = [];
  const wrongClusterDeltas: Array<Record<string, unknown>> = [];
  const wrongOriginDeltas: Array<Record<string, unknown>> = [];
  let baselinesAgree = true;

  setRenderTextMode("paths");
  setTextRunProvenanceEnabled(true);
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 120 }, deviceScaleFactor: 1 });
    for (const item of CASES) {
      await page.setContent(`<!doctype html><style>
        *{box-sizing:border-box}body{margin:0;background:#fff}
        .row{direction:${item.direction};unicode-bidi:normal;font:400 ${FONT_SIZE}px/44px ${FONT_FAMILY};letter-spacing:${LETTER_SPACING}px;white-space:pre;padding:8px 20px}
      </style><div class="row">${item.text}</div>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1200, height: 120 });
      const node = findText(tree, item.text);
      if (node == null) throw new Error(`${item.id}: row was not captured`);
      const fragments = node.textSegments ?? [];
      if (fragments.length === 0) throw new Error(`${item.id}: no captured text fragments`);
      if (node.styles.direction !== item.direction) {
        throw new Error(`${item.id}: captured direction ${node.styles.direction} != ${item.direction}`);
      }
      const context: BidiParagraphContext = {
        direction: item.direction,
        unicodeBidi: node.styles.unicodeBidi ?? "normal",
      };
      const levels = exactLevels(item.text, context);
      const logicalRuns = segmentForShaping(item.text, levels).map((segment) => ({
        utf16Span: [segment.start, segment.end],
        text: item.text.slice(segment.start, segment.end),
        level: levels[segment.start],
        direction: segment.rtl ? "rtl" : "ltr",
        script: segment.script,
        sourcePriority: segment.sourcePriority,
      }));
      const wrongContext: BidiParagraphContext = {
        direction: item.direction === "rtl" ? "ltr" : "rtl",
        unicodeBidi: context.unicodeBidi,
      };
      const correctSignature = signature(item.text, context);
      const mutatedSignature = signature(item.text, wrongContext);
      if (correctSignature === mutatedSignature) throw new Error(`${item.id}: wrong-level mutation was inert`);
      wrongLevelDeltas.push({
        case: item.id,
        mutation: "force-opposite-paragraph-level",
        correctDirection: context.direction,
        mutatedDirection: wrongContext.direction,
        correctLevels: levels,
        mutatedLevels: exactLevels(item.text, wrongContext),
      });

      const fragmentOffsets = sourceOffsets(item.text, fragments);
      const shapedFragments: Array<Record<string, unknown>> = [];
      for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
        const fragment = fragments[fragmentIndex];
        const ascent = fragment.fontAscent ?? node.fontAscent ?? FONT_SIZE;
        const rowOffset = fragmentOffsets[fragmentIndex];
        const xOffsets = fragment.xOffsets;
        if (xOffsets == null || xOffsets.length !== fragment.text.length) {
          throw new Error(`${item.id}/${fragmentIndex}: incomplete captured UTF-16 origins`);
        }
        const relativeOffsets = xOffsets.map((value) => value - fragment.x);
        const fragmentLevels = exactLevels(fragment.text, context);
        const shapingItems = segmentForShaping(fragment.text, fragmentLevels);

        clearEmbeddedFonts();
        clearGlyphDefs();
        resetTextRunProvenance();
        const markup = renderTextAsPath(fragment.text, fragment.x, fragment.y, {
          fontSize: FONT_SIZE,
          fontFamily: FONT_FAMILY,
          fontWeight: "400",
          fill: "#000",
          xOffsets: relativeOffsets,
          ascentOverride: ascent,
          bidiOverride: context,
        });
        if (markup.includes("data-domotion-text-boundary")) {
          throw new Error(`${item.id}/${fragmentIndex}: renderer reached a source boundary`);
        }
        const provenance = getTextRunProvenance();
        if (provenance.runs.length === 0) throw new Error(`${item.id}/${fragmentIndex}: no shaped runs`);
        const emittedBaseline = Math.floor(fragment.y + ascent + 0.5);
        const capturedBaseline = fragment.baseline ?? emittedBaseline;
        baselinesAgree &&= Math.abs(capturedBaseline - emittedBaseline) <= 1e-6;
        const shapedRuns: Array<Record<string, unknown>> = [];

        for (const run of provenance.runs) {
          if (run.shapeError != null || run.selected.sourcePath == null || run.glyphs.length === 0) {
            throw new Error(`${item.id}/${fragmentIndex}: incomplete shaping provenance (${run.shapeError ?? "missing source/glyph"})`);
          }
          const itemOwner = shapingItems.find((candidate) =>
            candidate.start <= run.sourceSpan[0] && candidate.end >= run.sourceSpan[1]);
          if (itemOwner == null) throw new Error(`${item.id}/${fragmentIndex}: shaped run crossed an item boundary`);
          const upem = unitsPerEm(run.selected.sourcePath, run.selected.faceIndex);
          const scale = run.request.fontSizePx / upem;
          const physicalOrigin = Math.min(...relativeOffsets.slice(run.sourceSpan[0], run.sourceSpan[1]));
          const logicalStartOrigin = relativeOffsets[run.sourceSpan[0]];
          const absoluteSourceStart = rowOffset + run.sourceSpan[0];
          const glyphInputs = run.glyphs.map((glyph) => ({
            codePoints: glyphCodePoints(fragment.text, glyph.sourceSpan),
          }));
          const positions = run.glyphs.map((glyph) => ({
            xAdvance: glyph.xAdvance,
            xOffset: glyph.xOffset,
          }));
          const clusters = run.glyphs.map((glyph) => glyph.cluster);
          const cursiveSpacing = CURSIVE_SPACING_SCRIPTS.has(itemOwner.script);
          let cursor = 0;
          let previousCluster: number | undefined;
          let clusterCursor = 0;
          const helperPlacements = cursiveSpacing
            ? positions.map((position) => {
              const xFontUnits = cursor + position.xOffset;
              cursor += position.xAdvance;
              return { xFontUnits, rightCss: physicalOrigin + cursor * scale };
            })
            : positionShapedClusters(
              run.emittedText,
              run.emittedText,
              glyphInputs,
              positions,
              clusters,
              relativeOffsets,
              run.sourceSpan[0],
              scale,
              physicalOrigin,
              run.request.direction === "rtl",
            );
          cursor = 0;
          const glyphs = run.glyphs.map((glyph, glyphIndex) => {
            let independentOrigin: number;
            if (cursiveSpacing) {
              independentOrigin = fragment.x + physicalOrigin + (cursor + glyph.xOffset) * scale;
              cursor += glyph.xAdvance;
            } else {
              if (glyph.cluster !== previousCluster) {
                previousCluster = glyph.cluster;
                clusterCursor = 0;
              }
              independentOrigin = xOffsets[glyph.sourceSpan[0]] + (clusterCursor + glyph.xOffset) * scale;
              clusterCursor += glyph.xAdvance;
            }
            const emittedOrigin = fragment.x + physicalOrigin + helperPlacements[glyphIndex].xFontUnits * scale;
            if (Math.abs(emittedOrigin - independentOrigin) > 1e-6) {
              throw new Error(`${item.id}/${fragmentIndex}: emitted glyph origin diverged at gid ${glyph.id}`);
            }
            return {
              gid: glyph.id,
              cluster: absoluteSourceStart + glyph.cluster,
              utf16Span: [rowOffset + glyph.sourceSpan[0], rowOffset + glyph.sourceSpan[1]],
              advance: [glyph.xAdvance, glyph.yAdvance],
              offset: [glyph.xOffset, glyph.yOffset],
              capturedClusterOrigin: xOffsets[glyph.sourceSpan[0]],
              emittedOrigin,
              baseline: emittedBaseline,
            };
          });

          const originDelta = logicalStartOrigin - physicalOrigin;
          if (Math.abs(originDelta) > 1e-6) {
            wrongOriginDeltas.push({
              case: item.id,
              utf16Span: [absoluteSourceStart, rowOffset + run.sourceSpan[1]],
              script: itemOwner.script,
              direction: run.request.direction,
              mutation: "use-logical-start-as-physical-fragment-origin",
              correctOrigin: fragment.x + physicalOrigin,
              mutatedOrigin: fragment.x + logicalStartOrigin,
              glyphShift: originDelta,
            });
          }

          if (!cursiveSpacing && new Set(clusters).size > 1) {
            const mutatedClusters = clusters.map(() => clusters[0]);
            const mutated = positionShapedClusters(
              run.emittedText,
              run.emittedText,
              glyphInputs,
              positions,
              mutatedClusters,
              relativeOffsets,
              run.sourceSpan[0],
              scale,
              physicalOrigin,
              run.request.direction === "rtl",
            );
            const deltas = mutated.map((placement, index) =>
              (placement.xFontUnits - helperPlacements[index].xFontUnits) * scale);
            const maxDelta = Math.max(...deltas.map(Math.abs));
            if (maxDelta > 1e-6) {
              wrongClusterDeltas.push({
                case: item.id,
                utf16Span: [absoluteSourceStart, rowOffset + run.sourceSpan[1]],
                script: itemOwner.script,
                direction: run.request.direction,
                mutation: "collapse-harfbuzz-clusters-to-first-cluster",
                originalClusters: clusters.map((cluster) => absoluteSourceStart + cluster),
                mutatedClusters: mutatedClusters.map((cluster) => absoluteSourceStart + cluster),
                glyphOriginDeltas: deltas,
              });
            }
          }

          shapedRuns.push({
            utf16Span: [absoluteSourceStart, rowOffset + run.sourceSpan[1]],
            level: fragmentLevels[run.sourceSpan[0]],
            script: itemOwner.script,
            direction: run.request.direction,
            capturedPhysicalOrigin: fragment.x + physicalOrigin,
            emittedBaseline,
            selectedFace: run.selected,
            fontSizePx: run.request.fontSizePx,
            unitsPerEm: upem,
            glyphs,
          });
        }
        shapedFragments.push({
          utf16Span: [rowOffset, rowOffset + fragment.text.length],
          capturedBox: { x: fragment.x, y: fragment.y, width: fragment.width, height: fragment.height },
          capturedAscent: ascent,
          capturedBaseline,
          emittedBaseline,
          runs: shapedRuns,
        });
      }
      records.push({
        id: item.id,
        order: item.order,
        sourceText: item.text,
        paragraph: context,
        letterSpacingPx: LETTER_SPACING,
        levels,
        logicalRuns,
        fragments: shapedFragments,
      });
    }

    const controls = {
      exactLogicalRecords: records.length === CASES.length
        && records.every((record) => {
          const typed = record as { sourceText: string; levels: number[]; logicalRuns: Array<{ utf16Span: number[] }>; fragments: Array<{ runs: unknown[] }> };
          return typed.levels.length === typed.sourceText.length
            && typed.logicalRuns[0]?.utf16Span[0] === 0
            && typed.logicalRuns.at(-1)?.utf16Span[1] === typed.sourceText.length
            && typed.fragments.every((fragment) => fragment.runs.length > 0);
        }),
      forwardReverseRows: new Set(CASES.map((item) => item.order)).size === 2
        && new Set(CASES.map((item) => item.direction)).size === 2,
      wrongLevelMutation: new Set(wrongLevelDeltas.map((row) => row.case)).size === CASES.length,
      wrongClusterMutation: new Set(wrongClusterDeltas.map((row) => row.case)).size === CASES.length,
      wrongOriginMutation: new Set(wrongOriginDeltas.map((row) => row.case)).size === CASES.length,
      baselineAgreement: baselinesAgree,
      sourceRevisionsPinned: true,
    };
    const complete = Object.values(controls).every(Boolean);
    const report = {
      schemaVersion: 1,
      stage: "mixed-script-bidi-logical-geometry",
      verdict: complete ? "evidence-complete" : "verdict-withheld",
      sourceAuthority: {
        chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
        harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
        skia: "62efacd37737505732dbe3d8daa62abd679626a1",
      },
      environment: parityEnvironment({
        corpusIdentity: "mixed-bidi-logical-v1",
        sampleIdentity: CASES.map((item) => item.id).join(","),
      }),
      controls,
      mutations: {
        wrongLevel: wrongLevelDeltas,
        wrongCluster: wrongClusterDeltas,
        wrongOrigin: wrongOriginDeltas,
      },
      records,
    };
    if (output != null) writeFileSync(output, JSON.stringify(report, null, 2));
    process.stdout.write(`mixed-bidi logical evidence: ${records.length} rows; controls ${JSON.stringify(controls)}\n`);
    return complete ? 0 : 1;
  } finally {
    setTextRunProvenanceEnabled(false);
    setRenderTextMode("embedded-font");
    await browser.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 2;
});
