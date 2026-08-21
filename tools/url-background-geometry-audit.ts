#!/usr/bin/env tsx
/**
 * DM-2370 investigation probe.
 *
 * Observational only: paint the same CSS url() background in Chromium and in
 * Domotion's generated SVG, then compare device-pixel geometry of a synthetic
 * source image whose four solid regions make tile size, phase, repeat, clip,
 * and fragment ownership visible.  Rows marked `current-gap` are regression
 * witnesses for follow-up implementation tickets, not accepted fidelity.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { chromium, type Page } from "playwright";
import type { CapturedElement } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

const VIEWPORT = { width: 240, height: 170 };
const DEVICE_SCALE_FACTOR = 1;
const MAX_EQUIVALENT_LABEL_MISMATCH = 0.005;
const MAX_EQUIVALENT_BOUND_DELTA = 1;
const MIN_GAP_LABEL_MISMATCH = 0.04;
const MIN_GAP_BOUND_DELTA = 2;

type ExpectedRoute = "source-equivalent" | "current-gap";
type Mutation = "scroll-local";

interface AuditCase {
  id: string;
  axis: string;
  expectedRoute: ExpectedRoute;
  targetCss: string;
  hostCss?: string;
  sceneCss?: string;
  targetTag?: "div" | "span";
  targetContent?: string;
  extraCss?: string;
  mutation?: Mutation;
  imageCss?: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PaintFacts {
  rect: Rect;
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: string;
  backgroundOrigin: string;
  backgroundClip: string;
  backgroundAttachment: string;
  boxDecorationBreak: string;
  zoom: string;
  transform: string;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

interface PatternFacts {
  x: number;
  y: number;
  width: number;
  height: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
}

interface Comparison {
  sourceColorPixels: number;
  generatedColorPixels: number;
  unionColorPixels: number;
  mismatchedLabels: number;
  labelMismatchFraction: number;
  /** null means one side had no pixels for at least one source marker color. */
  maxColorBoundDelta: number | null;
  sourceBounds: Record<string, Bounds | null>;
  generatedBounds: Record<string, Bounds | null>;
}

interface AuditRow {
  id: string;
  axis: string;
  expectedRoute: ExpectedRoute;
  source: PaintFacts;
  captured: PaintFacts | null;
  patterns: PatternFacts[];
  comparison: Comparison;
  warnings: string[];
  pass: boolean;
}

const PALETTE = [
  { name: "red", rgb: [229, 33, 44] as const },
  { name: "green", rgb: [18, 166, 106] as const },
  { name: "blue", rgb: [25, 85, 209] as const },
  { name: "yellow", rgb: [242, 189, 29] as const },
  { name: "cyan", rgb: [0, 174, 214] as const },
  { name: "magenta", rgb: [213, 40, 155] as const },
  { name: "orange", rgb: [240, 112, 28] as const },
  { name: "violet", rgb: [111, 66, 193] as const },
] as const;

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const TILE_URL = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20" viewBox="0 0 32 20">'
  + '<path fill="#e5212c" d="M0 0h16v10H0z"/><path fill="#12a66a" d="M16 0h16v10H16z"/>'
  + '<path fill="#1955d1" d="M0 10h16v10H0z"/><path fill="#f2bd1d" d="M16 10h16v10H16z"/></svg>',
);

const MARKER_URLS = PALETTE.slice(4).map(({ rgb }, index) => {
  const [r, g, b] = rgb;
  const x = index % 2 === 0 ? 1 : 23;
  const y = index < 2 ? 1 : 13;
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20" viewBox="0 0 32 20"><path fill="rgb(${r},${g},${b})" d="M${x} ${y}h8v6H${x}z"/></svg>`,
  );
});

