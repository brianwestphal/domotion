#!/usr/bin/env tsx
/**
 * DM-2371 / DM-2473 / DM-2474 / DM-2475 two-leg parity gate.
 *
 * Leg 1 compares Blink's used parent-relative affine CTM and projective raster
 * ownership with the production capture. Leg 2 independently screenshots the
 * live Chromium source and the complete generated SVG, then compares physical
 * alpha/ink bounds and RGBA error at fixed device-pixel tolerances. The same
 * generated corpus runs at DPR 1/2 on macOS, Linux, and Windows CI; no
 * platform-specific tolerance envelope is accepted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import type { CapturedElement } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;
const VIEWPORT = { width: 420, height: 260 };
const MATRIX_EPSILON = 1 / 256;
const MAX_ALPHA_BOUND_DELTA_PX = 2;
const MAX_ALPHA_MISMATCH_FRACTION = 0.05;
const MAX_RGBA_MEAN_ERROR = 0.03;

export const INLINE_SVG_3D_GATE_THRESHOLDS = {
  matrixEpsilon: MATRIX_EPSILON,
  maxAlphaBoundDeltaPx: MAX_ALPHA_BOUND_DELTA_PX,
  maxAlphaMismatchFraction: MAX_ALPHA_MISMATCH_FRACTION,
  maxRgbaMeanError: MAX_RGBA_MEAN_ERROR,
} as const;

type Matrix2D = [number, number, number, number, number, number];
type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];

export type ExpectedRoute =
  | "clone-equivalent"
  | "outer-raster"
  | "promoted-inline-svg-raster";

export interface AuditCase {
  id: string;
  expectedRoute: ExpectedRoute;
  rootCss?: string;
  hostCss?: string;
  layerCss?: string;
  targetCss?: string;
  targetAttrs?: string;
  foreignObject?: boolean;
  foreignHostCss?: string;
  extraCss?: string;
}

interface DomFacts {
  computedTransform: string;
  computedTransformBox: string;
  computedTransformOrigin: string;
  computedTransformStyle: string;
  computedPerspective: string;
  bbox: { x: number; y: number; width: number; height: number };
  clientRect: { x: number; y: number; width: number; height: number };
  ctm: Matrix2D | null;
  /** Target CTM expressed in its immediate SVG parent's coordinate space. */
  localCtm: Matrix2D | null;
  screenCtm: Matrix2D | null;
  quad: Quad | null;
}

interface InkBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

interface PixelComparison {
  width: number;
  height: number;
  sourceAlphaPixels: number;
  generatedAlphaPixels: number;
  alphaUnionPixels: number;
  alphaMismatchedPixels: number;
  alphaMismatchFraction: number;
  rgbaMeanError: number;
  alphaBoundsDelta: number | null;
  sourceAlphaBounds: InkBounds | null;
  generatedAlphaBounds: InkBounds | null;
  pass: boolean;
}

export interface AuditRow {
  id: string;
  deviceScaleFactor: number;
  expectedRoute: ExpectedRoute;
  source: DomFacts;
  clone: DomFacts | null;
  clonedTransformAttribute: string | null;
  matrixDelta: number;
  quadAffineResidual: number;
  transformRaster: boolean;
  rasterOwnerCount: number;
  effectiveRasterOwnerCount: number;
  rasterOwnerPaths: string[];
  capturedInlineSvg: {
    storedTransform: string | null;
    projectiveTransform: CapturedElement["projectiveTransform"] | null;
    ownsTransformRaster: boolean;
  } | null;
  pixels: PixelComparison;
  sourceDomMutationCount: number;
  warnings: string[];
  logicalPass: boolean;
  pass: boolean;
}

export type MutationKind =
  | "literal-matrix3d-attribute"
  | "simple-2d-submatrix"
  | "non-scaling-stroke-box"
  | "html-marker-root-measurement"
  | "nested-owner-below-svg-content"
  | "property-presence-routing";

export interface MutationResult {
  id: string;
  kind: MutationKind;
  discriminator: string;
  baseline: number | string | boolean;
  mutated: number | string | boolean;
  moved: boolean;
}

export interface InlineSvg3dGateReport {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevisions: typeof SOURCE_REVISIONS;
  fingerprint: {
    chromiumVersion: string;
    playwrightVersion: string;
    userAgent: string;
    os: NodeJS.Platform;
    osRelease: string;
    architecture: string;
    node: string;
    viewport: typeof VIEWPORT;
    deviceScaleFactors: number[];
    matrixEpsilon: number;
    maxAlphaBoundDeltaPx: number;
    maxAlphaMismatchFraction: number;
    maxRgbaMeanError: number;
  };
  corpus: {
    cases: number;
    routes: ExpectedRoute[];
    mutationKinds: MutationKind[];
  };
  rows: AuditRow[];
  mutations: MutationResult[];
  controls: Record<string, boolean>;
  summary: {
    logicalPassed: number;
    logicalFailed: number;
    pixelsPassed: number;
    pixelsFailed: number;
    mutationsMoved: number;
    mutationsFailed: number;
  };
  verdict: string;
}

const ROTATE_29_MATRIX = "matrix(0.8746197,0.4848096,-0.4848096,0.8746197,7.25,-3.5)";
const ROTATE_29_MATRIX3D = "matrix3d(0.8746197,0.4848096,0,0,-0.4848096,0.8746197,0,0,0,0,1,0,7.25,-3.5,0,1)";

