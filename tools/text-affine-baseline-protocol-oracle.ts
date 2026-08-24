#!/usr/bin/env tsx
/**
 * Strict logical oracle for Blink's affine text line-origin protocol.
 *
 * This is deliberately a logical gate. It joins same-frame Range rects,
 * DevTools text-node quads, a zero-area inline baseline witness, Domotion's
 * captured fragment record, and the generated SVG text CTM. It does not read
 * pixels and it does not authorize a production fallback or visual envelope.
 */

import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import { chromium, type CDPSession, type Page } from "playwright";

import type {
  CapturedElement,
  CapturedTextPaintAffine,
  CapturedTextPaintFragment,
  CapturedTextPaintQuad,
  TextSegment,
} from "../src/capture/types.js";
import type { CapturedTextWritingMode } from "../src/capture/text-line-origin.js";

export const TEXT_BASELINE_PROTOCOL_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzzPinnedByChromium: "511df88b82e697cd2a0f1f0635787aa0b18bddbb",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

/** Blink LayoutUnit/DevTools coordinates are discriminated at 1/64 CSS px. */
export const TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX = 1 / 64;
/** SVG coordinates are serialized to hundredths before the browser rebuilds a CTM. */
export const TEXT_BASELINE_EMITTED_SERIALIZATION_EPSILON_CSS_PX = 1 / 32;

type ExpectedDisposition =
  | "decoded-vector"
  | "decoded-fragments";

export interface TextBaselineProtocolCase {
  id: string;
  text: string;
  expectedDisposition: ExpectedDisposition;
  outerCss?: string;
  targetCss: string;
}

export const TEXT_BASELINE_PROTOCOL_CASES: readonly TextBaselineProtocolCase[] = [
  {
    id: "fractional-horizontal",
    text: "Fractional baseline",
    expectedDisposition: "decoded-vector",
    targetCss: "transform:matrix(.91,.27,-.19,1.07,11.25,-7.5);transform-origin:17.25px 23.75px",
  },
  {
    id: "nested-zoom-horizontal",
    text: "Nested zoom baseline",
    expectedDisposition: "decoded-vector",
    outerCss: "zoom:1.25;transform:rotate(17deg) scale(1.08,.83);transform-origin:11.25px 79%",
    targetCss: "transform:matrix(.93,-.21,.17,1.04,6.25,-3.5);transform-origin:73% 18%",
  },
  {
    id: "mixed-script-fragments",
    text: "Latin العربية 漢字",
    expectedDisposition: "decoded-fragments",
    targetCss: "transform:matrix(.91,.27,-.19,1.07,11.25,-7.5);transform-origin:17.25px 23.75px",
  },
  {
    id: "vertical-rl-plane",
    text: "縦書漢字",
    expectedDisposition: "decoded-vector",
    targetCss: "writing-mode:vertical-rl;height:240px;transform:matrix(.91,.27,-.19,1.07,11.25,-7.5);transform-origin:17.25px 23.75px",
  },
  {
    id: "vertical-lr-plane",
    text: "縦書左組",
    expectedDisposition: "decoded-vector",
    targetCss: "writing-mode:vertical-lr;height:240px;transform:matrix(.91,.27,-.19,1.07,11.25,-7.5);transform-origin:17.25px 23.75px",
  },
  {
    id: "sideways-rl-plane",
    text: "Sideways RL",
    expectedDisposition: "decoded-vector",
    targetCss: "writing-mode:sideways-rl;height:240px;transform:matrix(.91,.27,-.19,1.07,11.25,-7.5);transform-origin:17.25px 23.75px",
  },
  {
    id: "sideways-lr-plane",
    text: "Sideways LR",
    expectedDisposition: "decoded-vector",
    targetCss: "writing-mode:sideways-lr;height:240px;transform:matrix(.91,.27,-.19,1.07,11.25,-7.5);transform-origin:17.25px 23.75px",
  },
] as const;

export type TextBaselineMutationKind =
  | "post-transform-aabb-plus-ascent"
  | "ascent-after-affine"
  | "snap-after-affine"
  | "double-apply-zoom"
  | "drop-transform-origin-translation"
  | "collapse-mixed-fragments"
  | "vertical-horizontal-plane"
  | "drop-fragment-relative-top";

