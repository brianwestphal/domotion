#!/usr/bin/env tsx
/**
 * DM-2371 investigation probe.
 *
 * This is intentionally observational. It compares Blink's used affine CTM
 * for an SVG graphics element with the CTM obtained after Domotion clones and
 * re-embeds that inline SVG, and separately records when the existing outer
 * Chromium-surface boundary activates. It does not change capture routing.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import type { CapturedElement } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;
const VIEWPORT = { width: 420, height: 260 };
const MATRIX_EPSILON = 0.02;

type Matrix2D = [number, number, number, number, number, number];
type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];

type ExpectedRoute =
  | "clone-equivalent"
  | "clone-gap"
  | "spurious-raster"
  | "hidden-spurious-raster-owner"
  | "outer-raster"
  | "missed-outer-raster"
  | "hidden-raster-owner";

interface AuditCase {
  id: string;
  expectedRoute: ExpectedRoute;
  rootCss?: string;
  hostCss?: string;
  layerCss?: string;
  targetCss?: string;
  targetAttrs?: string;
  foreignObject?: boolean;
  foreignHostCss?: string;
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

interface AuditRow {
  id: string;
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
  warnings: string[];
  pass: boolean;
}

const ROTATE_29_MATRIX = "matrix(0.8746197,0.4848096,-0.4848096,0.8746197,7.25,-3.5)";
const ROTATE_29_MATRIX3D = "matrix3d(0.8746197,0.4848096,0,0,-0.4848096,0.8746197,0,0,0,0,1,0,7.25,-3.5,0,1)";

const CASES: AuditCase[] = [
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
    expectedRoute: "clone-gap",
    targetAttrs: 'vector-effect="non-scaling-stroke"',
    targetCss: `transform-box:stroke-box;transform-origin:23% 81%;transform:${ROTATE_29_MATRIX}`,
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
    expectedRoute: "clone-gap",
    targetCss: "transform-box:fill-box;transform-origin:19% 77%;transform:rotateY(47deg)",
  },
  {
    id: "css-rotate-y-stroke-box",
    expectedRoute: "clone-gap",
    targetCss: "transform-box:stroke-box;transform-origin:19% 77%;transform:rotateY(47deg)",
  },
  {
    id: "css-rotate-y-view-box",
    expectedRoute: "clone-gap",
    targetCss: "transform-box:view-box;transform-origin:19% 77%;transform:rotateY(47deg)",
  },
  {
    id: "css-rotate-y-z-origin",
    expectedRoute: "clone-gap",
    targetCss: "transform-box:fill-box;transform-origin:19% 77% 31px;transform:rotateY(47deg)",
  },
  {
    id: "css-perspective-function-svg-flatten",
    expectedRoute: "clone-gap",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:perspective(260px) rotateY(43deg) translateZ(22px)",
  },
  {
    id: "svg-layer-perspective-ignored",
    expectedRoute: "hidden-spurious-raster-owner",
    layerCss: "perspective:180px;perspective-origin:9% 91%;transform-style:preserve-3d",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:rotateY(43deg) translateZ(22px)",
  },
  {
    id: "svg-layer-flat-control",
    expectedRoute: "clone-gap",
    layerCss: "perspective:none;transform-style:flat",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:rotateY(43deg) translateZ(22px)",
  },
  {
    id: "svg-layer-preserve3d-flattens",
    expectedRoute: "clone-gap",
    layerCss: "transform-style:preserve-3d",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "svg-layer-grouping-opacity-flattens",
    expectedRoute: "clone-gap",
    layerCss: "transform-style:preserve-3d;opacity:.72",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:translateZ(35px) rotateY(31deg)",
  },
  {
    id: "root-svg-inert-perspective-spurious-raster",
    expectedRoute: "spurious-raster",
    rootCss: "perspective:310px;perspective-origin:13% 86%;transform-style:preserve-3d",
    targetCss: "transform-box:fill-box;transform-origin:17% 83%;transform:rotateY(48deg) translateZ(27px)",
  },
  {
    id: "root-svg-own-projective-transform-raster",
    expectedRoute: "missed-outer-raster",
    rootCss: "transform:perspective(310px) rotateY(48deg);transform-origin:13% 86%",
  },
  {
    id: "html-ancestor-perspective-raster",
    expectedRoute: "outer-raster",
    hostCss: "perspective:290px;perspective-origin:88% 17%;transform-style:preserve-3d",
    rootCss: "transform:rotateY(36deg) translateZ(18px);transform-origin:31% 74%",
  },
  {
    id: "foreign-object-nested-projective-owner-hidden",
    expectedRoute: "hidden-raster-owner",
    foreignObject: true,
    foreignHostCss: "perspective:330px;perspective-origin:19% 79%;transform-style:preserve-3d",
    targetCss: "transform:rotateY(44deg) translateZ(24px);transform-origin:21% 76%",
  },
];

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

function htmlFor(test: AuditCase): string {
  const target = test.foreignObject
    ? `<foreignObject x="38" y="31" width="104" height="76"><div xmlns="http://www.w3.org/1999/xhtml" id="fohost"><div id="target"></div></div></foreignObject>`
    : `<rect id="target" x="38" y="31" width="104" height="76" rx="7" fill="rgb(21,82,214)" stroke="rgb(212,43,61)" stroke-width="12" ${test.targetAttrs ?? ""}/>`;
  return `<!doctype html><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:white;overflow:hidden}
    #scene{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px}
    #host{position:absolute;left:70px;top:38px;width:280px;height:184px;${test.hostCss ?? ""}}
    #art{display:block;width:280px;height:184px;overflow:visible;${test.rootCss ?? ""}}
    #layer{${test.layerCss ?? ""}}
    #fohost{width:104px;height:76px;${test.foreignHostCss ?? ""}}
    #fohost #target{width:104px;height:76px;background:rgb(21,82,214)}
    #target{${test.targetCss ?? ""}}
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

export async function runInlineSvg3dAudit(): Promise<{
  sourceRevisions: typeof SOURCE_REVISIONS;
  chromiumVersion: string;
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  rows: AuditRow[];
  controls: Record<string, boolean>;
  verdict: string;
}> {
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const { captureElementTreeWithWarnings } = await import("../src/capture/index.js");
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const clonePage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const rows: AuditRow[] = [];
    for (const test of CASES) {
      await page.setContent(htmlFor(test), { waitUntil: "load" });
      const source = await readFacts(page);
      const { tree, warnings } = await captureElementTreeWithWarnings(
        page,
        "#scene",
        { x: 0, y: 0, ...VIEWPORT },
      );
      const inlineSvg = findInlineSvg(tree);
      const raster = rasterFacts(tree);
      const cloneResult = inlineSvg?.svgContent == null
        ? null
        : await readClone(clonePage, inlineSvg.svgContent);
      const delta = cloneResult == null
        ? Number.POSITIVE_INFINITY
        : matrixDelta(source.localCtm, cloneResult.facts.localCtm);
      const transformRaster = raster.count > 0;
      const pass = test.expectedRoute === "outer-raster"
        ? raster.effective === 1
        : test.expectedRoute === "spurious-raster"
          ? raster.effective === 1 && quadAffineResidual(source.quad) <= MATRIX_EPSILON
          : test.expectedRoute === "hidden-spurious-raster-owner"
            ? raster.count === 1 && raster.effective === 0 && quadAffineResidual(source.quad) <= MATRIX_EPSILON
            : test.expectedRoute === "hidden-raster-owner"
              ? raster.count === 1 && raster.effective === 0 && quadAffineResidual(source.quad) > MATRIX_EPSILON
              : test.expectedRoute === "missed-outer-raster"
                ? raster.effective === 0 && quadAffineResidual(source.quad) > MATRIX_EPSILON
            : test.expectedRoute === "clone-equivalent"
              ? raster.count === 0 && delta <= MATRIX_EPSILON
              : raster.count === 0 && delta > MATRIX_EPSILON;
      rows.push({
        id: test.id,
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
        warnings: warnings.map((warning) => `${warning.feature}: ${warning.message}`),
        pass,
      });
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
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
      svgPerspectivePropertyIgnored: matricesEqual(
        byId.get("svg-layer-perspective-ignored"),
        byId.get("svg-layer-flat-control"),
      ),
      svgChildPreserve3dFlattens: matricesEqual(
        byId.get("svg-layer-preserve3d-flattens"),
        byId.get("svg-layer-grouping-opacity-flattens"),
      ),
      zOriginMovesCloneAnswer: (byId.get("css-rotate-y-z-origin")?.matrixDelta ?? 0) > MATRIX_EPSILON,
      everyOuterProjectiveRowHasOneOwner: rows
        .filter((row) => row.expectedRoute === "outer-raster")
        .every((row) => row.effectiveRasterOwnerCount === 1),
      nestedForeignObjectOwnerIsSuppressed: rows
        .filter((row) => row.expectedRoute === "hidden-raster-owner")
        .every((row) => row.rasterOwnerCount === 1 && row.effectiveRasterOwnerCount === 0),
      inlineSvgProjectiveRootIsMissed: rows
        .filter((row) => row.expectedRoute === "missed-outer-raster")
        .every((row) => row.quadAffineResidual > MATRIX_EPSILON && row.effectiveRasterOwnerCount === 0),
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
      verdict: pass ? "source-boundary-and-current-inline-svg-gaps-observed" : "probe-expectation-or-source-drift",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runInlineSvg3dAudit();
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  const failures = report.rows.filter((row) => !row.pass);
  console.log(`inline SVG 3D audit: ${report.rows.length - failures.length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    const delta = Number.isFinite(row.matrixDelta) ? row.matrixDelta.toFixed(4) : "inf";
    const residual = Number.isFinite(row.quadAffineResidual) ? row.quadAffineResidual.toFixed(4) : "inf";
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id}: route=${row.expectedRoute}, matrix-delta=${delta}, quad-residual=${residual}, raster-owners=${row.rasterOwnerCount}/${row.effectiveRasterOwnerCount} effective, cloned=${row.clonedTransformAttribute ?? "none"}`);
  }
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  return failures.length === 0 && Object.values(report.controls).every(Boolean) ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