export const INLINE_SVG_3D_CASES: AuditCase[] = [
  {
    id: "native-transform-attribute-negative",
    expectedRoute: "clone-equivalent",
    targetAttrs: 'transform="matrix(.92 .18 -.11 1.08 9 -6)"',
  },
  {
    id: "css-matrix-fill-box",
    expectedRoute: "clone-equivalent",
    targetCss: `transform-box:fill-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
  },
  {
    id: "css-matrix-stroke-box",
    expectedRoute: "clone-equivalent",
    targetCss: `transform-box:stroke-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
  },
  {
    id: "css-matrix-non-scaling-stroke",
    expectedRoute: "clone-equivalent",
    targetAttrs: 'vector-effect="non-scaling-stroke"',
    targetCss: `transform-box:stroke-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
  },
  {
    id: "css-matrix-content-box-alias",
    expectedRoute: "clone-equivalent",
    targetCss: `transform-box:content-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
  },
  {
    id: "css-matrix-border-box-alias",
    expectedRoute: "clone-equivalent",
    targetCss: `transform-box:border-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
  },
  {
    id: "css-matrix-view-box",
    expectedRoute: "clone-equivalent",
    targetCss: `transform-box:view-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
  },
  {
    id: "css-affine-matrix3d-fill-box",
    expectedRoute: "clone-equivalent",
    targetCss: `transform-box:fill-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX3D}`,
  },
  {
    id: "css-rotate-y-svg-flatten",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:fill-box;transform-origin:19% 77%;transform:rotateY(47deg)",
  },
  {
    id: "css-rotate-x-svg-flatten",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:fill-box;transform-origin:81% 17% 23px;transform:rotateX(39deg)",
  },
  {
    id: "css-rotate-3d-svg-flatten",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:fill-box;transform-origin:13% 86% 19px;transform:rotate3d(.3,.8,.5,41deg) translateZ(17px)",
  },
  {
    id: "css-rotate-y-stroke-box",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:stroke-box;transform-origin:19% 77%;transform:rotateY(47deg)",
  },
  {
    id: "css-rotate-y-view-box",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:view-box;transform-origin:19% 77%;transform:rotateY(47deg)",
  },
  {
    id: "css-rotate-y-z-origin",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:fill-box;transform-origin:19% 77% 31px;transform:rotateY(47deg)",
  },
  {
    id: "css-perspective-function-svg-flatten",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:perspective(260px) rotateY(43deg) translateZ(22px)",
  },
  {
    id: "css-independent-3d-properties",
    expectedRoute: "clone-equivalent",
    targetCss: "transform-box:fill-box;transform-origin:37% 61% 14px;translate:7px 11px 5px;rotate:y 31deg;scale:1.1 .85 1.2",
  },
  {
    id: "css-motion-path-plus-3d-transform",
    expectedRoute: "clone-equivalent",
    targetCss: 'transform-box:fill-box;transform-origin:30% 70% 8px;offset-path:path("M 0 0 C 15 30 35 -10 52 18");offset-distance:43%;offset-rotate:27deg;transform:rotateY(22deg)',
  },
  {
    id: "css-overrides-static-transform-attribute",
    expectedRoute: "clone-equivalent",
    targetAttrs: 'transform="translate(999 999)"',
    targetCss: "transform-box:fill-box;transform-origin:23% 71% 29px;transform:perspective(240px) rotateY(39deg) translateZ(17px)",
  },
  {
    id: "effective-zoom-svg-child",
    expectedRoute: "clone-equivalent",
    hostCss: "zoom:1.35",
    targetCss: "transform-box:stroke-box;transform-origin:29% 68% 17px;transform:rotateY(41deg) translateZ(12px)",
  },
  {
    id: "svg-layer-perspective-ignored",
    expectedRoute: "clone-equivalent",
    layerCss: "perspective:180px;perspective-origin:9% 91%;transform-style:preserve-3d",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:rotateY(43deg) translateZ(22px)",
  },
  {
    id: "svg-layer-flat-control",
    expectedRoute: "clone-equivalent",
    layerCss: "perspective:none;transform-style:flat",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:rotateY(43deg) translateZ(22px)",
  },
  {
    id: "svg-layer-preserve3d-flattens",
    expectedRoute: "clone-equivalent",
    layerCss: "transform-style:preserve-3d",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "svg-layer-grouping-opacity-flattens",
    expectedRoute: "clone-equivalent",
    layerCss: "transform-style:preserve-3d;opacity:.72",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "svg-layer-grouping-filter-flattens",
    expectedRoute: "clone-equivalent",
    layerCss: "transform-style:preserve-3d;filter:drop-shadow(2px 1px 0 rgb(20,160,90))",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "svg-layer-grouping-clip-flattens",
    expectedRoute: "clone-equivalent",
    layerCss: "transform-style:preserve-3d;clip-path:inset(3px 5px 7px 2px)",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "svg-layer-grouping-mask-flattens",
    expectedRoute: "clone-equivalent",
    layerCss: "transform-style:preserve-3d;mask-image:linear-gradient(90deg,transparent 0 8%,black 24% 100%)",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "svg-layer-grouping-overflow-flattens",
    expectedRoute: "clone-equivalent",
    layerCss: "transform-style:preserve-3d;overflow:hidden",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "root-svg-inert-perspective-vector",
    expectedRoute: "clone-equivalent",
    rootCss: "perspective:310px;perspective-origin:13% 86%;transform-style:preserve-3d",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:rotateY(48deg) translateZ(27px)",
  },
  {
    id: "root-svg-own-projective-transform-raster",
    expectedRoute: "promoted-inline-svg-raster",
    rootCss: "transform:perspective(310px) rotateY(48deg);transform-origin:13% 86%",
  },
  {
    id: "html-ancestor-perspective-raster",
    expectedRoute: "outer-raster",
    hostCss: "perspective:290px;perspective-origin:88% 17%;transform-style:preserve-3d",
    rootCss: "transform:rotateY(36deg) translateZ(18px);transform-origin:31% 74%",
  },
  {
    id: "foreign-object-nested-projective-owner-promoted",
    expectedRoute: "promoted-inline-svg-raster",
    foreignObject: true,
    foreignHostCss: "perspective:330px;perspective-origin:19% 79%;transform-style:preserve-3d",
    targetCss: "transform:rotateY(44deg) translateZ(24px);transform-origin:21% 76%",
  },
];