export const REQUIRED_TEXT_BASELINE_MUTATIONS: readonly TextBaselineMutationKind[] = [
  "post-transform-aabb-plus-ascent",
  "ascent-after-affine",
  "snap-after-affine",
  "double-apply-zoom",
  "drop-transform-origin-translation",
  "collapse-mixed-fragments",
  "vertical-horizontal-plane",
  "drop-fragment-relative-top",
] as const;

interface Point { x: number; y: number }
interface Rect { x: number; y: number; width: number; height: number }

interface BrowserTextState {
  rangeBounds: Rect;
  rangeClientRects: Rect[];
  codeUnitRects: Rect[][];
  baselineWitness: Point;
  computed: {
    writingMode: string;
    direction: string;
    transform: string;
    transformOrigin: string;
    font: string;
    effectiveZoom: number;
  };
  canvasFontBoundingBoxAscent: number;
  canvasFontBoundingBoxDescent: number;
  quads: CapturedTextPaintQuad[];
}

interface CapturedTextState {
  segmentCount: number;
  segments: Array<Pick<TextSegment, "text" | "x" | "y" | "width" | "height" | "fontAscent">>;
  fragments: CapturedTextPaintFragment[];
  rasterOwnerCount: number;
  relevantWarnings: string[];
}

interface EmittedTextState {
  textCount: number;
  imageCount: number;
  localBaselines: number[];
  transformAttributes: string[];
  firstBaselineStart: Point | null;
  finalBaselineEnd: Point | null;
}

export interface TextBaselineProtocolRow {
  id: string;
  expectedDisposition: ExpectedDisposition;
  live: BrowserTextState;
  neutral: BrowserTextState;
  restored: BrowserTextState;
  independentMatrix: CapturedTextPaintAffine | null;
  captured: CapturedTextState;
  emitted: EmittedTextState;
  logical: {
    sourceAscent: number;
    neutralBaselinePoint: Point | null;
    liveBaselinePoint: Point | null;
    capturedPaintBaselinePoint: Point | null;
    independentLineRelativeOrigin: Point | null;
    independentPhysicalBaselinePoint: Point | null;
    capturedPhysicalBaselinePoint: Point | null;
    rangeFragmentSourceSpans: Array<{ fragmentIndex: number; sourceOffsets: number[] }>;
    maxRestorationDeltaCssPx: number;
    maxCapturedMatrixDelta: number;
    maxLiveCaptureBaselineDeltaCssPx: number;
    maxLiveEmittedBaselineDeltaCssPx: number;
  };
  controls: Record<string, boolean>;
  pass: boolean;
}

export interface TextBaselineMutationResult {
  kind: TextBaselineMutationKind;
  baseline: number;
  mutated: number;
  moved: boolean;
}

export interface TextBaselineProtocolReport {
  schemaVersion: 2;
  generatedAt: string;
  sourcePins: typeof TEXT_BASELINE_PROTOCOL_SOURCE_PINS;
  fingerprint: {
    chromiumVersion: string;
    playwrightVersion: string;
    userAgent: string;
    os: NodeJS.Platform;
    osRelease: string;
    architecture: string;
    node: string;
  };
  rows: TextBaselineProtocolRow[];
  mutations: TextBaselineMutationResult[];
  controls: Record<string, boolean>;
  verdict: "source-exact-line-origin" | "line-origin-gate-failure";
}

