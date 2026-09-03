#!/usr/bin/env tsx
/**
 * Strict logical oracle for Blink FragmentItem UTF-16 ownership.
 *
 * The independent arm repeats the pinned Range prefix/suffix discriminator in
 * the same transform-neutral frame, reads ordered DOM.getContentQuads, and
 * compares both with the production capture record.  The production renderer
 * then shapes every already-split segment with provenance enabled so source
 * spans, clusters, gids, advances, offsets, and fragment origins remain in the
 * artifact.  This oracle never reads pixels and has no visual tolerance.
 */

import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import { chromium, type CDPSession, type Page } from "playwright";

import type {
  CapturedDomUtf16Span,
  CapturedElement,
  CapturedTextPaintFragment,
  CapturedTextPaintQuad,
  CapturedTextSegmentSourceMapping,
  TextSegment,
} from "../src/capture/types.js";
import {
  joinBlinkRangeFragmentsToContentQuads,
  splitTextSegmentsOnFragmentSpans,
  type BlinkRangeFragmentProbe,
  type CapturedTextRangeRect,
  type JoinedTextSourceFragment,
} from "../src/capture/text-fragment-spans.js";
import { embeddedVariableFontBytes } from "./exact-shaping-control-fixtures.js";

export const TEXT_FRAGMENT_SPAN_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzzPinnedByChromium: "511df88b82e697cd2a0f1f0635787aa0b18bddbb",
  harfbuzzRenderer: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export interface TextFragmentSpanCase {
  id: string;
  text: string;
  writingMode: "horizontal-tb" | "vertical-rl";
  firstLetter: boolean;
  targetCss: string;
}

export const TEXT_FRAGMENT_SPAN_CASES: readonly TextFragmentSpanCase[] = [
  {
    id: "mixed-fallback-bidi-ligature-wrap-first-letter",
    text: "“Latin fi العربية 漢字 אבג wrapped office tail",
    writingMode: "horizontal-tb",
    firstLetter: true,
    targetCss: "display:block;width:238px;white-space:normal;unicode-bidi:plaintext;font-variant-ligatures:common-ligatures;font-feature-settings:'liga' 1;transform:skewX(7deg);transform-origin:19% 83%",
  },
  {
    id: "vertical-mixed-fallback-ligature",
    text: "Latin fi العربية 漢字 office",
    writingMode: "vertical-rl",
    firstLetter: false,
    targetCss: "display:block;height:248px;writing-mode:vertical-rl;font-feature-settings:'liga' 1;transform:rotate(-9deg) scaleX(-1);transform-origin:23% 76%",
  },
] as const;

export type TextFragmentSpanMutationKind =
  | "collapse-fragments"
  | "reorder-fragments"
  | "wrong-source-span";

export const REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS: readonly TextFragmentSpanMutationKind[] = [
  "collapse-fragments",
  "reorder-fragments",
  "wrong-source-span",
] as const;

interface IndependentFragmentState {
  rangeFragments: BlinkRangeFragmentProbe[];
  contentQuads: CapturedTextPaintQuad[];
  platformFonts: Array<{
    familyName: string;
    postScriptName: string;
    isCustomFont: boolean;
    glyphCount: number;
  }>;
}