export const REQUIRED_INLINE_SVG_3D_MUTATIONS: MutationKind[] = [
  "literal-matrix3d-attribute",
  "simple-2d-submatrix",
  "non-scaling-stroke-box",
  "html-marker-root-measurement",
  "nested-owner-below-svg-content",
  "property-presence-routing",
];

export function validateInlineSvg3dCorpus(): string[] {
  const errors: string[] = [];
  const ids = new Set(INLINE_SVG_3D_CASES.map((test) => test.id));
  const requiredRows = [
    "native-transform-attribute-negative",
    "css-matrix-fill-box",
    "css-matrix-stroke-box",
    "css-matrix-non-scaling-stroke",
    "css-matrix-content-box-alias",
    "css-matrix-border-box-alias",
    "css-matrix-view-box",
    "css-affine-matrix3d-fill-box",
    "css-rotate-x-svg-flatten",
    "css-rotate-y-svg-flatten",
    "css-rotate-3d-svg-flatten",
    "css-rotate-y-z-origin",
    "css-perspective-function-svg-flatten",
    "css-independent-3d-properties",
    "css-motion-path-plus-3d-transform",
    "effective-zoom-svg-child",
    "svg-layer-perspective-ignored",
    "svg-layer-preserve3d-flattens",
    "svg-layer-grouping-opacity-flattens",
    "svg-layer-grouping-filter-flattens",
    "svg-layer-grouping-clip-flattens",
    "svg-layer-grouping-mask-flattens",
    "svg-layer-grouping-overflow-flattens",
    "root-svg-inert-perspective-vector",
    "root-svg-own-projective-transform-raster",
    "html-ancestor-perspective-raster",
    "foreign-object-nested-projective-owner-promoted",
  ];
  for (const id of requiredRows) if (!ids.has(id)) errors.push(`missing required row ${id}`);
  for (const route of ["clone-equivalent", "outer-raster", "promoted-inline-svg-raster"] as const) {
    if (!INLINE_SVG_3D_CASES.some((test) => test.expectedRoute === route)) errors.push(`missing route ${route}`);
  }
  if (new Set(INLINE_SVG_3D_CASES.map((test) => test.id)).size !== INLINE_SVG_3D_CASES.length) {
    errors.push("case ids must be unique");
  }
  if (new Set(REQUIRED_INLINE_SVG_3D_MUTATIONS).size !== 6) errors.push("six distinct mutation kinds are required");
  return errors;
}

function matrixDelta(a: Matrix2D | null, b: Matrix2D | null): number {
  if (a == null || b == null) return Number.POSITIVE_INFINITY;
  return Math.max(...a.map((value, index) => Math.abs(value - b[index])));
}

function findInlineSvg(elements: CapturedElement[]): CapturedElement | null {
  for (const element of elements) {
    if (element.tag === "svg" && element.svgContent != null) return element;
    const nested = findInlineSvg(element.children ?? []);
    if (nested != null) return nested;
  }
  return null;
}

function rasterFacts(elements: CapturedElement[]): { count: number; effective: number; paths: string[] } {
  let count = 0;
  let effective = 0;
  const paths: string[] = [];
  const walk = (nodes: CapturedElement[], path: string, suppressedByInlineSvg: boolean): void => {
    for (let index = 0; index < nodes.length; index++) {
      const element = nodes[index];
      const currentPath = `${path}/${element.tag}[${index}]`;
      if (element.transformSubtreeRaster?.dataUri != null) {
        count++;
        paths.push(currentPath);
        if (!suppressedByInlineSvg) effective++;
      }
      // paintInlineSvg owns the complete subtree. A raster recorded below this
      // point exists in the serialized tree but is never visited by render.
      const suppressChildren = suppressedByInlineSvg || element.svgContent != null;
      walk(element.children ?? [], currentPath, suppressChildren);
    }
  };
  walk(elements, "", false);
  return { count, effective, paths };
}