export function validateTextBaselineProtocolCorpus(): string[] {
  const errors: string[] = [];
  const ids = TEXT_BASELINE_PROTOCOL_CASES.map((row) => row.id);
  if (new Set(ids).size !== ids.length) errors.push("case ids must be unique");
  if (!TEXT_BASELINE_PROTOCOL_CASES.some((row) => row.id === "fractional-horizontal")) errors.push("fractional horizontal row is required");
  if (!TEXT_BASELINE_PROTOCOL_CASES.some((row) => row.id === "nested-zoom-horizontal")) errors.push("nested zoom row is required");
  if (!TEXT_BASELINE_PROTOCOL_CASES.some((row) => row.expectedDisposition === "decoded-fragments")) errors.push("decoded mixed-fragment row is required");
  for (const mode of ["vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr"]) {
    if (!TEXT_BASELINE_PROTOCOL_CASES.some((row) => row.targetCss.includes(`writing-mode:${mode}`))) errors.push(`${mode} row is required`);
  }
  if (new Set(REQUIRED_TEXT_BASELINE_MUTATIONS).size !== REQUIRED_TEXT_BASELINE_MUTATIONS.length) errors.push("mutation ids must be unique");
  return errors;
}

function fixtureHtml(test: TextBaselineProtocolCase): string {
  return `<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}
    #scene{position:relative;width:900px;height:520px}
    #outer{position:absolute;left:100.25px;top:80.375px;${test.outerCss ?? ""}}
    #target{display:inline-block;color:#152030;font:24px/30px Arial,sans-serif;white-space:nowrap;${test.targetCss}}
    .baseline-probe{display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;overflow:visible}
  </style><div id="scene"><div id="outer" data-affine-owner><span id="target" data-affine-owner>${test.text}<span class="baseline-probe" aria-hidden="true"></span></span></div></div>`;
}

function walk(nodes: readonly CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function ownerFor(tree: readonly CapturedElement[], text: string): CapturedElement | null {
  return walk(tree).find((node) => node.textSegments?.some((segment) => segment.text.includes(text)) === true)
    ?? walk(tree).find((node) => node.text.includes(text))
    ?? null;
}

function pointDistance(left: Point | null, right: Point | null): number {
  if (left == null || right == null) return Number.POSITIVE_INFINITY;
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function capturedWritingMode(value: string): CapturedTextWritingMode | null {
  return value === "horizontal-tb" || value === "vertical-rl" || value === "vertical-lr"
    || value === "sideways-rl" || value === "sideways-lr" ? value : null;
}

function maxNumericDelta(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  return left.reduce((max, value, index) => Math.max(max, Math.abs(value - right[index])), 0);
}

function maxQuadSetDelta(left: readonly CapturedTextPaintQuad[], right: readonly CapturedTextPaintQuad[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  return left.reduce((max, quad, index) => Math.max(max, maxNumericDelta(quad, right[index])), 0);
}

export function mapTextBaselinePoint(matrix: CapturedTextPaintAffine, point: Point): Point {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  };
}

export function solveTextBaselineAffine(
  neutral: CapturedTextPaintQuad,
  live: CapturedTextPaintQuad,
): CapturedTextPaintAffine | null {
  const nx1 = neutral[2] - neutral[0];
  const ny1 = neutral[3] - neutral[1];
  const nx2 = neutral[6] - neutral[0];
  const ny2 = neutral[7] - neutral[1];
  const determinant = nx1 * ny2 - nx2 * ny1;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
  const px1 = live[2] - live[0];
  const py1 = live[3] - live[1];
  const px2 = live[6] - live[0];
  const py2 = live[7] - live[1];
  const ia = ny2 / determinant;
  const ib = -ny1 / determinant;
  const ic = -nx2 / determinant;
  const id = nx1 / determinant;
  const a = px1 * ia + px2 * ib;
  const c = px1 * ic + px2 * id;
  const b = py1 * ia + py2 * ib;
  const d = py1 * ic + py2 * id;
  return [a, b, c, d, live[0] - a * neutral[0] - c * neutral[1], live[1] - b * neutral[0] - d * neutral[1]];
}

/** Independent transcription of Blink's line-relative origin and writing map. */
export function decodeBlinkTextLineOrigin(
  neutralQuad: CapturedTextPaintQuad,
  ascent: number,
  writingMode: CapturedTextWritingMode,
): { lineRelative: Point; rotation: CapturedTextPaintAffine; physical: Point } {
  const left = neutralQuad[0];
  const top = neutralQuad[1];
  const width = neutralQuad[2] - neutralQuad[0];
  const height = neutralQuad[7] - neutralQuad[1];
  const lineRelative = { x: left, y: top + ascent };
  const rotation: CapturedTextPaintAffine = writingMode === "horizontal-tb"
    ? [1, 0, 0, 1, 0, 0]
    : writingMode === "sideways-lr"
      ? [0, -1, 1, 0, left - top, left + top + height]
      : [0, 1, -1, 0, left + top + width, top - left];
  return { lineRelative, rotation, physical: mapTextBaselinePoint(rotation, lineRelative) };
}

/** Backward-compatible unit-test name for the investigation's original row. */
export function decodeVerticalRlBaseline(
  neutralQuad: CapturedTextPaintQuad,
  ascent: number,
): { lineRelative: Point; physical: Point } {
  const decoded = decodeBlinkTextLineOrigin(neutralQuad, ascent, "vertical-rl");
  return { lineRelative: decoded.lineRelative, physical: decoded.physical };
}

function rectForQuad(quad: CapturedTextPaintQuad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function rectDelta(left: Rect, right: Rect): number {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.x + left.width - right.x - right.width),
    Math.abs(left.y + left.height - right.y - right.height),
  );
}

function sourceSpans(state: BrowserTextState): Array<{ fragmentIndex: number; sourceOffsets: number[] }> {
  return state.rangeClientRects.map((fragmentRect, fragmentIndex) => ({
    fragmentIndex,
    sourceOffsets: state.codeUnitRects.flatMap((rects, sourceOffset) =>
      rects.some((rect) => rectDelta(rect, fragmentRect) <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX
        || (rect.x + rect.width / 2 >= fragmentRect.x - TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX
          && rect.x + rect.width / 2 <= fragmentRect.x + fragmentRect.width + TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX
          && rect.y + rect.height / 2 >= fragmentRect.y - TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX
          && rect.y + rect.height / 2 <= fragmentRect.y + fragmentRect.height + TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX))
        ? [sourceOffset] : []),
  }));
}

async function animationFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
}

