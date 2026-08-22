#!/usr/bin/env tsx
/**
 * DM-2368 investigation probe.
 *
 * Observational only.  It compares live Chromium scrollbar pixels and geometry
 * with Domotion's generated SVG.  Loud author scrollbar colors isolate Blink's
 * custom-scrollbar part geometry; marker-free native rows record the active
 * platform theme without pretending that one host's chrome is portable.
 */
import { writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { chromium, type Page } from "playwright";
import type { CapturedElement } from "../src/capture/types.js";

const SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

const VIEWPORT = { width: 270, height: 205 };
const TARGET_BACKGROUND = [237, 241, 245] as const;
const MARKER_DISTANCE_SQUARED = 30 ** 2 * 3;

const MARKERS = [
  { name: "track", rgb: [229, 33, 44] as const },
  { name: "thumb", rgb: [25, 85, 209] as const },
  { name: "corner", rgb: [18, 166, 106] as const },
  { name: "button", rgb: [242, 189, 29] as const },
] as const;

type ExpectedRoute =
  | "marker-free-control"
  | "custom-vector-current-gap"
  | "suppressed-captured-absence"
  | "native-platform-fingerprint";

interface AuditCase {
  id: string;
  axis: string;
  expectedRoute: ExpectedRoute;
  targetCss: string;
  contentCss: string;
  custom?: boolean;
  clipCss?: string;
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
  missingFacts: string[];
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
  source: BrowserFacts;
  captured: CapturedFacts | null;
  sourcePixels: PixelFacts;
  generatedPixels: PixelFacts;
  generatedGenericThumbs: number;
  warnings: string[];
  pass: boolean;
}

const CUSTOM_SCROLLBAR_CSS = `
  #target::-webkit-scrollbar{width:16px;height:14px;background:#e5212c}
  #target::-webkit-scrollbar-track{background:#e5212c}
  #target::-webkit-scrollbar-thumb{background:#1955d1;border:2px solid #e5212c;border-radius:0}
  #target::-webkit-scrollbar-corner{background:#12a66a}
  #target::-webkit-scrollbar-button{display:none;background:#f2bd1d;width:0;height:0}
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
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow:scroll",
    contentCss: "width:70px;height:60px",
    custom: true,
  },
  {
    id: "custom-y-top",
    axis: "vertical custom track/thumb at minimum offset",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow-y:auto;overflow-x:hidden",
    contentCss: "width:90px;height:360px",
    custom: true,
  },
  {
    id: "custom-y-mid",
    axis: "vertical custom thumb proportional midpoint",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow-y:auto;overflow-x:hidden",
    contentCss: "width:90px;height:360px",
    custom: true,
    mutation: { top: 122 },
  },
  {
    id: "custom-y-max",
    axis: "vertical custom thumb maximum offset",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow-y:auto;overflow-x:hidden",
    contentCss: "width:90px;height:360px",
    custom: true,
    mutation: { top: 10000 },
  },
  {
    id: "custom-x-mid",
    axis: "horizontal custom track/thumb midpoint",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow-x:auto;overflow-y:hidden",
    contentCss: "width:390px;height:60px",
    custom: true,
    mutation: { left: 137 },
  },
  {
    id: "custom-both-corner",
    axis: "both axes plus source-owned scroll corner",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow:auto",
    contentCss: "width:390px;height:330px",
    custom: true,
    mutation: { left: 91, top: 83 },
    dprs: [1, 2],
  },
  {
    id: "custom-rtl-logical-left",
    axis: "horizontal-tb RTL places vertical scrollbar on logical left",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow-y:auto;overflow-x:hidden;direction:rtl",
    contentCss: "width:90px;height:360px",
    custom: true,
    mutation: { top: 88 },
  },
  {
    id: "custom-vertical-writing",
    axis: "vertical-rl writing mode",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow:auto;writing-mode:vertical-rl",
    contentCss: "width:360px;height:300px",
    custom: true,
    mutation: { left: -73, top: 61 },
  },
  {
    id: "custom-border-clip",
    axis: "asymmetric borders/radius plus ancestor overflow clip",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "left:-9px;top:-7px;overflow:auto;border-width:3px 9px 7px 5px;border-radius:22px 7px 28px 3px",
    contentCss: "width:390px;height:330px",
    clipCss: "overflow:hidden;border-radius:19px;width:145px;height:112px",
    custom: true,
    mutation: { left: 97, top: 76 },
  },
  {
    id: "custom-zoom-125",
    axis: "CSS zoom 1.25 crosses layout/paint coordinates once",
    expectedRoute: "custom-vector-current-gap",
    targetCss: "overflow:auto;zoom:1.25",
    contentCss: "width:390px;height:330px",
    custom: true,
    mutation: { left: 93, top: 79 },
    dprs: [1, 2],
  },
  {
    id: "native-auto-light",
    axis: "active platform native theme, light scheme",
    expectedRoute: "native-platform-fingerprint",
    targetCss: "overflow:auto;color-scheme:light",
    contentCss: "width:390px;height:330px",
    mutation: { left: 83, top: 71 },
    dprs: [1, 2],
  },
  {
    id: "native-auto-dark",
    axis: "active platform native theme, dark scheme and dark scroller surface",
    expectedRoute: "native-platform-fingerprint",
    targetCss: "overflow:auto;color-scheme:dark",
    contentCss: "width:390px;height:330px",
    background: [28, 32, 40],
    mutation: { left: 83, top: 71 },
  },
  {
    id: "native-thin-colors",
    axis: "standard scrollbar-width/color stay native-theme paint",
    expectedRoute: "native-platform-fingerprint",
    targetCss: "overflow:auto;scrollbar-width:thin;scrollbar-color:rgb(25,85,209) rgb(229,33,44)",
    contentCss: "width:390px;height:330px",
    mutation: { left: 83, top: 71 },
  },
  {
    id: "native-stable-both-edges",
    axis: "scrollbar-gutter stable both-edges layout reservation",
    expectedRoute: "native-platform-fingerprint",
    targetCss: "overflow:auto;scrollbar-gutter:stable both-edges",
    contentCss: "width:80px;height:70px",
  },
];

function htmlFor(test: AuditCase): string {
  const background = test.background ?? TARGET_BACKGROUND;
  return `<!doctype html><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}
    *{box-sizing:border-box}
    #scene{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;overflow:hidden}
    #clip{position:absolute;left:34px;top:27px;width:176px;height:142px;${test.clipCss ?? "overflow:visible"}}
    #target{position:absolute;left:0;top:0;width:156px;height:118px;border:4px solid #343d48;background:rgb(${background.join(",")});${test.targetCss}}
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
    if (element.width < 220 && element.height < 190
        && [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
          .some((width) => (parseFloat(width ?? "0") || 0) > 0)) return element;
    const child = findCapturedScroller(element.children ?? []);
    if (child != null) return child;
  }
  return null;
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