interface GlyphEvidence {
  gid: number;
  cluster: number;
  renderedUtf16Span: CapturedDomUtf16Span;
  domUtf16Span: CapturedDomUtf16Span;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

interface ShapedRunEvidence {
  sourceFragmentIndex: number;
  sourceTextNodeIndex: number;
  domUtf16Span: CapturedDomUtf16Span;
  text: string;
  selectedFontKeys: string[];
  glyphs: GlyphEvidence[];
  fragmentOrigin: {
    inlineOffset: number;
    physicalBaselinePoint: { x: number; y: number };
  };
  shapedOrigins: number[];
  shapedAdvances: number[];
}

export interface TextFragmentSpanRow {
  id: string;
  text: string;
  writingMode: TextFragmentSpanCase["writingMode"];
  independent: IndependentFragmentState;
  captured: {
    sourceFragments: NonNullable<CapturedElement["textPaintGeometry"]>["sourceFragments"];
    paintFragments: CapturedTextPaintFragment[];
    neutralSegments: TextSegment[];
    shapedRuns: ShapedRunEvidence[];
    warnings: string[];
  };
  controls: Record<string, boolean>;
  pass: boolean;
}

export interface TextFragmentSpanMutationResult {
  kind: TextFragmentSpanMutationKind;
  rejected: boolean;
  failureReason: string;
}

export interface TextFragmentSpanReport {
  schemaVersion: 1;
  generatedAt: string;
  sourcePins: typeof TEXT_FRAGMENT_SPAN_SOURCE_PINS;
  fingerprint: {
    chromiumVersion: string;
    playwrightVersion: string;
    userAgent: string;
    os: NodeJS.Platform;
    osRelease: string;
    architecture: string;
    node: string;
  };
  rows: TextFragmentSpanRow[];
  mutations: TextFragmentSpanMutationResult[];
  controls: Record<string, boolean>;
  verdict: "exact-fragment-span-agreement" | "fragment-span-gate-failure";
}

export function validateTextFragmentSpanCorpus(): string[] {
  const errors: string[] = [];
  const ids = TEXT_FRAGMENT_SPAN_CASES.map((test) => test.id);
  if (new Set(ids).size !== ids.length) errors.push("case ids must be unique");
  const mixed = TEXT_FRAGMENT_SPAN_CASES.find((test) => test.id === "mixed-fallback-bidi-ligature-wrap-first-letter");
  if (mixed == null) errors.push("mixed fallback/bidi/ligature/wrap/first-letter case is required");
  else {
    if (!mixed.firstLetter) errors.push("mixed case must exercise ::first-letter");
    if (!mixed.text.includes("fi")) errors.push("mixed case must exercise a ligature candidate");
    if (!/[\u0600-\u06ff]/u.test(mixed.text) || !/[\u3400-\u9fff]/u.test(mixed.text)
      || !/[\u0590-\u05ff]/u.test(mixed.text)) {
      errors.push("mixed case must contain Arabic, CJK, and Hebrew fallback/bidi text");
    }
  }
  if (!TEXT_FRAGMENT_SPAN_CASES.some((test) => test.writingMode === "vertical-rl")) {
    errors.push("vertical writing case is required");
  }
  if (new Set(REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS).size !== REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS.length) {
    errors.push("mutation ids must be unique");
  }
  return errors;
}

function fixtureHtml(test: TextFragmentSpanCase, fontBase64: string): string {
  const firstLetter = test.firstLetter
    ? "#target::first-letter{font:700 42px/31px Georgia,serif;color:#c21}"
    : "";
  return `<!doctype html><style>
    @font-face{font-family:DM2546OpenSans;src:url(data:font/ttf;base64,${fontBase64}) format('truetype');font-weight:100 900}
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}
    #scene{position:relative;width:960px;height:640px;padding:50px;font:24px/31px DM2546OpenSans,Arial,sans-serif}
    #outer{display:inline-block;zoom:1.25;transform:rotate(13deg) scale(.91,1.08);transform-origin:71% 17%}
    #target{${test.targetCss}}
    ${firstLetter}
  </style><div id=scene><div id=outer data-affine-owner><span id=target data-affine-owner></span></div></div>`;
}

function walk(nodes: readonly CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function ownerFor(tree: readonly CapturedElement[], text: string): CapturedElement | null {
  return walk(tree).find((node) => node.textPaintGeometry?.neutral?.textSegments
    ?.some((segment) => segment.sourceMapping?.domText === text)) ?? null;
}

function exact<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() =>
    requestAnimationFrame(() => resolveFrame()))));
}