async function browserState(page: Page, session: CDPSession): Promise<BrowserTextState> {
  const dom = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>("#target")!;
    const text = target.firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rangeBounds = range.getBoundingClientRect();
    const rangeClientRects: Rect[] = [];
    for (const rect of range.getClientRects()) {
      rangeClientRects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    const codeUnitRects: Rect[][] = [];
    for (let index = 0; index < text.length; index++) {
      const unit = document.createRange();
      unit.setStart(text, index);
      unit.setEnd(text, index + 1);
      const rects: Rect[] = [];
      for (const rect of unit.getClientRects()) rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      codeUnitRects.push(rects);
    }
    const markerRect = target.querySelector<HTMLElement>(".baseline-probe")!.getBoundingClientRect();
    const style = getComputedStyle(target);
    let effectiveZoom = 1;
    for (let owner: HTMLElement | null = target; owner != null; owner = owner.parentElement) {
      const zoom = Number.parseFloat(getComputedStyle(owner).zoom);
      if (Number.isFinite(zoom) && zoom > 0) effectiveZoom *= zoom;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = context.measureText("Mxgp");
    return {
      rangeBounds: { x: rangeBounds.x, y: rangeBounds.y, width: rangeBounds.width, height: rangeBounds.height },
      rangeClientRects,
      codeUnitRects,
      baselineWitness: { x: markerRect.x, y: markerRect.y },
      computed: {
        writingMode: style.writingMode,
        direction: style.direction,
        transform: style.transform,
        transformOrigin: style.transformOrigin,
        font: style.font,
        effectiveZoom,
      },
      canvasFontBoundingBoxAscent: metrics.fontBoundingBoxAscent,
      canvasFontBoundingBoxDescent: metrics.fontBoundingBoxDescent,
    };
  });
  const evaluated = await session.send("Runtime.evaluate", {
    expression: "document.querySelector('#target').firstChild",
    returnByValue: false,
  });
  const objectId = evaluated.result.objectId;
  if (objectId == null) throw new Error("CDP text-node object is unavailable");
  try {
    const described = await session.send("DOM.describeNode", { objectId });
    const measured = await session.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
    return { ...dom, quads: measured.quads.map((quad) => quad as CapturedTextPaintQuad) };
  } finally {
    await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function emittedState(page: Page, svg: string): Promise<EmittedTextState> {
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block}</style>${svg}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const texts = Array.from(document.querySelectorAll<SVGTextElement>("svg text"));
    const first = texts[0] ?? null;
    const last = texts.at(-1) ?? null;
    let firstBaselineStart: Point | null = null;
    if (first != null && (first.textContent?.length ?? 0) > 0) {
      const matrix = first.getScreenCTM();
      if (matrix != null) {
        const local = first.getStartPositionOfChar(0);
        const mapped = new DOMPoint(local.x, local.y).matrixTransform(matrix);
        firstBaselineStart = { x: mapped.x, y: mapped.y };
      }
    }
    let finalBaselineEnd: Point | null = null;
    if (last != null && (last.textContent?.length ?? 0) > 0) {
      const matrix = last.getScreenCTM();
      if (matrix != null) {
        const local = last.getEndPositionOfChar((last.textContent?.length ?? 1) - 1);
        const mapped = new DOMPoint(local.x, local.y).matrixTransform(matrix);
        finalBaselineEnd = { x: mapped.x, y: mapped.y };
      }
    }
    const localBaselines: number[] = [];
    for (const text of texts) localBaselines.push(Number.parseFloat(text.getAttribute("y") ?? "NaN"));
    const transformAttributes: string[] = [];
    for (const node of document.querySelectorAll<SVGGraphicsElement>("svg [transform]")) transformAttributes.push(node.getAttribute("transform") ?? "");
    return {
      textCount: texts.length,
      imageCount: document.querySelectorAll("svg image").length,
      localBaselines,
      transformAttributes,
      firstBaselineStart,
      finalBaselineEnd,
    };
  });
}