const CASES: AuditCase[] = [
  {
    id: "explicit-size-repeat-control",
    axis: "explicit-size/repeat positive control",
    expectedRoute: "source-equivalent",
    targetCss: "background-size:32px 20px;background-position:0 0;background-repeat:repeat",
  },
  {
    id: "intrinsic-auto-auto-control",
    axis: "intrinsic dimensions + ratio",
    expectedRoute: "source-equivalent",
    targetCss: "background-size:auto auto;background-position:7px 5px;background-repeat:repeat",
  },
  {
    id: "auto-width-from-explicit-height",
    axis: "one auto dimension resolves through natural ratio",
    expectedRoute: "current-gap",
    targetCss: "background-size:auto 37px;background-position:11px 9px;background-repeat:no-repeat",
  },
  {
    id: "calculated-size",
    axis: "calculated length-percentage size",
    expectedRoute: "current-gap",
    targetCss: "background-size:calc(37% + 9px) calc(24% + 5px);background-position:13px 17px;background-repeat:no-repeat",
  },
  {
    id: "contain-fractional-area",
    axis: "contain dependent-axis integer rounding",
    expectedRoute: "current-gap",
    targetCss: "width:157.5px;height:93.5px;background-size:contain;background-position:43% 61%;background-repeat:no-repeat",
  },
  {
    id: "cover-position-control",
    axis: "cover + percentage position",
    expectedRoute: "source-equivalent",
    targetCss: "background-size:cover;background-position:37% 63%;background-repeat:no-repeat",
  },
  {
    id: "calculated-position-control",
    axis: "calculated length-percentage position",
    expectedRoute: "current-gap",
    targetCss: "background-size:47px 31px;background-position:calc(23% + 7px) calc(71% - 5px);background-repeat:no-repeat",
  },
  {
    id: "round-recomputes-auto-axis",
    axis: "round repeat changes orthogonal auto dimension",
    expectedRoute: "current-gap",
    targetCss: "width:153px;height:97px;background-size:43px auto;background-position:31% 67%;background-repeat:round no-repeat",
  },
  {
    id: "space-multiple-tiles-control",
    axis: "space repeat ignores position with two or more tiles",
    expectedRoute: "current-gap",
    targetCss: "width:153px;height:97px;background-size:38px 24px;background-position:29px 61px;background-repeat:space no-repeat",
  },
  {
    id: "space-single-tile-fallback",
    axis: "space repeat falls back to no-repeat",
    expectedRoute: "current-gap",
    targetCss: "width:91px;height:75px;background-size:54px 27px;background-position:23px 31px;background-repeat:space no-repeat",
  },
  {
    id: "origin-clip-cross-control",
    axis: "independent origin and clip reference boxes",
    expectedRoute: "source-equivalent",
    targetCss: "box-sizing:border-box;width:171px;height:109px;border:7px solid #202020;padding:13px 11px;background-origin:content-box;background-clip:padding-box;background-size:32px 20px;background-position:5px 7px;background-repeat:repeat",
  },
  {
    id: "fixed-viewport-control",
    axis: "fixed attachment viewport positioning area",
    expectedRoute: "current-gap",
    targetCss: "margin-left:17px;background-size:47px 31px;background-position:19px 23px;background-repeat:repeat;background-attachment:fixed",
  },
  {
    id: "fixed-under-transform",
    axis: "transformed ancestor converts fixed to scroll attachment",
    expectedRoute: "current-gap",
    hostCss: "transform:translate(0,0)",
    targetCss: "margin-left:17px;background-size:47px 31px;background-position:19px 23px;background-repeat:repeat;background-attachment:fixed",
  },
  {
    id: "local-nonzero-scroll",
    axis: "local attachment uses scroll offset and scrollable paint area",
    expectedRoute: "current-gap",
    mutation: "scroll-local",
    targetContent: '<i aria-hidden="true"></i>',
    extraCss: "#target::-webkit-scrollbar{display:none}#target>i{display:block;width:330px;height:260px}",
    targetCss: "overflow:scroll;scrollbar-width:none;background-size:47px 31px;background-position:11px 17px;background-repeat:repeat;background-attachment:local",
  },
  {
    id: "effective-zoom-auto-intrinsic",
    axis: "effective zoom scales natural image size",
    expectedRoute: "current-gap",
    targetCss: "zoom:1.25;width:128px;height:80px;background-size:auto auto;background-position:7px 5px;background-repeat:repeat",
  },
  {
    id: "affine-transform-control",
    axis: "tile geometry remains in transformed local space",
    expectedRoute: "current-gap",
    hostCss: "transform:translate(9px,5px) rotate(3deg);transform-origin:0 0",
    targetCss: "width:147px;height:91px;background-size:32px 20px;background-position:7px 5px;background-repeat:repeat",
  },
  {
    id: "cyclic-multiple-layer-lists",
    axis: "background longhand lists repeat cyclically",
    expectedRoute: "current-gap",
    imageCss: MARKER_URLS.map((url) => `url("${url}")`).join(","),
    targetCss: "background-size:32px 20px,24px 16px;background-position:9px 7px,99px 63px;background-repeat:no-repeat",
  },
  {
    id: "wrapped-inline-clone",
    axis: "clone fragment restarts image geometry",
    expectedRoute: "source-equivalent",
    targetTag: "span",
    sceneCss: "width:104px;line-height:31px;font:24px/31px sans-serif",
    targetContent: "wide words wrap here",
    targetCss: "box-decoration-break:clone;-webkit-box-decoration-break:clone;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat;padding:2px 5px",
  },
  {
    id: "wrapped-inline-slice",
    axis: "slice fragment uses stitched imaginary box",
    expectedRoute: "current-gap",
    targetTag: "span",
    sceneCss: "width:104px;line-height:31px;font:24px/31px sans-serif",
    targetContent: "wide words wrap here",
    targetCss: "box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat;padding:2px 5px",
  },
  {
    id: "multicol-block-clone",
    axis: "clone block fragment restarts image geometry",
    expectedRoute: "source-equivalent",
    sceneCss: "padding:10px;width:220px;height:150px;column-count:2;column-gap:16px;column-fill:auto;font:12px/18px sans-serif",
    hostCss: "display:contents",
    targetContent: "A fragmented block crosses the first column and continues through the second column with enough words to preserve a visible background in both physical fragments.",
    targetCss: "width:auto;height:auto;padding:4px;color:transparent;box-decoration-break:clone;-webkit-box-decoration-break:clone;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat",
  },
  {
    id: "multicol-block-slice",
    axis: "slice block fragment uses stitched imaginary box",
    expectedRoute: "current-gap",
    sceneCss: "padding:10px;width:220px;height:150px;column-count:2;column-gap:16px;column-fill:auto;font:12px/18px sans-serif",
    hostCss: "display:contents",
    targetContent: "A fragmented block crosses the first column and continues through the second column with enough words to preserve a visible background in both physical fragments.",
    targetCss: "width:auto;height:auto;padding:4px;color:transparent;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat",
  },
];