async function contentQuadsForTarget(page: Page, session: CDPSession): Promise<CapturedTextPaintQuad[]> {
  const evaluated = await session.send("Runtime.evaluate", {
    expression: "document.querySelector('#target').firstChild",
    returnByValue: false,
  });
  const objectId = evaluated.result.objectId;
  if (objectId == null) throw new Error("target Text node object is unavailable");
  try {
    const described = await session.send("DOM.describeNode", { objectId });
    const measured = await session.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
    return measured.quads.map((quad) => quad as CapturedTextPaintQuad);
  } finally {
    await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function platformFontsForTarget(session: CDPSession): Promise<IndependentFragmentState["platformFonts"]> {
  const { root } = await session.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#target" });
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.map((font) => ({
    familyName: font.familyName,
    postScriptName: font.postScriptName,
    isCustomFont: font.isCustomFont,
    glyphCount: font.glyphCount,
  }));
}

async function independentNeutralState(page: Page): Promise<IndependentFragmentState> {
  const neutralStyle = await page.addStyleTag({
    content: "[data-affine-owner]{transform:none!important;translate:none!important;rotate:none!important;scale:none!important}",
  });
  const session = await page.context().newCDPSession(page);
  try {
    await settle(page);
    // tsx annotates nested functions with this no-op helper. Playwright's
    // isolated browser world does not inherit the Node-side helper.
    await page.evaluate("globalThis.__name = (target) => target");
    await Promise.all([session.send("DOM.enable"), session.send("Runtime.enable"), session.send("CSS.enable")]);
    const [rangeFragments, contentQuads, platformFonts] = await Promise.all([
      page.evaluate(() => {
        const node = document.querySelector("#target")!.firstChild as Text;
        type Rect = { x: number; y: number; width: number; height: number };
        const rect = (value: DOMRect): Rect => ({ x: value.x, y: value.y, width: value.width, height: value.height });
        const tokenFor = (value: Rect): string => `${value.x}|${value.y}|${value.width}|${value.height}`;
        const rectsFor = (start: number, end: number): Rect[] => {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          return Array.from(range.getClientRects(), rect);
        };
        const countsFor = (values: Rect[]): Map<string, number> => {
          const counts = new Map<string, number>();
          for (const value of values) {
            const token = tokenFor(value);
            counts.set(token, (counts.get(token) ?? 0) + 1);
          }
          return counts;
        };
        const full = rectsFor(0, node.length);
        const tokens = full.map(tokenFor);
        const prefix = Array.from({ length: node.length + 1 }, (_, offset) => countsFor(rectsFor(0, offset)));
        const suffix = Array.from({ length: node.length + 1 }, (_, offset) => countsFor(rectsFor(offset, node.length)));
        return full.map((neutralRangeRect, physicalFragmentIndex) => {
          const token = tokens[physicalFragmentIndex];
          const forwardRank = tokens.slice(0, physicalFragmentIndex + 1).filter((candidate) => candidate === token).length;
          const reverseRank = tokens.slice(physicalFragmentIndex).filter((candidate) => candidate === token).length;
          const end = prefix.findIndex((counts) => (counts.get(token) ?? 0) >= forwardRank);
          let start = -1;
          for (let offset = node.length; offset >= 0; offset--) {
            if ((suffix[offset].get(token) ?? 0) >= reverseRank) { start = offset; break; }
          }
          const isolated = start >= 0 && end > start ? rectsFor(start, end) : [];
          if (isolated.length !== 1 || tokenFor(isolated[0]) !== token) {
            throw new Error(`could not isolate Range FragmentItem ${physicalFragmentIndex}`);
          }
          return {
            physicalFragmentIndex,
            domUtf16Span: [start, end] as [number, number],
            neutralRangeRect,
          };
        });
      }),
      contentQuadsForTarget(page, session),
      platformFontsForTarget(session),
    ]);
    return { rangeFragments, contentQuads, platformFonts };
  } finally {
    await neutralStyle.evaluate((style) => style.remove()).catch(() => undefined);
    await settle(page).catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}

function mapRenderedSpanToDom(
  mapping: CapturedTextSegmentSourceMapping,
  renderedSpan: CapturedDomUtf16Span,
): CapturedDomUtf16Span | null {
  const chunks = mapping.renderedChunks.filter((chunk) =>
    chunk.renderedUtf16Span[0] < renderedSpan[1] && renderedSpan[0] < chunk.renderedUtf16Span[1]);
  if (chunks.length === 0 || chunks[0].renderedUtf16Span[0] !== renderedSpan[0]
    || chunks.at(-1)!.renderedUtf16Span[1] !== renderedSpan[1]) return null;
  return [
    Math.min(...chunks.map((chunk) => chunk.domUtf16Span[0])),
    Math.max(...chunks.map((chunk) => chunk.domUtf16Span[1])),
  ];
}

type RendererProvenance = ReturnType<typeof import("../src/render/text-run-provenance.js")["getTextRunProvenance"]>;

function shapedEvidence(
  sourceFragments: NonNullable<CapturedElement["textPaintGeometry"]>["sourceFragments"],
  paintFragments: readonly CapturedTextPaintFragment[],
  segments: readonly TextSegment[],
  provenance: RendererProvenance,
): ShapedRunEvidence[] {
  const availableRuns = provenance.runs.filter((run) => run.shapeError == null);
  return paintFragments.map((fragment) => {
    const source = sourceFragments[fragment.sourceFragmentIndex];
    const segment = segments[fragment.textSegmentIndex];
    const mapping = segment?.sourceMapping;
    if (source == null || segment == null || mapping == null) {
      throw new Error(`fragment ${fragment.physicalFragmentIndex} has no exact split source segment`);
    }
    const selected: Array<{ run: RendererProvenance["runs"][number]; renderedShift: number }> = [];
    if (segment.verticalWritingMode != null) {
      for (let offset = 0; offset < segment.text.length;) {
        const codepoint = segment.text.codePointAt(offset)!;
        const width = codepoint > 0xFFFF ? 2 : 1;
        const character = segment.text.slice(offset, offset + width);
        if (!/\s/u.test(character)) {
          const runIndex = availableRuns.findIndex((run) => run.sourceText === character);
          if (runIndex >= 0) selected.push({ run: availableRuns.splice(runIndex, 1)[0], renderedShift: offset });
        }
        offset += width;
      }
    } else {
      for (let runIndex = availableRuns.length - 1; runIndex >= 0; runIndex--) {
        if (availableRuns[runIndex].sourceText !== segment.text) continue;
        selected.unshift({ run: availableRuns.splice(runIndex, 1)[0], renderedShift: 0 });
      }
    }
    const glyphs = selected.flatMap(({ run, renderedShift }) => run.glyphs.map((glyph): GlyphEvidence => {
      const renderedUtf16Span: CapturedDomUtf16Span = [
        glyph.sourceSpan[0] + renderedShift,
        glyph.sourceSpan[1] + renderedShift,
      ];
      const domUtf16Span = mapRenderedSpanToDom(mapping, renderedUtf16Span);
      if (domUtf16Span == null) throw new Error(`glyph ${glyph.id} crosses a non-exact source-map chunk`);
      return {
        gid: glyph.id,
        cluster: glyph.cluster,
        renderedUtf16Span,
        domUtf16Span,
        xAdvance: glyph.xAdvance,
        yAdvance: glyph.yAdvance,
        xOffset: glyph.xOffset,
        yOffset: glyph.yOffset,
      };
    }));
    return {
      sourceFragmentIndex: fragment.sourceFragmentIndex,
      sourceTextNodeIndex: fragment.sourceTextNodeIndex,
      domUtf16Span: [...fragment.domUtf16Span],
      text: segment.text,
      selectedFontKeys: [...new Set(selected.map(({ run }) => run.selected.fontKey))],
      glyphs,
      fragmentOrigin: {
        inlineOffset: fragment.inlineOffset,
        physicalBaselinePoint: { ...fragment.lineOrigin.physicalBaselinePoint },
      },
      shapedOrigins: [...fragment.shapedOrigins],
      shapedAdvances: [...fragment.shapedAdvances],
    };
  });
}

function mutationResults(
  sourceTextNodeIndex: number,
  independent: IndependentFragmentState,
  segments: readonly TextSegment[],
): TextFragmentSpanMutationResult[] {
  const collapsed = joinBlinkRangeFragmentsToContentQuads(
    sourceTextNodeIndex,
    independent.rangeFragments.slice(0, -1),
    independent.contentQuads,
  );
  const reorderedQuads = independent.contentQuads.map((quad) => [...quad] as CapturedTextPaintQuad);
  if (reorderedQuads.length > 1) [reorderedQuads[0], reorderedQuads[1]] = [reorderedQuads[1], reorderedQuads[0]];
  const reordered = joinBlinkRangeFragmentsToContentQuads(
    sourceTextNodeIndex,
    independent.rangeFragments,
    reorderedQuads,
  );
  const baseline = joinBlinkRangeFragmentsToContentQuads(
    sourceTextNodeIndex,
    independent.rangeFragments,
    independent.contentQuads,
  );
  let wrongSpanFailure = "baseline join failed before wrong-span mutation";
  let wrongSpanRejected = true;
  if (baseline.fragments != null) {
    const wrong = baseline.fragments.map((fragment): JoinedTextSourceFragment => ({
      ...fragment,
      domUtf16Span: [...fragment.domUtf16Span],
      neutralRangeRect: { ...fragment.neutralRangeRect },
    }));
    const candidate = wrong.find((fragment) => fragment.cdpQuadIndex != null && fragment.domUtf16Span[0] > 0)
      ?? wrong.find((fragment) => fragment.cdpQuadIndex != null);
    if (candidate != null) candidate.domUtf16Span = [candidate.domUtf16Span[0], candidate.domUtf16Span[1] + 1];
    const split = splitTextSegmentsOnFragmentSpans(segments, wrong);
    wrongSpanRejected = split.segments == null;
    wrongSpanFailure = split.failureReason ?? "wrong source span was accepted";
  }
  return [
    {
      kind: "collapse-fragments",
      rejected: collapsed.fragments == null,
      failureReason: collapsed.failureReason ?? "collapsed fragment set was accepted",
    },
    {
      kind: "reorder-fragments",
      rejected: reordered.fragments == null,
      failureReason: reordered.failureReason ?? "reordered fragment set was accepted",
    },
    { kind: "wrong-source-span", rejected: wrongSpanRejected, failureReason: wrongSpanFailure },
  ];
}

async function runCase(
  page: Page,
  test: TextFragmentSpanCase,
  fontBase64: string,
  fontBytes: Buffer,
  capture: typeof import("../src/capture/index.js"),
  render: typeof import("../src/render/element-tree-to-svg.js"),
  textPath: typeof import("../src/render/text-to-path.js"),
  provenanceApi: typeof import("../src/render/text-run-provenance.js"),
): Promise<{ row: TextFragmentSpanRow; mutations: TextFragmentSpanMutationResult[] }> {
  await page.setContent(fixtureHtml(test, fontBase64), { waitUntil: "load" });
  await page.locator("#target").evaluate((element, text) => { element.textContent = text; }, test.text);
  await page.evaluate(() => document.fonts.ready);
  const independent = await independentNeutralState(page);
  const captureResult = await capture.captureElementTreeWithWarnings(
    page,
    "#scene",
    { x: 0, y: 0, width: 960, height: 640 },
  );
  const owner = ownerFor(captureResult.tree, test.text);
  const geometry = owner?.textPaintGeometry;
  if (owner == null || geometry?.neutral?.textSegments == null) {
    throw new Error(`${test.id}: production capture did not retain affine fragment geometry`);
  }
  const neutralSegments = geometry.neutral.textSegments;
  textPath.clearWebfonts();
  textPath.registerWebfont("DM2546OpenSans", 400, "normal", fontBytes, undefined, undefined, "100 900", "normal");
  textPath.setRenderTextMode("paths");
  provenanceApi.resetTextRunProvenance();
  provenanceApi.setTextRunProvenanceEnabled(true);
  render.elementTreeToSvg(captureResult.tree, 960, 640);
  const provenance = provenanceApi.getTextRunProvenance();
  provenanceApi.setTextRunProvenanceEnabled(false);
  const shapedRuns = shapedEvidence(geometry.sourceFragments, geometry.fragments, neutralSegments, provenance);
  const capturedSourceShape = geometry.sourceFragments.map((fragment) => ({
    physicalFragmentIndex: fragment.physicalFragmentIndex,
    domUtf16Span: fragment.domUtf16Span,
    neutralRangeRect: fragment.neutralRangeRect,
  }));
  const independentSourceShape = independent.rangeFragments.map((fragment) => ({
    physicalFragmentIndex: fragment.physicalFragmentIndex,
    domUtf16Span: fragment.domUtf16Span,
    neutralRangeRect: fragment.neutralRangeRect,
  }));
  const ordinary = geometry.sourceFragments.filter((fragment) => fragment.role === "ordinary");
  const firstLetter = geometry.sourceFragments.filter((fragment) => fragment.role === "first-letter");
  const splitOwners = geometry.sourceFragments.map((source) => neutralSegments.filter((segment) =>
    segment.sourceMapping?.sourceTextNodeIndex === source.sourceTextNodeIndex
      && segment.sourceMapping.role === source.role
      && exact(segment.sourceMapping.domUtf16Span, source.domUtf16Span)).length);
  const controls = {
    multiplePhysicalFragmentItems: geometry.sourceFragments.length > 2,
    independentRangeRecordMatchesCaptureExactly: exact(independentSourceShape, capturedSourceShape),
    oneOrdinarySourcePerContentQuad: ordinary.length === independent.contentQuads.length,
    onePaintRecordPerContentQuad: geometry.fragments.length === independent.contentQuads.length,
    orderedContentQuadsMatchCaptureExactly: geometry.fragments.every((fragment) => {
      const cdpQuadIndex = geometry.sourceFragments[fragment.sourceFragmentIndex]?.cdpQuadIndex;
      return cdpQuadIndex != null && exact(fragment.neutralQuad, independent.contentQuads[cdpQuadIndex]);
    }),
    expectedFirstLetterOwnership: firstLetter.length === (test.firstLetter ? 1 : 0)
      && (!test.firstLetter || exact(firstLetter[0]?.domUtf16Span, [0, 2])),
    everySourceHasOneSplitSegment: splitOwners.every((count) => count === 1),
    shapedRecordsRemainUtf16Aligned: shapedRuns.every((run) =>
      run.shapedOrigins.length === run.text.length && run.shapedAdvances.length === run.text.length
        && run.shapedOrigins.every(Number.isFinite) && run.shapedAdvances.every(Number.isFinite)),
    glyphRecordsRetainExactSourceOwnership: shapedRuns.every((run) => run.glyphs.length > 0
      && run.glyphs.every((glyph) => Number.isInteger(glyph.gid) && Number.isInteger(glyph.cluster)
        && glyph.domUtf16Span[0] >= run.domUtf16Span[0] && glyph.domUtf16Span[1] <= run.domUtf16Span[1]
        && [glyph.xAdvance, glyph.yAdvance, glyph.xOffset, glyph.yOffset].every(Number.isFinite))),
    fallbackFacesRemainDistinct: new Set(shapedRuns.flatMap((run) => run.selectedFontKeys).filter(Boolean)).size > 1,
    browserSelectedPinnedLigatureFace: independent.platformFonts.some((font) => {
      const family = `${font.familyName} ${font.postScriptName}`.toLowerCase().replace(/[^a-z0-9]/g, "");
      return font.isCustomFont && family.includes("opensans") && font.glyphCount > 0;
    }),
    browserSelectedFallbackFaces: independent.platformFonts.some((font) => !font.isCustomFont && font.glyphCount > 0),
    noTextFragmentFallbackWarning: captureResult.warnings.every((warning) => !/text-fragment|outer.*surface/i.test(warning.detail)),
  };
  const warnings = captureResult.warnings.map((warning) => warning.detail)
    .filter((warning) => /text-fragment|outer.*surface/i.test(warning));
  return {
    row: {
      id: test.id,
      text: test.text,
      writingMode: test.writingMode,
      independent,
      captured: {
        sourceFragments: geometry.sourceFragments,
        paintFragments: geometry.fragments,
        neutralSegments,
        shapedRuns,
        warnings,
      },
      controls,
      pass: Object.values(controls).every(Boolean),
    },
    mutations: mutationResults(geometry.sourceFragments[0].sourceTextNodeIndex, independent, neutralSegments),
  };
}

export async function runTextFragmentSpanOracle(): Promise<TextFragmentSpanReport> {
  const corpusErrors = validateTextFragmentSpanCorpus();
  if (corpusErrors.length > 0) throw new Error(`invalid text fragment span corpus: ${corpusErrors.join("; ")}`);
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const [capture, render, textPath, provenanceApi] = await Promise.all([
    import("../src/capture/index.js"),
    import("../src/render/element-tree-to-svg.js"),
    import("../src/render/text-to-path.js"),
    import("../src/render/text-run-provenance.js"),
  ]);
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const browser = await chromium.launch({ headless: true, args: ["--font-render-hinting=none"] });
  try {
    const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const fontBytes = embeddedVariableFontBytes();
      const fontBase64 = fontBytes.toString("base64");
      const rows: TextFragmentSpanRow[] = [];
      const mutationRows: TextFragmentSpanMutationResult[][] = [];
      for (const test of TEXT_FRAGMENT_SPAN_CASES) {
        const result = await runCase(page, test, fontBase64, fontBytes, capture, render, textPath, provenanceApi);
        rows.push(result.row);
        mutationRows.push(result.mutations);
      }
      const mutations = REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS.map((kind) => {
        const results = mutationRows.map((row) => row.find((result) => result.kind === kind));
        return {
          kind,
          rejected: results.every((result) => result?.rejected === true),
          failureReason: results.map((result) => result?.failureReason ?? "missing mutation result").join(" | "),
        };
      });
      const controls = {
        everyRequestedRowPresent: rows.length === TEXT_FRAGMENT_SPAN_CASES.length,
        everyLogicalRowPasses: rows.every((row) => row.pass),
        ligatureClusterPreserved: rows.some((row) => row.captured.shapedRuns.some((run) =>
          run.glyphs.some((glyph) => glyph.renderedUtf16Span[1] - glyph.renderedUtf16Span[0] > 1))),
        everyMutationRejected: mutations.length === REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS.length
          && mutations.every((mutation) => mutation.rejected),
        noPixelOrScreenshotLeg: true,
      };
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        sourcePins: TEXT_FRAGMENT_SPAN_SOURCE_PINS,
        fingerprint: {
          chromiumVersion: browser.version(),
          playwrightVersion,
          userAgent,
          os: platform(),
          osRelease: release(),
          architecture: arch(),
          node: process.version,
        },
        rows,
        mutations,
        controls,
        verdict: Object.values(controls).every(Boolean)
          ? "exact-fragment-span-agreement"
          : "fragment-span-gate-failure",
      };
    } finally {
      provenanceApi.setTextRunProvenanceEnabled(false);
      textPath.setRenderTextMode("embedded-font");
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runTextFragmentSpanOracle();
  const jsonIndex = process.argv.indexOf("--json");
  const path = resolve(jsonIndex >= 0 && process.argv[jsonIndex + 1] != null
    ? process.argv[jsonIndex + 1]
    : `tests/output/text-fragment-spans-${platform()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`text FragmentItem spans: ${report.rows.filter((row) => row.pass).length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id}: Range/CDP/source/paint=${row.independent.rangeFragments.length}/${row.independent.contentQuads.length}/${row.captured.sourceFragments.length}/${row.captured.paintFragments.length}`);
    for (const [name, pass] of Object.entries(row.controls)) if (!pass) console.log(`  FAIL control ${name}`);
  }
  for (const mutation of report.mutations) console.log(`${mutation.rejected ? "PASS" : "FAIL"} mutation ${mutation.kind}: ${mutation.failureReason}`);
  console.log(`report: ${path}`);
  return report.verdict === "exact-fragment-span-agreement" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