function capturedState(tree: readonly CapturedElement[], text: string, warnings: readonly unknown[]): CapturedTextState {
  const owner = ownerFor(tree, text);
  return {
    segmentCount: owner?.textSegments?.length ?? 0,
    segments: (owner?.textSegments ?? []).map((segment) => ({
      text: segment.text,
      x: segment.x,
      y: segment.y,
      width: segment.width,
      height: segment.height,
      fontAscent: segment.fontAscent,
    })),
    fragments: owner?.textPaintGeometry?.fragments ?? [],
    rasterOwnerCount: walk(tree).filter((node) => node.transformSubtreeRaster?.dataUri != null).length,
    relevantWarnings: warnings.map((warning) => typeof warning === "string" ? warning : JSON.stringify(warning))
      .filter((warning) => /text-fragment|outer raster|outer.*surface/i.test(warning)),
  };
}

async function runCase(
  source: Page,
  output: Page,
  test: TextBaselineProtocolCase,
  capture: typeof import("../src/capture/index.js"),
  render: typeof import("../src/render/element-tree-to-svg.js"),
): Promise<TextBaselineProtocolRow> {
  await source.setContent(fixtureHtml(test), { waitUntil: "load" });
  await source.evaluate(() => document.fonts.ready);
  const session = await source.context().newCDPSession(source);
  let neutralStyle: Awaited<ReturnType<Page["addStyleTag"]>> | undefined;
  try {
    await Promise.all([session.send("DOM.enable"), session.send("Runtime.enable")]);
    const live = await browserState(source, session);
    neutralStyle = await source.addStyleTag({ content: "[data-affine-owner]{transform:none!important;translate:none!important;rotate:none!important;scale:none!important}" });
    await animationFrame(source);
    const neutral = await browserState(source, session);
    await neutralStyle.evaluate((style) => style.remove());
    neutralStyle = undefined;
    await animationFrame(source);
    const restored = await browserState(source, session);

    const captureResult = await capture.captureElementTreeWithWarnings(source, "#scene", { x: 0, y: 0, width: 900, height: 520 });
    const captured = capturedState(captureResult.tree, test.text, captureResult.warnings);
    const svg = render.elementTreeToSvg(captureResult.tree, 900, 520);
    const emitted = await emittedState(output, svg);
    const independentMatrix = neutral.quads[0] == null || live.quads[0] == null
      ? null : solveTextBaselineAffine(neutral.quads[0], live.quads[0]);
    const firstFragment = captured.fragments[0];
    const sourceAscent = firstFragment?.lineOrigin.primaryFontIntegerAscent
      ?? captured.segments[0]?.fontAscent
      ?? neutral.canvasFontBoundingBoxAscent * neutral.computed.effectiveZoom;
    const writingMode = capturedWritingMode(neutral.computed.writingMode);
    const decoded = writingMode != null && neutral.quads[0] != null
      ? decodeBlinkTextLineOrigin(neutral.quads[0], sourceAscent, writingMode)
      : null;
    const neutralBaselinePoint = decoded?.physical ?? null;
    const liveBaselinePoint = decoded != null && independentMatrix != null
      ? mapTextBaselinePoint(independentMatrix, decoded.physical) : null;
    const capturedPhysicalBaselinePoint = firstFragment?.lineOrigin.physicalBaselinePoint ?? null;
    const capturedPaintBaselinePoint = firstFragment != null && capturedPhysicalBaselinePoint != null
      ? mapTextBaselinePoint(firstFragment.paintMatrix, capturedPhysicalBaselinePoint)
      : null;
    const maxCapturedMatrixDelta = firstFragment == null || independentMatrix == null
      ? Number.POSITIVE_INFINITY : maxNumericDelta(firstFragment.paintMatrix, independentMatrix);
    const maxLiveCaptureBaselineDeltaCssPx = pointDistance(liveBaselinePoint, capturedPaintBaselinePoint);
    const maxLiveEmittedBaselineDeltaCssPx = writingMode === "horizontal-tb"
      ? pointDistance(liveBaselinePoint, emitted.firstBaselineStart)
      : 0;
    const logical = {
      sourceAscent,
      neutralBaselinePoint,
      liveBaselinePoint,
      capturedPaintBaselinePoint,
      independentLineRelativeOrigin: decoded?.lineRelative ?? null,
      independentPhysicalBaselinePoint: decoded?.physical ?? null,
      capturedPhysicalBaselinePoint,
      rangeFragmentSourceSpans: sourceSpans(neutral),
      maxRestorationDeltaCssPx: maxQuadSetDelta(live.quads, restored.quads),
      maxCapturedMatrixDelta,
      maxLiveCaptureBaselineDeltaCssPx,
      maxLiveEmittedBaselineDeltaCssPx,
    };
    const sharedControls = {
      liveAndRestoredQuadsMatch: logical.maxRestorationDeltaCssPx <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
      rangeAndCdpFragmentCountsMatch: neutral.rangeClientRects.length === neutral.quads.length,
      everyRangeFragmentHasSourceOffsets: logical.rangeFragmentSourceSpans.every((fragment) => fragment.sourceOffsets.length > 0),
    };
    let dispositionControls: Record<string, boolean>;
    if (test.expectedDisposition === "decoded-vector" || test.expectedDisposition === "decoded-fragments") {
      const record = firstFragment?.lineOrigin;
      const recordTop = record == null ? Infinity
        : record.roundedContainingPaintOffsetTop + record.fragmentRelativeTop;
      dispositionControls = {
        expectedSourceFragmentCardinality: test.expectedDisposition === "decoded-vector"
          ? neutral.quads.length === 1 : neutral.quads.length > 1,
        capturedEveryVectorFragment: captured.fragments.length === neutral.quads.length && captured.rasterOwnerCount === 0,
        capturedMatrixMatchesIndependent: logical.maxCapturedMatrixDelta <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        structuredRecordPresent: record?.source === "blink-text-fragment-line-origin-v1",
        structuredTopMatchesNeutralFragment: Math.abs(recordTop - neutral.quads[0][1]) <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        integerPrimaryAscentMatchesBrowser: record?.primaryFontIntegerAscent === Math.round(sourceAscent),
        lineRelativeOriginMatchesIndependent: pointDistance(
          record == null ? null : { x: record.lineRelativeTextOrigin.lineLeft, y: record.lineRelativeTextOrigin.lineOver },
          decoded?.lineRelative ?? null,
        ) <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        writingRotationMatchesIndependent: record != null && decoded != null
          && maxNumericDelta(record.writingModeRotation, decoded.rotation) <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        physicalBaselineMatchesIndependent: pointDistance(record?.physicalBaselinePoint ?? null, decoded?.physical ?? null)
          <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        zoomRetainedOnlyInNeutralRecord: Math.abs((record?.effectiveZoom ?? Infinity) - neutral.computed.effectiveZoom)
          <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        pinnedProvenancePresent: record?.provenance.chromiumRevision === TEXT_BASELINE_PROTOCOL_SOURCE_PINS.chromium,
        matrixMapsBaselineBeforeTransform: pointDistance(liveBaselinePoint, capturedPaintBaselinePoint)
          <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        capturedBaselineMapsToLive: logical.maxLiveCaptureBaselineDeltaCssPx <= TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX,
        emittedBaselineMapsToLive: writingMode !== "horizontal-tb"
          || logical.maxLiveEmittedBaselineDeltaCssPx <= TEXT_BASELINE_EMITTED_SERIALIZATION_EPSILON_CSS_PX,
        noRelevantWarnings: captured.relevantWarnings.length === 0,
      };
    }
    const controls = { ...sharedControls, ...dispositionControls };
    return { id: test.id, expectedDisposition: test.expectedDisposition, live, neutral, restored, independentMatrix, captured, emitted, logical, controls, pass: Object.values(controls).every(Boolean) };
  } finally {
    if (neutralStyle != null) await neutralStyle.evaluate((style) => style.remove()).catch(() => undefined);
    await session.detach();
  }
}

