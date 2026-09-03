#!/usr/bin/env tsx
/**
 * DM-2478 source-owned URL background geometry oracle.
 *
 * Paint the same CSS url() background in Chromium and in
 * Domotion's generated SVG, then compare device-pixel geometry of a synthetic
 * source image whose four solid regions make tile size, phase, repeat, clip,
 * and fragment ownership visible. Rows marked `source-equivalent` require the
 * strict raster match; external-SVG sampling rows additionally require every
 * authored marker edge to stay within one device pixel. DM-2365 additionally
 * requires sliced fragments to preserve the same source-owned tile geometry.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release as osRelease } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { chromium, type Page } from "playwright";
import type { CapturedElement } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

const VIEWPORT = { width: 240, height: 170 };
const MAX_EQUIVALENT_LABEL_MISMATCH = 0.005;
const MAX_EQUIVALENT_BOUND_DELTA = 1;
const MAX_GEOMETRY_LABEL_MISMATCH = 0.07;
const MAX_GEOMETRY_BOUND_DELTA = 1;
const MIN_RESTART_MUTATION_LABEL_MISMATCH = 0.04;
const MIN_RESTART_MUTATION_BOUND_DELTA = 2;

export type ExpectedRoute = "source-equivalent" | "source-geometry-equivalent";
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
  attachmentFixedToViewport?: boolean;
  attachmentLocalOffsetX?: number;
  attachmentLocalOffsetY?: number;
  fragments?: Array<{
    rect: Rect;
    backgroundPositioningArea?: Rect;
    backgroundOffsetInStitchedBox?: { x: number; y: number };
  }>;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

export interface PatternFacts {
  x: number;
  y: number;
  width: number;
  height: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
}

export interface Comparison {
  sourceColorPixels: number;
  generatedColorPixels: number;
  unionColorPixels: number;
  mismatchedLabels: number;
  labelMismatchFraction: number;
  /** null means one side had no pixels for at least one source marker color. */
  maxColorBoundDelta: number | null;
  sourceInkBounds: Bounds | null;
  generatedInkBounds: Bounds | null;
  maxInkBoundDelta: number | null;
  sourceBounds: Record<string, Bounds | null>;
  generatedBounds: Record<string, Bounds | null>;
}

export interface EvidenceArtifact {
  role: "source-png" | "generated-png" | "generated-svg" | "restart-mutation-png" | "restart-mutation-svg";
  path: string;
  bytes: number;
  sha256: string;
}

export interface AuditRow {
  id: string;
  axis: string;
  expectedRoute: ExpectedRoute;
  source: PaintFacts;
  captured: PaintFacts | null;
  patterns: PatternFacts[];
  expectedPatternCount: number;
  activePalette: string[];
  comparison: Comparison;
  restartMutation?: {
    patterns: PatternFacts[];
    comparison: Comparison;
    discriminated: boolean;
  };
  warnings: string[];
  blockers: string[];
  artifacts: EvidenceArtifact[];
  pass: boolean;
}

export interface UrlBackgroundAuditReport {
  schemaVersion: 2;
  sourceRevisions: typeof SOURCE_REVISIONS;
  chromiumVersion: string;
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  environment: {
    fingerprint: string;
    chromiumVersion: string;
    playwrightVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    osRelease: string;
    nodeVersion: string;
    runnerOS: string | null;
    runnerImageOS: string | null;
    runnerImageVersion: string | null;
    browserType: "chromium";
    headless: true;
    viewport: typeof VIEWPORT;
    deviceScaleFactor: number;
  };
  deviceScaleFactor: number;
  thresholds: Record<string, number>;
  rows: AuditRow[];
  controls: Record<string, boolean>;
  blockers: string[];
  verdict: "source-equivalent" | "source-drift";
}

