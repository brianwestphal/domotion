#!/usr/bin/env tsx
/**
 * DM-2368 investigation probe.
 *
 * It compares live Chromium scrollbar pixels and geometry with Domotion's
 * generated SVG. Loud author scrollbar colors strictly gate custom-part
 * geometry within one device pixel; native rows retain their platform-owned
 * adjudication contract rather than substituting one host's chrome.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { chromium, type Page } from "playwright";
import type { CapturedElement, CapturedNativeScrollbarRaster } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

const TARGET_ORIGIN = { x: 34, y: 27 } as const;
const TARGET_SIZE = { width: 156, height: 118 } as const;
const CLIP_SIZE = { width: 176, height: 142 } as const;
const MAX_AUDIT_ZOOM = 2;
// Keep the complete zoomed clip and target inside the authenticated scene.
// A fixed 270x205 scene clipped zoom=2 scrollbars out of the capture region,
// making those Cartesian cells vacuous rather than testing Blink ownership.
const VIEWPORT = {
  width: TARGET_ORIGIN.x + CLIP_SIZE.width * MAX_AUDIT_ZOOM + 44,
  height: TARGET_ORIGIN.y + CLIP_SIZE.height * MAX_AUDIT_ZOOM + 39,
};

export function scrollbarAuditSceneGeometry(cssZoom: number): {
  viewport: typeof VIEWPORT;
  clip: { x: number; y: number; width: number; height: number };
  targetVisual: { width: number; height: number };
} {
  if (!Number.isFinite(cssZoom) || cssZoom <= 0 || cssZoom > MAX_AUDIT_ZOOM) {
    throw new Error(`unsupported scrollbar audit zoom ${cssZoom}`);
  }
  return {
    viewport: VIEWPORT,
    clip: {
      x: TARGET_ORIGIN.x,
      y: TARGET_ORIGIN.y,
      width: CLIP_SIZE.width * cssZoom,
      height: CLIP_SIZE.height * cssZoom,
    },
    targetVisual: {
      width: TARGET_SIZE.width * cssZoom,
      height: TARGET_SIZE.height * cssZoom,
    },
  };
}
const TARGET_BACKGROUND = [237, 241, 245] as const;
const MARKER_DISTANCE_SQUARED = 30 ** 2 * 3;

const MARKERS = [
  { name: "track", rgb: [229, 33, 44] as const },
  { name: "thumb", rgb: [25, 85, 209] as const },
  { name: "corner", rgb: [18, 166, 106] as const },
  { name: "button", rgb: [242, 189, 29] as const },
  { name: "resizer", rgb: [171, 42, 199] as const },
] as const;

type ExpectedRoute =
  | "marker-free-control"
  | "custom-vector"
  | "suppressed-captured-absence"
  | "native-raster"
  | "native-platform-fingerprint";

interface AuditCase {
  id: string;
  axis: string;
  expectedRoute: ExpectedRoute;
  targetCss: string;
  contentCss: string;
  custom?: boolean;
  clipCss?: string;
  clipSize?: { width: number; height: number };
  mutation?: { left?: number; top?: number };
  dprs?: number[];
  background?: readonly [number, number, number];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds extends Rect {
  pixels: number;
}

interface PseudoFacts {
  display: string;
  width: string;
  height: string;
  backgroundColor: string;
  border: string;
}

interface BrowserFacts {
  rect: Rect;
  clipRect: Rect;
  offsetWidth: number;
  offsetHeight: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
  overflowX: string;
  overflowY: string;
  scrollbarWidth: string;
  scrollbarColor: string;
  scrollbarGutter: string;
  colorScheme: string;
  direction: string;
  writingMode: string;
  zoom: string;
  backgroundRgb: [number, number, number];
  borderWidths: [number, number, number, number];
  layoutGutter: { vertical: number; horizontal: number };
  platformMode: "classic-layout" | "overlay-or-suppressed";
  pseudos: Record<string, PseudoFacts>;
}

interface CapturedFacts {
  rect: Rect;
  overflowX: string;
  overflowY: string;
  scrollbarGutter: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
  scrollbarStatus: NonNullable<CapturedElement["scrollbars"]>["status"] | null;
  horizontalRoute: string | null;
  verticalRoute: string | null;
  horizontalParts: string[];
  verticalParts: string[];
  horizontalLogicalSide: string | null;
  verticalLogicalSide: string | null;
  horizontalPosition: number | null;
  verticalPosition: number | null;
  horizontalNativeRaster: NativeRasterFacts | null;
  verticalNativeRaster: NativeRasterFacts | null;
  nativeCornerRaster: NativeRasterFacts | null;
  corner: Rect | null;
  outputTransform: [number, number, number, number, number, number] | null;
  resizeHandle: Rect | null;
  resizerOverlap: { rect: Rect; paintOrder: string } | null;
  missingFacts: string[];
}

interface NativeRasterFacts extends Rect {
  pixelWidth: number;
  pixelHeight: number;
  captureDpr: number;
  sourceFrameSha256: string;
  cropSha256: string | null;
  empty: boolean;
}

interface EdgeFingerprint {
  samplePixels: number;
  changedPixels: number;
  changedFraction: number;
  topColors: Array<{ rgb: string; pixels: number }>;
}

interface PixelFacts {
  width: number;
  height: number;
  markers: Record<string, Bounds | null>;
  markerPixels: number;
  edges: {
    left: EdgeFingerprint;
    right: EdgeFingerprint;
    bottom: EdgeFingerprint;
  };
}

interface AuditRow {
  id: string;
  axis: string;
  expectedRoute: ExpectedRoute;
  deviceScaleFactor: number;
  cssZoom: number;
  source: BrowserFacts;
  captured: CapturedFacts | null;
  sourcePixels: PixelFacts;
  generatedPixels: PixelFacts;
  generatedGenericThumbs: number;
  artifacts: Array<{
    role: "source" | "generated";
    path: string;
    sha256: string;
    pngWidth: number;
    pngHeight: number;
  }>;
  warnings: string[];
  pass: boolean;
}

const CUSTOM_SCROLLBAR_CSS = `
  #target::-webkit-scrollbar{width:16px;height:14px;background:#e5212c}
  #target::-webkit-scrollbar-track{background:#e5212c}
  #target::-webkit-scrollbar-thumb{background:#1955d1;border:2px solid #e5212c;border-radius:0}
  #target::-webkit-scrollbar-corner{background:#12a66a}
  #target::-webkit-scrollbar-button{display:none;background:#f2bd1d;width:0;height:0}
  #target::-webkit-resizer{background:transparent;border:4px solid #ab2ac7;border-radius:0;box-shadow:none}
`;

const CASES: AuditCase[] = [
  {
    id: "overflow-visible-negative",
    axis: "overflow:visible must not create chrome",
    expectedRoute: "marker-free-control",
    targetCss: "overflow:visible",
    contentCss: "width:260px;height:220px",
  },
  {
    id: "overflow-hidden-negative",
    axis: "overflow:hidden scroll container has no scrollbar",
    expectedRoute: "marker-free-control",
    targetCss: "overflow:hidden",
    contentCss: "width:260px;height:220px",
  },
  {
    id: "overflow-clip-negative",
    axis: "overflow:clip is not a scroll container",
    expectedRoute: "marker-free-control",
    targetCss: "overflow:clip",
    contentCss: "width:260px;height:220px",
  },
  {
    id: "auto-no-overflow-negative",
    axis: "overflow:auto without overflow",
    expectedRoute: "marker-free-control",
    targetCss: "overflow:auto",
    contentCss: "width:80px;height:70px",
  },
  {
    id: "width-none-scrolled",
    axis: "scrollbar-width:none suppresses chrome at a nonzero offset",
    expectedRoute: "suppressed-captured-absence",
    targetCss: "overflow:auto;scrollbar-width:none",
    contentCss: "width:260px;height:250px",
    mutation: { left: 51, top: 67 },
    dprs: [1, 2],
  },
  {
    id: "custom-scroll-no-overflow",
    axis: "custom non-overlay overflow:scroll bars exist without overflow",
    expectedRoute: "custom-vector",
    targetCss: "overflow:scroll",
    contentCss: "width:70px;height:60px",
    custom: true,
  },
  {
    id: "custom-y-top",
    axis: "vertical custom track/thumb at minimum offset",
    expectedRoute: "custom-vector",
    targetCss: "overflow-y:auto;overflow-x:hidden",
    contentCss: "width:90px;height:360px",
    custom: true,
  },
  {
    id: "custom-y-mid",
    axis: "vertical custom thumb proportional midpoint",
    expectedRoute: "custom-vector",
    targetCss: "overflow-y:auto;overflow-x:hidden",
    contentCss: "width:90px;height:360px",
    custom: true,
    mutation: { top: 122 },
  },
  {
    id: "custom-y-max",
    axis: "vertical custom thumb maximum offset",
    expectedRoute: "custom-vector",
    targetCss: "overflow-y:auto;overflow-x:hidden",
    contentCss: "width:90px;height:360px",
    custom: true,
    mutation: { top: 10000 },
  },
  {
    id: "custom-x-mid",
    axis: "horizontal custom track/thumb midpoint",
    expectedRoute: "custom-vector",
    targetCss: "overflow-x:auto;overflow-y:hidden",
    contentCss: "width:390px;height:60px",
    custom: true,
    mutation: { left: 137 },
  },
  {
    id: "custom-both-corner",
    axis: "both axes plus source-owned scroll corner",
    expectedRoute: "custom-vector",
    targetCss: "overflow:auto",
    contentCss: "width:390px;height:330px",
    custom: true,
    mutation: { left: 91, top: 83 },
    dprs: [1, 2],
  },
  {
    id: "custom-rtl-logical-left",
    axis: "horizontal-tb RTL places vertical scrollbar on logical left",
    expectedRoute: "custom-vector",
    targetCss: "overflow-y:auto;overflow-x:hidden;direction:rtl",
    contentCss: "width:90px;height:360px",
    custom: true,
    mutation: { top: 88 },
  },
  {
    id: "custom-vertical-writing",
    axis: "vertical-rl writing mode",
    expectedRoute: "custom-vector",
    targetCss: "overflow:auto;writing-mode:vertical-rl",
    contentCss: "width:360px;height:300px",
    custom: true,
    mutation: { left: -73, top: 61 },
  },
  {
    id: "custom-border-clip",
    axis: "asymmetric borders plus exact axis-aligned ancestor overflow clip",
    expectedRoute: "custom-vector",
    targetCss: "left:-9px;top:-7px;overflow:auto;border-width:3px 9px 7px 5px",
    contentCss: "width:390px;height:330px",
    clipCss: "overflow:hidden",
    clipSize: { width: 145, height: 112 },
    custom: true,
    mutation: { left: 97, top: 76 },
  },
  {
    id: "custom-zoom-125",
    axis: "CSS zoom 1.25 crosses layout/paint coordinates once",
    expectedRoute: "custom-vector",
    targetCss: "overflow:auto;zoom:1.25",
    contentCss: "width:390px;height:330px",
    custom: true,
    mutation: { left: 93, top: 79 },
    dprs: [1, 2],
  },
  {
    id: "custom-resizer-overlap",
    axis: "both scrollbar axes paint before the overlapping resizer",
    expectedRoute: "custom-vector",
    targetCss: "overflow:scroll;resize:both",
    contentCss: "width:390px;height:330px",
    custom: true,
    mutation: { left: 91, top: 83 },
  },
  {
    id: "native-auto-light",
    axis: "active platform native theme, light scheme",
    expectedRoute: "native-raster",
    targetCss: "overflow:auto;color-scheme:light",
    contentCss: "width:390px;height:330px",
    mutation: { left: 83, top: 71 },
    dprs: [1, 2],
  },
  {
    id: "native-auto-dark",
    axis: "active platform native theme, dark scheme and dark scroller surface",
    expectedRoute: "native-raster",
    targetCss: "overflow:auto;color-scheme:dark",
    contentCss: "width:390px;height:330px",
    background: [28, 32, 40],
    mutation: { left: 83, top: 71 },
  },
  {
    id: "native-thin-colors",
    axis: "standard scrollbar-width/color stay native-theme paint",
    expectedRoute: "native-raster",
    targetCss: "overflow:auto;scrollbar-width:thin;scrollbar-color:rgb(25,85,209) rgb(229,33,44)",
    contentCss: "width:390px;height:330px",
    mutation: { left: 83, top: 71 },
  },
  {
    id: "native-stable-both-edges",
    axis: "scrollbar-gutter stable both-edges layout reservation",
    expectedRoute: "suppressed-captured-absence",
    targetCss: "overflow:auto;scrollbar-gutter:stable both-edges",
    contentCss: "width:80px;height:70px",
  },
];

function htmlFor(test: AuditCase, cssZoom = 1): string {
  const background = test.background ?? TARGET_BACKGROUND;
  const scene = scrollbarAuditSceneGeometry(cssZoom);
  const clipWidth = (test.clipSize?.width ?? CLIP_SIZE.width) * cssZoom;
  const clipHeight = (test.clipSize?.height ?? CLIP_SIZE.height) * cssZoom;
  return `<!doctype html><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}
    *{box-sizing:border-box}
    #scene{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}
    #clip{position:absolute;left:${scene.clip.x}px;top:${scene.clip.y}px;width:${clipWidth}px;height:${clipHeight}px;${test.clipCss ?? "overflow:visible"}}
    #target{position:absolute;left:0;top:0;width:${TARGET_SIZE.width}px;height:${TARGET_SIZE.height}px;border:4px solid #343d48;background:rgb(${background.join(",")});${test.targetCss};zoom:${cssZoom}}
    #content{display:block;background:rgb(${background.join(",")});${test.contentCss}}
    ${test.custom ? CUSTOM_SCROLLBAR_CSS : ""}
  </style><div id="scene"><div id="clip"><div id="target"><i id="content"></i></div></div></div>`;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function mutate(page: Page, mutation: AuditCase["mutation"]): Promise<void> {
  if (mutation != null) {
    await page.locator("#target").evaluate((element, value) => {
      if (value.left != null) element.scrollLeft = value.left;
      if (value.top != null) element.scrollTop = value.top;
    }, mutation);
  }
  await settle(page);
}

async function browserFacts(page: Page): Promise<BrowserFacts> {
  return page.locator("#target").evaluate((target) => {
    const style = getComputedStyle(target);
    const clip = document.querySelector<HTMLElement>("#clip")!;
    const scrollbar = getComputedStyle(target, "::-webkit-scrollbar");
    const track = getComputedStyle(target, "::-webkit-scrollbar-track");
    const thumb = getComputedStyle(target, "::-webkit-scrollbar-thumb");
    const corner = getComputedStyle(target, "::-webkit-scrollbar-corner");
    const button = getComputedStyle(target, "::-webkit-scrollbar-button");
    const borderWidths = [
      parseFloat(style.borderTopWidth) || 0,
      parseFloat(style.borderRightWidth) || 0,
      parseFloat(style.borderBottomWidth) || 0,
      parseFloat(style.borderLeftWidth) || 0,
    ] as [number, number, number, number];
    const vertical = Math.max(0, target.offsetWidth - target.clientWidth - borderWidths[1] - borderWidths[3]);
    const horizontal = Math.max(0, target.offsetHeight - target.clientHeight - borderWidths[0] - borderWidths[2]);
    const targetRect = target.getBoundingClientRect();
    const clipRect = clip.getBoundingClientRect();
    const backgroundParts = (style.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    return {
      rect: { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height },
      clipRect: { x: clipRect.x, y: clipRect.y, width: clipRect.width, height: clipRect.height },
      offsetWidth: target.offsetWidth,
      offsetHeight: target.offsetHeight,
      clientWidth: target.clientWidth,
      clientHeight: target.clientHeight,
      scrollWidth: target.scrollWidth,
      scrollHeight: target.scrollHeight,
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
      scrollbarColor: style.scrollbarColor,
      scrollbarGutter: style.scrollbarGutter,
      colorScheme: style.colorScheme,
      direction: style.direction,
      writingMode: style.writingMode,
      zoom: style.zoom,
      backgroundRgb: [backgroundParts[0] ?? 0, backgroundParts[1] ?? 0, backgroundParts[2] ?? 0],
      borderWidths,
      layoutGutter: { vertical, horizontal },
      platformMode: vertical > 0 || horizontal > 0 ? "classic-layout" : "overlay-or-suppressed",
      pseudos: {
        scrollbar: { display: scrollbar.display, width: scrollbar.width, height: scrollbar.height, backgroundColor: scrollbar.backgroundColor, border: scrollbar.border },
        track: { display: track.display, width: track.width, height: track.height, backgroundColor: track.backgroundColor, border: track.border },
        thumb: { display: thumb.display, width: thumb.width, height: thumb.height, backgroundColor: thumb.backgroundColor, border: thumb.border },
        corner: { display: corner.display, width: corner.width, height: corner.height, backgroundColor: corner.backgroundColor, border: corner.border },
        button: { display: button.display, width: button.width, height: button.height, backgroundColor: button.backgroundColor, border: button.border },
      },
    };
  });
}

function findCapturedScroller(elements: CapturedElement[]): CapturedElement | null {
  for (const element of elements) {
    const style = element.styles;
    // The fixture target is the only bordered descendant.  Selecting by
    // overflow would accidentally choose the ancestor clip in the clip row and
    // would make the overflow:visible negative disappear from capture facts.
    if (element.width <= TARGET_SIZE.width * MAX_AUDIT_ZOOM
        && element.height <= TARGET_SIZE.height * MAX_AUDIT_ZOOM
        && [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
          .some((width) => (parseFloat(width ?? "0") || 0) > 0)) return element;
    const child = findCapturedScroller(element.children ?? []);
    if (child != null) return child;
  }
  return null;
}

function capturedNativeRasterFacts(raster: CapturedNativeScrollbarRaster | undefined): NativeRasterFacts | null {
  if (raster == null) return null;
  return {
    x: raster.x,
    y: raster.y,
    width: raster.width,
    height: raster.height,
    pixelWidth: raster.pixelWidth,
    pixelHeight: raster.pixelHeight,
    captureDpr: raster.captureDpr,
    sourceFrameSha256: raster.sourceFrameSha256,
    cropSha256: raster.cropSha256 ?? null,
    empty: raster.empty === true,
  };
}

function capturedFacts(element: CapturedElement | null): CapturedFacts | null {
  if (element == null) return null;
  const style = element.styles;
  const scrollbars = element.scrollbars;
  return {
    rect: { x: element.x, y: element.y, width: element.width, height: element.height },
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    scrollbarGutter: style.scrollbarGutter,
    clientWidth: style.clientWidth,
    clientHeight: style.clientHeight,
    scrollWidth: style.scrollWidth,
    scrollHeight: style.scrollHeight,
    scrollLeft: style.scrollLeft,
    scrollTop: style.scrollTop,
    scrollbarStatus: scrollbars?.status ?? null,
    horizontalRoute: scrollbars?.horizontal?.route ?? null,
    verticalRoute: scrollbars?.vertical?.route ?? null,
    horizontalParts: scrollbars?.horizontal?.parts.map(({ kind }) => kind) ?? [],
    verticalParts: scrollbars?.vertical?.parts.map(({ kind }) => kind) ?? [],
    horizontalLogicalSide: scrollbars?.horizontal?.logicalSide ?? null,
    verticalLogicalSide: scrollbars?.vertical?.logicalSide ?? null,
    horizontalPosition: scrollbars?.horizontal?.currentPosition ?? null,
    verticalPosition: scrollbars?.vertical?.currentPosition ?? null,
    horizontalNativeRaster: capturedNativeRasterFacts(scrollbars?.horizontal?.nativeRaster),
    verticalNativeRaster: capturedNativeRasterFacts(scrollbars?.vertical?.nativeRaster),
    nativeCornerRaster: capturedNativeRasterFacts(scrollbars?.nativeCornerRaster),
    corner: scrollbars?.corner?.rect ?? null,
    outputTransform: scrollbars?.outputTransform.matrix ?? null,
    resizeHandle: element.resizeHandle == null ? null : {
      x: element.resizeHandle.x,
      y: element.resizeHandle.y,
      width: element.resizeHandle.width,
      height: element.resizeHandle.height,
    },
    resizerOverlap: scrollbars?.resizerOverlap == null ? null : {
      rect: scrollbars.resizerOverlap.rect,
      paintOrder: scrollbars.resizerOverlap.paintOrder,
    },
    missingFacts: scrollbars?.missingFacts ?? [],
  };
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
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

function edgeFingerprint(
  data: Buffer,
  imageWidth: number,
  imageHeight: number,
  rect: Rect,
  dpr: number,
  edge: "left" | "right" | "bottom",
  background: readonly [number, number, number],
): EdgeFingerprint {
  const left = Math.max(0, Math.round(rect.x * dpr));
  const top = Math.max(0, Math.round(rect.y * dpr));
  const right = Math.min(imageWidth, Math.round((rect.x + rect.width) * dpr));
  const bottom = Math.min(imageHeight, Math.round((rect.y + rect.height) * dpr));
  const inset = Math.max(1, Math.round(5 * dpr));
  const strip = Math.max(2, Math.round(20 * dpr));
  const x0 = edge === "left" ? left + inset : edge === "right" ? Math.max(left, right - inset - strip) : left + inset;
  const x1 = edge === "left" ? Math.min(right, left + inset + strip) : edge === "right" ? right - inset : right - inset;
  const y0 = edge === "bottom" ? Math.max(top, bottom - inset - strip) : top + inset;
  const y1 = edge === "bottom" ? bottom - inset : bottom - inset;
  const histogram = new Map<string, number>();
  let samplePixels = 0;
  let changedPixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * imageWidth + x) * 3;
      if (offset < 0 || offset + 2 >= data.length) continue;
      samplePixels++;
      const rgb = [data[offset], data[offset + 1], data[offset + 2]] as const;
      if (squaredDistance(rgb, background) <= 8 ** 2 * 3) continue;
      changedPixels++;
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
  }
  return {
    samplePixels,
    changedPixels,
    changedFraction: samplePixels === 0 ? 0 : changedPixels / samplePixels,
    topColors: [...histogram.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([rgb, pixels]) => ({ rgb, pixels })),
  };
}

async function pixelFacts(png: Buffer, source: BrowserFacts, dpr: number): Promise<PixelFacts> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const labels = new Uint8Array(info.width * info.height);
  let markerPixels = 0;
  for (let pixel = 0; pixel < labels.length; pixel++) {
    const offset = pixel * 3;
    const rgb = [data[offset], data[offset + 1], data[offset + 2]] as const;
    let best = Number.POSITIVE_INFINITY;
    let label = 0;
    for (let index = 0; index < MARKERS.length; index++) {
      const distance = squaredDistance(rgb, MARKERS[index].rgb);
      if (distance < best) {
        best = distance;
        label = index + 1;
      }
    }
    if (best <= MARKER_DISTANCE_SQUARED) {
      labels[pixel] = label;
      markerPixels++;
    }
  }
  const markers: Record<string, Bounds | null> = {};
  for (let index = 0; index < MARKERS.length; index++) {
    markers[MARKERS[index].name] = boundsFor(labels, info.width, index + 1);
  }
  return {
    width: info.width,
    height: info.height,
    markers,
    markerPixels,
    edges: {
      left: edgeFingerprint(data, info.width, info.height, source.rect, dpr, "left", source.backgroundRgb),
      right: edgeFingerprint(data, info.width, info.height, source.rect, dpr, "right", source.backgroundRgb),
      bottom: edgeFingerprint(data, info.width, info.height, source.rect, dpr, "bottom", source.backgroundRgb),
    },
  };
}

function countGenericThumbs(svg: string): number {
  return [...svg.matchAll(/<rect\b[^>]*\bfill="rgba\(0,0,0,0\.40\)"[^>]*>/g)].length;
}

function markerBoundsMatchWithinOneDevicePixel(
  source: PixelFacts,
  generated: PixelFacts,
): boolean {
  return MARKERS.every(({ name }) => {
    const expected = source.markers[name];
    const actual = generated.markers[name];
    if (expected == null || actual == null) return expected == null && actual == null;
    return boundDelta(expected, actual) != null && boundDelta(expected, actual)! <= 1;
  });
}

function pixelFactsMatchExactly(source: PixelFacts, generated: PixelFacts): boolean {
  return source.width === generated.width
    && source.height === generated.height
    && source.markerPixels === generated.markerPixels
    && JSON.stringify(source.markers) === JSON.stringify(generated.markers)
    && JSON.stringify(source.edges) === JSON.stringify(generated.edges);
}

function rasterFactsAreAuthenticated(facts: NativeRasterFacts | null, dpr: number): boolean {
  return facts != null
    && facts.empty === false
    && facts.captureDpr === dpr
    && facts.pixelWidth === Math.round(facts.width * dpr)
    && facts.pixelHeight === Math.round(facts.height * dpr)
    && /^[a-f0-9]{64}$/.test(facts.sourceFrameSha256)
    && facts.cropSha256 != null
    && /^[a-f0-9]{64}$/.test(facts.cropSha256);
}

function rowPass(row: Omit<AuditRow, "pass">): boolean {
  if (row.expectedRoute === "marker-free-control") {
    return row.sourcePixels.markerPixels === 0
      && row.generatedPixels.markerPixels === 0
      && row.generatedGenericThumbs === 0;
  }
  if (row.expectedRoute === "custom-vector") {
    return row.sourcePixels.markerPixels >= 120
      && row.generatedPixels.markerPixels >= 120
      && row.sourcePixels.markers.track != null
      // overflow:scroll creates disabled track chrome even when there is no
      // scroll range; Blink correctly has no thumb in that activation row.
      && (row.id === "custom-scroll-no-overflow" || row.sourcePixels.markers.thumb != null)
      && markerBoundsMatchWithinOneDevicePixel(row.sourcePixels, row.generatedPixels)
      && row.generatedGenericThumbs === 0
      && row.warnings.length === 0
      && row.captured?.scrollbarStatus === "captured"
      && row.captured.missingFacts.length === 0
      && [row.captured.horizontalRoute, row.captured.verticalRoute].includes("author-custom")
      && (row.id !== "custom-resizer-overlap" || (
        row.sourcePixels.markers.resizer != null
        && row.generatedPixels.markers.resizer != null
        && row.captured.resizeHandle != null
        && row.captured.resizerOverlap?.paintOrder === "corner-before-resizer"
      ));
  }
  if (row.expectedRoute === "suppressed-captured-absence") {
    return row.sourcePixels.markerPixels === 0
      && row.generatedPixels.markerPixels === 0
      && row.generatedGenericThumbs === 0
      && row.warnings.length === 0
      && row.captured?.scrollbarStatus === "absent"
      && row.captured.missingFacts.length === 0;
  }
  if (row.expectedRoute === "native-raster") {
    return pixelFactsMatchExactly(row.sourcePixels, row.generatedPixels)
      && row.generatedGenericThumbs === 0
      && row.warnings.length === 0
      && row.captured?.scrollbarStatus === "captured"
      && row.captured.missingFacts.length === 0
      && row.captured.horizontalRoute === "native-raster"
      && row.captured.verticalRoute === "native-raster"
      && rasterFactsAreAuthenticated(row.captured.horizontalNativeRaster, row.deviceScaleFactor)
      && rasterFactsAreAuthenticated(row.captured.verticalNativeRaster, row.deviceScaleFactor)
      && JSON.stringify(row.captured.outputTransform) === "[1,0,0,1,0,0]";
  }
  // This route is deliberately observation-only and can never turn the
  // producer green. Dynamic platform fade evidence remains separate from the
  // exact same-frame raster owner above.
  return false;
}

function cssBounds(bounds: Bounds | null, dpr: number): Bounds | null {
  if (bounds == null) return null;
  return {
    x: bounds.x / dpr,
    y: bounds.y / dpr,
    width: bounds.width / dpr,
    height: bounds.height / dpr,
    pixels: bounds.pixels,
  };
}

function boundDelta(a: Bounds | null, b: Bounds | null): number | null {
  if (a == null || b == null) return null;
  return Math.max(
    Math.abs(a.x - b.x), Math.abs(a.y - b.y),
    Math.abs(a.width - b.width), Math.abs(a.height - b.height),
  );
}

function ownershipControls(rows: readonly AuditRow[]): Record<string, boolean> {
  const row = (id: string, dpr = 1, cssZoom?: number) => rows.find((candidate) => (
    candidate.id === id && candidate.deviceScaleFactor === dpr
    && (cssZoom == null || candidate.cssZoom === cssZoom)
  ));
  const thumb = (arm: "sourcePixels" | "generatedPixels", id: string, dpr = 1) => (
    row(id, dpr)?.[arm].markers.thumb ?? null
  );
  const sourceTop = thumb("sourcePixels", "custom-y-top");
  const sourceMid = thumb("sourcePixels", "custom-y-mid");
  const sourceMax = thumb("sourcePixels", "custom-y-max");
  const generatedTop = thumb("generatedPixels", "custom-y-top");
  const generatedMid = thumb("generatedPixels", "custom-y-mid");
  const generatedMax = thumb("generatedPixels", "custom-y-max");
  const capturedTop = row("custom-y-top")?.captured?.verticalPosition;
  const capturedMid = row("custom-y-mid")?.captured?.verticalPosition;
  const capturedMax = row("custom-y-max")?.captured?.verticalPosition;
  const sourceHorizontal = thumb("sourcePixels", "custom-x-mid");
  const generatedHorizontal = thumb("generatedPixels", "custom-x-mid");
  const capturedHorizontal = row("custom-x-mid")?.captured;
  const capturedVertical = row("custom-y-mid")?.captured;
  const sourceRtl = thumb("sourcePixels", "custom-rtl-logical-left");
  const generatedRtl = thumb("generatedPixels", "custom-rtl-logical-left");
  const clipped = row("custom-border-clip");
  const clippedTrack = clipped?.sourcePixels.markers.track;
  const clipRect = clipped?.source.clipRect;
  const dpr1 = cssBounds(thumb("sourcePixels", "custom-both-corner", 1), 1);
  const dpr2 = cssBounds(thumb("sourcePixels", "custom-both-corner", 2), 2);
  const both = row("custom-both-corner");
  const resizer = row("custom-resizer-overlap");
  const nativeRows = rows.filter((candidate) => candidate.expectedRoute === "native-raster");

  return {
    allRowsClassified: rows.every((candidate) => candidate.pass && rowPass(candidate)),
    overflowNegativesStayMarkerFree: rows
      .filter((candidate) => candidate.expectedRoute === "marker-free-control")
      .every((candidate) => rowPass(candidate)),
    everyCustomRouteIsDiscriminated: rows
      .filter((candidate) => candidate.expectedRoute === "custom-vector")
      .every((candidate) => rowPass(candidate)),
    everyNativeRasterIsSourceExact: nativeRows.length > 0
      && nativeRows.every((candidate) => rowPass(candidate)),
    hiddenWidthCapturesExplicitAbsence: rows
      .filter((candidate) => candidate.id === "width-none-scrolled")
      .every((candidate) => rowPass(candidate)),
    sourceAndGeneratedThumbMoveTopMidMax:
      sourceTop != null && sourceMid != null && sourceMax != null
      && generatedTop != null && generatedMid != null && generatedMax != null
      && capturedTop != null && capturedMid != null && capturedMax != null
      && sourceTop.y < sourceMid.y && sourceMid.y < sourceMax.y
      && generatedTop.y < generatedMid.y && generatedMid.y < generatedMax.y
      && capturedTop < capturedMid && capturedMid < capturedMax,
    horizontalAndVerticalAxesDiffer:
      sourceHorizontal != null && sourceMid != null
      && generatedHorizontal != null && generatedMid != null
      && sourceHorizontal.width > sourceHorizontal.height && sourceMid.height > sourceMid.width
      && generatedHorizontal.width > generatedHorizontal.height && generatedMid.height > generatedMid.width
      && capturedHorizontal?.horizontalPosition != null
      && capturedHorizontal.verticalPosition == null
      && capturedVertical?.horizontalPosition == null
      && capturedVertical?.verticalPosition != null,
    rtlMovesVerticalChromeToLogicalLeft:
      sourceMid != null && sourceRtl != null && generatedMid != null && generatedRtl != null
      && sourceRtl.x + 40 < sourceMid.x && generatedRtl.x + 40 < generatedMid.x
      && row("custom-rtl-logical-left")?.captured?.verticalLogicalSide === "left",
    bothAxesOwnCorner:
      (both?.sourcePixels.markers.corner?.pixels ?? 0) > 20
      && (both?.generatedPixels.markers.corner?.pixels ?? 0) > 20
      && both?.captured?.horizontalRoute === "author-custom"
      && both.captured.verticalRoute === "author-custom"
      && both.captured.corner != null,
    resizerPaintsAfterOwnedCorner:
      resizer?.sourcePixels.markers.resizer != null
      && resizer.generatedPixels.markers.resizer != null
      && resizer.captured?.resizeHandle != null
      && resizer.captured.corner != null
      && resizer.captured.resizerOverlap?.paintOrder === "corner-before-resizer",
    verticalWritingRecorded: row("custom-vertical-writing")?.source.writingMode === "vertical-rl",
    borderClipContainsChrome: clippedTrack != null && clipRect != null
      && clippedTrack.x >= Math.floor(clipRect.x)
      && clippedTrack.y >= Math.floor(clipRect.y)
      && clippedTrack.x + clippedTrack.width <= Math.ceil(clipRect.x + clipRect.width)
      && clippedTrack.y + clippedTrack.height <= Math.ceil(clipRect.y + clipRect.height),
    zoomChangesPhysicalBox: (row("custom-zoom-125", 1, 1.25)?.source.rect.width ?? 0) > 190,
    dprGeometryStableWithinOneCssPixel: (boundDelta(dpr1, dpr2) ?? Number.POSITIVE_INFINITY) <= 1,
    lightDarkSchemesRecorded: row("native-auto-light")?.source.colorScheme === "light"
      && row("native-auto-dark")?.source.colorScheme === "dark",
    darkSurfaceChangesNativeInk:
      row("native-auto-light")?.sourcePixels.edges.right.topColors[0]?.rgb != null
      && row("native-auto-dark")?.sourcePixels.edges.right.topColors[0]?.rgb != null
      && row("native-auto-light")!.sourcePixels.edges.right.topColors[0].rgb
        !== row("native-auto-dark")!.sourcePixels.edges.right.topColors[0].rgb,
    standardWidthAndColorRecorded: row("native-thin-colors")?.source.scrollbarWidth === "thin"
      && row("native-thin-colors")?.source.scrollbarColor.includes("rgb(25, 85, 209)"),
    captureContractCarriesOwnershipFacts: rows.every((candidate) => {
      if (candidate.captured == null) return false;
      if (candidate.expectedRoute === "marker-free-control") return true;
      return candidate.captured.scrollbarStatus != null;
    }),
  };
}

function activeMutationControls(rows: readonly AuditRow[]): Record<string, boolean> {
  const mutate = (id: string, callback: (row: AuditRow) => void): AuditRow[] => {
    const copy = structuredClone(rows) as AuditRow[];
    const target = copy.find((candidate) => candidate.id === id && candidate.deviceScaleFactor === 1);
    if (target != null) callback(target);
    return copy;
  };
  const controlsAfter = (id: string, callback: (row: AuditRow) => void) => (
    ownershipControls(mutate(id, callback))
  );
  return {
    frozenTopMidMaxRejected: !controlsAfter("custom-y-max", (target) => {
      const mid = rows.find((candidate) => candidate.id === "custom-y-mid" && candidate.deviceScaleFactor === 1);
      if (target.captured != null && mid?.captured?.verticalPosition != null) {
        target.captured.verticalPosition = mid.captured.verticalPosition;
      }
    }).sourceAndGeneratedThumbMoveTopMidMax,
    swappedAxisRejected: !controlsAfter("custom-x-mid", (target) => {
      if (target.captured != null) {
        target.captured.verticalPosition = target.captured.horizontalPosition;
        target.captured.horizontalPosition = null;
      }
    }).horizontalAndVerticalAxesDiffer,
    wrongRtlSideRejected: !controlsAfter("custom-rtl-logical-left", (target) => {
      if (target.captured != null) target.captured.verticalLogicalSide = "right";
    }).rtlMovesVerticalChromeToLogicalLeft,
    missingBothAxisCornerRejected: !controlsAfter("custom-both-corner", (target) => {
      if (target.captured != null) target.captured.corner = null;
    }).bothAxesOwnCorner,
    wrongResizerOrderRejected: !controlsAfter("custom-resizer-overlap", (target) => {
      if (target.captured != null) target.captured.resizerOverlap = null;
    }).resizerPaintsAfterOwnedCorner,
    missingNativeRasterDigestRejected: !controlsAfter("native-auto-light", (target) => {
      if (target.captured?.horizontalNativeRaster != null) {
        target.captured.horizontalNativeRaster.cropSha256 = null;
      }
    }).everyNativeRasterIsSourceExact,
  };
}

export interface NativeScrollbarAuditOptions {
  deviceScaleFactors?: readonly number[];
  cssZooms?: readonly number[];
  artifactDir?: string;
  reportDir?: string;
  evidenceRole?: "proposal" | "validation";
  provenance?: {
    githubRunId: string;
    githubRunAttempt: string;
    githubJob: string;
    runnerName: string;
    runnerImage: string;
    runnerImageVersion: string;
    workflowRef: string;
    bootId: string;
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runNativeScrollbarOwnershipAudit(options: NativeScrollbarAuditOptions = {}): Promise<{
  schemaVersion: 2;
  evidenceRole: "proposal" | "validation" | "local";
  observationId: string;
  provenance: NativeScrollbarAuditOptions["provenance"] | null;
  logicalRowsSha256: string;
  rowSetSha256: string;
  artifactSetSha256: string;
  dynamicFadeClassification: "separate-platform-terminal-not-observed";
  browserLaunch: { headless: true; ignoredDefaultArguments: ["--hide-scrollbars"] };
  chromiumExecutableSha256: string;
  sourceRevisions: typeof SOURCE_REVISIONS;
  chromiumVersion: string;
  playwrightVersion: string;
  host: { platform: NodeJS.Platform; architecture: string; release: string };
  rows: AuditRow[];
  controls: Record<string, boolean>;
  mutations: Record<string, boolean>;
  platformFingerprints: Array<{
    id: string;
    dpr: number;
    mode: BrowserFacts["platformMode"];
    layoutGutter: BrowserFacts["layoutGutter"];
    leftInk: number;
    rightInk: number;
    bottomInk: number;
    dominantRightColor: string | null;
    dominantBottomColor: string | null;
  }>;
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
  // Playwright normally adds `--hide-scrollbars`, which would turn every
  // screenshot into a false negative for the exact thing this probe audits.
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const rows: AuditRow[] = [];
  try {
    for (const test of CASES) {
      for (const deviceScaleFactor of options.deviceScaleFactors ?? test.dprs ?? [1]) {
        for (const cssZoom of options.cssZooms ?? [test.id === "custom-zoom-125" ? 1.25 : 1]) {
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
        const generatedContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
        const page = await context.newPage();
        const generatedPage = await generatedContext.newPage();
        try {
          await page.setContent(htmlFor(test, cssZoom), { waitUntil: "load" });
          await mutate(page, test.mutation);
          const source = await browserFacts(page);
          const sourcePng = await page.screenshot({ type: "png" });
          const { tree, warnings } = await captureElementTreeWithWarnings(
            page, "#scene", { x: 0, y: 0, ...VIEWPORT },
          );
          const captured = capturedFacts(findCapturedScroller(tree));
          const svg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: deviceScaleFactor });
          await generatedPage.setContent(
            `<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}svg{display:block}</style>${svg}`,
            { waitUntil: "load" },
          );
          await settle(generatedPage);
          const generatedPng = await generatedPage.screenshot({ type: "png" });
          const artifacts: AuditRow["artifacts"] = [];
          if (options.artifactDir != null) {
            mkdirSync(options.artifactDir, { recursive: true });
            for (const [role, bytes] of [["source", sourcePng], ["generated", generatedPng]] as const) {
              const filename = `${test.id}-dpr${deviceScaleFactor}-zoom${cssZoom}-${role}.png`;
              const path = join(options.artifactDir, filename);
              writeFileSync(path, bytes);
              const metadata = await sharp(bytes).metadata();
              artifacts.push({
                role,
                path: options.reportDir == null ? filename : relative(options.reportDir, path),
                sha256: sha256(bytes),
                pngWidth: metadata.width!,
                pngHeight: metadata.height!,
              });
            }
          }
          const base = {
            id: test.id,
            axis: test.axis,
            expectedRoute: test.expectedRoute,
            deviceScaleFactor,
            cssZoom,
            source,
            captured,
            sourcePixels: await pixelFacts(sourcePng, source, deviceScaleFactor),
            generatedPixels: await pixelFacts(generatedPng, source, deviceScaleFactor),
            generatedGenericThumbs: countGenericThumbs(svg),
            artifacts,
            warnings: warnings.map((warning) => `${warning.feature}: ${warning.detail}`),
          };
          rows.push({ ...base, pass: rowPass(base) });
        } finally {
          await context.close();
          await generatedContext.close();
        }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const controls = ownershipControls(rows);
  const mutations = activeMutationControls(rows);
  const platformFingerprints = rows
    .filter((candidate) => candidate.expectedRoute === "native-raster")
    .map((candidate) => ({
      id: candidate.id,
      dpr: candidate.deviceScaleFactor,
      mode: candidate.source.platformMode,
      layoutGutter: candidate.source.layoutGutter,
      leftInk: candidate.sourcePixels.edges.left.changedPixels,
      rightInk: candidate.sourcePixels.edges.right.changedPixels,
      bottomInk: candidate.sourcePixels.edges.bottom.changedPixels,
      dominantRightColor: candidate.sourcePixels.edges.right.topColors[0]?.rgb ?? null,
      dominantBottomColor: candidate.sourcePixels.edges.bottom.topColors[0]?.rgb ?? null,
    }));
  const pass = Object.values(controls).every(Boolean) && Object.values(mutations).every(Boolean);
  const logicalRows = rows.map((row) => ({
    id: row.id,
    axis: row.axis,
    expectedRoute: row.expectedRoute,
    deviceScaleFactor: row.deviceScaleFactor,
    cssZoom: row.cssZoom,
    captured: row.captured,
  }));
  const artifactManifest = rows.flatMap((row) => row.artifacts.map((artifact) => ({
    row: `${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}`,
    ...artifact,
  })));
  return {
    schemaVersion: 2,
    evidenceRole: options.evidenceRole ?? "local",
    observationId: randomUUID(),
    provenance: options.provenance ?? null,
    logicalRowsSha256: sha256(JSON.stringify(logicalRows)),
    rowSetSha256: sha256(JSON.stringify(rows)),
    artifactSetSha256: sha256(JSON.stringify(artifactManifest)),
    dynamicFadeClassification: "separate-platform-terminal-not-observed",
    browserLaunch: { headless: true, ignoredDefaultArguments: ["--hide-scrollbars"] },
    chromiumExecutableSha256: sha256(readFileSync(chromium.executablePath())),
    sourceRevisions: SOURCE_REVISIONS,
    chromiumVersion: browser.version(),
    playwrightVersion,
    host: { platform: platform(), architecture: arch(), release: release() },
    rows,
    controls,
    mutations,
    platformFingerprints,
    verdict: pass ? "authoritative-capture-and-source-owned-paint-exact" : "probe-expectation-or-source-drift",
  };
}

async function main(): Promise<number> {
  const jsonIndex = process.argv.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : undefined;
  const value = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const numbers = (flag: string): number[] | undefined => value(flag)?.split(",").map(Number);
  const role = value("--evidence-role");
  if (role != null && role !== "proposal" && role !== "validation") {
    throw new Error("--evidence-role must be proposal or validation");
  }
  const artifactDir = value("--artifacts");
  const bootIdPath = value("--boot-id");
  const runnerImagePath = value("--runner-image");
  const provenance = role == null ? undefined : {
    githubRunId: process.env.GITHUB_RUN_ID ?? "local",
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
    githubJob: process.env.GITHUB_JOB ?? `${role}-local`,
    runnerName: process.env.RUNNER_NAME ?? `${platform()}-${role}-local`,
    runnerImage: process.env.ImageOS ?? process.env.RUNNER_OS ?? platform(),
    runnerImageVersion: process.env.ImageVersion ?? (runnerImagePath == null ? "local" : sha256(readFileSync(runnerImagePath))),
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "local",
    bootId: bootIdPath == null ? `local-${randomUUID()}` : readFileSync(bootIdPath, "utf8").trim(),
  };
  const report = await runNativeScrollbarOwnershipAudit({
    deviceScaleFactors: numbers("--dpr"),
    cssZooms: numbers("--zoom"),
    artifactDir,
    reportDir: jsonPath == null ? undefined : resolve(jsonPath, ".."),
    evidenceRole: role as "proposal" | "validation" | undefined,
    provenance,
  });
  if (jsonPath != null) {
    mkdirSync(resolve(jsonPath, ".."), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`native scrollbar ownership audit: ${report.rows.filter((row) => row.pass).length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    console.log(
      `${row.pass ? "PASS" : "FAIL"} ${row.id}@${row.deviceScaleFactor}x: route=${row.expectedRoute}, source-markers=${row.sourcePixels.markerPixels}, generated-markers=${row.generatedPixels.markerPixels}, generic-thumbs=${row.generatedGenericThumbs}, mode=${row.source.platformMode}`,
    );
  }
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  console.log(`mutations: ${JSON.stringify(report.mutations)}`);
  return report.verdict === "authoritative-capture-and-source-owned-paint-exact" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