function quadAffineResidual(quad: Quad | null): number {
  if (quad == null) return Number.POSITIVE_INFINITY;
  const dx = quad[2].x - (quad[1].x + quad[3].x - quad[0].x);
  const dy = quad[2].y - (quad[1].y + quad[3].y - quad[0].y);
  return Math.hypot(dx, dy);
}

function alphaBounds(data: Buffer, width: number, height: number, channels: number): InkBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + 3];
      if (alpha <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels++;
    }
  }
  return pixels === 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels };
}

function boundsDelta(left: InkBounds | null, right: InkBounds | null): number | null {
  if (left == null && right == null) return 0;
  if (left == null || right == null) return null;
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

async function compareFinalPixels(sourcePng: Buffer, generatedPng: Buffer): Promise<PixelComparison> {
  const [source, generated] = await Promise.all([
    sharp(sourcePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(generatedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (source.info.width !== generated.info.width || source.info.height !== generated.info.height) {
    throw new Error(`pixel-leg size mismatch: ${source.info.width}x${source.info.height} vs ${generated.info.width}x${generated.info.height}`);
  }
  const pixels = source.info.width * source.info.height;
  let sourceAlphaPixels = 0;
  let generatedAlphaPixels = 0;
  let alphaUnionPixels = 0;
  let alphaMismatchedPixels = 0;
  let rgbaError = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    const sourceAlpha = source.data[offset + 3];
    const generatedAlpha = generated.data[offset + 3];
    const sourcePaints = sourceAlpha > 8;
    const generatedPaints = generatedAlpha > 8;
    if (sourcePaints) sourceAlphaPixels++;
    if (generatedPaints) generatedAlphaPixels++;
    if (!sourcePaints && !generatedPaints) continue;
    alphaUnionPixels++;
    if (Math.abs(sourceAlpha - generatedAlpha) > 16) alphaMismatchedPixels++;
    for (let channel = 0; channel < 4; channel++) {
      rgbaError += Math.abs(source.data[offset + channel] - generated.data[offset + channel]);
    }
  }
  const sourceAlphaBounds = alphaBounds(source.data, source.info.width, source.info.height, 4);
  const generatedAlphaBounds = alphaBounds(generated.data, generated.info.width, generated.info.height, 4);
  const alphaBoundsDelta = boundsDelta(sourceAlphaBounds, generatedAlphaBounds);
  const alphaMismatchFraction = alphaUnionPixels === 0 ? 0 : alphaMismatchedPixels / alphaUnionPixels;
  const rgbaMeanError = alphaUnionPixels === 0 ? 0 : rgbaError / (alphaUnionPixels * 4 * 255);
  const pass = alphaBoundsDelta != null
    && alphaBoundsDelta <= MAX_ALPHA_BOUND_DELTA_PX
    && alphaMismatchFraction <= MAX_ALPHA_MISMATCH_FRACTION
    && rgbaMeanError <= MAX_RGBA_MEAN_ERROR;
  return {
    width: source.info.width,
    height: source.info.height,
    sourceAlphaPixels,
    generatedAlphaPixels,
    alphaUnionPixels,
    alphaMismatchedPixels,
    alphaMismatchFraction,
    rgbaMeanError,
    alphaBoundsDelta,
    sourceAlphaBounds,
    generatedAlphaBounds,
    pass,
  };
}

function htmlFor(test: AuditCase): string {
  const target = test.foreignObject
    ? `<foreignObject x="38" y="31" width="104" height="76"><div xmlns="http://www.w3.org/1999/xhtml" id="fohost"><div id="target"></div></div></foreignObject>`
    : `<rect id="target" x="38" y="31" width="104" height="76" rx="7" fill="rgb(21,82,214)" stroke="rgb(212,43,61)" stroke-width="12" ${test.targetAttrs ?? ""}/>`;
  return `<!doctype html><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:transparent;overflow:hidden}
    #scene{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px}
    #host{position:absolute;left:70px;top:38px;width:280px;height:184px;${test.hostCss ?? ""}}
    #art{display:block;width:280px;height:184px;overflow:visible;${test.rootCss ?? ""}}
    #layer{${test.layerCss ?? ""}}
    #fohost{width:104px;height:76px;${test.foreignHostCss ?? ""}}
    #fohost #target{width:104px;height:76px;background:rgb(21,82,214)}
    #target{${test.targetCss ?? ""}}
    ${test.extraCss ?? ""}
  </style><div id="scene"><div id="host"><svg id="art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 138"><g id="layer">${target}</g></svg></div></div>`;
}

async function contentQuad(page: Page, selector: string): Promise<Quad | null> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (nodeId === 0) return null;
    const response = await session.send("DOM.getContentQuads", { nodeId });
    const values = response.quads[0];
    if (values == null || values.length !== 8) return null;
    return [
      { x: values[0], y: values[1] },
      { x: values[2], y: values[3] },
      { x: values[4], y: values[5] },
      { x: values[6], y: values[7] },
    ];
  } finally {
    await session.detach();
  }
}

async function readFacts(page: Page): Promise<DomFacts> {
  const facts = await page.locator("#target").evaluate((target) => {
    const svgTarget = target as SVGGraphicsElement;
    const style = getComputedStyle(target);
    const box = typeof svgTarget.getBBox === "function" ? svgTarget.getBBox() : { x: 0, y: 0, width: 0, height: 0 };
    const rect = target.getBoundingClientRect();
    const ctm = typeof svgTarget.getCTM === "function" ? svgTarget.getCTM() : null;
    const screenCtm = typeof svgTarget.getScreenCTM === "function" ? svgTarget.getScreenCTM() : null;
    const parentSvg = target.parentElement as SVGGraphicsElement | null;
    const parentCtm = parentSvg != null && typeof parentSvg.getCTM === "function" ? parentSvg.getCTM() : null;
    const localCtm = ctm != null && parentCtm != null ? parentCtm.inverse().multiply(ctm) : null;
    return {
      computedTransform: style.transform,
      computedTransformBox: style.transformBox,
      computedTransformOrigin: style.transformOrigin,
      computedTransformStyle: style.transformStyle,
      computedPerspective: style.perspective,
      bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
      clientRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ctm: ctm == null ? null : [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f] as [number, number, number, number, number, number],
      localCtm: localCtm == null ? null : [localCtm.a, localCtm.b, localCtm.c, localCtm.d, localCtm.e, localCtm.f] as [number, number, number, number, number, number],
      screenCtm: screenCtm == null ? null : [screenCtm.a, screenCtm.b, screenCtm.c, screenCtm.d, screenCtm.e, screenCtm.f] as [number, number, number, number, number, number],
    };
  });
  return { ...facts, quad: await contentQuad(page, "#target") };
}

async function readClone(page: Page, svgContent: string): Promise<{ facts: DomFacts; transformAttribute: string | null }> {
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:white}</style>${svgContent}`, { waitUntil: "load" });
  const facts = await readFacts(page);
  const transformAttribute = await page.locator("#target").getAttribute("transform");
  return { facts, transformAttribute };
}

function matricesEqual(a: AuditRow | undefined, b: AuditRow | undefined): boolean {
  return a != null && b != null && matrixDelta(a.source.localCtm, b.source.localCtm) <= MATRIX_EPSILON;
}

async function measureUnsafeMatrixMutations(page: Page): Promise<{
  literalMatrix3dDelta: number;
  simpleSubmatrixDelta: number;
}> {
  const markup = `<svg width="240" height="140"><rect id="mutation-target" x="45" y="28" width="96" height="54" style="transform:perspective(230px) rotateY(43deg) translateZ(22px);transform-origin:17% 83% 31px;transform-box:fill-box"/></svg>`;
  const measure = async (kind: "literal" | "submatrix") => {
    await page.setContent(markup);
    return page.locator("#mutation-target").evaluate((node, mutationKind) => {
      const target = node as SVGGraphicsElement;
      const parent = target.parentElement as SVGGraphicsElement;
      const used = parent.getCTM()!.inverse().multiply(target.getCTM()!);
      const computed = getComputedStyle(target).transform;
      const matrix3d = new DOMMatrix(computed);
      const mutation = mutationKind === "literal"
        ? computed
        : `matrix(${matrix3d.m11} ${matrix3d.m12} ${matrix3d.m21} ${matrix3d.m22} ${matrix3d.m41} ${matrix3d.m42})`;
      target.removeAttribute("style");
      target.setAttribute("transform", mutation);
      const actual = parent.getCTM()!.inverse().multiply(target.getCTM()!);
      return Math.max(
        Math.abs(used.a - actual.a), Math.abs(used.b - actual.b),
        Math.abs(used.c - actual.c), Math.abs(used.d - actual.d),
        Math.abs(used.e - actual.e), Math.abs(used.f - actual.f),
      );
    }, kind);
  };
  return {
    literalMatrix3dDelta: await measure("literal"),
    simpleSubmatrixDelta: await measure("submatrix"),
  };
}

async function htmlMarkerCanMeasureSvgRoot(page: Page): Promise<boolean> {
  await page.setContent(`<style>html,body{margin:0}#host{position:absolute;left:73px;top:41px;zoom:1.35}</style><div id="host"><svg id="marker-root" width="220" height="130" viewBox="0 0 220 130"><rect width="80" height="50"/></svg></div>`);
  return page.locator("#marker-root").evaluate((svg) => {
    const marker = document.createElement("span");
    marker.style.cssText = "position:absolute;left:11px;top:7px;width:1px;height:1px";
    svg.appendChild(marker);
    try {
      const rect = marker.getBoundingClientRect();
      return marker.namespaceURI === "http://www.w3.org/1999/xhtml"
        && rect.width > 0 && rect.height > 0
        && Number.isFinite(rect.x) && Number.isFinite(rect.y);
    } finally {
      marker.remove();
    }
  });
}

function buildMutationResults(
  rows: AuditRow[],
  unsafe: Awaited<ReturnType<typeof measureUnsafeMatrixMutations>>,
  markerUsable: boolean,
): MutationResult[] {
  const firstDpr = Math.min(...rows.map((row) => row.deviceScaleFactor));
  const byId = new Map(rows.filter((row) => row.deviceScaleFactor === firstDpr).map((row) => [row.id, row]));
  const nonScaling = byId.get("css-matrix-non-scaling-stroke");
  const fill = byId.get("css-matrix-fill-box");
  const stroke = byId.get("css-matrix-stroke-box");
  const nonScalingBaselineDelta = nonScaling == null || fill == null
    ? Number.POSITIVE_INFINITY
    : matrixDelta(nonScaling.source.localCtm, fill.source.localCtm);
  const nonScalingMutantDelta = nonScaling == null || stroke == null
    ? 0
    : matrixDelta(nonScaling.source.localCtm, stroke.source.localCtm);
  const foreign = byId.get("foreign-object-nested-projective-owner-promoted");
  const inert = byId.get("root-svg-inert-perspective-vector");
  return [
    {
      id: "mutation.literal-matrix3d-attribute",
      kind: "literal-matrix3d-attribute",
      discriminator: "An SVG transform attribute cannot consume the computed CSS matrix3d string as Blink's used local affine.",
      baseline: 0,
      mutated: unsafe.literalMatrix3dDelta,
      moved: unsafe.literalMatrix3dDelta > 1,
    },
    {
      id: "mutation.simple-2d-submatrix",
      kind: "simple-2d-submatrix",
      discriminator: "Selecting m11/m12/m21/m22/m41/m42 drops origin and perspective flattening and must move the used local matrix.",
      baseline: 0,
      mutated: unsafe.simpleSubmatrixDelta,
      moved: unsafe.simpleSubmatrixDelta > 1,
    },
    {
      id: "mutation.non-scaling-stroke-box",
      kind: "non-scaling-stroke-box",
      discriminator: "Blink aliases non-scaling-stroke stroke-box to fill-box; retaining stroke-box must select a distinct origin.",
      baseline: nonScalingBaselineDelta,
      mutated: nonScalingMutantDelta,
      moved: nonScalingBaselineDelta <= MATRIX_EPSILON && nonScalingMutantDelta > 1,
    },
    {
      id: "mutation.html-marker-root-measurement",
      kind: "html-marker-root-measurement",
      discriminator: "A bare HTML marker appended under an SVG root has no usable SVG paint box and cannot own root transform measurement.",
      baseline: true,
      mutated: markerUsable,
      moved: markerUsable === false,
    },
    {
      id: "mutation.nested-owner-below-svg-content",
      kind: "nested-owner-below-svg-content",
      discriminator: "A projective raster left below opaque svgContent is unreachable; promotion changes effective ownership from zero to one.",
      baseline: foreign?.effectiveRasterOwnerCount ?? 0,
      mutated: 0,
      moved: foreign?.effectiveRasterOwnerCount === 1 && foreign.capturedInlineSvg?.ownsTransformRaster === true,
    },
    {
      id: "mutation.property-presence-routing",
      kind: "property-presence-routing",
      discriminator: "Perspective/preserve-3d property presence on an SVG root is inert after used flattening and must not substitute for measured paint activation.",
      baseline: inert?.rasterOwnerCount ?? -1,
      mutated: 1,
      moved: inert?.rasterOwnerCount === 0,
    },
  ];
}

export async function runInlineSvg3dAudit(options: {
  deviceScaleFactors?: number[];
} = {}): Promise<InlineSvg3dGateReport> {
  const corpusErrors = validateInlineSvg3dCorpus();
  if (corpusErrors.length > 0) throw new Error(`invalid inline-SVG 3D corpus:\n${corpusErrors.join("\n")}`);
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const [{ captureElementTreeWithWarnings }, { elementTreeToSvg }] = await Promise.all([
    import("../src/capture/index.js"),
    import("../src/render/element-tree-to-svg.js"),
  ]);
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const deviceScaleFactors = [...new Set(options.deviceScaleFactors ?? [1, 2])].sort((a, b) => a - b);
  if (deviceScaleFactors.length === 0 || deviceScaleFactors.some((dpr) => !Number.isFinite(dpr) || dpr <= 0)) {
    throw new Error("--dpr requires one or more positive finite numbers");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const rows: AuditRow[] = [];
    let userAgent = "";
    for (const deviceScaleFactor of deviceScaleFactors) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
      const page = await context.newPage();
      const clonePage = await context.newPage();
      const generatedPage = await context.newPage();
      try {
        if (userAgent === "") userAgent = await page.evaluate(() => navigator.userAgent);
        for (const test of INLINE_SVG_3D_CASES) {
          await page.setContent(htmlFor(test), { waitUntil: "load" });
          await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
          await page.evaluate(() => {
            const state = { htmlUnderSvg: 0 };
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                if (!(record.target instanceof SVGElement)) continue;
                for (const node of record.addedNodes) {
                  if (node instanceof HTMLElement) state.htmlUnderSvg++;
                }
              }
            });
            observer.observe(document, { childList: true, subtree: true });
            (globalThis as typeof globalThis & { __dm2475MutationState?: typeof state }).__dm2475MutationState = state;
            (globalThis as typeof globalThis & { __dm2475MutationObserver?: MutationObserver }).__dm2475MutationObserver = observer;
          });
          const sourcePng = await page.screenshot({ type: "png", omitBackground: true });
          const source = await readFacts(page);
          const { tree, warnings } = await captureElementTreeWithWarnings(
            page,
            "#scene",
            { x: 0, y: 0, ...VIEWPORT },
          );
          const sourceDomMutationCount = await page.evaluate(() => {
            const scope = globalThis as typeof globalThis & {
              __dm2475MutationState?: { htmlUnderSvg: number };
              __dm2475MutationObserver?: MutationObserver;
            };
            scope.__dm2475MutationObserver?.disconnect();
            const count = scope.__dm2475MutationState?.htmlUnderSvg ?? 0;
            delete scope.__dm2475MutationObserver;
            delete scope.__dm2475MutationState;
            return count;
          });
          const inlineSvg = findInlineSvg(tree);
          const raster = rasterFacts(tree);
          const cloneResult = inlineSvg?.svgContent == null
            ? null
            : await readClone(clonePage, inlineSvg.svgContent);
          const delta = cloneResult == null
            ? Number.POSITIVE_INFINITY
            : matrixDelta(source.localCtm, cloneResult.facts.localCtm);
          const transformRaster = raster.count > 0;
          const logicalPass = test.expectedRoute === "outer-raster"
            ? raster.effective === 1
            : test.expectedRoute === "promoted-inline-svg-raster"
              ? raster.count === 1 && raster.effective === 1 && inlineSvg?.transformSubtreeRaster?.dataUri != null
              : raster.count === 0 && delta <= MATRIX_EPSILON;
          const generatedSvg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: deviceScaleFactor });
          await generatedPage.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${generatedSvg}`, { waitUntil: "load" });
          await generatedPage.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
          const generatedPng = await generatedPage.screenshot({ type: "png", omitBackground: true });
          const pixels = await compareFinalPixels(sourcePng, generatedPng);
          rows.push({
            id: test.id,
            deviceScaleFactor,
            expectedRoute: test.expectedRoute,
            source,
            clone: cloneResult?.facts ?? null,
            clonedTransformAttribute: cloneResult?.transformAttribute ?? null,
            matrixDelta: delta,
            quadAffineResidual: quadAffineResidual(source.quad),
            transformRaster,
            rasterOwnerCount: raster.count,
            effectiveRasterOwnerCount: raster.effective,
            rasterOwnerPaths: raster.paths,
            capturedInlineSvg: inlineSvg == null ? null : {
              storedTransform: inlineSvg.styles.transform ?? null,
              projectiveTransform: inlineSvg.projectiveTransform ?? null,
              ownsTransformRaster: inlineSvg.transformSubtreeRaster?.dataUri != null,
            },
            pixels,
            sourceDomMutationCount,
            warnings: warnings.map((warning) => `${warning.feature}: ${warning.detail}`),
            logicalPass,
            pass: logicalPass && pixels.pass && sourceDomMutationCount === 0,
          });
        }
      } finally {
        await context.close();
      }
    }

    const mutationContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: deviceScaleFactors[0] });
    const mutationPage = await mutationContext.newPage();
    let unsafeMutations: Awaited<ReturnType<typeof measureUnsafeMatrixMutations>>;
    let markerUsable: boolean;
    try {
      unsafeMutations = await measureUnsafeMatrixMutations(mutationPage);
      markerUsable = await htmlMarkerCanMeasureSvgRoot(mutationPage);
    } finally {
      await mutationContext.close();
    }
    const mutations = buildMutationResults(rows, unsafeMutations, markerUsable);

    const firstDpr = deviceScaleFactors[0];
    const byId = new Map(rows.filter((row) => row.deviceScaleFactor === firstDpr).map((row) => [row.id, row]));
    const referenceMatrices = [
      byId.get("css-matrix-fill-box")?.source.localCtm,
      byId.get("css-matrix-stroke-box")?.source.localCtm,
      byId.get("css-matrix-view-box")?.source.localCtm,
    ];
    const referenceBoxesDistinct = referenceMatrices.every((matrix) => matrix != null)
      && matrixDelta(referenceMatrices[0]!, referenceMatrices[1]!) > 1
      && matrixDelta(referenceMatrices[1]!, referenceMatrices[2]!) > 1;
    const controls = {
      staticAttributeRoundTrips: (byId.get("native-transform-attribute-negative")?.matrixDelta ?? Infinity) <= MATRIX_EPSILON,
      referenceBoxesDistinct,
      nonScalingStrokeUsesFillBox: matricesEqual(
        byId.get("css-matrix-non-scaling-stroke"),
        byId.get("css-matrix-fill-box"),
      ),
      contentBoxUsesFillBox: matricesEqual(
        byId.get("css-matrix-content-box-alias"),
        byId.get("css-matrix-fill-box"),
      ),
      borderBoxUsesStrokeBox: matricesEqual(
        byId.get("css-matrix-border-box-alias"),
        byId.get("css-matrix-stroke-box"),
      ),
      svgPerspectivePropertyIgnored: matricesEqual(
        byId.get("svg-layer-perspective-ignored"),
        byId.get("svg-layer-flat-control"),
      ),
      svgChildPreserve3dFlattens: matricesEqual(
        byId.get("svg-layer-preserve3d-flattens"),
        byId.get("svg-layer-grouping-opacity-flattens"),
      ),
      zOriginMovesBlinkAnswer: !matricesEqual(
        byId.get("css-rotate-y-z-origin"),
        byId.get("css-rotate-y-svg-flatten"),
      ),
      everyVectorTransformIsValidSvgMatrix: rows
        .filter((row) => row.expectedRoute === "clone-equivalent")
        .every((row) => row.clonedTransformAttribute?.startsWith("matrix(") === true
          && !row.clonedTransformAttribute.includes("matrix3d")),
      everyOuterProjectiveRowHasOneOwner: rows
        .filter((row) => row.expectedRoute === "outer-raster")
        .every((row) => row.effectiveRasterOwnerCount === 1),
      nestedForeignObjectOwnerIsPromoted: (byId.get("foreign-object-nested-projective-owner-promoted")?.capturedInlineSvg?.ownsTransformRaster) === true,
      inlineSvgProjectiveRootIsOwned: (byId.get("root-svg-own-projective-transform-raster")?.capturedInlineSvg?.ownsTransformRaster) === true,
      inertSvgPerspectiveStaysVector: (byId.get("root-svg-inert-perspective-vector")?.rasterOwnerCount) === 0
        && (byId.get("svg-layer-perspective-ignored")?.rasterOwnerCount) === 0,
      everyScenarioHasEveryCase: deviceScaleFactors.every((dpr) =>
        rows.filter((row) => row.deviceScaleFactor === dpr).length === INLINE_SVG_3D_CASES.length),
      everyFinalSvgPixelLegPasses: rows.every((row) => row.pixels.pass),
      sourceDomWasNotPollutedByHtmlMarkers: rows.every((row) => row.sourceDomMutationCount === 0),
      everyRequiredMutationMoves: mutations.length === REQUIRED_INLINE_SVG_3D_MUTATIONS.length
        && mutations.every((mutation) => mutation.moved),
    };
    const pass = rows.every((row) => row.pass)
      && mutations.every((mutation) => mutation.moved)
      && Object.values(controls).every(Boolean);
    const logicalPassed = rows.filter((row) => row.logicalPass).length;
    const pixelsPassed = rows.filter((row) => row.pixels.pass).length;
    const mutationsMoved = mutations.filter((mutation) => mutation.moved).length;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRevisions: SOURCE_REVISIONS,
      fingerprint: {
        chromiumVersion: browser.version(),
        playwrightVersion,
        userAgent,
        os: platform(),
        osRelease: release(),
        architecture: arch(),
        node: process.version,
        viewport: VIEWPORT,
        deviceScaleFactors,
        matrixEpsilon: MATRIX_EPSILON,
        maxAlphaBoundDeltaPx: MAX_ALPHA_BOUND_DELTA_PX,
        maxAlphaMismatchFraction: MAX_ALPHA_MISMATCH_FRACTION,
        maxRgbaMeanError: MAX_RGBA_MEAN_ERROR,
      },
      corpus: {
        cases: INLINE_SVG_3D_CASES.length,
        routes: ["clone-equivalent", "outer-raster", "promoted-inline-svg-raster"],
        mutationKinds: REQUIRED_INLINE_SVG_3D_MUTATIONS,
      },
      rows,
      mutations,
      controls,
      summary: {
        logicalPassed,
        logicalFailed: rows.length - logicalPassed,
        pixelsPassed,
        pixelsFailed: rows.length - pixelsPassed,
        mutationsMoved,
        mutationsFailed: mutations.length - mutationsMoved,
      },
      verdict: pass ? "hard-two-leg-inline-svg-3d-parity" : "inline-svg-3d-parity-failure",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const dprIndex = process.argv.indexOf("--dpr");
  const deviceScaleFactors = dprIndex >= 0 && process.argv[dprIndex + 1] != null
    ? process.argv[dprIndex + 1].split(",").map(Number)
    : [1, 2];
  const report = await runInlineSvg3dAudit({ deviceScaleFactors });
  const jsonIndex = process.argv.indexOf("--json");
  const reportPath = resolve(jsonIndex >= 0 && process.argv[jsonIndex + 1] != null
    ? process.argv[jsonIndex + 1]
    : `tests/output/inline-svg-3d-gate-${platform()}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const failures = report.rows.filter((row) => !row.pass);
  console.log(`inline SVG 3D gate: ${report.rows.length - failures.length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    const delta = Number.isFinite(row.matrixDelta) ? row.matrixDelta.toFixed(4) : "inf";
    const residual = Number.isFinite(row.quadAffineResidual) ? row.quadAffineResidual.toFixed(4) : "inf";
    const alpha = (row.pixels.alphaMismatchFraction * 100).toFixed(3);
    const rgba = (row.pixels.rgbaMeanError * 100).toFixed(3);
    console.log(`${row.pass ? "PASS" : "FAIL"} dpr=${row.deviceScaleFactor} ${row.id}: route=${row.expectedRoute}, matrix-delta=${delta}, quad-residual=${residual}, alpha-mismatch=${alpha}%, rgba-error=${rgba}%, bound-delta=${row.pixels.alphaBoundsDelta ?? "missing"}, raster-owners=${row.rasterOwnerCount}/${row.effectiveRasterOwnerCount} effective`);
  }
  for (const mutation of report.mutations) console.log(`${mutation.moved ? "PASS" : "FAIL"} ${mutation.id}: baseline=${mutation.baseline}, mutated=${mutation.mutated}`);
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  console.log(`report: ${reportPath}`);
  return failures.length === 0
    && report.mutations.every((mutation) => mutation.moved)
    && Object.values(report.controls).every(Boolean) ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
