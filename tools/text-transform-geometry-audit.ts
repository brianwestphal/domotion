#!/usr/bin/env tsx
/**
 * Hard two-leg transformed-text gate. Leg 1 compares independently sampled
 * Chromium live/neutral/restored text quads with the production capture.
 * Leg 2 compares Chromium and generated-SVG ink with fixed device tolerances.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { chromium, type CDPSession, type ElementHandle, type Page } from "playwright";
import sharp from "sharp";
import type {
  CapturedElement,
  CapturedTextPaintAffine,
  CapturedTextPaintFragment,
  CapturedTextPaintQuad,
} from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
  htmlEvidenceRun: "32366215930",
} as const;
const VIEWPORT = { width: 680, height: 380 };
const QUAD_EPSILON_CSS_PX = 1 / 64;
const MATRIX_EPSILON = 1 / 256;
const MAX_AFFINE_RESIDUAL_CSS_PX = 0.05;
const MAX_INK_EDGE_DELTA_DEVICE_PX = 4;
// Windows DirectWrite can move the terminal antialiased edge of a transformed
// 30px glyph by two device pixels at DPR2 even when source quads, glyph
// origins, advances, face, and embedded outline are identical. Keep this in
// device space and below the independent four-pixel outer-edge bound.
const INK_NEIGHBOR_RADIUS_DEVICE_PX = 2;
const MAX_INK_MISMATCH_FRACTION = 0.08;
const MAX_PREMULTIPLIED_COLOR_ERROR = 0.1;

export const TEXT_TRANSFORM_GATE_THRESHOLDS = {
  quadEpsilonCssPx: QUAD_EPSILON_CSS_PX,
  matrixEpsilon: MATRIX_EPSILON,
  maxAffineResidualCssPx: MAX_AFFINE_RESIDUAL_CSS_PX,
  maxInkEdgeDeltaDevicePx: MAX_INK_EDGE_DELTA_DEVICE_PX,
  inkNeighborRadiusDevicePx: INK_NEIGHBOR_RADIUS_DEVICE_PX,
  maxInkMismatchFraction: MAX_INK_MISMATCH_FRACTION,
  maxPremultipliedColorError: MAX_PREMULTIPLIED_COLOR_ERROR,
} as const;

type ExpectedRoute = "affine-vector" | "affine-vector-or-source-raster" | "projective-raster";

export function expectedRouteAllowsAffineVector(route: ExpectedRoute): boolean {
  return route !== "projective-raster";
}
type Matrix2D = CapturedTextPaintAffine;
interface AuditTarget { selector: `#${string}`; label: string }
export interface TextTransformCase {
  id: string;
  expectedRoute: ExpectedRoute;
  text?: string;
  targetCss?: string;
  outerCss?: string;
  content?: string;
  targets?: AuditTarget[];
  extraCss?: string;
  iframe?: boolean;
  sourceFixture?: string;
}

const COS_37 = Math.cos(37 * Math.PI / 180).toFixed(8);
export const TEXT_TRANSFORM_CASES: TextTransformCase[] = [
  { id: "identity-negative", expectedRoute: "affine-vector", text: "Identity negative" },
  { id: "translation-negative", expectedRoute: "affine-vector", text: "Translation negative", targetCss: "transform:translate(17.5px,-8.25px)" },
  { id: "uniform-scale-scalar-collision", expectedRoute: "affine-vector", text: "Uniform scalar collision", targetCss: `transform:scale(${COS_37})` },
  { id: "rotate-scalar-collision", expectedRoute: "affine-vector", text: "Rotation scalar collision", targetCss: "transform:rotate(37deg)" },
  { id: "anisotropic-scale", expectedRoute: "affine-vector", text: "Anisotropic scale", targetCss: "transform:scale(1.6,.7)" },
  { id: "rotate-anisotropic-scale", expectedRoute: "affine-vector", text: "Rotate and scale", targetCss: "transform:rotate(31deg) scale(1.6,.65);transform-origin:17px 82%" },
  { id: "skew-x", expectedRoute: "affine-vector", text: "Horizontal skew", targetCss: "transform:skewX(22deg);transform-origin:73% 18%" },
  { id: "skew-y", expectedRoute: "affine-vector", text: "Vertical skew", targetCss: "transform:skewY(-17deg);transform-origin:21% 87%" },
  { id: "reflect-x", expectedRoute: "affine-vector", text: "Reflect horizontal", targetCss: "transform:scaleX(-1);transform-origin:0 0" },
  { id: "reflect-y", expectedRoute: "affine-vector", text: "Reflect vertical", targetCss: "transform:scaleY(-1);transform-origin:100% 100%" },
  { id: "nested-asymmetric-origins", expectedRoute: "affine-vector", text: "Nested asymmetric origins", outerCss: "transform:rotate(23deg) scale(1.4,.75);transform-origin:11px 91%", targetCss: "transform:rotate(-11deg) scale(.9,1.2);transform-origin:73% 18%" },
  { id: "border-box-reference", expectedRoute: "affine-vector", text: "Border reference box", targetCss: "box-sizing:content-box;width:235px;border:7px solid transparent;padding:9px 21px;transform-box:border-box;transform:rotate(19deg) scale(1.2,.8);transform-origin:100% 0" },
  { id: "content-box-reference", expectedRoute: "affine-vector", text: "Content reference box", targetCss: "box-sizing:content-box;width:235px;border:7px solid transparent;padding:9px 21px;transform-box:content-box;transform:rotate(19deg) scale(1.2,.8);transform-origin:100% 0" },
  { id: "wrapped-inline-fragments", expectedRoute: "affine-vector", text: "Wrapped affine fragments cross several physical lines", targetCss: "display:block;width:205px;white-space:normal;transform:skewX(16deg) scale(.9,1.12)" },
  {
    id: "mixed-face-size", expectedRoute: "affine-vector", targetCss: "transform:rotate(14deg) scale(1.08,.82)",
    content: '<span id="mixed-a" style="font:700 34px/42px Georgia,serif">Mixed</span><span id="mixed-b" style="font:22px/42px Arial,sans-serif"> size</span><span id="mixed-c" style="font:28px/42px serif"> 文</span>',
    targets: [{ selector: "#mixed-a", label: "Mixed" }, { selector: "#mixed-b", label: "size" }, { selector: "#mixed-c", label: "文" }],
  },
  { id: "decorations-shadows-stroke", expectedRoute: "affine-vector", text: "Decoration shadow stroke", targetCss: "transform:rotate(-17deg) scale(1.15,.76);text-decoration:underline wavy;text-shadow:4px 3px 2px rgb(57,115,219);-webkit-text-stroke:1px rgb(192,38,211)" },
  { id: "raster-glyph-overlay", expectedRoute: "affine-vector", text: "Affine 🧭 raster overlay", targetCss: "transform:matrix(.82,.31,-.24,1.14,9,-4)" },
  { id: "rtl-horizontal", expectedRoute: "affine-vector", text: "RTL matrix العربية", targetCss: "direction:rtl;transform:skewY(13deg) scale(.83,1.2)" },
  // Some Linux inventories give the leading upright fallback glyphs zero
  // advance and a Range AABB wholly contained by the following Latin run.
  // The protocol then cannot authenticate their FragmentItem span or paint
  // order. Preserve the affine vector route when it is source-exact; otherwise
  // the existing outer screenshot surface is the only exact fail-closed route.
  { id: "vertical-writing", expectedRoute: "affine-vector-or-source-raster", text: "縦書Affine", targetCss: "writing-mode:vertical-rl;height:185px;transform:rotate(11deg) scaleX(-1)" },
  { id: "css-zoom-local", expectedRoute: "affine-vector", text: "Zoom remains local", outerCss: "zoom:1.35", targetCss: "transform:rotate(23deg) scale(.8,1.1)" },
  { id: "same-origin-iframe", expectedRoute: "affine-vector", iframe: true, text: "Frame affine text", targetCss: "transform:rotate(-21deg) scale(.8,1.3);transform-origin:77% 12%" },
  { id: "affine-matrix3d-negative", expectedRoute: "affine-vector", text: "Affine matrix3d negative", targetCss: "transform:matrix3d(1.1,.2,0,0,-.15,.8,0,0,0,0,1,0,13,-9,0,1)" },
  { id: "projective-positive", expectedRoute: "projective-raster", text: "Projective source surface", outerCss: "perspective:320px;perspective-origin:17% 83%;transform-style:preserve-3d", targetCss: "transform:rotateY(42deg) translateZ(28px);transform-origin:19% 77%" },
  {
    id: "html-run-anisotropic-text", expectedRoute: "affine-vector", sourceFixture: "external/html-test/21-deep-anisotropic-scale.html",
    targetCss: "display:block;width:220px;padding:12px;white-space:normal;background:rgb(241,245,249);transform:scale(1.5,1);transform-origin:left center;font:16px/normal system-ui,sans-serif",
    content: '<span id="fixture-anisotropic">Wide-scaled text should appear stretched horizontally; descenders and ascenders keep regular height.</span>',
    targets: [{ selector: "#fixture-anisotropic", label: "Wide-scaled text" }],
  },
  { id: "html-run-transform-origin-text", expectedRoute: "affine-vector", sourceFixture: "external/html-test/21-deep-transform-origin.html", text: "25% 75%", targetCss: "box-sizing:border-box;width:160px;height:160px;background:rgb(29,78,216);color:white;padding:4px;transform:rotate(20deg);transform-origin:25% 75%;font:16px/normal sans-serif" },
];

export type TextTransformMutationKind = "scalar-collision" | "drop-off-diagonals" | "drop-reflection-sign" | "collapse-reference-box-origin" | "collapse-wrapped-fragments" | "fold-zoom-into-matrix" | "double-apply-transform" | "force-projective-vector";
export const REQUIRED_TEXT_TRANSFORM_MUTATIONS: TextTransformMutationKind[] = ["scalar-collision", "drop-off-diagonals", "drop-reflection-sign", "collapse-reference-box-origin", "collapse-wrapped-fragments", "fold-zoom-into-matrix", "double-apply-transform", "force-projective-vector"];
const REQUIRED_CASE_IDS = ["identity-negative", "translation-negative", "uniform-scale-scalar-collision", "rotate-scalar-collision", "anisotropic-scale", "rotate-anisotropic-scale", "skew-x", "skew-y", "reflect-x", "reflect-y", "nested-asymmetric-origins", "border-box-reference", "content-box-reference", "wrapped-inline-fragments", "mixed-face-size", "decorations-shadows-stroke", "raster-glyph-overlay", "rtl-horizontal", "vertical-writing", "css-zoom-local", "same-origin-iframe", "affine-matrix3d-negative", "projective-positive", "html-run-anisotropic-text", "html-run-transform-origin-text"] as const;

export function validateTextTransformCorpus(): string[] {
  const errors: string[] = [];
  const ids = new Set(TEXT_TRANSFORM_CASES.map((test) => test.id));
  for (const id of REQUIRED_CASE_IDS) if (!ids.has(id)) errors.push(`missing required case ${id}`);
  if (ids.size !== TEXT_TRANSFORM_CASES.length) errors.push("case ids must be unique");
  if (!TEXT_TRANSFORM_CASES.some((test) => test.expectedRoute === "projective-raster")) errors.push("projective raster positive is required");
  if (TEXT_TRANSFORM_CASES.filter((test) => test.sourceFixture != null).length !== 2) errors.push("both HTML-run integration fixtures are required");
  if (new Set(REQUIRED_TEXT_TRANSFORM_MUTATIONS).size !== REQUIRED_TEXT_TRANSFORM_MUTATIONS.length) errors.push("mutation ids must be unique");
  return errors;
}

interface CdpNode { nodeType: number; backendNodeId: number; attributes?: string[]; children?: CdpNode[]; shadowRoots?: CdpNode[]; pseudoElements?: CdpNode[]; contentDocument?: CdpNode }
interface DirectTargetFacts { selector: string; label: string; liveQuads: CapturedTextPaintQuad[]; neutralQuads: CapturedTextPaintQuad[]; restoredQuads: CapturedTextPaintQuad[] }
export interface FragmentComparison { physicalFragmentIndex: number; paintQuadDeltaCssPx: number; neutralQuadDeltaCssPx: number; restoredQuadDeltaCssPx: number; matrixDelta: number; mappedResidualCssPx: number; independentResidualCssPx: number; determinant: number; shapedOriginCount: number; shapedAdvanceCount: number; pass: boolean }
export interface TargetComparison { selector: string; label: string; directFragmentCount: number; capturedFragmentCount: number; capturedNeutralBundle: boolean; fragments: FragmentComparison[]; independentClassification: "affine" | "projective" | "unavailable"; pass: boolean }
interface InkBounds { left: number; top: number; right: number; bottom: number; pixels: number }
export interface TextPixelComparison { width: number; height: number; sourceInkPixels: number; generatedInkPixels: number; sourceBounds: InkBounds | null; generatedBounds: InkBounds | null; maxEdgeDeltaDevicePx: number | null; unmatchedSourcePixels: number; unmatchedGeneratedPixels: number; inkMismatchFraction: number; premultipliedColorError: number; pass: boolean }
export interface TextTransformAuditRow { id: string; deviceScaleFactor: number; expectedRoute: ExpectedRoute; sourceFixture?: string; targets: TargetComparison[]; transformRasterOwnerCount: number; generatedImageCount: number; scalarVocabularyFound: boolean; warnings: string[]; relevantWarnings: string[]; pixels: TextPixelComparison; logicalPass: boolean; pass: boolean }
export interface MutationResult { kind: TextTransformMutationKind; baseline: number | boolean; mutated: number | boolean; moved: boolean }
export interface TextTransformGateReport {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevisions: typeof SOURCE_REVISIONS;
  fingerprint: { chromiumVersion: string; playwrightVersion: string; userAgent: string; os: NodeJS.Platform; osRelease: string; architecture: string; node: string; viewport: typeof VIEWPORT; deviceScaleFactors: number[]; requestedFontFamilies: string[]; resolvedFontFaces: string[]; thresholds: typeof TEXT_TRANSFORM_GATE_THRESHOLDS };
  integrationFixtures: Array<{ path: string; sha256: string }>;
  corpus: { cases: number; mutations: TextTransformMutationKind[] };
  rows: TextTransformAuditRow[];
  mutations: MutationResult[];
  controls: Record<string, boolean>;
  summary: { logicalPassed: number; logicalFailed: number; pixelsPassed: number; pixelsFailed: number; mutationsMoved: number; mutationsFailed: number };
  verdict: "hard-two-leg-transformed-text-parity" | "transformed-text-parity-failure";
}

function childrenOf(node: CdpNode): CdpNode[] { return [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.pseudoElements ?? []), ...(node.contentDocument == null ? [] : [node.contentDocument])]; }
function idOf(node: CdpNode): string | null { const attrs = node.attributes ?? []; const index = attrs.indexOf("id"); return index >= 0 ? attrs[index + 1] ?? null : null; }
function findNodeById(node: CdpNode, id: string): CdpNode | null { if (idOf(node) === id) return node; for (const child of childrenOf(node)) { const found = findNodeById(child, id); if (found != null) return found; } return null; }
function directTextNodes(node: CdpNode): CdpNode[] { const direct = (node.children ?? []).filter((child) => child.nodeType === 3); return direct.length > 0 ? direct : (node.children ?? []).flatMap((child) => directTextNodes(child)); }
async function readQuads(session: CDPSession, ids: readonly number[]): Promise<CapturedTextPaintQuad[]> { const result: CapturedTextPaintQuad[] = []; for (const backendNodeId of ids) { const response = await session.send("DOM.getContentQuads", { backendNodeId }); for (const quad of response.quads) if (quad.length === 8) result.push(quad as unknown as CapturedTextPaintQuad); } return result; }
async function animationFrame(page: Page): Promise<void> { await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))); }

async function independentTextFacts(page: Page, targets: readonly AuditTarget[]): Promise<DirectTargetFacts[]> {
  const session = await page.context().newCDPSession(page);
  const styles: ElementHandle<HTMLStyleElement>[] = [];
  try {
    await session.send("DOM.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const retained = targets.map((target) => {
      const node = findNodeById(root as CdpNode, target.selector.slice(1));
      if (node == null) throw new Error(`${target.selector}: CDP target unavailable`);
      const texts = directTextNodes(node);
      if (texts.length === 0) throw new Error(`${target.selector}: CDP text unavailable`);
      return { ...target, ids: texts.map((text) => text.backendNodeId) };
    });
    const live = await Promise.all(retained.map((target) => readQuads(session, target.ids)));
    const neutralCss = "[data-text-transform-owner]{transform:none!important;translate:none!important;rotate:none!important;scale:none!important;offset-path:none!important}[data-text-perspective-owner]{perspective:none!important;transform-style:flat!important}";
    for (const frame of page.frames()) styles.push(await frame.addStyleTag({ content: neutralCss }));
    await animationFrame(page);
    const neutral = await Promise.all(retained.map((target) => readQuads(session, target.ids)));
    for (const style of styles.splice(0)) await style.evaluate((node) => node.remove());
    await animationFrame(page);
    const restored = await Promise.all(retained.map((target) => readQuads(session, target.ids)));
    return retained.map((target, index) => ({ selector: target.selector, label: target.label, liveQuads: live[index], neutralQuads: neutral[index], restoredQuads: restored[index] }));
  } finally {
    for (const style of styles) await style.evaluate((node) => node.remove()).catch(() => undefined);
    await session.detach();
  }
}

function solveAffine(neutral: CapturedTextPaintQuad, paint: CapturedTextPaintQuad): Matrix2D | null {
  const nx1 = neutral[2] - neutral[0], ny1 = neutral[3] - neutral[1], nx2 = neutral[6] - neutral[0], ny2 = neutral[7] - neutral[1];
  const det = nx1 * ny2 - nx2 * ny1;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const lx1 = paint[2] - paint[0], ly1 = paint[3] - paint[1], lx2 = paint[6] - paint[0], ly2 = paint[7] - paint[1];
  const ia = ny2 / det, ib = -ny1 / det, ic = -nx2 / det, id = nx1 / det;
  const a = lx1 * ia + lx2 * ib, c = lx1 * ic + lx2 * id, b = ly1 * ia + ly2 * ib, d = ly1 * ic + ly2 * id;
  return [a, b, c, d, paint[0] - a * neutral[0] - c * neutral[1], paint[1] - b * neutral[0] - d * neutral[1]];
}
function mapPoint(matrix: Matrix2D, x: number, y: number): [number, number] { return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]; }
function mappedResidual(matrix: Matrix2D, neutral: CapturedTextPaintQuad, paint: CapturedTextPaintQuad): number { let max = 0; for (let i = 0; i < 4; i++) { const mapped = mapPoint(matrix, neutral[i * 2], neutral[i * 2 + 1]); max = Math.max(max, Math.abs(mapped[0] - paint[i * 2]), Math.abs(mapped[1] - paint[i * 2 + 1])); } return max; }
function numericDelta(left: readonly number[], right: readonly number[]): number { return left.length !== right.length ? Number.POSITIVE_INFINITY : left.reduce((max, value, index) => Math.max(max, Math.abs(value - right[index])), 0); }
function walk(nodes: readonly CapturedElement[]): CapturedElement[] { return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]); }
function ownerFor(tree: readonly CapturedElement[], label: string): CapturedElement | null {
  const nodes = walk(tree);
  return nodes.find((node) => node.textSegments?.some((segment) => segment.text.includes(label)) === true)
    ?? nodes.find((node) => node.textPaintGeometry != null && node.text.includes(label))
    ?? null;
}
function transformRasterOwnerCount(tree: readonly CapturedElement[]): number { return walk(tree).filter((node) => node.transformSubtreeRaster?.dataUri != null).length; }

function compareTarget(direct: DirectTargetFacts, owner: CapturedElement | null, route: ExpectedRoute): TargetComparison {
  const captured = owner?.textPaintGeometry?.fragments ?? [];
  const fragments: FragmentComparison[] = [];
  let projective = false;
  for (let index = 0; index < Math.min(direct.liveQuads.length, direct.neutralQuads.length); index++) {
    const independent = solveAffine(direct.neutralQuads[index], direct.liveQuads[index]);
    if (independent == null || mappedResidual(independent, direct.neutralQuads[index], direct.liveQuads[index]) > MAX_AFFINE_RESIDUAL_CSS_PX) projective = true;
  }
  for (const fact of captured) {
    const index = fact.physicalFragmentIndex;
    if (direct.liveQuads[index] == null || direct.neutralQuads[index] == null || direct.restoredQuads[index] == null) continue;
    const independent = solveAffine(direct.neutralQuads[index], direct.liveQuads[index]);
    const comparison: FragmentComparison = {
      physicalFragmentIndex: fact.physicalFragmentIndex,
      paintQuadDeltaCssPx: numericDelta(fact.paintQuad, direct.liveQuads[index]),
      neutralQuadDeltaCssPx: numericDelta(fact.neutralQuad, direct.neutralQuads[index]),
      restoredQuadDeltaCssPx: numericDelta(direct.liveQuads[index], direct.restoredQuads[index]),
      matrixDelta: independent == null ? Number.POSITIVE_INFINITY : numericDelta(fact.paintMatrix, independent),
      mappedResidualCssPx: mappedResidual(fact.paintMatrix, fact.neutralQuad, fact.paintQuad),
      independentResidualCssPx: independent == null ? Number.POSITIVE_INFINITY : mappedResidual(independent, direct.neutralQuads[index], direct.liveQuads[index]),
      determinant: fact.paintMatrix[0] * fact.paintMatrix[3] - fact.paintMatrix[1] * fact.paintMatrix[2],
      shapedOriginCount: fact.shapedOrigins.length,
      shapedAdvanceCount: fact.shapedAdvances.length,
      pass: false,
    };
    comparison.pass = comparison.paintQuadDeltaCssPx <= QUAD_EPSILON_CSS_PX && comparison.neutralQuadDeltaCssPx <= QUAD_EPSILON_CSS_PX && comparison.restoredQuadDeltaCssPx <= QUAD_EPSILON_CSS_PX && comparison.matrixDelta <= MATRIX_EPSILON && comparison.mappedResidualCssPx <= MAX_AFFINE_RESIDUAL_CSS_PX && comparison.independentResidualCssPx <= MAX_AFFINE_RESIDUAL_CSS_PX && comparison.shapedOriginCount > 0 && comparison.shapedOriginCount === comparison.shapedAdvanceCount;
    fragments.push(comparison);
  }
  const classification = direct.liveQuads.length === 0 || direct.neutralQuads.length === 0 ? "unavailable" : projective ? "projective" : "affine";
  const pass = expectedRouteAllowsAffineVector(route)
    ? classification === "affine" && captured.length === direct.liveQuads.length && direct.liveQuads.length === direct.neutralQuads.length && direct.liveQuads.length === direct.restoredQuads.length && captured.map((fragment) => fragment.physicalFragmentIndex).sort((a, b) => a - b).every((value, index) => value === index) && owner?.textPaintGeometry?.neutral != null && fragments.length === captured.length && fragments.every((fragment) => fragment.pass)
    : classification === "projective" && captured.length === 0;
  return { selector: direct.selector, label: direct.label, directFragmentCount: direct.liveQuads.length, capturedFragmentCount: captured.length, capturedNeutralBundle: owner?.textPaintGeometry?.neutral != null, fragments, independentClassification: classification, pass };
}

function inkBounds(data: Buffer, width: number, height: number): InkBounds | null { let left = width, top = height, right = -1, bottom = -1, pixels = 0; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { if (data[(y * width + x) * 4 + 3] <= 8) continue; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); pixels++; } return pixels === 0 ? null : { left, top, right, bottom, pixels }; }
function premultipliedError(left: readonly number[], right: readonly number[]): number { const la = left[3] / 255, ra = right[3] / 255; return (Math.abs(left[0] * la - right[0] * ra) + Math.abs(left[1] * la - right[1] * ra) + Math.abs(left[2] * la - right[2] * ra) + Math.abs(left[3] - right[3])) / (4 * 255); }
export function nearestInkColorError(
  source: readonly number[],
  target: Buffer | Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number | null {
  let bestError = Number.POSITIVE_INFINITY;
  for (let dy = -INK_NEIGHBOR_RADIUS_DEVICE_PX; dy <= INK_NEIGHBOR_RADIUS_DEVICE_PX; dy++) {
    for (let dx = -INK_NEIGHBOR_RADIUS_DEVICE_PX; dx <= INK_NEIGHBOR_RADIUS_DEVICE_PX; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const offset = (py * width + px) * 4;
      if (target[offset + 3] <= 8) continue;
      bestError = Math.min(bestError, premultipliedError(source, [
        target[offset], target[offset + 1], target[offset + 2], target[offset + 3],
      ]));
    }
  }
  return Number.isFinite(bestError) ? bestError : null;
}
function directedInkComparison(source: Buffer, target: Buffer, width: number, height: number): { unmatched: number; colorError: number; samples: number } { let unmatched = 0, colorError = 0, samples = 0; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = (y * width + x) * 4; if (source[offset + 3] <= 8) continue; samples++; const nearestError = nearestInkColorError([source[offset], source[offset + 1], source[offset + 2], source[offset + 3]], target, width, height, x, y); if (nearestError == null) { unmatched++; colorError++; } else colorError += nearestError; } return { unmatched, colorError, samples }; }

async function comparePixels(sourcePng: Buffer, generatedPng: Buffer): Promise<TextPixelComparison> {
  const [source, generated] = await Promise.all([sharp(sourcePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(generatedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
  if (source.info.width !== generated.info.width || source.info.height !== generated.info.height) throw new Error(`pixel size mismatch ${source.info.width}x${source.info.height} vs ${generated.info.width}x${generated.info.height}`);
  const sourceBounds = inkBounds(source.data, source.info.width, source.info.height), generatedBounds = inkBounds(generated.data, generated.info.width, generated.info.height);
  const edge = sourceBounds == null || generatedBounds == null ? null : Math.max(Math.abs(sourceBounds.left - generatedBounds.left), Math.abs(sourceBounds.top - generatedBounds.top), Math.abs(sourceBounds.right - generatedBounds.right), Math.abs(sourceBounds.bottom - generatedBounds.bottom));
  const forward = directedInkComparison(source.data, generated.data, source.info.width, source.info.height), reverse = directedInkComparison(generated.data, source.data, source.info.width, source.info.height), samples = forward.samples + reverse.samples;
  const mismatch = samples === 0 ? 1 : (forward.unmatched + reverse.unmatched) / samples, color = samples === 0 ? 1 : (forward.colorError + reverse.colorError) / samples;
  const pass = edge != null && edge <= MAX_INK_EDGE_DELTA_DEVICE_PX && mismatch <= MAX_INK_MISMATCH_FRACTION && color <= MAX_PREMULTIPLIED_COLOR_ERROR;
  return { width: source.info.width, height: source.info.height, sourceInkPixels: sourceBounds?.pixels ?? 0, generatedInkPixels: generatedBounds?.pixels ?? 0, sourceBounds, generatedBounds, maxEdgeDeltaDevicePx: edge, unmatchedSourcePixels: forward.unmatched, unmatchedGeneratedPixels: reverse.unmatched, inkMismatchFraction: mismatch, premultipliedColorError: color, pass };
}

function escapeAttribute(value: string): string { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
function htmlFor(test: TextTransformCase): string {
  if (test.iframe === true) {
    const inner = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:visible}#target{display:inline-block;position:absolute;left:115px;top:75px;color:rgb(21,32,48);font:30px/40px Arial,sans-serif;white-space:nowrap;${test.targetCss ?? ""}}</style><span id="target" data-text-transform-owner>${test.text ?? ""}</span>`;
    return `<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#scene{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px}iframe{position:absolute;left:70px;top:45px;width:500px;height:260px;border:0;background:transparent}</style><div id="scene"><iframe srcdoc="${escapeAttribute(inner)}"></iframe></div>`;
  }
  return `<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#scene{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px}#outer{position:absolute;left:220.25px;top:125.5px;${test.outerCss ?? ""}}#target{display:inline-block;color:rgb(21,32,48);font:30px/40px Arial,sans-serif;white-space:nowrap;transform-origin:13% 82%;${test.targetCss ?? ""}}${test.extraCss ?? ""}</style><div id="scene"><div id="outer" data-text-transform-owner data-text-perspective-owner><span id="target" data-text-transform-owner>${test.content ?? test.text ?? ""}</span></div></div>`;
}
function normalizeWarnings(warnings: readonly unknown[]): string[] { return warnings.map((warning) => typeof warning === "string" ? warning : JSON.stringify(warning) ?? String(warning)); }
function requestedTargets(test: TextTransformCase): AuditTarget[] { return test.targets ?? [{ selector: "#target", label: test.text ?? "" }]; }
function fixtureFingerprints(): Array<{ path: string; sha256: string }> { return ["external/html-test/21-deep-anisotropic-scale.html", "external/html-test/21-deep-transform-origin.html"].map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(resolve(path))).digest("hex") })); }
async function waitForFonts(page: Page): Promise<void> { await page.waitForFunction(() => Array.from(document.querySelectorAll("iframe")).every((frame) => frame.contentDocument?.readyState === "complete")); await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.fonts.ready))); }

async function runRow(source: Page, output: Page, test: TextTransformCase, dpr: number, capture: typeof import("../src/capture/index.js"), render: typeof import("../src/render/element-tree-to-svg.js"), artifactDir?: string): Promise<{ row: TextTransformAuditRow; fonts: string[]; faces: string[]; mutationFragment?: CapturedTextPaintFragment }> {
  await source.setContent(htmlFor(test), { waitUntil: "load" });
  await waitForFonts(source);
  const targets = requestedTargets(test), direct = await independentTextFacts(source, targets);
  const captured = await capture.captureElementTreeWithWarnings(source, "#scene", { x: 0, y: 0, ...VIEWPORT });
  const comparisons = direct.map((facts) => compareTarget(facts, ownerFor(captured.tree, facts.label), test.expectedRoute));
  const warnings = normalizeWarnings(captured.warnings), relevantWarnings = warnings.filter((warning) => /text-fragment|transform.*raster|projective/i.test(warning));
  const rasterOwners = transformRasterOwnerCount(captured.tree);
  const allowedProjectiveWarnings = test.expectedRoute === "projective-raster" && relevantWarnings.every((warning) => /outer raster|outer.*surface|projective/i.test(warning));
  const svg = render.elementTreeToSvg(captured.tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: dpr });
  const generatedImageCount = (svg.match(/<image\b/g) ?? []).length, scalarVocabularyFound = /anisotropicCorrection|cumScaleX|cumScaleY|_scaleMag|_computeOwnScale/.test(svg);
  const bitmapRoutePass = test.id !== "raster-glyph-overlay" || generatedImageCount > 0;
  const vectorPass = comparisons.every((item) => item.pass) && rasterOwners === 0
    && relevantWarnings.length === 0 && bitmapRoutePass && !scalarVocabularyFound;
  const sourceRasterPass = comparisons.every((item) => item.independentClassification === "affine"
    && item.capturedFragmentCount === 0 && !item.capturedNeutralBundle)
    && rasterOwners === 1 && generatedImageCount === 1 && relevantWarnings.length === 1
    && relevantWarnings.every((warning) => /Chromium text-fragment geometry unavailable; retained one outer raster surface: a rendered source chunk crosses or ambiguously belongs to FragmentItem spans/.test(warning))
    && !scalarVocabularyFound;
  const logicalPass = test.expectedRoute === "affine-vector"
    ? vectorPass
    : test.expectedRoute === "affine-vector-or-source-raster"
      ? vectorPass || sourceRasterPass
      : comparisons.every((item) => item.pass) && rasterOwners === 1
        && allowedProjectiveWarnings && !scalarVocabularyFound;
  await output.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}svg{display:block}</style>${svg}`, { waitUntil: "load" }); await output.evaluate(() => document.fonts.ready);
  const [sourcePng, generatedPng] = await Promise.all([source.screenshot({ type: "png", omitBackground: true }), output.screenshot({ type: "png", omitBackground: true })]);
  if (artifactDir != null) {
    mkdirSync(artifactDir, { recursive: true });
    const stem = `dpr-${dpr}-${test.id}`;
    writeFileSync(resolve(artifactDir, `${stem}-expected.png`), sourcePng);
    writeFileSync(resolve(artifactDir, `${stem}-actual.png`), generatedPng);
    writeFileSync(resolve(artifactDir, `${stem}.svg`), svg);
  }
  const pixels = await comparePixels(sourcePng, generatedPng), elements = walk(captured.tree);
  const fonts = elements.flatMap((element) => [element.styles.fontFamily ?? "", ...(element.textSegments ?? []).map((segment) => segment.fontFamily ?? "")]).filter(Boolean);
  const faces = elements.flatMap((element) => (element.textSegments ?? []).map((segment) => segment.resolvedFontFace?.postScriptName ?? segment.resolvedFontFace?.familyName ?? "")).filter(Boolean);
  const mutationFragment = ownerFor(captured.tree, targets[0].label)?.textPaintGeometry?.fragments[0];
  return { row: { id: test.id, deviceScaleFactor: dpr, expectedRoute: test.expectedRoute, sourceFixture: test.sourceFixture, targets: comparisons, transformRasterOwnerCount: rasterOwners, generatedImageCount, scalarVocabularyFound, warnings, relevantWarnings, pixels, logicalPass, pass: logicalPass && pixels.pass }, fonts, faces, mutationFragment };
}

function firstRow(rows: readonly TextTransformAuditRow[], id: string): TextTransformAuditRow | undefined { return rows.find((row) => row.id === id && row.deviceScaleFactor === 1) ?? rows.find((row) => row.id === id); }
function fragmentFor(fragments: ReadonlyMap<string, CapturedTextPaintFragment>, rows: readonly TextTransformAuditRow[], id: string): CapturedTextPaintFragment | undefined { const row = firstRow(rows, id); return row == null ? undefined : fragments.get(`${row.deviceScaleFactor}:${id}`); }
function multiply(left: Matrix2D, right: Matrix2D): Matrix2D { return [left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1], left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3], left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5]]; }

function mutationResults(rows: readonly TextTransformAuditRow[], fragments: ReadonlyMap<string, CapturedTextPaintFragment>): MutationResult[] {
  const scale = fragmentFor(fragments, rows, "uniform-scale-scalar-collision"), rotate = fragmentFor(fragments, rows, "rotate-scalar-collision"), reflect = fragmentFor(fragments, rows, "reflect-x"), border = fragmentFor(fragments, rows, "border-box-reference"), content = fragmentFor(fragments, rows, "content-box-reference"), zoom = fragmentFor(fragments, rows, "css-zoom-local"), nested = fragmentFor(fragments, rows, "nested-asymmetric-origins"), wrapped = firstRow(rows, "wrapped-inline-fragments"), projective = firstRow(rows, "projective-positive");
  const diag = scale == null || rotate == null ? Infinity : Math.max(Math.abs(scale.paintMatrix[0] - rotate.paintMatrix[0]), Math.abs(scale.paintMatrix[3] - rotate.paintMatrix[3]));
  const offdiag = scale == null || rotate == null ? 0 : Math.abs(scale.paintMatrix[1] - rotate.paintMatrix[1]) + Math.abs(scale.paintMatrix[2] - rotate.paintMatrix[2]);
  const dropOffdiag = rotate == null ? 0 : mappedResidual([rotate.paintMatrix[0], 0, 0, rotate.paintMatrix[3], rotate.paintMatrix[4], rotate.paintMatrix[5]], rotate.neutralQuad, rotate.paintQuad);
  const dropSign = reflect == null ? 0 : mappedResidual(reflect.paintMatrix.map((value, index) => index < 4 ? Math.abs(value) : value) as Matrix2D, reflect.neutralQuad, reflect.paintQuad);
  const referenceDelta = border == null || content == null ? 0 : Math.max(Math.abs(border.paintMatrix[4] - content.paintMatrix[4]), Math.abs(border.paintMatrix[5] - content.paintMatrix[5]));
  const wrappedCount = wrapped?.targets[0]?.capturedFragmentCount ?? 0;
  const zoomFolded = zoom == null ? 0 : mappedResidual([zoom.paintMatrix[0] * zoom.lineOrigin.effectiveZoom, zoom.paintMatrix[1] * zoom.lineOrigin.effectiveZoom, zoom.paintMatrix[2] * zoom.lineOrigin.effectiveZoom, zoom.paintMatrix[3] * zoom.lineOrigin.effectiveZoom, zoom.paintMatrix[4], zoom.paintMatrix[5]], zoom.neutralQuad, zoom.paintQuad);
  const doubled = nested == null ? 0 : mappedResidual(multiply(nested.paintMatrix, nested.paintMatrix), nested.neutralQuad, nested.paintQuad);
  return [
    { kind: "scalar-collision", baseline: diag, mutated: offdiag, moved: diag <= QUAD_EPSILON_CSS_PX && offdiag > 0.5 },
    { kind: "drop-off-diagonals", baseline: rotate?.affineResidual ?? Infinity, mutated: dropOffdiag, moved: dropOffdiag > 1 },
    { kind: "drop-reflection-sign", baseline: reflect?.affineResidual ?? Infinity, mutated: dropSign, moved: dropSign > 1 },
    { kind: "collapse-reference-box-origin", baseline: 0, mutated: referenceDelta, moved: referenceDelta > 1 },
    { kind: "collapse-wrapped-fragments", baseline: wrappedCount, mutated: wrappedCount > 0 ? 1 : 0, moved: wrappedCount > 1 },
    { kind: "fold-zoom-into-matrix", baseline: zoom?.affineResidual ?? Infinity, mutated: zoomFolded, moved: zoomFolded > 1 },
    { kind: "double-apply-transform", baseline: nested?.affineResidual ?? Infinity, mutated: doubled, moved: doubled > 1 },
    { kind: "force-projective-vector", baseline: projective?.transformRasterOwnerCount === 1, mutated: projective?.targets[0]?.independentClassification === "affine", moved: projective?.transformRasterOwnerCount === 1 && projective?.targets[0]?.independentClassification === "projective" },
  ];
}

export async function runTextTransformGeometryAudit(options: { deviceScaleFactors?: number[]; artifactDir?: string } = {}): Promise<TextTransformGateReport> {
  const errors = validateTextTransformCorpus(); if (errors.length > 0) throw new Error(`invalid transformed-text corpus: ${errors.join("; ")}`);
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const capture = await import("../src/capture/index.js"), render = await import("../src/render/element-tree-to-svg.js");
  const require = createRequire(import.meta.url), playwrightVersion = (require("playwright/package.json") as { version: string }).version, dprs = options.deviceScaleFactors ?? [1, 2];
  const browser = await chromium.launch({ headless: true }), rows: TextTransformAuditRow[] = [], fonts = new Set<string>(), faces = new Set<string>(), fragments = new Map<string, CapturedTextPaintFragment>();
  try {
    const fingerprintPage = await browser.newPage({ viewport: VIEWPORT }), userAgent = await fingerprintPage.evaluate(() => navigator.userAgent); await fingerprintPage.close();
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr }), source = await context.newPage(), output = await context.newPage();
      try { for (const test of TEXT_TRANSFORM_CASES) { const result = await runRow(source, output, test, dpr, capture, render, options.artifactDir); rows.push(result.row); result.fonts.forEach((font) => fonts.add(font)); result.faces.forEach((face) => faces.add(face)); if (result.mutationFragment != null) fragments.set(`${dpr}:${test.id}`, result.mutationFragment); } } finally { await context.close(); }
    }
    const mutations = mutationResults(rows, fragments), fixtureHashes = fixtureFingerprints();
    const controls = { everyDprHasEveryCase: dprs.every((dpr) => rows.filter((row) => row.deviceScaleFactor === dpr).length === TEXT_TRANSFORM_CASES.length), everyAffineRowUsesSourceExactRoute: rows.filter((row) => row.expectedRoute !== "projective-raster").every((row) => row.logicalPass), projectivePositiveOwnsOneSurface: rows.filter((row) => row.expectedRoute === "projective-raster").every((row) => row.logicalPass), everyPixelLegPasses: rows.every((row) => row.pixels.pass), scalarVocabularyAbsent: rows.every((row) => !row.scalarVocabularyFound), bothHtmlRunFixturesPresent: fixtureHashes.length === 2, everyRequiredMutationMoves: mutations.length === REQUIRED_TEXT_TRANSFORM_MUTATIONS.length && mutations.every((mutation) => mutation.moved) };
    const pass = rows.every((row) => row.pass) && Object.values(controls).every(Boolean), logicalPassed = rows.filter((row) => row.logicalPass).length, pixelsPassed = rows.filter((row) => row.pixels.pass).length, mutationsMoved = mutations.filter((mutation) => mutation.moved).length;
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceRevisions: SOURCE_REVISIONS, fingerprint: { chromiumVersion: browser.version(), playwrightVersion, userAgent, os: platform(), osRelease: release(), architecture: arch(), node: process.version, viewport: VIEWPORT, deviceScaleFactors: dprs, requestedFontFamilies: [...fonts].sort(), resolvedFontFaces: [...faces].sort(), thresholds: TEXT_TRANSFORM_GATE_THRESHOLDS }, integrationFixtures: fixtureHashes, corpus: { cases: TEXT_TRANSFORM_CASES.length, mutations: REQUIRED_TEXT_TRANSFORM_MUTATIONS }, rows, mutations, controls, summary: { logicalPassed, logicalFailed: rows.length - logicalPassed, pixelsPassed, pixelsFailed: rows.length - pixelsPassed, mutationsMoved, mutationsFailed: mutations.length - mutationsMoved }, verdict: pass ? "hard-two-leg-transformed-text-parity" : "transformed-text-parity-failure" };
  } finally { await browser.close(); }
}

async function main(): Promise<number> {
  const dprIndex = process.argv.indexOf("--dpr"), dprs = dprIndex >= 0 && process.argv[dprIndex + 1] != null ? process.argv[dprIndex + 1].split(",").map(Number) : [1, 2];
  const artifactIndex = process.argv.indexOf("--artifact-dir");
  const artifactDir = artifactIndex >= 0 && process.argv[artifactIndex + 1] != null
    ? resolve(process.argv[artifactIndex + 1])
    : undefined;
  const report = await runTextTransformGeometryAudit({ deviceScaleFactors: dprs, artifactDir }), jsonIndex = process.argv.indexOf("--json"), reportPath = resolve(jsonIndex >= 0 && process.argv[jsonIndex + 1] != null ? process.argv[jsonIndex + 1] : `tests/output/text-transform-parity-${platform()}.json`);
  mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`transformed-text gate: ${report.rows.filter((row) => row.pass).length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) console.log(`${row.pass ? "PASS" : "FAIL"} dpr=${row.deviceScaleFactor} ${row.id}: route=${row.expectedRoute}, logical=${row.logicalPass}, edge=${row.pixels.maxEdgeDeltaDevicePx ?? "missing"}, ink-mismatch=${(row.pixels.inkMismatchFraction * 100).toFixed(3)}%, color-error=${(row.pixels.premultipliedColorError * 100).toFixed(3)}%, raster=${row.transformRasterOwnerCount}`);
  for (const mutation of report.mutations) console.log(`${mutation.moved ? "PASS" : "FAIL"} mutation ${mutation.kind}: baseline=${mutation.baseline}, mutated=${mutation.mutated}`);
  console.log(`report: ${reportPath}`); return report.verdict === "hard-two-leg-transformed-text-parity" ? 0 : 1;
}
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