function mutationResult(kind: TextBaselineMutationKind, baseline: number, mutated: number, minimum: number): TextBaselineMutationResult {
  return { kind, baseline, mutated, moved: Number.isFinite(baseline) && Number.isFinite(mutated) && mutated - baseline > minimum };
}

export function evaluateTextBaselineMutations(rows: readonly TextBaselineProtocolRow[]): TextBaselineMutationResult[] {
  const fractional = rows.find((row) => row.id === "fractional-horizontal");
  const zoom = rows.find((row) => row.id === "nested-zoom-horizontal");
  const mixed = rows.find((row) => row.id === "mixed-script-fragments");
  const vertical = rows.find((row) => row.id === "vertical-rl-plane");
  const matrix = fractional?.independentMatrix ?? null;
  const neutral = fractional?.neutral;
  const live = fractional?.live;
  const correct = fractional?.logical.liveBaselinePoint ?? null;
  const ascent = fractional?.logical.sourceAscent ?? Infinity;
  const postTransform = live == null ? null : { x: live.rangeBounds.x, y: live.rangeBounds.y + ascent };
  const addAscentAfter = matrix == null || neutral == null ? null : (() => {
    const top = mapTextBaselinePoint(matrix, { x: neutral.rangeBounds.x, y: neutral.rangeBounds.y });
    return { x: top.x, y: top.y + ascent };
  })();
  const snapped = correct == null ? null : { x: Math.round(correct.x), y: Math.round(correct.y) };
  const originless = matrix == null || neutral == null ? null
    : mapTextBaselinePoint([matrix[0], matrix[1], matrix[2], matrix[3], 0, 0], {
      x: neutral.rangeBounds.x,
      y: neutral.rangeBounds.y + ascent,
    });

  const zoomMatrix = zoom?.independentMatrix ?? null;
  const zoomNeutral = zoom?.neutral;
  const zoomCorrect = zoom?.logical.liveBaselinePoint ?? null;
  const zoomAscent = zoom?.logical.sourceAscent ?? Infinity;
  const doubleZoom = zoomMatrix == null || zoomNeutral == null ? null : mapTextBaselinePoint(zoomMatrix, {
    x: zoomNeutral.rangeBounds.x,
    y: zoomNeutral.rangeBounds.y + zoomAscent * zoomNeutral.computed.effectiveZoom,
  });

  const verticalRecord = vertical?.captured.fragments[0]?.lineOrigin;
  const wrongVerticalPlane = verticalRecord == null ? Infinity : pointDistance(
    verticalRecord.physicalBaselinePoint,
    {
      x: verticalRecord.lineRelativeTextOrigin.lineLeft,
      y: verticalRecord.lineRelativeTextOrigin.lineOver,
    },
  );
  const fragmentTopDelta = Math.abs(verticalRecord?.fragmentRelativeTop ?? Infinity);
  return [
    mutationResult("post-transform-aabb-plus-ascent", 0, pointDistance(correct, postTransform), 1),
    mutationResult("ascent-after-affine", 0, pointDistance(correct, addAscentAfter), 1),
    mutationResult("snap-after-affine", 0, pointDistance(correct, snapped), TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX),
    mutationResult("double-apply-zoom", 0, pointDistance(zoomCorrect, doubleZoom), 1),
    mutationResult("drop-transform-origin-translation", 0, pointDistance(correct, originless), 1),
    mutationResult("collapse-mixed-fragments", mixed?.neutral.quads.length ?? Infinity, 1, 0),
    mutationResult("vertical-horizontal-plane", 0, wrongVerticalPlane, 1),
    mutationResult("drop-fragment-relative-top", 0, fragmentTopDelta, TEXT_BASELINE_LOGICAL_EPSILON_CSS_PX),
  ].map((mutation) => mutation.kind === "collapse-mixed-fragments"
    ? { ...mutation, moved: Number.isFinite(mutation.baseline) && Number.isFinite(mutation.mutated) && mutation.baseline > mutation.mutated && mutation.baseline > 1 }
    : mutation);
}