export interface UrlBackgroundGateReport {
  schemaVersion: 1;
  gate: "url-background-geometry";
  requiredPlatforms: readonly ["darwin", "linux", "win32"];
  requiredDeviceScaleFactors: readonly [1, 2];
  sourceRevisions: typeof SOURCE_REVISIONS;
  runs: UrlBackgroundAuditReport[];
  blockers: string[];
  verdict: "pass" | "fail";
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
    expectedRoute: "source-equivalent",
    targetCss: "background-size:auto 37px;background-position:11px 9px;background-repeat:no-repeat",
  },
  {
    id: "calculated-size",
    axis: "calculated length-percentage size",
    expectedRoute: "source-equivalent",
    targetCss: "background-size:calc(37% + 9px) calc(24% + 5px);background-position:13px 17px;background-repeat:no-repeat",
  },
  {
    id: "contain-fractional-area",
    axis: "contain dependent-axis integer rounding",
    expectedRoute: "source-geometry-equivalent",
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
    expectedRoute: "source-equivalent",
    targetCss: "background-size:47px 31px;background-position:calc(23% + 7px) calc(71% - 5px);background-repeat:no-repeat",
  },
  {
    id: "round-recomputes-auto-axis",
    axis: "round repeat changes orthogonal auto dimension",
    expectedRoute: "source-geometry-equivalent",
    targetCss: "width:153px;height:97px;background-size:43px auto;background-position:31% 67%;background-repeat:round no-repeat",
  },
  {
    id: "space-multiple-tiles-control",
    axis: "space repeat ignores position with two or more tiles",
    expectedRoute: "source-equivalent",
    targetCss: "width:153px;height:97px;background-size:38px 24px;background-position:29px 61px;background-repeat:space no-repeat",
  },
  {
    id: "space-single-tile-fallback",
    axis: "space repeat falls back to no-repeat",
    expectedRoute: "source-equivalent",
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
    expectedRoute: "source-equivalent",
    targetCss: "margin-left:17px;background-size:47px 31px;background-position:19px 23px;background-repeat:repeat;background-attachment:fixed",
  },
  {
    id: "fixed-under-transform",
    axis: "transformed ancestor converts fixed to scroll attachment",
    expectedRoute: "source-equivalent",
    hostCss: "transform:translate(0,0)",
    targetCss: "margin-left:17px;background-size:47px 31px;background-position:19px 23px;background-repeat:repeat;background-attachment:fixed",
  },
  {
    id: "local-nonzero-scroll",
    axis: "local attachment uses scroll offset and scrollable paint area",
    expectedRoute: "source-equivalent",
    mutation: "scroll-local",
    targetContent: '<i aria-hidden="true"></i>',
    extraCss: "#target::-webkit-scrollbar{display:none}#target>i{display:block;width:330px;height:260px}",
    targetCss: "overflow:scroll;scrollbar-width:none;background-size:47px 31px;background-position:11px 17px;background-repeat:repeat;background-attachment:local",
  },
  {
    id: "effective-zoom-auto-intrinsic",
    axis: "effective zoom scales natural image size",
    expectedRoute: "source-equivalent",
    targetCss: "zoom:1.25;width:128px;height:80px;background-size:auto auto;background-position:7px 5px;background-repeat:repeat",
  },
  {
    id: "affine-transform-control",
    axis: "tile geometry remains in transformed local space",
    expectedRoute: "source-geometry-equivalent",
    hostCss: "transform:translate(9px,5px) rotate(3deg);transform-origin:0 0",
    targetCss: "width:147px;height:91px;background-size:32px 20px;background-position:7px 5px;background-repeat:repeat",
  },
  {
    id: "cyclic-multiple-layer-lists",
    axis: "background longhand lists repeat cyclically",
    expectedRoute: "source-equivalent",
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
    targetCss: "color:transparent;box-decoration-break:clone;-webkit-box-decoration-break:clone;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat;padding:2px 5px",
  },
  {
    id: "wrapped-inline-slice",
    axis: "slice fragment uses stitched imaginary box",
    expectedRoute: "source-equivalent",
    targetTag: "span",
    sceneCss: "width:104px;line-height:31px;font:24px/31px sans-serif",
    targetContent: "wide words wrap here",
    targetCss: "color:transparent;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat;padding:2px 5px",
  },
  {
    id: "wrapped-inline-slice-rtl",
    axis: "RTL slice uses Blink's physical before/after swap",
    expectedRoute: "source-equivalent",
    targetTag: "span",
    sceneCss: "width:104px;line-height:31px;font:24px/31px sans-serif;direction:rtl",
    targetContent: "wide words wrap here",
    targetCss: "color:transparent;direction:rtl;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:29px 17px;background-position:7px 3px;background-repeat:repeat;padding:2px 5px",
  },
  {
    id: "wrapped-inline-slice-origin-clip",
    axis: "slice continuation crosses independent origin and clip boxes",
    expectedRoute: "source-equivalent",
    targetTag: "span",
    sceneCss: "width:104px;line-height:31px;font:24px/31px sans-serif",
    targetContent: "wide words wrap here",
    targetCss: "color:transparent;box-decoration-break:slice;-webkit-box-decoration-break:slice;border:3px solid transparent;padding:4px 6px;background-origin:content-box;background-clip:padding-box;background-size:31px 19px;background-position:7px 5px;background-repeat:repeat",
  },
  {
    id: "wrapped-inline-slice-fixed",
    axis: "fixed attachment remains viewport-owned across sliced fragments",
    expectedRoute: "source-equivalent",
    targetTag: "span",
    sceneCss: "width:104px;line-height:31px;font:24px/31px sans-serif",
    targetContent: "wide words wrap here",
    targetCss: "color:transparent;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-attachment:fixed;background-size:31px 19px;background-position:7px 5px;background-repeat:repeat;padding:2px 5px",
  },
  {
    id: "wrapped-inline-slice-vertical-rl",
    axis: "vertical-rl slice continues on the physical Y axis",
    expectedRoute: "source-equivalent",
    targetTag: "span",
    sceneCss: "width:180px;height:104px;line-height:31px;font:24px/31px sans-serif;writing-mode:vertical-rl",
    targetContent: "wide words wrap here",
    targetCss: "color:transparent;writing-mode:vertical-rl;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:19px 29px;background-position:3px 7px;background-repeat:repeat;padding:5px 2px",
  },
  {
    id: "multicol-block-clone",
    axis: "clone block fragment restarts image geometry",
    expectedRoute: "source-equivalent",
    sceneCss: "padding:10px;width:220px;height:150px;column-count:2;column-gap:16px;column-fill:auto;font:12px/18px sans-serif",
    hostCss: "display:contents",
    targetContent: "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>",
    extraCss: "#target>i{display:block;height:24px}",
    targetCss: "width:auto;height:auto;padding:4px;color:transparent;box-decoration-break:clone;-webkit-box-decoration-break:clone;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat",
  },
  {
    id: "multicol-block-slice",
    axis: "slice block fragment uses stitched imaginary box",
    expectedRoute: "source-equivalent",
    sceneCss: "padding:10px;width:220px;height:150px;column-count:2;column-gap:16px;column-fill:auto;font:12px/18px sans-serif",
    hostCss: "display:contents",
    targetContent: "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>",
    extraCss: "#target>i{display:block;height:24px}",
    targetCss: "width:auto;height:auto;padding:4px;color:transparent;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:32px 20px;background-position:3px 4px;background-repeat:repeat",
  },
  {
    id: "multicol-block-slice-vertical-rl",
    axis: "vertical-rl multicol slice uses stitched logical block geometry",
    expectedRoute: "source-equivalent",
    sceneCss: "padding:10px;width:220px;height:150px;column-count:2;column-gap:16px;column-fill:auto;font:12px/18px sans-serif;writing-mode:vertical-rl",
    hostCss: "display:contents",
    targetContent: "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>",
    extraCss: "#target>i{display:block;width:24px}",
    targetCss: "width:auto;height:auto;padding:4px;color:transparent;writing-mode:vertical-rl;box-decoration-break:slice;-webkit-box-decoration-break:slice;background-size:23px 32px;background-position:4px 3px;background-repeat:repeat",
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
      fragments: Array.from(target.getClientRects(), (fragment) => ({
        rect: {
          x: fragment.x,
          y: fragment.y,
          width: fragment.width,
          height: fragment.height,
        },
      })),
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

/** Keep this paint oracle independent from unrelated atomic text/projective
 * fallbacks. Replaying a Chromium surface would otherwise make a missing SVG
 * background pattern compare perfectly against its own source screenshot. */
function suppressAtomicRasterSurfaces(elements: CapturedElement[]): void {
  for (const element of elements) {
    element.transformSubtreeRaster = undefined;
    suppressAtomicRasterSurfaces(element.children ?? []);
  }
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
    attachmentFixedToViewport: style.backgroundAttachmentGeometry?.fixedToViewport,
    attachmentLocalOffsetX: style.backgroundAttachmentGeometry?.local?.scrollOffsetX,
    attachmentLocalOffsetY: style.backgroundAttachmentGeometry?.local?.scrollOffsetY,
    fragments: element.inlineFragments?.map((fragment) => ({
      rect: {
        x: fragment.x,
        y: fragment.y,
        width: fragment.width,
        height: fragment.height,
      },
      backgroundPositioningArea: fragment.backgroundPositioningArea,
      backgroundOffsetInStitchedBox: fragment.backgroundOffsetInStitchedBox,
    })),
  };
}

