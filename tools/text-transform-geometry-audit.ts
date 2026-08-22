#!/usr/bin/env tsx
/**
 * DM-2381 investigation probe.
 *
 * This is deliberately observational: it proves that Chromium exposes an
 * oriented quad per text fragment, records the transform-local font facts,
 * and classifies affine versus projective paint. It does not change routing.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { CapturedElement } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;
const VIEWPORT = { width: 720, height: 420 };
const AFFINE_EPSILON = 0.05;
const LABEL = "Affine glyph probe";

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
type Affine = [number, number, number, number, number, number];

interface AuditCase {
  id: string;
  targetCss?: string;
  outerCss?: string;
  targetAttrs?: string;
  text?: string;
  expected: "affine" | "projective";
}

interface CapturedFacts {
  fontLogicalSize: number | null;
  fontComputedSize: number | null;
  fontPaintSize: number | null;
  paintMetricScale: number | null;
  storedTransform: string | null;
  textSegmentCount: number;
  transformRaster: boolean;
}

interface AuditRow {
  id: string;
  expected: AuditCase["expected"];
  computed: { targetTransform: string; outerTransform: string; transformBox: string; transformOrigin: string; fontSize: string; zoom: string };
  liveQuads: Quad[];
  neutralQuads: Quad[];
  neutralToLive: Affine | null;
  affineResidual: number;
  signedDeterminant: number | null;
  classification: "affine" | "projective" | "unavailable";
  captured: CapturedFacts;
  pass: boolean;
}

const CASES: AuditCase[] = [
  { id: "identity-negative-control", expected: "affine" },
  { id: "translate-negative-control", targetCss: "transform:translate(17.5px,-8.25px);transform-origin:13% 82%", expected: "affine" },
  { id: "uniform-scale-negative-control", targetCss: "transform:scale(1.25);transform-origin:13% 82%", expected: "affine" },
  { id: "uniform-cos37-collision", targetCss: "transform:scale(.79863551);transform-origin:13% 82%", expected: "affine" },
  { id: "rotate-37-collision", targetCss: "transform:rotate(37deg);transform-origin:13% 82%", expected: "affine" },
  { id: "anisotropic-scale", targetCss: "transform:scale(1.6,.7);transform-origin:13% 82%", expected: "affine" },
  { id: "rotate-anisotropic-scale", targetCss: "transform:rotate(31deg) scale(1.6,.65);transform-origin:17px 82%", expected: "affine" },
  { id: "skew", targetCss: "transform:skew(22deg,-9deg);transform-origin:73% 18%", expected: "affine" },
  { id: "axis-reflection", targetCss: "transform:scaleX(-1);transform-origin:0 0", expected: "affine" },
  {
    id: "nested-asymmetric-origin",
    outerCss: "transform:rotate(23deg) scale(1.4,.75);transform-origin:11px 91%",
    targetCss: "transform:rotate(-11deg) scale(.9,1.2);transform-origin:73% 18%",
    expected: "affine",
  },
  {
    id: "border-box-reference",
    targetCss: "border:7px solid transparent;padding:11px 23px;transform-box:border-box;transform:rotate(19deg) scale(1.2,.8);transform-origin:100% 0",
    expected: "affine",
  },
  {
    id: "content-box-reference",
    targetCss: "border:7px solid transparent;padding:11px 23px;transform-box:content-box;transform:rotate(19deg) scale(1.2,.8);transform-origin:100% 0",
    expected: "affine",
  },
  { id: "wrapped-skew", targetCss: "transform:skewX(19deg);width:150px;white-space:normal", text: "Affine glyph probe wraps across three lines", expected: "affine" },
  { id: "zoom-negative-control", outerCss: "zoom:1.5", expected: "affine" },
  { id: "zoom-plus-rotation", outerCss: "zoom:1.5", targetCss: "transform:rotate(37deg);transform-origin:13% 82%", expected: "affine" },
  {
    id: "perspective-raster-boundary",
    outerCss: "perspective:320px;perspective-origin:17% 83%;transform-style:preserve-3d",
    targetCss: "transform:rotateY(42deg) translateZ(28px);transform-origin:19% 77%",
    expected: "projective",
  },
];

function parsePx(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asQuads(values: number[][]): Quad[] {
  return values.filter((value) => value.length === 8).map((value) => [
    { x: value[0], y: value[1] },
    { x: value[2], y: value[3] },
    { x: value[4], y: value[5] },
    { x: value[6], y: value[7] },
  ]);
}

function solveAffine(neutral: Quad, live: Quad): Affine | null {
  const nx1 = neutral[1].x - neutral[0].x;
  const ny1 = neutral[1].y - neutral[0].y;
  const nx2 = neutral[3].x - neutral[0].x;
  const ny2 = neutral[3].y - neutral[0].y;
  const det = nx1 * ny2 - nx2 * ny1;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const lx1 = live[1].x - live[0].x;
  const ly1 = live[1].y - live[0].y;
  const lx2 = live[3].x - live[0].x;
  const ly2 = live[3].y - live[0].y;
  const ia = ny2 / det;
  const ib = -ny1 / det;
  const ic = -nx2 / det;
  const id = nx1 / det;
  const a = lx1 * ia + lx2 * ib;
  const c = lx1 * ic + lx2 * id;
  const b = ly1 * ia + ly2 * ib;
  const d = ly1 * ic + ly2 * id;
  const e = live[0].x - a * neutral[0].x - c * neutral[0].y;
  const f = live[0].y - b * neutral[0].x - d * neutral[0].y;
  return [a, b, c, d, e, f];
}

function mapPoint(matrix: Affine, point: Point): Point {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  };
}

function residual(matrix: Affine, neutral: Quad[], live: Quad[]): number {
  if (neutral.length !== live.length) return Infinity;
  let max = 0;
  for (let q = 0; q < neutral.length; q++) {
    for (let p = 0; p < 4; p++) {
      const mapped = mapPoint(matrix, neutral[q][p]);
      max = Math.max(max, Math.abs(mapped.x - live[q][p].x), Math.abs(mapped.y - live[q][p].y));
    }
  }
  return max;
}

function walk(elements: CapturedElement[], visit: (element: CapturedElement) => void): void {
  for (const element of elements) {
    visit(element);
    walk(element.children, visit);
  }
}

function capturedFacts(tree: CapturedElement[], text: string): CapturedFacts {
  let textOwner: CapturedElement | null = null;
  let transformRaster = false;
  const needle = text.trim().split(/\s+/)[0] ?? "";
  walk(tree, (element) => {
    if (element.transformSubtreeRaster?.dataUri != null) transformRaster = true;
    const joined = element.textSegments?.map((segment) => segment.text).join("") ?? element.text ?? "";
    if (textOwner == null && needle !== "" && joined.includes(needle)) textOwner = element;
  });
  if (textOwner == null) {
    return {
      fontLogicalSize: null, fontComputedSize: null, fontPaintSize: null,
      paintMetricScale: null, storedTransform: null,
      textSegmentCount: 0, transformRaster,
    };
  }
  const owner: CapturedElement = textOwner;
  const fontLogicalSize = parsePx(owner.styles.fontLogicalSize ?? owner.styles.fontSize);
  const fontComputedSize = parsePx(owner.styles.fontComputedSize ?? owner.styles.fontSize);
  const fontPaintSize = parsePx(owner.styles.fontSize);
  return {
    fontLogicalSize,
    fontComputedSize,
    fontPaintSize,
    paintMetricScale: fontComputedSize != null && fontComputedSize !== 0 && fontPaintSize != null
      ? fontPaintSize / fontComputedSize
      : null,
    storedTransform: owner.styles.transform ?? null,
    textSegmentCount: owner.textSegments?.length ?? 0,
    transformRaster,
  };
}

function htmlFor(test: AuditCase): string {
  const text = test.text ?? LABEL;
  return `<!doctype html><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:white;overflow:hidden}
    #scene{position:relative;width:100%;height:100%}
    #outer{position:absolute;left:240px;top:145px;${test.outerCss ?? ""}}
    #target{display:inline-block;color:rgb(22,43,211);font:32px/40px Arial,sans-serif;letter-spacing:.5px;white-space:nowrap;${test.targetCss ?? ""}}
  </style><div id=scene><div id=outer data-neutral-owner data-perspective-owner><span id=target data-neutral-owner ${test.targetAttrs ?? ""}>${text}</span></div></div>`;
}

export async function runTextTransformGeometryAudit(): Promise<{
  sourceRevisions: typeof SOURCE_REVISIONS;
  chromiumVersion: string;
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  rows: AuditRow[];
  controls: { scalarCollision: boolean; wrappedFragmentQuads: boolean; reflectionWinding: boolean; referenceBoxMoved: boolean; zoomSeparatedFromTransformScale: boolean };
  verdict: string;
}> {
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const { captureElementTree } = await import("../src/capture/index.js");
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    const rows: AuditRow[] = [];
    for (const test of CASES) {
      const text = test.text ?? LABEL;
      await page.setContent(htmlFor(test), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#target" });
      const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: 1, pierce: true });
      const textNode = node.children?.find((child) => child.nodeType === 3);
      if (textNode == null) throw new Error(`${test.id}: target text node unavailable`);
      const liveResponse = await cdp.send("DOM.getContentQuads", { backendNodeId: textNode.backendNodeId });
      const liveQuads = asQuads(liveResponse.quads);
      const computed = await page.locator("#target").evaluate((target) => {
        const targetStyle = getComputedStyle(target);
        const outerStyle = getComputedStyle(document.querySelector("#outer")!);
        return {
          targetTransform: targetStyle.transform,
          outerTransform: outerStyle.transform,
          transformBox: targetStyle.transformBox,
          transformOrigin: targetStyle.transformOrigin,
          fontSize: targetStyle.fontSize,
          zoom: outerStyle.zoom,
        };
      });

      const neutralStyle = await page.addStyleTag({ content: `
        [data-neutral-owner]{transform:matrix(1,0,0,1,0,0)!important;translate:none!important;rotate:none!important;scale:none!important}
        [data-perspective-owner]{perspective:none!important;transform-style:flat!important}
      ` });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const neutralResponse = await cdp.send("DOM.getContentQuads", { backendNodeId: textNode.backendNodeId });
      const neutralQuads = asQuads(neutralResponse.quads);
      await neutralStyle.evaluate((style) => style.remove());
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

      const matrix = liveQuads.length > 0 && neutralQuads.length > 0
        ? solveAffine(neutralQuads[0], liveQuads[0])
        : null;
      const affineResidual = matrix == null ? Infinity : residual(matrix, neutralQuads, liveQuads);
      const classification = matrix == null
        ? "unavailable"
        : affineResidual <= AFFINE_EPSILON ? "affine" : "projective";
      const tree = await captureElementTree(page, "#scene", { x: 0, y: 0, ...VIEWPORT });
      const captured = capturedFacts(tree, text);
      const signedDeterminant = matrix == null ? null : matrix[0] * matrix[3] - matrix[1] * matrix[2];
      rows.push({
        id: test.id,
        expected: test.expected,
        computed,
        liveQuads,
        neutralQuads,
        neutralToLive: matrix,
        affineResidual,
        signedDeterminant,
        classification,
        captured,
        pass: classification === test.expected
          && (test.expected === "projective" ? captured.transformRaster : !captured.transformRaster),
      });
    }
    await cdp.detach();

    const byId = new Map(rows.map((row) => [row.id, row]));
    const rotate = byId.get("rotate-37-collision")!;
    const scaled = byId.get("uniform-cos37-collision")!;
    const matrixDistance = rotate.neutralToLive == null || scaled.neutralToLive == null
      ? 0
      : Math.max(...rotate.neutralToLive.map((value, index) => Math.abs(value - scaled.neutralToLive![index])));
    const scalarDelta = rotate.captured.paintMetricScale == null || scaled.captured.paintMetricScale == null
      ? Infinity
      : Math.abs(rotate.captured.paintMetricScale - scaled.captured.paintMetricScale);
    const borderBoxMatrix = byId.get("border-box-reference")?.neutralToLive;
    const contentBoxMatrix = byId.get("content-box-reference")?.neutralToLive;
    const referenceBoxTranslationDelta = borderBoxMatrix == null || contentBoxMatrix == null
      ? 0
      : Math.max(Math.abs(borderBoxMatrix[4] - contentBoxMatrix[4]), Math.abs(borderBoxMatrix[5] - contentBoxMatrix[5]));
    const zoom = byId.get("zoom-negative-control")!;
    const controls = {
      scalarCollision: scalarDelta <= 0.0002 && matrixDistance > 0.2,
      wrappedFragmentQuads: (byId.get("wrapped-skew")?.liveQuads.length ?? 0) >= 2,
      reflectionWinding: (byId.get("axis-reflection")?.signedDeterminant ?? 0) < 0,
      referenceBoxMoved: referenceBoxTranslationDelta > 1,
      zoomSeparatedFromTransformScale: Math.abs((zoom.captured.paintMetricScale ?? Infinity) - 1) <= 0.0002,
    };
    const pass = rows.every((row) => row.pass) && Object.values(controls).every(Boolean);
    return {
      sourceRevisions: SOURCE_REVISIONS,
      chromiumVersion: browser.version(),
      playwrightVersion,
      platform: process.platform,
      architecture: process.arch,
      rows,
      controls,
      verdict: pass ? "scalar-model-disproven-and-exact-boundary-observed" : "probe-or-source-drift",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runTextTransformGeometryAudit();
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  const failures = report.rows.filter((row) => !row.pass);
  console.log(`text transform geometry audit: ${report.rows.length - failures.length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    const scale = row.captured.paintMetricScale == null ? "n/a" : row.captured.paintMetricScale.toFixed(6);
    const residualText = Number.isFinite(row.affineResidual) ? row.affineResidual.toFixed(4) : "inf";
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id}: ${row.classification}, residual=${residualText}, captured-metric-scale=${scale}, quads=${row.liveQuads.length}, raster=${row.captured.transformRaster}`);
  }
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  return failures.length === 0 && Object.values(report.controls).every(Boolean) ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