export async function runTextAffineBaselineProtocolOracle(): Promise<TextBaselineProtocolReport> {
  const corpusErrors = validateTextBaselineProtocolCorpus();
  if (corpusErrors.length > 0) throw new Error(`invalid text baseline protocol corpus: ${corpusErrors.join("; ")}`);
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const capture = await import("../src/capture/index.js");
  const render = await import("../src/render/element-tree-to-svg.js");
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
    try {
      const source = await context.newPage();
      const output = await context.newPage();
      const userAgent = await source.evaluate(() => navigator.userAgent);
      const rows: TextBaselineProtocolRow[] = [];
      for (const test of TEXT_BASELINE_PROTOCOL_CASES) rows.push(await runCase(source, output, test, capture, render));
      const mutations = evaluateTextBaselineMutations(rows);
      const controls = {
        everyRequestedRowPresent: rows.length === TEXT_BASELINE_PROTOCOL_CASES.length,
        everyRowDiscriminatorActive: rows.every((row) => row.pass),
        everyWrongPlaneMutationMoves: mutations.length === REQUIRED_TEXT_BASELINE_MUTATIONS.length && mutations.every((mutation) => mutation.moved),
        noPixelOrScreenshotLeg: true,
      };
      const pass = Object.values(controls).every(Boolean);
      return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        sourcePins: TEXT_BASELINE_PROTOCOL_SOURCE_PINS,
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
        verdict: pass ? "source-exact-line-origin" : "line-origin-gate-failure",
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runTextAffineBaselineProtocolOracle();
  const jsonIndex = process.argv.indexOf("--json");
  const path = resolve(jsonIndex >= 0 && process.argv[jsonIndex + 1] != null
    ? process.argv[jsonIndex + 1]
    : `tests/output/text-affine-baseline-protocol-${platform()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`text affine baseline protocol: ${report.rows.filter((row) => row.pass).length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id}: disposition=${row.expectedDisposition}, range/cdp/capture=${row.neutral.rangeClientRects.length}/${row.neutral.quads.length}/${row.captured.fragments.length}, raster=${row.captured.rasterOwnerCount}`);
    for (const [name, pass] of Object.entries(row.controls)) if (!pass) console.log(`  FAIL control ${name}`);
  }
  for (const mutation of report.mutations) console.log(`${mutation.moved ? "PASS" : "FAIL"} mutation ${mutation.kind}: baseline=${mutation.baseline}, mutated=${mutation.mutated}`);
  console.log(`report: ${path}`);
  return report.verdict === "source-exact-line-origin" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