function rowPass(row: Omit<AuditRow, "pass">): boolean {
  if (row.expectedRoute === "marker-free-control") {
    return row.sourcePixels.markerPixels === 0
      && row.generatedPixels.markerPixels === 0
      && row.generatedGenericThumbs === 0;
  }
  if (row.expectedRoute === "custom-vector-current-gap") {
    return row.sourcePixels.markerPixels >= 120
      && row.sourcePixels.markers.track != null
      // overflow:scroll creates disabled track chrome even when there is no
      // scroll range; Blink correctly has no thumb in that activation row.
      && (row.id === "custom-scroll-no-overflow" || row.sourcePixels.markers.thumb != null)
      && row.generatedPixels.markerPixels <= 4
      && row.generatedGenericThumbs === 0
      && row.captured?.scrollbarStatus === "partial"
      && [row.captured.horizontalRoute, row.captured.verticalRoute].includes("author-custom");
  }
  if (row.expectedRoute === "suppressed-captured-absence") {
    return row.sourcePixels.markerPixels === 0
      && row.generatedGenericThumbs === 0
      && row.captured?.scrollbarStatus === "absent";
  }
  if (row.id === "native-stable-both-edges") {
    return row.sourcePixels.edges.left.changedPixels === 0
      && row.sourcePixels.edges.right.changedPixels === 0
      && row.sourcePixels.edges.bottom.changedPixels === 0
      && row.generatedGenericThumbs === 0;
  }
  if (row.id === "native-thin-colors") {
    return (row.sourcePixels.markers.thumb?.pixels ?? 0) >= 100
      && row.generatedPixels.markerPixels <= 4
      && row.generatedGenericThumbs === 0
      && row.captured?.scrollbarStatus === "partial";
  }
  return row.sourcePixels.edges.right.changedPixels >= 100
    && row.sourcePixels.edges.bottom.changedPixels >= 100
    && row.generatedGenericThumbs === 0
    && row.captured?.scrollbarStatus === "partial";
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

export async function runNativeScrollbarOwnershipAudit(): Promise<{
  sourceRevisions: typeof SOURCE_REVISIONS;
  chromiumVersion: string;
  playwrightVersion: string;
  host: { platform: NodeJS.Platform; architecture: string; release: string };
  rows: AuditRow[];
  controls: Record<string, boolean>;
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
      for (const deviceScaleFactor of test.dprs ?? [1]) {
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
        const generatedContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
        const page = await context.newPage();
        const generatedPage = await generatedContext.newPage();
        try {
          await page.setContent(htmlFor(test), { waitUntil: "load" });
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
          const base = {
            id: test.id,
            axis: test.axis,
            expectedRoute: test.expectedRoute,
            deviceScaleFactor,
            source,
            captured,
            sourcePixels: await pixelFacts(sourcePng, source, deviceScaleFactor),
            generatedPixels: await pixelFacts(generatedPng, source, deviceScaleFactor),
            generatedGenericThumbs: countGenericThumbs(svg),
            warnings: warnings.map((warning) => `${warning.feature}: ${warning.detail}`),
          };
          rows.push({ ...base, pass: rowPass(base) });
        } finally {
          await context.close();
          await generatedContext.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const row = (id: string, dpr = 1) => rows.find((candidate) => candidate.id === id && candidate.deviceScaleFactor === dpr);
  const thumb = (id: string, dpr = 1) => row(id, dpr)?.sourcePixels.markers.thumb ?? null;
  const top = thumb("custom-y-top");
  const mid = thumb("custom-y-mid");
  const max = thumb("custom-y-max");
  const ltr = thumb("custom-y-mid");
  const rtl = thumb("custom-rtl-logical-left");
  const clipped = row("custom-border-clip");
  const clippedTrack = clipped?.sourcePixels.markers.track;
  const clipRect = clipped?.source.clipRect;
  const dpr1 = cssBounds(thumb("custom-both-corner", 1), 1);
  const dpr2 = cssBounds(thumb("custom-both-corner", 2), 2);
  const controls = {
    allRowsClassified: rows.every((candidate) => candidate.pass),
    overflowNegativesStayMarkerFree: rows
      .filter((candidate) => candidate.expectedRoute === "marker-free-control")
      .every((candidate) => candidate.pass),
    everyCustomRouteIsDiscriminated: rows
      .filter((candidate) => candidate.expectedRoute === "custom-vector-current-gap")
      .every((candidate) => candidate.pass),
    everyNativeFingerprintIsDiscriminated: rows
      .filter((candidate) => candidate.expectedRoute === "native-platform-fingerprint")
      .every((candidate) => candidate.pass),
    hiddenWidthCapturesExplicitAbsence: rows
      .filter((candidate) => candidate.id === "width-none-scrolled")
      .every((candidate) => candidate.pass),
    sourceThumbMovesTopMidMax: top != null && mid != null && max != null
      && top.y < mid.y && mid.y < max.y,
    horizontalAndVerticalAxesDiffer: thumb("custom-x-mid") != null && mid != null
      && thumb("custom-x-mid")!.width > thumb("custom-x-mid")!.height
      && mid.height > mid.width,
    rtlMovesVerticalChromeToLogicalLeft: ltr != null && rtl != null && rtl.x + 40 < ltr.x,
    bothAxesOwnCorner: (row("custom-both-corner")?.sourcePixels.markers.corner?.pixels ?? 0) > 20,
    verticalWritingRecorded: row("custom-vertical-writing")?.source.writingMode === "vertical-rl",
    borderClipContainsChrome: clippedTrack != null && clipRect != null
      && clippedTrack.x >= Math.floor(clipRect.x)
      && clippedTrack.y >= Math.floor(clipRect.y)
      && clippedTrack.x + clippedTrack.width <= Math.ceil(clipRect.x + clipRect.width)
      && clippedTrack.y + clippedTrack.height <= Math.ceil(clipRect.y + clipRect.height),
    zoomChangesPhysicalBox: (row("custom-zoom-125")?.source.rect.width ?? 0) > 190,
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
  const platformFingerprints = rows
    .filter((candidate) => candidate.expectedRoute === "native-platform-fingerprint")
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
  const pass = Object.values(controls).every(Boolean);
  return {
    sourceRevisions: SOURCE_REVISIONS,
    chromiumVersion: browser.version(),
    playwrightVersion,
    host: { platform: platform(), architecture: arch(), release: release() },
    rows,
    controls,
    platformFingerprints,
    verdict: pass ? "authoritative-capture-and-dependent-paint-gaps-observed" : "probe-expectation-or-source-drift",
  };
}

async function main(): Promise<number> {
  const report = await runNativeScrollbarOwnershipAudit();
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`native scrollbar ownership audit: ${report.rows.filter((row) => row.pass).length}/${report.rows.length}; ${report.verdict}`);
  for (const row of report.rows) {
    console.log(
      `${row.pass ? "PASS" : "FAIL"} ${row.id}@${row.deviceScaleFactor}x: route=${row.expectedRoute}, source-markers=${row.sourcePixels.markerPixels}, generated-markers=${row.generatedPixels.markerPixels}, generic-thumbs=${row.generatedGenericThumbs}, mode=${row.source.platformMode}`,
    );
  }
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  return report.verdict === "authoritative-capture-and-dependent-paint-gaps-observed" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