function numericAttribute(tag: string, name: string): number {
  const match = new RegExp(`\\b${name}="([-+0-9.eE]+)"`).exec(tag);
  return match == null ? Number.NaN : Number(match[1]);
}

function parsePatternFacts(svg: string): PatternFacts[] {
  const facts: PatternFacts[] = [];
  const imageDefs = new Map<string, string>();
  for (const match of svg.matchAll(/<image\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    imageDefs.set(match[1], match[0]);
  }
  for (const match of svg.matchAll(/(<pattern\b[^>]*>)([\s\S]*?)<\/pattern>/g)) {
    const directImage = /<image\b[^>]*>/.exec(match[2])?.[0] ?? null;
    const use = /<use\b[^>]*>/.exec(match[2])?.[0] ?? null;
    if (directImage == null && use == null) continue;
    const referencedId = use == null ? null : /\bhref="#([^"]+)"/.exec(use)?.[1] ?? null;
    const image = directImage ?? (referencedId == null ? "" : imageDefs.get(referencedId) ?? "");
    const positioned = directImage ?? use ?? "";
    facts.push({
      x: numericAttribute(match[1], "x"),
      y: numericAttribute(match[1], "y"),
      width: numericAttribute(match[1], "width"),
      height: numericAttribute(match[1], "height"),
      imageX: numericAttribute(positioned, "x"),
      imageY: numericAttribute(positioned, "y"),
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

function boundsForAny(labels: Uint8Array, width: number, active: ReadonlySet<number>): Bounds | null {
  let minX = width;
  let minY = Math.ceil(labels.length / width);
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let index = 0; index < labels.length; index++) {
    if (!active.has(labels[index])) continue;
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

async function comparePaint(
  sourcePng: Buffer,
  generatedPng: Buffer,
  activeLabels: readonly number[],
): Promise<Comparison> {
  const source = await labelPixels(sourcePng);
  const generated = await labelPixels(generatedPng);
  if (source.width !== generated.width || source.height !== generated.height) {
    throw new Error(`screenshot size mismatch: ${source.width}x${source.height} vs ${generated.width}x${generated.height}`);
  }
  let sourceColorPixels = 0;
  let generatedColorPixels = 0;
  let unionColorPixels = 0;
  let mismatchedLabels = 0;
  const active = new Set(activeLabels);
  for (let index = 0; index < source.labels.length; index++) {
    // Scaled tile seams can be nearest to one of the colors reserved for the
    // independent multi-layer marker fixture. Only adjudicate colors the row
    // actually authors; otherwise a red/blue blend can become false violet.
    const a = active.has(source.labels[index]) ? source.labels[index] : 0;
    const b = active.has(generated.labels[index]) ? generated.labels[index] : 0;
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
    const delta = active.has(index + 1) ? boundDelta(a, b) : 0;
    maxColorBoundDelta = delta == null || maxColorBoundDelta == null
      ? null
      : Math.max(maxColorBoundDelta, delta);
  }
  const sourceInkBounds = boundsForAny(source.labels, source.width, active);
  const generatedInkBounds = boundsForAny(generated.labels, generated.width, active);
  return {
    sourceColorPixels,
    generatedColorPixels,
    unionColorPixels,
    mismatchedLabels,
    labelMismatchFraction: unionColorPixels === 0 ? 0 : mismatchedLabels / unionColorPixels,
    maxColorBoundDelta,
    sourceInkBounds,
    generatedInkBounds,
    maxInkBoundDelta: boundDelta(sourceInkBounds, generatedInkBounds),
    sourceBounds,
    generatedBounds,
  };
}

function comparisonMatchesRoute(expectedRoute: ExpectedRoute, comparison: Comparison): boolean {
  if (expectedRoute === "source-equivalent") {
    return comparison.labelMismatchFraction <= MAX_EQUIVALENT_LABEL_MISMATCH
      && comparison.maxColorBoundDelta != null
      && comparison.maxColorBoundDelta <= MAX_EQUIVALENT_BOUND_DELTA;
  }
  if (expectedRoute === "source-geometry-equivalent") {
    // A decoded SVG is raster-sampled once by CSS Image paint and again when
    // the generated SVG's external <image> is composited. Geometry is exact
    // when every independent marker edge remains within one device pixel;
    // the bounded label fraction covers only those differently filtered edge
    // pixels and is not used for bitmap or unscaled positive controls.
    return comparison.labelMismatchFraction <= MAX_GEOMETRY_LABEL_MISMATCH
      && comparison.maxColorBoundDelta != null
      && comparison.maxColorBoundDelta <= MAX_GEOMETRY_BOUND_DELTA;
  }
  return false;
}

function restartMutationDiscriminated(comparison: Comparison): boolean {
  return comparison.labelMismatchFraction >= MIN_RESTART_MUTATION_LABEL_MISMATCH
    || comparison.maxColorBoundDelta == null
    || comparison.maxColorBoundDelta >= MIN_RESTART_MUTATION_BOUND_DELTA;
}

function validPattern(pattern: PatternFacts): boolean {
  return [pattern.x, pattern.y, pattern.imageX, pattern.imageY].every(Number.isFinite)
    && [pattern.width, pattern.height, pattern.imageWidth, pattern.imageHeight]
      .every((value) => Number.isFinite(value) && value > 0);
}

export function adjudicateUrlBackgroundRow(row: {
  expectedRoute: string;
  comparison: Comparison;
  patterns: PatternFacts[];
  expectedPatternCount: number;
  activePalette: string[];
  warnings: string[];
  restartMutation?: AuditRow["restartMutation"];
  requiresRestartMutation: boolean;
}): string[] {
  const blockers: string[] = [];
  if (row.expectedRoute !== "source-equivalent" && row.expectedRoute !== "source-geometry-equivalent") {
    blockers.push(`unsupported or observational route ${row.expectedRoute}`);
  } else if (!comparisonMatchesRoute(row.expectedRoute, row.comparison)) {
    blockers.push(`source comparison exceeds the ${row.expectedRoute} envelope`);
  }
  if (row.comparison.sourceInkBounds == null || row.comparison.generatedInkBounds == null) {
    blockers.push("independent source/generated marker ink is missing");
  } else if (row.comparison.maxInkBoundDelta == null || row.comparison.maxInkBoundDelta > 1) {
    blockers.push("independent marker ink bounds differ by more than one device pixel");
  }
  for (const name of row.activePalette) {
    if (row.comparison.sourceBounds[name] == null) blockers.push(`source palette color ${name} is missing`);
    if (row.comparison.generatedBounds[name] == null) blockers.push(`generated palette color ${name} is missing`);
  }
  if (row.patterns.length !== row.expectedPatternCount) {
    blockers.push(`expected ${row.expectedPatternCount} materialized patterns, received ${row.patterns.length}`);
  }
  if (!row.patterns.every(validPattern)) blockers.push("materialized pattern facts are missing or non-finite");
  if (row.warnings.length > 0) blockers.push(`capture emitted ${row.warnings.length} warning(s)`);
  if (row.requiresRestartMutation && row.restartMutation?.discriminated !== true) {
    blockers.push("slice restart mutation was not discriminated");
  }
  return blockers;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function persistArtifact(
  root: string | undefined,
  relativePath: string,
  role: EvidenceArtifact["role"],
  contents: Buffer | string,
): EvidenceArtifact | null {
  if (root == null) return null;
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return {
    role,
    path: relativePath.replaceAll("\\", "/"),
    bytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  };
}

export async function runUrlBackgroundGeometryAudit(
  deviceScaleFactor = 1,
  artifactDir?: string,
): Promise<UrlBackgroundAuditReport> {
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
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor });
    const generatedPage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor });
    const rows: AuditRow[] = [];
    for (const test of CASES) {
      const activeLabels = test.imageCss == null ? [1, 2, 3, 4] : [5, 6, 7, 8];
      const activePalette = activeLabels.map((label) => PALETTE[label - 1].name);
      const artifactPrefix = `dpr-${deviceScaleFactor}/${test.id}`;
      const artifacts: EvidenceArtifact[] = [];
      await page.setContent(htmlFor(test), { waitUntil: "load" });
      await mutate(page, test.mutation);
      const source = await readPaintFacts(page);
      const sourcePng = await page.screenshot({ type: "png" });
      const { tree, warnings } = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, ...VIEWPORT });
      const captured = findCapturedTarget(tree);
      // This oracle adjudicates the vector URL-background route itself. A
      // source-owned text fallback may atomically raster the same fragmented
      // element when unrelated protocol text facts are unavailable; suppress
      // that outer surface here so it cannot make a missing vector pattern
      // appear pixel-perfect by replaying Chromium's source screenshot.
      suppressAtomicRasterSurfaces(tree);
      const svg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: deviceScaleFactor });
      await generatedPage.setContent(
        `<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}svg{display:block}</style>${svg}`,
        { waitUntil: "load" },
      );
      await generatedPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const generatedPng = await generatedPage.screenshot({ type: "png" });
      for (const artifact of [
        persistArtifact(artifactDir, `${artifactPrefix}/source.png`, "source-png", sourcePng),
        persistArtifact(artifactDir, `${artifactPrefix}/generated.png`, "generated-png", generatedPng),
        persistArtifact(artifactDir, `${artifactPrefix}/generated.svg`, "generated-svg", svg),
      ]) if (artifact != null) artifacts.push(artifact);
      const comparison = await comparePaint(
        sourcePng,
        generatedPng,
        activeLabels,
      );
      let restartMutation: AuditRow["restartMutation"];
      const fixedToViewport = source.backgroundAttachment === "fixed"
        && captured?.styles.backgroundAttachmentGeometry?.fixedToViewport === true;
      if (source.boxDecorationBreak === "slice" && !fixedToViewport
          && captured?.inlineFragments != null) {
        const savedGeometry = captured.inlineFragments.map((fragment) => ({
          area: fragment.backgroundPositioningArea,
          offset: fragment.backgroundOffsetInStitchedBox,
        }));
        for (const fragment of captured.inlineFragments) {
          // Held-out negative: replace Blink's stitched imaginary box with
          // the clone route's physical fragment box. A real continuation row
          // must visibly reject this restart without relying on source labels.
          fragment.backgroundPositioningArea = {
            x: fragment.x,
            y: fragment.y,
            width: fragment.width,
            height: fragment.height,
          };
          fragment.backgroundOffsetInStitchedBox = { x: 0, y: 0 };
        }
        const mutatedSvg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: deviceScaleFactor });
        await generatedPage.setContent(
          `<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}svg{display:block}</style>${mutatedSvg}`,
          { waitUntil: "load" },
        );
        await generatedPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const mutatedPng = await generatedPage.screenshot({ type: "png" });
        for (const artifact of [
          persistArtifact(artifactDir, `${artifactPrefix}/restart-mutation.png`, "restart-mutation-png", mutatedPng),
          persistArtifact(artifactDir, `${artifactPrefix}/restart-mutation.svg`, "restart-mutation-svg", mutatedSvg),
        ]) if (artifact != null) artifacts.push(artifact);
        const mutatedComparison = await comparePaint(
          sourcePng,
          mutatedPng,
          activeLabels,
        );
        restartMutation = {
          patterns: parsePatternFacts(mutatedSvg),
          comparison: mutatedComparison,
          discriminated: restartMutationDiscriminated(mutatedComparison),
        };
        captured.inlineFragments.forEach((fragment, index) => {
          fragment.backgroundPositioningArea = savedGeometry[index].area;
          fragment.backgroundOffsetInStitchedBox = savedGeometry[index].offset;
        });
      }
      const patterns = parsePatternFacts(svg);
      const expectedPatternCount = (test.imageCss == null ? 1 : 4)
        * Math.max(1, captured?.inlineFragments?.length ?? 1);
      const warningMessages = warnings.map((warning) => `${warning.feature}: ${warning.detail}`);
      const requiresRestartMutation = source.boxDecorationBreak === "slice"
        && !fixedToViewport && (captured?.inlineFragments?.length ?? 0) > 1;
      const blockers = adjudicateUrlBackgroundRow({
        expectedRoute: test.expectedRoute,
        comparison,
        patterns,
        expectedPatternCount,
        activePalette,
        warnings: warningMessages,
        restartMutation,
        requiresRestartMutation,
      });
      rows.push({
        id: test.id,
        axis: test.axis,
        expectedRoute: test.expectedRoute,
        source,
        captured: capturedFacts(captured),
        patterns,
        expectedPatternCount,
        activePalette,
        comparison,
        restartMutation,
        warnings: warningMessages,
        blockers,
        artifacts,
        pass: blockers.length === 0,
      });
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const sliceRows = rows.filter((row) => row.source.boxDecorationBreak === "slice"
      && (row.captured?.fragments?.length ?? 0) > 1);
    const controls = {
      paletteEvidenceComplete: rows.every((row) => row.activePalette.every((name) =>
        row.comparison.sourceBounds[name] != null && row.comparison.generatedBounds[name] != null)),
      allRowsSourceEquivalent: rows.every((row) => row.pass),
      noObservationalRoutes: rows.every((row) => row.expectedRoute === "source-equivalent"
        || row.expectedRoute === "source-geometry-equivalent"),
      warningsEmpty: rows.every((row) => row.warnings.length === 0),
      patternEvidenceComplete: rows.every((row) => row.patterns.length === row.expectedPatternCount
        && row.patterns.every(validPattern)),
      independentInkBoundsExact: rows.every((row) => row.comparison.maxInkBoundDelta != null
        && row.comparison.maxInkBoundDelta <= 1),
      autoRatioRouteIsExact: byId.get("auto-width-from-explicit-height")?.pass === true,
      // DM-2479 closed the old transformed-fixed ownership gap. Keep the
      // discriminator independent by asserting its captured ownership facts
      // in addition to the exact DM-2478 raster row.
      attachmentOwnershipCaptured:
        byId.get("fixed-viewport-control")?.captured?.attachmentFixedToViewport === true
        && byId.get("fixed-under-transform")?.captured?.attachmentFixedToViewport === false,
      localAttachmentOffsetsCaptured:
        byId.get("local-nonzero-scroll")?.captured?.attachmentLocalOffsetX
          === byId.get("local-nonzero-scroll")?.source.scrollLeft
        && byId.get("local-nonzero-scroll")?.captured?.attachmentLocalOffsetY
          === byId.get("local-nonzero-scroll")?.source.scrollTop,
      sliceRowsAreSourceEquivalent:
        sliceRows.length >= 2 && sliceRows.every((row) => row.expectedRoute === "source-equivalent" && row.pass),
      sliceGeometryRecordsCaptured:
        sliceRows.every((row) => (row.captured?.fragments?.length ?? 0) > 1
          && row.captured!.fragments!.every((fragment) => fragment.backgroundPositioningArea != null
            && fragment.backgroundOffsetInStitchedBox != null)),
      sliceRestartMutationsDiscriminated:
        sliceRows.every((row) => row.captured?.attachmentFixedToViewport === true
          || row.restartMutation?.discriminated === true),
      fragmentPatternsMaterialized:
        rows.filter((row) => (row.captured?.fragments?.length ?? 0) > 1)
          .every((row) => row.patterns.length === row.captured!.fragments!.length),
      cyclicLayerRowHasFourImagePatterns: byId.get("cyclic-multiple-layer-lists")?.patterns.length === 4,
    };
    const pass = rows.every((row) => row.pass) && Object.values(controls).every(Boolean);
    const chromiumVersion = browser.version();
    const environmentBase = {
      chromiumVersion,
      playwrightVersion,
      platform: process.platform,
      architecture: process.arch,
      osRelease: osRelease(),
      nodeVersion: process.version,
      runnerOS: process.env.RUNNER_OS ?? null,
      runnerImageOS: process.env.ImageOS ?? null,
      runnerImageVersion: process.env.ImageVersion ?? null,
      browserType: "chromium" as const,
      headless: true as const,
      viewport: VIEWPORT,
      deviceScaleFactor,
    };
    const environment = {
      fingerprint: sha256(JSON.stringify({ sourceRevisions: SOURCE_REVISIONS, ...environmentBase })),
      ...environmentBase,
    };
    const blockers = [
      ...rows.flatMap((row) => row.blockers.map((blocker) => `${row.id}: ${blocker}`)),
      ...Object.entries(controls).filter(([, value]) => !value).map(([name]) => `control failed: ${name}`),
    ];
    return {
      schemaVersion: 2,
      sourceRevisions: SOURCE_REVISIONS,
      chromiumVersion,
      playwrightVersion,
      platform: process.platform,
      architecture: process.arch,
      environment,
      deviceScaleFactor,
      thresholds: {
        maxEquivalentLabelMismatch: MAX_EQUIVALENT_LABEL_MISMATCH,
        maxEquivalentBoundDelta: MAX_EQUIVALENT_BOUND_DELTA,
        maxGeometryLabelMismatch: MAX_GEOMETRY_LABEL_MISMATCH,
        maxGeometryBoundDelta: MAX_GEOMETRY_BOUND_DELTA,
        minRestartMutationLabelMismatch: MIN_RESTART_MUTATION_LABEL_MISMATCH,
        minRestartMutationBoundDelta: MIN_RESTART_MUTATION_BOUND_DELTA,
      },
      rows,
      controls,
      blockers,
      verdict: pass ? "source-equivalent" : "source-drift",
    };
  } finally {
    await browser.close();
  }
}