function htmlFor(test: AuditCase): string {
  const tag = test.targetTag ?? "div";
  const imageCss = test.imageCss ?? `url("${TILE_URL}")`;
  return `<!doctype html><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}
    #scene{position:relative;margin:0;padding:20px;width:200px;height:130px;box-sizing:border-box;${test.sceneCss ?? ""}}
    #host{position:relative;${test.hostCss ?? ""}}
    #target{display:${tag === "span" ? "inline" : "block"};width:160px;height:100px;box-sizing:border-box;color:#111;background-color:transparent;background-image:${imageCss};${test.targetCss}}
    ${test.extraCss ?? ""}
  </style><div id="scene"><div id="host"><${tag} id="target">${test.targetContent ?? ""}</${tag}></div></div>`;
}

async function mutate(page: Page, mutation: Mutation | undefined): Promise<void> {
  if (mutation === "scroll-local") {
    await page.locator("#target").evaluate((element) => {
      element.scrollLeft = 73;
      element.scrollTop = 59;
    });
  }
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function readPaintFacts(page: Page): Promise<PaintFacts> {
  return page.locator("#target").evaluate((target) => {
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      backgroundImage: style.backgroundImage,
      backgroundSize: style.backgroundSize,
      backgroundPosition: style.backgroundPosition,
      backgroundRepeat: style.backgroundRepeat,
      backgroundOrigin: style.backgroundOrigin,
      backgroundClip: style.backgroundClip,
      backgroundAttachment: style.backgroundAttachment,
      boxDecorationBreak: style.boxDecorationBreak || style.webkitBoxDecorationBreak,
      zoom: style.zoom,
      transform: style.transform,
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop,
      scrollWidth: target.scrollWidth,
      scrollHeight: target.scrollHeight,
    };
  });
}