const REQUIRED_DEVICE_SCALE_FACTORS = [1, 2] as const;
const REQUIRED_PLATFORMS = ["darwin", "linux", "win32"] as const;

export async function runUrlBackgroundGeometryGate(
  deviceScaleFactors: number[] = [...REQUIRED_DEVICE_SCALE_FACTORS],
  artifactDir?: string,
): Promise<UrlBackgroundGateReport> {
  const uniqueDprs = [...new Set(deviceScaleFactors)].sort((a, b) => a - b);
  const runs: UrlBackgroundAuditReport[] = [];
  for (const dpr of uniqueDprs) runs.push(await runUrlBackgroundGeometryAudit(dpr, artifactDir));
  const blockers: string[] = [];
  if (JSON.stringify(uniqueDprs) !== JSON.stringify(REQUIRED_DEVICE_SCALE_FACTORS)) {
    blockers.push(`required DPR Cartesian rows are 1,2; received ${uniqueDprs.join(",") || "none"}`);
  }
  if (!(REQUIRED_PLATFORMS as readonly string[]).includes(process.platform)) {
    blockers.push(`unsupported producer platform ${process.platform}`);
  }
  for (const run of runs) {
    if (run.verdict !== "source-equivalent") blockers.push(`${run.platform}@${run.deviceScaleFactor}x: ${run.verdict}`);
    if (artifactDir != null) {
      for (const row of run.rows) {
        const expectedArtifacts = row.restartMutation == null ? 3 : 5;
        if (row.artifacts.length !== expectedArtifacts) {
          blockers.push(`${run.platform}@${run.deviceScaleFactor}x/${row.id}: expected ${expectedArtifacts} artifacts, received ${row.artifacts.length}`);
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    gate: "url-background-geometry",
    requiredPlatforms: REQUIRED_PLATFORMS,
    requiredDeviceScaleFactors: REQUIRED_DEVICE_SCALE_FACTORS,
    sourceRevisions: SOURCE_REVISIONS,
    runs,
    blockers,
    verdict: blockers.length === 0 ? "pass" : "fail",
  };
}

async function main(): Promise<number> {
  const dprIndex = process.argv.indexOf("--dpr");
  const parsedDprs = (dprIndex >= 0 ? process.argv[dprIndex + 1] : "1,2")
    ?.split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0) ?? [];
  const artifactsIndex = process.argv.indexOf("--artifacts");
  const artifactDir = artifactsIndex >= 0 ? process.argv[artifactsIndex + 1] : undefined;
  const report = await runUrlBackgroundGeometryGate(parsedDprs, artifactDir);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    mkdirSync(dirname(process.argv[jsonIndex + 1]), { recursive: true });
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const run of report.runs) {
    const failures = run.rows.filter((row) => !row.pass);
    console.log(`url background geometry ${run.platform}@${run.deviceScaleFactor}x: ${run.rows.length - failures.length}/${run.rows.length}; ${run.verdict}`);
    for (const row of run.rows) {
      const mismatch = (row.comparison.labelMismatchFraction * 100).toFixed(2);
      const bound = row.comparison.maxColorBoundDelta ?? "missing";
      console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id}: route=${row.expectedRoute}, label-mismatch=${mismatch}%, max-bound-delta=${bound}, ink-bound-delta=${row.comparison.maxInkBoundDelta ?? "missing"}, patterns=${row.patterns.length}/${row.expectedPatternCount}`);
      for (const blocker of row.blockers) console.log(`  BLOCKER ${blocker}`);
    }
    console.log(`controls: ${JSON.stringify(run.controls)}`);
  }
  for (const blocker of report.blockers) console.log(`BLOCKER ${blocker}`);
  console.log(`url background geometry release gate: ${report.verdict}`);
  return report.verdict === "pass" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