function findCapturedTarget(elements: CapturedElement[]): CapturedElement | null {
  for (const element of elements) {
    if (element.styles.backgroundImage != null
        && element.styles.backgroundImage !== ""
        && element.styles.backgroundImage !== "none") return element;
    const child = findCapturedTarget(element.children ?? []);
    if (child != null) return child;
  }
  return null;
}

function capturedFacts(element: CapturedElement | null): PaintFacts | null {
  if (element == null) return null;
  const style = element.styles;
  return {
    rect: { x: element.x, y: element.y, width: element.width, height: element.height },
    backgroundImage: style.backgroundImage ?? "",
    backgroundSize: style.backgroundSize ?? "",
    backgroundPosition: style.backgroundPosition ?? "",
    backgroundRepeat: style.backgroundRepeat ?? "",
    backgroundOrigin: style.backgroundOrigin ?? "",
    backgroundClip: style.backgroundClip ?? "",
    backgroundAttachment: style.backgroundAttachment ?? "",
    boxDecorationBreak: style.boxDecorationBreak ?? "",
    zoom: style.zoom ?? "",
    transform: style.transform ?? "",
    scrollLeft: style.scrollLeft ?? 0,
    scrollTop: style.scrollTop ?? 0,
    scrollWidth: style.scrollWidth ?? element.width,
    scrollHeight: style.scrollHeight ?? element.height,
  };
}

function numericAttribute(tag: string, name: string): number {
  const match = new RegExp(`\\b${name}="([-+0-9.eE]+)"`).exec(tag);
  return match == null ? Number.NaN : Number(match[1]);
}

function parsePatternFacts(svg: string): PatternFacts[] {
  const facts: PatternFacts[] = [];
  for (const match of svg.matchAll(/(<pattern\b[^>]*>)([\s\S]*?)<\/pattern>/g)) {
    if (!/<image\b/.test(match[2])) continue;
    const image = /<image\b[^>]*>/.exec(match[2])?.[0] ?? "";
    facts.push({
      x: numericAttribute(match[1], "x"),
      y: numericAttribute(match[1], "y"),
      width: numericAttribute(match[1], "width"),
      height: numericAttribute(match[1], "height"),
      imageX: numericAttribute(image, "x"),
      imageY: numericAttribute(image, "y"),
      imageWidth: numericAttribute(image, "width"),
      imageHeight: numericAttribute(image, "height"),
    });
  }
  return facts;
}

async function labelPixels(png: Buffer): Promise<{ labels: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const labels = new Uint8Array(info.width * info.height);
  for (let pixel = 0; pixel < labels.length; pixel++) {
    const offset = pixel * 3;
    let best = Number.POSITIVE_INFINITY;
    let label = 0;
    for (let index = 0; index < PALETTE.length; index++) {
      const [r, g, b] = PALETTE[index].rgb;
      const distance = (data[offset] - r) ** 2 + (data[offset + 1] - g) ** 2 + (data[offset + 2] - b) ** 2;
      if (distance < best) {
        best = distance;
        label = index + 1;
      }
    }
    // Keep only pixels close to a marker color. This removes text, borders,
    // and white canvas pixels while retaining scaled-image interiors.
    if (best <= 34 ** 2 * 3) labels[pixel] = label;
  }
  return { labels, width: info.width, height: info.height };
}

function boundsFor(labels: Uint8Array, width: number, label: number): Bounds | null {
  let minX = width;
  let minY = Math.ceil(labels.length / width);
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let index = 0; index < labels.length; index++) {
    if (labels[index] !== label) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    pixels++;
  }
  return pixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels };
}

function boundDelta(a: Bounds | null, b: Bounds | null): number | null {
  if (a == null && b == null) return 0;
  if (a == null || b == null) return null;
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );
}

async function comparePaint(sourcePng: Buffer, generatedPng: Buffer): Promise<Comparison> {
  const source = await labelPixels(sourcePng);
  const generated = await labelPixels(generatedPng);
  if (source.width !== generated.width || source.height !== generated.height) {
    throw new Error(`screenshot size mismatch: ${source.width}x${source.height} vs ${generated.width}x${generated.height}`);
  }
  let sourceColorPixels = 0;
  let generatedColorPixels = 0;
  let unionColorPixels = 0;
  let mismatchedLabels = 0;
  for (let index = 0; index < source.labels.length; index++) {
    const a = source.labels[index];
    const b = generated.labels[index];
    if (a !== 0) sourceColorPixels++;
    if (b !== 0) generatedColorPixels++;
    if (a !== 0 || b !== 0) {
      unionColorPixels++;
      if (a !== b) mismatchedLabels++;
    }
  }
  const sourceBounds: Record<string, Bounds | null> = {};
  const generatedBounds: Record<string, Bounds | null> = {};
  let maxColorBoundDelta: number | null = 0;
  for (let index = 0; index < PALETTE.length; index++) {
    const name = PALETTE[index].name;
    const a = boundsFor(source.labels, source.width, index + 1);
    const b = boundsFor(generated.labels, generated.width, index + 1);
    sourceBounds[name] = a;
    generatedBounds[name] = b;
    const delta = boundDelta(a, b);
    maxColorBoundDelta = delta == null || maxColorBoundDelta == null
      ? null
      : Math.max(maxColorBoundDelta, delta);
  }
  return {
    sourceColorPixels,
    generatedColorPixels,
    unionColorPixels,
    mismatchedLabels,
    labelMismatchFraction: unionColorPixels === 0 ? 0 : mismatchedLabels / unionColorPixels,
    maxColorBoundDelta,
    sourceBounds,
    generatedBounds,
  };
}

function rowPass(expectedRoute: ExpectedRoute, comparison: Comparison): boolean {
  if (expectedRoute === "source-equivalent") {
    return comparison.labelMismatchFraction <= MAX_EQUIVALENT_LABEL_MISMATCH
      && comparison.maxColorBoundDelta != null
      && comparison.maxColorBoundDelta <= MAX_EQUIVALENT_BOUND_DELTA;
  }
  return comparison.labelMismatchFraction >= MIN_GAP_LABEL_MISMATCH
    || comparison.maxColorBoundDelta == null
    || comparison.maxColorBoundDelta >= MIN_GAP_BOUND_DELTA;
}

export async function runUrlBackgroundGeometryAudit(): Promise<{
  sourceRevisions: typeof SOURCE_REVISIONS;
  chromiumVersion: string;
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  deviceScaleFactor: number;
  thresholds: Record<string, number>;
  rows: AuditRow[];
  controls: Record<string, boolean>;
  verdict: string;
}> {
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  process.env.DOMOTION_GENERIC_PROBE = "0";
  const [{ captureElementTreeWithWarnings }, { elementTreeToSvg }] = await Promise.all([
    import("../src/capture/index.js"),
    import("../src/render/element-tree-to-svg.js"),
  ]);
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
    const generatedPage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
    const rows: AuditRow[] = [];
    for (const test of CASES) {
      await page.setContent(htmlFor(test), { waitUntil: "load" });
      await mutate(page, test.mutation);
      const source = await readPaintFacts(page);
      const sourcePng = await page.screenshot({ type: "png" });
      const { tree, warnings } = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, ...VIEWPORT });
      const captured = findCapturedTarget(tree);
      const svg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: DEVICE_SCALE_FACTOR });
      await generatedPage.setContent(
        `<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}svg{display:block}</style>${svg}`,
        { waitUntil: "load" },
      );
      await generatedPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const generatedPng = await generatedPage.screenshot({ type: "png" });
      const comparison = await comparePaint(sourcePng, generatedPng);
      rows.push({
        id: test.id,
        axis: test.axis,
        expectedRoute: test.expectedRoute,
        source,
        captured: capturedFacts(captured),
        patterns: parsePatternFacts(svg),
        comparison,
        warnings: warnings.map((warning) => `${warning.feature}: ${warning.detail}`),
        pass: rowPass(test.expectedRoute, comparison),
      });
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const equivalentRows = rows.filter((row) => row.expectedRoute === "source-equivalent");
    const gapRows = rows.filter((row) => row.expectedRoute === "current-gap");
    const controls = {
      paletteDetectedEverywhere: rows.every((row) => row.comparison.sourceColorPixels > 100),
      positiveControlsRemainTight: equivalentRows.every((row) => row.pass),
      everyExpectedGapIsDiscriminated: gapRows.every((row) => row.pass),
      autoRatioMutationMovesPaint: (byId.get("auto-width-from-explicit-height")?.comparison.labelMismatchFraction ?? 0) >= MIN_GAP_LABEL_MISMATCH,
      transformedFixedDiffersFromViewportFixed:
        (byId.get("fixed-under-transform")?.comparison.labelMismatchFraction ?? 0)
        > (byId.get("fixed-viewport-control")?.comparison.labelMismatchFraction ?? 1) + 0.02,
      sliceAndCloneTakeDifferentRoutes:
        byId.get("wrapped-inline-clone")?.pass === true && byId.get("wrapped-inline-slice")?.pass === true,
      blockSliceAndCloneTakeDifferentRoutes:
        byId.get("multicol-block-clone")?.pass === true && byId.get("multicol-block-slice")?.pass === true,
      cyclicLayerRowHasFourImagePatterns: byId.get("cyclic-multiple-layer-lists")?.patterns.length === 4,
    };
    const pass = rows.every((row) => row.pass) && Object.values(controls).every(Boolean);
    return {
      sourceRevisions: SOURCE_REVISIONS,
      chromiumVersion: browser.version(),
      playwrightVersion,
      platform: process.platform,
      architecture: process.arch,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      thresholds: {
        maxEquivalentLabelMismatch: MAX_EQUIVALENT_LABEL_MISMATCH,
        maxEquivalentBoundDelta: MAX_EQUIVALENT_BOUND_DELTA,
        minGapLabelMismatch: MIN_GAP_LABEL_MISMATCH,
        minGapBoundDelta: MIN_GAP_BOUND_DELTA,
      },
      rows,
      controls,
      verdict: pass ? "source-boundary-and-current-url-background-gaps-observed" : "probe-expectation-or-source-drift",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runUrlBackgroundGeometryAudit();
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  const failures = report.rows.filter((row) => !row.pass);
  console.log(`url background geometry audit: ${report.rows.length - failures.length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    const mismatch = (row.comparison.labelMismatchFraction * 100).toFixed(2);
    const bound = row.comparison.maxColorBoundDelta ?? "missing";
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id}: route=${row.expectedRoute}, label-mismatch=${mismatch}%, max-bound-delta=${bound}, patterns=${row.patterns.length}`);
  }
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  return failures.length === 0 && Object.values(report.controls).every(Boolean) ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
