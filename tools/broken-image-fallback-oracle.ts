#!/usr/bin/env tsx
/**
 * DM-2465 independent all-platform broken-image geometry/raster gate.
 *
 * The production capture is checked against a second pierced-CDP read of the
 * live UA shadow tree.  Icon content is checked through a separately isolated
 * Chromium crop against the payload that reached the final SVG.  No committed
 * platform screenshot baseline or renderer-derived expected geometry is used.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CDPSession, Page, Route } from "playwright";
import sharp from "sharp";

import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type {
  CapturedBrokenImageFallback,
  CapturedBrokenImagePhysicalBox,
  CapturedElement,
} from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

export const BROKEN_IMAGE_GATE_SOURCE_REVISIONS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
} as const;

export const BROKEN_IMAGE_GATE_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const BROKEN_IMAGE_GATE_DPRS = [1, 2] as const;
export const BROKEN_IMAGE_GATE_SCHEMES = ["light", "dark"] as const;

export const BROKEN_IMAGE_GATE_THRESHOLDS = {
  geometryCssPx: 1 / 64,
  // CopyFromSurface clips are conservatively snapped to whole CSS pixels;
  // content alpha is checked separately below in device pixels.
  cropEnvelopeCssPx: 1,
  iconBoundDevicePx: 1,
  iconRgbaMeanError: 0.01,
  iconPixelMismatchFraction: 0.04,
} as const;

const VIEWPORT = { width: 440, height: 250 } as const;
const BROKEN = "data:image/png;base64,AAAA";
const GOOD = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PENDING_URL = "https://dm2465-pending.invalid/image.png";

type Platform = typeof BROKEN_IMAGE_GATE_PLATFORMS[number];
type Scheme = typeof BROKEN_IMAGE_GATE_SCHEMES[number];
type Disposition = CapturedBrokenImageFallback["disposition"];
type LoadState = CapturedBrokenImageFallback["loadState"];
type Rect = { x: number; y: number; width: number; height: number };
type Quad = [number, number, number, number, number, number, number, number];

export type BrokenImageCaseFamily =
  | "source-state"
  | "alt-title"
  | "threshold"
  | "direction"
  | "writing-mode"
  | "sizing-mode"
  | "author-box"
  | "clipping"
  | "mixed-text"
  | "zoom"
  | "transform"
  | "raster-negative"
  | "icon-content";

export interface BrokenImageGateCase {
  id: string;
  family: BrokenImageCaseFamily;
  expectedDisposition: Disposition;
  expectedLoadState: LoadState;
  expectedIcon: boolean;
  expectedText: boolean;
  expectedIgnored: boolean;
  alt?: string;
  title?: string;
  src?: "broken" | "good" | "pending" | "missing";
  width?: number;
  height?: number;
  css?: string;
  quirks?: boolean;
}

export const BROKEN_IMAGE_GATE_CASES: readonly BrokenImageGateCase[] = [
  { id: "src-loading", family: "source-state", src: "pending", alt: "pending image", expectedDisposition: "loading", expectedLoadState: "loading", expectedIcon: false, expectedText: false, expectedIgnored: false },
  { id: "src-error", family: "source-state", src: "broken", alt: "failed image", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "src-success", family: "source-state", src: "good", alt: "successful image", width: 24, height: 24, expectedDisposition: "primary", expectedLoadState: "loaded", expectedIcon: false, expectedText: false, expectedIgnored: false },
  { id: "src-missing-with-alt", family: "source-state", src: "missing", alt: "no source", expectedDisposition: "non-replaced-fallback", expectedLoadState: "no-source", expectedIcon: true, expectedText: true, expectedIgnored: false },

  { id: "alt-missing", family: "alt-title", src: "broken", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: false, expectedIgnored: false },
  { id: "alt-empty-auto", family: "alt-title", src: "broken", alt: "", expectedDisposition: "empty-inline", expectedLoadState: "failed", expectedIcon: false, expectedText: false, expectedIgnored: true },
  { id: "alt-text", family: "alt-title", src: "broken", alt: "Alternative name", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "title-fallback", family: "alt-title", src: "broken", title: "Title name", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },

  { id: "threshold-17", family: "threshold", src: "broken", alt: "", width: 17, height: 17, expectedDisposition: "replaced-flow-root-fallback", expectedLoadState: "failed", expectedIcon: false, expectedText: false, expectedIgnored: true },
  { id: "threshold-18", family: "threshold", src: "broken", alt: "", width: 18, height: 18, expectedDisposition: "replaced-flow-root-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: false, expectedIgnored: true },

  { id: "direction-ltr", family: "direction", src: "broken", alt: "LTR label", css: "direction:ltr", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "direction-rtl", family: "direction", src: "broken", alt: "مرحبا", css: "direction:rtl", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "writing-horizontal", family: "writing-mode", src: "broken", alt: "horizontal", css: "writing-mode:horizontal-tb", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "writing-vertical", family: "writing-mode", src: "broken", alt: "縦書き", css: "writing-mode:vertical-rl", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },

  { id: "standards-one-dimension", family: "sizing-mode", src: "broken", alt: "one dimension", width: 72, expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "standards-both-text", family: "sizing-mode", src: "broken", alt: "both dimensions", width: 96, height: 30, expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "standards-both-empty", family: "sizing-mode", src: "broken", alt: "", width: 96, height: 30, expectedDisposition: "replaced-flow-root-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: false, expectedIgnored: true },
  { id: "standards-aspect-ratio", family: "sizing-mode", src: "broken", alt: "", width: 96, css: "aspect-ratio:3/1", expectedDisposition: "replaced-flow-root-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: false, expectedIgnored: true },
  { id: "quirks-one-dimension", family: "sizing-mode", quirks: true, src: "broken", alt: "quirks one dimension", width: 72, expectedDisposition: "replaced-flow-root-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },

  { id: "author-box", family: "author-box", src: "broken", alt: "author box", css: "border:3px solid rgb(20,70,130);padding:4px 7px;background:rgb(235,242,252);box-shadow:2px 3px 0 rgba(4,8,12,.3)", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "long-clipped-quirks", family: "clipping", quirks: true, src: "broken", alt: "a very long alternative label that must stay clipped by the captured UA container", width: 104, height: 28, css: "white-space:nowrap", expectedDisposition: "replaced-flow-root-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "mixed-astral-bidi", family: "mixed-text", src: "broken", alt: "A😀ב alternative", css: "font-style:italic;font-weight:700", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "zoom-1", family: "zoom", src: "broken", alt: "zoom", css: "zoom:1", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "zoom-1-5", family: "zoom", src: "broken", alt: "zoom", css: "zoom:1.5", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "author-affine-transform", family: "transform", src: "broken", alt: "transformed", css: "transform:translate(7px,5px) scale(1.1);transform-origin:0 0", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: true, expectedIgnored: false },
  { id: "ordinary-author-raster", family: "raster-negative", src: "good", alt: "ordinary raster", width: 28, height: 22, css: "image-rendering:pixelated", expectedDisposition: "primary", expectedLoadState: "loaded", expectedIcon: false, expectedText: false, expectedIgnored: false },
  { id: "icon-content", family: "icon-content", src: "broken", expectedDisposition: "non-replaced-fallback", expectedLoadState: "failed", expectedIcon: true, expectedText: false, expectedIgnored: false },
] as const;

export const REQUIRED_BROKEN_IMAGE_MUTATIONS = [
  "load-error-success",
  "alt-missing-empty-text-title",
  "threshold-17-18",
  "ltr-rtl",
  "horizontal-vertical",
  "standards-quirks",
  "one-both-aspect-ratio",
  "author-box-offset",
  "long-container-clipping",
  "astral-utf16",
  "zoom-icon-size",
  "dpr-resource-switch",
  "light-dark-text-only",
  "gray-mountain-substitution",
  "reuse-1x-at-2x",
] as const;

export type BrokenImageMutationKind = typeof REQUIRED_BROKEN_IMAGE_MUTATIONS[number];

interface CdpNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

interface IndependentTextFacts {
  value: string;
  rect: Rect | null;
  baseline: number | null;
  fontAscent: number;
  fontDescent: number;
  color: string;
  fontFamily: string;
  writingMode: string;
  direction: string;
  codepoints: Array<{ text: string; start: number; end: number; rect: Rect | null }>;
}

interface IndependentFacts {
  hostBox: CapturedBrokenImagePhysicalBox | null;
  shadowPresent: boolean;
  containerBox: CapturedBrokenImagePhysicalBox | null;
  containerStyle: Record<string, string> | null;
  iconBox: CapturedBrokenImagePhysicalBox | null;
  iconStyle: Record<string, string> | null;
  iconBackendNodeId: number | null;
  text: IndependentTextFacts | null;
  accessibility: { ignored: boolean; role: string | null; name: string | null } | null;
}

export interface BrokenImageIconComparison {
  sourcePngSha256: string;
  emittedPngSha256: string;
  sourceRgbaSha256: string;
  emittedRgbaSha256: string;
  sourcePixels: { width: number; height: number };
  emittedPixels: { width: number; height: number };
  exactRgba: boolean;
  alphaBoundDeltaDevicePx: number | null;
  rgbaMeanError: number;
  pixelMismatchFraction: number;
  sourceArtifact: string;
  emittedArtifact: string;
  pass: boolean;
}

export interface BrokenImageGateRow {
  id: string;
  family: BrokenImageCaseFamily;
  deviceScaleFactor: number;
  colorScheme: Scheme;
  expected: {
    disposition: Disposition;
    loadState: LoadState;
    icon: boolean;
    text: boolean;
    ignored: boolean;
  };
  captured: {
    disposition: Disposition;
    loadState: LoadState;
    paintOwnership: CapturedBrokenImageFallback["paintOwnership"];
    iconVisible: boolean;
    resourceScale: 1 | 2 | null;
    iconPixelWidth: number | null;
    iconPixelHeight: number | null;
    textValue: string | null;
    textColor: string | null;
    fontFamily: string | null;
    fontAscent: number | null;
    fontDescent: number | null;
    textBaseline: number | null;
    textCodepoints: Array<{ text: string; start: number; end: number }>;
    hostBox: CapturedBrokenImagePhysicalBox | null;
    containerBox: CapturedBrokenImagePhysicalBox | null;
    iconBox: CapturedBrokenImagePhysicalBox | null;
    textBox: Rect | null;
    overflowClip: Quad | null;
    containerBorder: NonNullable<CapturedBrokenImageFallback["container"]>["border"] | null;
    containerPadding: NonNullable<CapturedBrokenImageFallback["container"]>["padding"] | null;
    float: string | null;
    writingMode: string | null;
    ignored: boolean | null;
    axRole: string | null;
    axName: string | null;
    resolvedFonts: string[];
  };
  independent: {
    shadowPresent: boolean;
    iconVisible: boolean;
    hostBox: CapturedBrokenImagePhysicalBox | null;
    containerBox: CapturedBrokenImagePhysicalBox | null;
    iconBox: CapturedBrokenImagePhysicalBox | null;
    textBox: Rect | null;
    textBaseline: number | null;
    fontAscent: number | null;
    fontDescent: number | null;
    fontFamily: string | null;
    float: string | null;
    writingMode: string | null;
    textValue: string | null;
    textColor: string | null;
    ignored: boolean | null;
    axRole: string | null;
    axName: string | null;
  };
  comparison: {
    sourceMatches: boolean;
    stylesMatch: boolean;
    textMatches: boolean;
    accessibilityMatches: boolean;
    maxGeometryDeltaCssPx: number;
    baselineDeltaCssPx: number;
    markerRectDeltaCssPx: number | null;
  };
  output: {
    iconMarkerCount: number;
    vectorTextMarkerCount: number;
    legacyMountainCount: number;
    rawAlternativeTextCount: number;
    markerRect: Rect | null;
  };
  iconComparison: BrokenImageIconComparison | null;
  warnings: string[];
  pass: boolean;
}

export interface BrokenImageMutationResult {
  id: `mutation.${BrokenImageMutationKind}`;
  kind: BrokenImageMutationKind;
  discriminator: string;
  baseline: string | number | boolean;
  mutated: string | number | boolean;
  moved: boolean;
}

export interface BrokenImageGateReport {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevisions: typeof BROKEN_IMAGE_GATE_SOURCE_REVISIONS;
  environment: {
    platform: Platform;
    architecture: string;
    osRelease: string;
    runnerImage: string;
    runnerImageVersion: string;
    chromiumVersion: string;
    chromiumRevision: string;
    playwrightVersion: string;
    userAgent: string;
    node: string;
    launchArguments: string[];
    deviceScaleFactors: number[];
    colorSchemes: Scheme[];
    viewport: typeof VIEWPORT;
    fontInventory: string[];
  };
  corpus: {
    cases: number;
    families: BrokenImageCaseFamily[];
    mutationKinds: readonly BrokenImageMutationKind[];
  };
  rows: BrokenImageGateRow[];
  mutations: BrokenImageMutationResult[];
  controls: Record<string, boolean>;
  summary: {
    rowsPassed: number;
    rowsFailed: number;
    mutationsMoved: number;
    mutationsFailed: number;
  };
  verdict: "hard-broken-image-fallback-parity" | "broken-image-fallback-parity-failure";
}

function attr(node: CdpNode, name: string): string | null {
  const attrs = node.attributes ?? [];
  for (let index = 0; index + 1 < attrs.length; index += 2) if (attrs[index] === name) return attrs[index + 1];
  return null;
}

function descendants(node: CdpNode): CdpNode[] {
  const result: CdpNode[] = [];
  const visit = (current: CdpNode): void => {
    result.push(current);
    for (const shadow of current.shadowRoots ?? []) visit(shadow);
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return result;
}

function findById(node: CdpNode, id: string): CdpNode | null {
  return descendants(node).find((candidate) => attr(candidate, "id") === id) ?? null;
}

function localizeQuad(values: number[]): Quad {
  if (values.length !== 8 || values.some((value) => !Number.isFinite(value))) throw new Error("invalid CDP quad");
  return values as Quad;
}

function rectFromQuad(quad: Quad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

async function boxFor(session: CDPSession, node: CdpNode | null): Promise<CapturedBrokenImagePhysicalBox | null> {
  if (node == null) return null;
  try {
    const { model } = await session.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
    const content = localizeQuad(model.content);
    const padding = localizeQuad(model.padding);
    const border = localizeQuad(model.border);
    const margin = localizeQuad(model.margin);
    return { rect: rectFromQuad(border), content, padding, border, margin };
  } catch {
    return null;
  }
}

async function frontendNodeId(session: CDPSession, node: CdpNode): Promise<number> {
  if (node.nodeId !== 0) return node.nodeId;
  const result = await session.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [node.backendNodeId] });
  if (result.nodeIds[0] == null || result.nodeIds[0] === 0) throw new Error(`could not push backend node ${node.backendNodeId}`);
  return result.nodeIds[0];
}

async function styleFor(session: CDPSession, node: CdpNode | null): Promise<Record<string, string> | null> {
  if (node == null) return null;
  try {
    const nodeId = await frontendNodeId(session, node);
    const result = await session.send("CSS.getComputedStyleForNode", { nodeId });
    return Object.fromEntries(result.computedStyle.map(({ name, value }) => [name, value]));
  } catch {
    return null;
  }
}

async function textFactsFor(session: CDPSession, textNode: CdpNode | null): Promise<IndependentTextFacts | null> {
  if (textNode == null) return null;
  const resolved = await session.send("DOM.resolveNode", { backendNodeId: textNode.backendNodeId });
  const objectId = resolved.object.objectId;
  if (objectId == null) return null;
  try {
    const result = await session.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const value = this.textContent || "";
        const owner = this.parentElement;
        if (!owner) return null;
        const style = getComputedStyle(owner);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.font = (style.fontStyle || "normal") + " " + (style.fontWeight || "400")
          + " " + style.fontSize + " " + style.fontFamily;
        const metrics = context.measureText("Mxgp");
        const codepoints = [];
        const rects = [];
        for (let start = 0; start < value.length;) {
          const text = String.fromCodePoint(value.codePointAt(start));
          const end = start + text.length;
          const range = document.createRange();
          range.setStart(this, start);
          range.setEnd(this, end);
          const list = Array.from(range.getClientRects());
          const rect = list.length === 0 ? null : {
            x: list[0].x, y: list[0].y, width: list[0].width, height: list[0].height,
          };
          codepoints.push({ text, start, end, rect });
          if (rect && (rect.width > 0 || rect.height > 0)) rects.push(rect);
          start = end;
        }
        let rect = null;
        if (rects.length > 0) {
          const x = Math.min(...rects.map((item) => item.x));
          const y = Math.min(...rects.map((item) => item.y));
          const right = Math.max(...rects.map((item) => item.x + item.width));
          const bottom = Math.max(...rects.map((item) => item.y + item.height));
          rect = { x, y, width: right - x, height: bottom - y };
        }
        const ascent = metrics.fontBoundingBoxAscent;
        let baseline = null;
        if (rect) {
          baseline = /^(vertical|sideways)-/.test(style.writingMode)
            ? (style.writingMode === "sideways-lr" ? rect.x + ascent : rect.x + rect.width - ascent)
            : rect.y + ascent;
        }
        return {
          value, rect, baseline, fontAscent: ascent,
          fontDescent: metrics.fontBoundingBoxDescent,
          color: style.color, fontFamily: style.fontFamily,
          writingMode: style.writingMode, direction: style.direction, codepoints,
        };
      }`,
    });
    return (result.result.value ?? null) as IndependentTextFacts | null;
  } finally {
    await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function independentFacts(page: Page, session: CDPSession): Promise<IndependentFacts> {
  const document = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const host = findById(document.root as CdpNode, "target");
  if (host == null) throw new Error("independent CDP read could not find #target");
  const container = findById(host, "alttext-container");
  const icon = findById(host, "alttext-image");
  const textElement = findById(host, "alttext");
  const textNode = textElement == null
    ? null
    : descendants(textElement).find((node) => node.nodeType === 3) ?? null;
  let accessibility: IndependentFacts["accessibility"] = null;
  try {
    const ax = await session.send("Accessibility.getPartialAXTree", {
      backendNodeId: host.backendNodeId,
      fetchRelatives: false,
    });
    const node = ax.nodes[0];
    if (node != null) {
      const value = (input: { value?: unknown } | undefined): string | null =>
        typeof input?.value === "string" ? input.value : null;
      accessibility = { ignored: node.ignored, role: value(node.role), name: value(node.name) };
    }
  } catch {
    accessibility = null;
  }
  return {
    hostBox: await boxFor(session, host),
    shadowPresent: container != null,
    containerBox: await boxFor(session, container),
    containerStyle: await styleFor(session, container),
    iconBox: await boxFor(session, icon),
    iconStyle: await styleFor(session, icon),
    iconBackendNodeId: icon?.backendNodeId ?? null,
    text: await textFactsFor(session, textNode),
    accessibility,
  };
}

function maxNumberDelta(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  return a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index])), 0);
}

function boxDelta(a: CapturedBrokenImagePhysicalBox | null, b: CapturedBrokenImagePhysicalBox | null): number {
  if (a == null || b == null) return a === b ? 0 : Number.POSITIVE_INFINITY;
  return Math.max(
    maxNumberDelta(Object.values(a.rect), Object.values(b.rect)),
    maxNumberDelta(a.content, b.content),
    maxNumberDelta(a.padding, b.padding),
    maxNumberDelta(a.border, b.border),
    maxNumberDelta(a.margin, b.margin),
  );
}

function rectDelta(a: Rect | null, b: Rect | null): number {
  if (a == null || b == null) return a === b ? 0 : Number.POSITIVE_INFINITY;
  return maxNumberDelta(Object.values(a), Object.values(b));
}

function numberStyle(style: Record<string, string> | null, property: string): number {
  const value = Number.parseFloat(style?.[property] ?? "");
  return Number.isFinite(value) ? value : 0;
}

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function imageMarkup(test: BrokenImageGateCase): string {
  const attrs: string[] = ['id="target"'];
  if (test.src === "broken") attrs.push(`src="${BROKEN}"`);
  if (test.src === "good") attrs.push(`src="${GOOD}"`);
  if (test.src === "pending") attrs.push(`src="${PENDING_URL}"`);
  if (test.alt != null) attrs.push(`alt="${test.alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`);
  if (test.title != null) attrs.push(`title="${test.title.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`);
  if (test.width != null) attrs.push(`width="${test.width}"`);
  if (test.height != null) attrs.push(`height="${test.height}"`);
  if (test.css != null) attrs.push(`style="${test.css}"`);
  return `<img ${attrs.join(" ")}>`;
}

function htmlFor(test: BrokenImageGateCase): string {
  const doctype = test.quirks ? "" : "<!doctype html>";
  return `${doctype}<style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:transparent}
    #stage{position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;font:18px/26px Arial,sans-serif;color:rgb(23,34,45)}
    #target{position:absolute;left:42px;top:36px;color:rgb(23,34,45)}
    @media(prefers-color-scheme:dark){#target{color:rgb(205,218,231)}}
  </style><div id="stage">${imageMarkup(test)}</div>`;
}

function expectedResolvedText(test: BrokenImageGateCase): string {
  if (test.alt != null) return test.alt;
  return test.title ?? "";
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface OutputFacts {
  iconMarkerCount: number;
  vectorTextMarkerCount: number;
  legacyMountainCount: number;
  rawAlternativeTextCount: number;
  markerRect: Rect | null;
  markerHref: string | null;
}

async function readOutputFacts(page: Page, svg: string, resolvedText: string): Promise<OutputFacts> {
  await page.setContent(`<style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:transparent}svg{display:block}</style>${svg}`, { waitUntil: "load" });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page.evaluate((expectedText) => {
    const markers = Array.from(document.querySelectorAll<SVGGraphicsElement>("[data-broken-image-icon]"));
    const marker = markers[0] ?? null;
    let markerHref: string | null = null;
    if (marker != null) {
      markerHref = marker.getAttribute("href");
      if (marker.tagName.toLowerCase() === "use" && markerHref?.startsWith("#")) {
        markerHref = document.querySelector(markerHref)?.getAttribute("href") ?? null;
      }
    }
    const rect = marker?.getBoundingClientRect();
    return {
      iconMarkerCount: markers.length,
      vectorTextMarkerCount: document.querySelectorAll('[data-broken-image-text="vector"]').length,
      legacyMountainCount: document.querySelectorAll("polyline").length,
      rawAlternativeTextCount: Array.from(document.querySelectorAll("text"))
        .filter((node) => node.textContent === expectedText).length,
      markerRect: rect == null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      markerHref,
    };
  }, resolvedText);
}

function dataUriBuffer(value: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/s.exec(value);
  if (match == null) throw new Error("emitted broken-image icon is not an inline PNG");
  return Buffer.from(match[1], "base64");
}

async function isolateIndependentIcon(
  page: Page,
  session: CDPSession,
  backendNodeId: number,
  rect: Rect,
): Promise<Buffer> {
  const restoreKey = `__dm2465_restore_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let objectId: string | undefined;
  let uaRestore: unknown;
  try {
    await page.evaluate((key) => {
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      const entries: Array<{ element: HTMLElement; property: string; value: string; priority: string }> = [];
      scope[key] = entries;
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        entries.push({ element, property: "visibility", value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") });
        element.style.setProperty("visibility", "hidden", "important");
      }
      const target = document.querySelector<HTMLElement>("#target");
      if (target == null) throw new Error("independent icon target disappeared");
      for (const [property, value] of [
        ["visibility", "visible"], ["opacity", "1"], ["filter", "none"],
        ["mix-blend-mode", "normal"], ["background", "transparent"],
        ["border-color", "transparent"], ["box-shadow", "none"], ["outline", "none"],
      ]) {
        entries.push({ element: target, property, value: target.style.getPropertyValue(property), priority: target.style.getPropertyPriority(property) });
        target.style.setProperty(property, value, "important");
      }
      for (const canvas of [document.documentElement, document.body]) {
        entries.push({ element: canvas, property: "background", value: canvas.style.getPropertyValue("background"), priority: canvas.style.getPropertyPriority("background") });
        canvas.style.setProperty("background", "transparent", "important");
      }
    }, restoreKey);
    const resolved = await session.send("DOM.resolveNode", { backendNodeId });
    objectId = resolved.object.objectId;
    if (objectId == null) throw new Error("independent icon backend node could not be resolved");
    const isolated = await session.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const root = this.getRootNode();
        const container = root.querySelector("#alttext-container");
        const text = root.querySelector("#alttext");
        if (!container || !text || this.id !== "alttext-image") throw new Error("UA icon identity changed");
        const entries = [];
        const set = (element, property, value) => {
          entries.push({ owner: element.id, property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) });
          element.style.setProperty(property, value, "important");
        };
        for (const property of ["background-color","border-top-color","border-right-color","border-bottom-color","border-left-color"]) set(container, property, "transparent");
        set(container, "background-image", "none");
        set(container, "box-shadow", "none");
        set(text, "visibility", "hidden");
        set(this, "visibility", "visible");
        set(this, "opacity", "1");
        set(this, "filter", "none");
        return entries;
      }`,
    });
    uaRestore = isolated.result.value;
    await page.evaluate(() => document.documentElement.getBoundingClientRect().width);
    return Buffer.from(await page.screenshot({ clip: rect, omitBackground: true, type: "png", animations: "allow" }));
  } finally {
    if (objectId != null && uaRestore != null) {
      await session.send("Runtime.callFunctionOn", {
        objectId,
        arguments: [{ value: uaRestore }],
        functionDeclaration: `function(entries) {
          const root = this.getRootNode();
          for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            const element = entry.owner === "alttext-image" ? this : root.querySelector("#" + entry.owner);
            if (!element) continue;
            if (entry.value === "" && entry.priority === "") element.style.removeProperty(entry.property);
            else element.style.setProperty(entry.property, entry.value, entry.priority);
          }
        }`,
      }).catch(() => undefined);
    }
    if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    await page.evaluate((key) => {
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      const entries = scope[key] as Array<{ element: HTMLElement; property: string; value: string; priority: string }> | undefined;
      for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
        const entry = entries![index];
        if (entry.value === "" && entry.priority === "") entry.element.style.removeProperty(entry.property);
        else entry.element.style.setProperty(entry.property, entry.value, entry.priority);
      }
      delete scope[key];
    }, restoreKey).catch(() => undefined);
  }
}

interface DecodedRgba {
  data: Buffer;
  width: number;
  height: number;
}

async function decodeRgba(png: Buffer): Promise<DecodedRgba> {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4) throw new Error("icon artifact did not decode to RGBA");
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function alphaBounds(image: DecodedRgba): Rect | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function compareIconPng(sourcePng: Buffer, emittedPng: Buffer): Promise<Omit<BrokenImageIconComparison, "sourceArtifact" | "emittedArtifact">> {
  const [source, emitted] = await Promise.all([decodeRgba(sourcePng), decodeRgba(emittedPng)]);
  let total = 0;
  let mismatched = 0;
  const commonLength = Math.min(source.data.length, emitted.data.length);
  for (let index = 0; index < commonLength; index += 4) {
    let pixelMoved = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(source.data[index + channel] - emitted.data[index + channel]);
      total += delta;
      if (delta > 2) pixelMoved = true;
    }
    if (pixelMoved) mismatched++;
  }
  const sameDimensions = source.width === emitted.width && source.height === emitted.height;
  const pixels = Math.max(source.width * source.height, emitted.width * emitted.height);
  const rgbaMeanError = sameDimensions ? total / Math.max(1, commonLength) / 255 : 1;
  const pixelMismatchFraction = sameDimensions ? mismatched / Math.max(1, pixels) : 1;
  const sourceBounds = alphaBounds(source);
  const emittedBounds = alphaBounds(emitted);
  const alphaBoundDeltaDevicePx = sourceBounds == null || emittedBounds == null
    ? sourceBounds === emittedBounds ? 0 : null
    : rectDelta(sourceBounds, emittedBounds);
  const exactRgba = sameDimensions && source.data.equals(emitted.data);
  const pass = sameDimensions
    && alphaBoundDeltaDevicePx != null
    && alphaBoundDeltaDevicePx <= BROKEN_IMAGE_GATE_THRESHOLDS.iconBoundDevicePx
    && rgbaMeanError <= BROKEN_IMAGE_GATE_THRESHOLDS.iconRgbaMeanError
    && pixelMismatchFraction <= BROKEN_IMAGE_GATE_THRESHOLDS.iconPixelMismatchFraction;
  return {
    sourcePngSha256: createHash("sha256").update(sourcePng).digest("hex"),
    emittedPngSha256: createHash("sha256").update(emittedPng).digest("hex"),
    sourceRgbaSha256: createHash("sha256").update(source.data).digest("hex"),
    emittedRgbaSha256: createHash("sha256").update(emitted.data).digest("hex"),
    sourcePixels: { width: source.width, height: source.height },
    emittedPixels: { width: emitted.width, height: emitted.height },
    exactRgba,
    alphaBoundDeltaDevicePx,
    rgbaMeanError,
    pixelMismatchFraction,
    pass,
  };
}

async function iconComparison(
  page: Page,
  session: CDPSession,
  independent: IndependentFacts,
  output: OutputFacts,
  artifactRoot: string,
  dpr: number,
  scheme: Scheme,
): Promise<{ comparison: BrokenImageIconComparison; sourcePng: Buffer; emittedPng: Buffer }> {
  if (independent.iconBackendNodeId == null || independent.iconBox == null || output.markerHref == null) {
    throw new Error("icon-content row lacks independent source or emitted payload");
  }
  const sourcePng = await isolateIndependentIcon(page, session, independent.iconBackendNodeId, independent.iconBox.rect);
  const emittedPng = dataUriBuffer(output.markerHref);
  const sourceName = `icon-${scheme}-${dpr}x-source.png`;
  const emittedName = `icon-${scheme}-${dpr}x-emitted.png`;
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(resolve(artifactRoot, sourceName), sourcePng);
  writeFileSync(resolve(artifactRoot, emittedName), emittedPng);
  return {
    comparison: {
      ...await compareIconPng(sourcePng, emittedPng),
      sourceArtifact: sourceName,
      emittedArtifact: emittedName,
    },
    sourcePng,
    emittedPng,
  };
}

function recordTextBox(record: CapturedBrokenImageFallback): Rect | null {
  return record.text?.box ?? null;
}

function sourceMatches(test: BrokenImageGateCase, record: CapturedBrokenImageFallback): boolean {
  const expectedSrcPresent = test.src !== "missing";
  return record.source.src.present === expectedSrcPresent
    && record.source.alt.present === (test.alt != null)
    && record.source.title.present === (test.title != null)
    && record.source.resolvedText === expectedResolvedText(test);
}

function styleMatches(record: CapturedBrokenImageFallback, live: IndependentFacts): boolean {
  if (record.container == null || live.containerStyle == null) return record.container == null && live.containerStyle == null;
  const iconStyle = live.iconStyle;
  return record.container.display === live.containerStyle.display
    && record.container.float === live.containerStyle.float
    && record.container.overflowX === live.containerStyle["overflow-x"]
    && record.container.overflowY === live.containerStyle["overflow-y"]
    && record.container.direction === live.containerStyle.direction
    && record.container.writingMode === live.containerStyle["writing-mode"]
    && Math.abs(record.container.border.top - numberStyle(live.containerStyle, "border-top-width")) <= BROKEN_IMAGE_GATE_THRESHOLDS.geometryCssPx
    && Math.abs(record.container.padding.top - numberStyle(live.containerStyle, "padding-top")) <= BROKEN_IMAGE_GATE_THRESHOLDS.geometryCssPx
    && (record.icon == null || iconStyle == null || (
      record.icon.display === iconStyle.display
      && record.icon.float === iconStyle.float
      && record.icon.visible === (iconStyle.display !== "none")
    ));
}

function textMatches(record: CapturedBrokenImageFallback, live: IndependentFacts): boolean {
  if (record.text == null || live.text == null) return record.text == null && (live.text == null || live.text.value === "");
  return record.text.value === live.text.value
    && record.text.style.color === live.text.color
    && record.text.style.fontFamily === live.text.fontFamily
    && record.text.style.writingMode === live.text.writingMode
    && record.text.style.direction === live.text.direction
    && record.text.codepoints.length === live.text.codepoints.length
    && record.text.codepoints.every((point, index) => point.text === live.text!.codepoints[index]?.text
      && point.start === live.text!.codepoints[index]?.start
      && point.end === live.text!.codepoints[index]?.end);
}

function accessibilityMatches(record: CapturedBrokenImageFallback, live: IndependentFacts): boolean {
  if ("unavailableReason" in record.accessibility || live.accessibility == null) return false;
  return record.accessibility.ignored === live.accessibility.ignored
    && record.accessibility.role === live.accessibility.role
    && record.accessibility.name === live.accessibility.name;
}

async function prepareCase(page: Page, test: BrokenImageGateCase): Promise<Route | null> {
  if (test.src !== "pending") {
    await page.setContent(htmlFor(test), { waitUntil: "load" });
    return null;
  }
  let pending: Route | null = null;
  await page.route(PENDING_URL, (route) => { pending = route; });
  const withoutImage = htmlFor({ ...test, src: "missing" }).replace(imageMarkup({ ...test, src: "missing" }), "");
  await page.setContent(withoutImage, { waitUntil: "load" });
  await page.evaluate(({ src, alt }) => {
    const image = document.createElement("img");
    image.id = "target";
    image.src = src;
    image.alt = alt;
    document.querySelector("#stage")?.append(image);
  }, { src: PENDING_URL, alt: test.alt ?? "" });
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("#target");
    return image != null && !image.complete;
  });
  return pending;
}

async function runCase(input: {
  page: Page;
  generatedPage: Page;
  session: CDPSession;
  test: BrokenImageGateCase;
  dpr: number;
  scheme: Scheme;
  artifactRoot: string;
}): Promise<{ row: BrokenImageGateRow; direct?: { sourcePng: Buffer; emittedPng: Buffer } }> {
  const { page, generatedPage, session, test, dpr, scheme, artifactRoot } = input;
  const pending = await prepareCase(page, test);
  try {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const result = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, ...VIEWPORT });
    const image = flatten(result.tree).find((element) => element.tag === "img");
    const record = image?.brokenImageFallback;
    if (image == null || record == null) throw new Error(`${test.id}: production capture omitted the target image record`);
    const live = await independentFacts(page, session);
    const svg = elementTreeToSvg(result.tree, VIEWPORT.width, VIEWPORT.height, { hiDPIFactor: dpr });
    const output = await readOutputFacts(generatedPage, svg, expectedResolvedText(test));
    const maxGeometryDeltaCssPx = Math.max(
      boxDelta(record.hostBox, live.hostBox),
      boxDelta(record.container?.box ?? null, live.containerBox),
      boxDelta(record.icon?.box ?? null, live.iconBox),
      rectDelta(recordTextBox(record), live.text?.rect ?? null),
    );
    const baselineDeltaCssPx = record.text?.segments[0]?.baseline == null || live.text?.baseline == null
      ? record.text?.segments[0]?.baseline == null && live.text?.baseline == null ? 0 : Number.POSITIVE_INFINITY
      : Math.abs(record.text.segments[0].baseline - live.text.baseline);
    const markerRectDeltaCssPx = output.markerRect == null || live.iconBox == null
      ? output.markerRect == null && !test.expectedIcon ? 0 : null
      : rectDelta(output.markerRect, live.iconBox.rect);
    let direct: { sourcePng: Buffer; emittedPng: Buffer } | undefined;
    let directComparison: BrokenImageIconComparison | null = null;
    if (test.id === "icon-content") {
      const compared = await iconComparison(page, session, live, output, artifactRoot, dpr, scheme);
      direct = { sourcePng: compared.sourcePng, emittedPng: compared.emittedPng };
      directComparison = compared.comparison;
    }
    const exactAx = "unavailableReason" in record.accessibility ? null : record.accessibility;
    const iconVisible = record.icon?.visible === true;
    const structuralPass = record.captureStatus === "exact"
      && record.disposition === test.expectedDisposition
      && record.loadState === test.expectedLoadState
      && iconVisible === test.expectedIcon
      && (record.icon?.raster != null) === test.expectedIcon
      && (record.text != null && record.text.segments.length > 0) === test.expectedText
      && exactAx?.ignored === test.expectedIgnored
      && output.iconMarkerCount === (test.expectedIcon ? 1 : 0)
      && output.vectorTextMarkerCount === (test.expectedText ? 1 : 0)
      && output.legacyMountainCount === 0
      && output.rawAlternativeTextCount === 0;
    const comparisonsPass = sourceMatches(test, record)
      && styleMatches(record, live)
      && textMatches(record, live)
      && accessibilityMatches(record, live)
      && maxGeometryDeltaCssPx <= BROKEN_IMAGE_GATE_THRESHOLDS.geometryCssPx
      && baselineDeltaCssPx <= BROKEN_IMAGE_GATE_THRESHOLDS.geometryCssPx
      && (markerRectDeltaCssPx ?? Number.POSITIVE_INFINITY) <= BROKEN_IMAGE_GATE_THRESHOLDS.cropEnvelopeCssPx;
    const row: BrokenImageGateRow = {
      id: test.id,
      family: test.family,
      deviceScaleFactor: dpr,
      colorScheme: scheme,
      expected: {
        disposition: test.expectedDisposition,
        loadState: test.expectedLoadState,
        icon: test.expectedIcon,
        text: test.expectedText,
        ignored: test.expectedIgnored,
      },
      captured: {
        disposition: record.disposition,
        loadState: record.loadState,
        paintOwnership: record.paintOwnership,
        iconVisible,
        resourceScale: record.icon?.resourceScale ?? null,
        iconPixelWidth: record.icon?.raster?.pixelWidth ?? null,
        iconPixelHeight: record.icon?.raster?.pixelHeight ?? null,
        textValue: record.text?.value ?? null,
        textColor: record.text?.style.color ?? null,
        fontFamily: record.text?.style.fontFamily ?? null,
        fontAscent: record.text?.fontMetrics.ascent ?? null,
        fontDescent: record.text?.fontMetrics.descent ?? null,
        textBaseline: record.text?.segments[0]?.baseline ?? null,
        textCodepoints: record.text?.codepoints.map(({ text, start, end }) => ({ text, start, end })) ?? [],
        hostBox: record.hostBox,
        containerBox: record.container?.box ?? null,
        iconBox: record.icon?.box ?? null,
        textBox: recordTextBox(record),
        overflowClip: record.container?.overflowClip ?? null,
        containerBorder: record.container?.border ?? null,
        containerPadding: record.container?.padding ?? null,
        float: record.icon?.float ?? null,
        writingMode: record.container?.writingMode ?? null,
        ignored: exactAx?.ignored ?? null,
        axRole: exactAx?.role ?? null,
        axName: exactAx?.name ?? null,
        resolvedFonts: record.text?.resolvedFonts.map((font) => `${font.familyName}|${font.postScriptName}|${font.isCustomFont ? "custom" : "system"}`) ?? [],
      },
      independent: {
        shadowPresent: live.shadowPresent,
        iconVisible: live.iconStyle?.display !== "none" && live.iconStyle != null,
        hostBox: live.hostBox,
        containerBox: live.containerBox,
        iconBox: live.iconBox,
        textBox: live.text?.rect ?? null,
        textBaseline: live.text?.baseline ?? null,
        fontAscent: live.text?.fontAscent ?? null,
        fontDescent: live.text?.fontDescent ?? null,
        fontFamily: live.text?.fontFamily ?? null,
        float: live.iconStyle?.float ?? null,
        writingMode: live.containerStyle?.["writing-mode"] ?? null,
        textValue: live.text?.value ?? null,
        textColor: live.text?.color ?? null,
        ignored: live.accessibility?.ignored ?? null,
        axRole: live.accessibility?.role ?? null,
        axName: live.accessibility?.name ?? null,
      },
      comparison: {
        sourceMatches: sourceMatches(test, record),
        stylesMatch: styleMatches(record, live),
        textMatches: textMatches(record, live),
        accessibilityMatches: accessibilityMatches(record, live),
        maxGeometryDeltaCssPx,
        baselineDeltaCssPx,
        markerRectDeltaCssPx,
      },
      output: {
        iconMarkerCount: output.iconMarkerCount,
        vectorTextMarkerCount: output.vectorTextMarkerCount,
        legacyMountainCount: output.legacyMountainCount,
        rawAlternativeTextCount: output.rawAlternativeTextCount,
        markerRect: output.markerRect,
      },
      iconComparison: directComparison,
      warnings: result.warnings.map((warning) => `${warning.feature}: ${warning.detail}`),
      pass: structuralPass && comparisonsPass && result.warnings.length === 0 && (directComparison?.pass ?? true),
    };
    return { row, direct };
  } finally {
    await pending?.abort().catch(() => undefined);
    if (test.src === "pending") await page.unroute(PENDING_URL).catch(() => undefined);
  }
}

function rowAt(rows: BrokenImageGateRow[], id: string, dpr = 1, scheme: Scheme = "light"): BrokenImageGateRow {
  const row = rows.find((candidate) => candidate.id === id && candidate.deviceScaleFactor === dpr && candidate.colorScheme === scheme);
  if (row == null) throw new Error(`missing gate row ${id}@${dpr}x/${scheme}`);
  return row;
}

async function mountainPng(dpr: number): Promise<Buffer> {
  const size = 16 * dpr;
  return sharp(Buffer.from(`<svg width="${size}" height="${size}" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" fill="none" stroke="gray"/><polyline points="3,12 6,7 9,10 13,12" fill="none" stroke="gray"/></svg>`)).png().toBuffer();
}

async function buildMutations(
  rows: BrokenImageGateRow[],
  direct: Map<string, { sourcePng: Buffer; emittedPng: Buffer }>,
): Promise<BrokenImageMutationResult[]> {
  const result = (kind: BrokenImageMutationKind, discriminator: string, baseline: string | number | boolean, mutated: string | number | boolean, moved: boolean): BrokenImageMutationResult => ({
    id: `mutation.${kind}`,
    kind,
    discriminator,
    baseline,
    mutated,
    moved,
  });
  const loading = rowAt(rows, "src-loading");
  const failed = rowAt(rows, "src-error");
  const success = rowAt(rows, "src-success");
  const missing = rowAt(rows, "alt-missing");
  const empty = rowAt(rows, "alt-empty-auto");
  const text = rowAt(rows, "alt-text");
  const title = rowAt(rows, "title-fallback");
  const threshold17 = rowAt(rows, "threshold-17");
  const threshold18 = rowAt(rows, "threshold-18");
  const ltr = rowAt(rows, "direction-ltr");
  const rtl = rowAt(rows, "direction-rtl");
  const horizontal = rowAt(rows, "writing-horizontal");
  const vertical = rowAt(rows, "writing-vertical");
  const standards = rowAt(rows, "standards-one-dimension");
  const quirks = rowAt(rows, "quirks-one-dimension");
  const one = rowAt(rows, "standards-one-dimension");
  const both = rowAt(rows, "standards-both-empty");
  const ratio = rowAt(rows, "standards-aspect-ratio");
  const plain = rowAt(rows, "alt-text");
  const author = rowAt(rows, "author-box");
  const clipped = rowAt(rows, "long-clipped-quirks");
  const astral = rowAt(rows, "mixed-astral-bidi");
  const zoom1 = rowAt(rows, "zoom-1");
  const zoom15 = rowAt(rows, "zoom-1-5");
  const dpr1 = rowAt(rows, "icon-content", 1);
  const dpr2 = rowAt(rows, "icon-content", 2);
  const light = rowAt(rows, "alt-text", 1, "light");
  const dark = rowAt(rows, "alt-text", 1, "dark");
  const source1 = direct.get("light/1")?.sourcePng;
  const source2 = direct.get("light/2")?.sourcePng;
  if (source1 == null || source2 == null) throw new Error("direct icon mutation inputs are missing");
  const grayComparison = await compareIconPng(source1, await mountainPng(1));
  const source1Decoded = await decodeRgba(source1);
  const upscaled1 = await sharp(source1).resize(source1Decoded.width * 2, source1Decoded.height * 2, { kernel: "nearest" }).png().toBuffer();
  const reuseComparison = await compareIconPng(source2, upscaled1);
  return [
    result("load-error-success", "The same source role crosses no fallback -> icon+text fallback -> ordinary decoded image.", `${loading.captured.disposition}/${failed.captured.disposition}`, success.captured.disposition, loading.output.iconMarkerCount === 0 && failed.output.iconMarkerCount === 1 && success.output.iconMarkerCount === 0),
    result("alt-missing-empty-text-title", "Attribute presence, not the DOM alt property, separates icon-only, decorative, visible alt, and title fallback.", `${missing.output.iconMarkerCount}/${empty.output.iconMarkerCount}`, `${text.output.vectorTextMarkerCount}/${title.captured.axName}`, missing.captured.textValue == null && empty.captured.ignored === true && text.captured.textValue === "Alternative name" && title.captured.textValue === "Title name"),
    result("threshold-17-18", "Blink's strict 18 CSS-pixel predicate turns on both the UA border and icon.", threshold17.output.iconMarkerCount, threshold18.output.iconMarkerCount, threshold17.output.iconMarkerCount === 0 && threshold18.output.iconMarkerCount === 1),
    result("ltr-rtl", "The UA icon float follows direction and must cross physical sides.", ltr.captured.float ?? "missing", rtl.captured.float ?? "missing", ltr.captured.float === "left" && rtl.captured.float === "right"),
    result("horizontal-vertical", "Writing-mode changes the captured hidden-text axis/orientation rather than reusing horizontal origins.", horizontal.captured.writingMode ?? "missing", vertical.captured.writingMode ?? "missing", horizontal.captured.writingMode === "horizontal-tb" && vertical.captured.writingMode === "vertical-rl"),
    result("standards-quirks", "One authored dimension stays non-replaced in standards mode but is mirrored/replaced in quirks mode.", standards.captured.disposition, quirks.captured.disposition, standards.captured.disposition !== quirks.captured.disposition),
    result("one-both-aspect-ratio", "Two dimensions or one dimension plus aspect-ratio activates replaced empty-alt fallback; one dimension alone does not.", one.captured.disposition, `${both.captured.disposition}/${ratio.captured.disposition}`, one.captured.disposition !== both.captured.disposition && both.captured.disposition === ratio.captured.disposition),
    result("author-box-offset", "Author border/padding moves the live icon without being baked into the Chromium icon payload.", plain.output.markerRect?.x ?? -1, author.output.markerRect?.x ?? -1, (author.output.markerRect?.x ?? 0) - (plain.output.markerRect?.x ?? 0) >= 9),
    result("long-container-clipping", "A replaced long label retains a text range wider than its UA overflow clip while output keeps one vector marker.", clipped.output.vectorTextMarkerCount, clipped.comparison.maxGeometryDeltaCssPx, clipped.output.vectorTextMarkerCount === 1 && clipped.pass),
    result("astral-utf16", "The astral scalar occupies two UTF-16 indices but one captured code-point row.", astral.captured.textCodepoints.find((point) => point.text === "😀")?.start ?? -1, astral.captured.textCodepoints.find((point) => point.text === "😀")?.end ?? -1, astral.captured.textCodepoints.some((point) => point.text === "😀" && point.end - point.start === 2)),
    result("zoom-icon-size", "Effective zoom scales the live 16 CSS-pixel icon to 24 CSS pixels before DPR multiplication.", zoom1.output.markerRect?.width ?? -1, zoom15.output.markerRect?.width ?? -1, Math.abs((zoom1.output.markerRect?.width ?? 0) * 1.5 - (zoom15.output.markerRect?.width ?? 0)) <= 1 / 64),
    result("dpr-resource-switch", "LayoutImageResource selects the 200% GRIT resource at DPR 2 and the device payload doubles in each axis.", `${dpr1.captured.resourceScale}/${dpr1.captured.iconPixelWidth}`, `${dpr2.captured.resourceScale}/${dpr2.captured.iconPixelWidth}`, dpr1.captured.resourceScale === 1 && dpr2.captured.resourceScale === 2 && dpr2.captured.iconPixelWidth === (dpr1.captured.iconPixelWidth ?? 0) * 2 && dpr1.iconComparison?.sourceRgbaSha256 !== dpr2.iconComparison?.sourceRgbaSha256),
    result("light-dark-text-only", "Color scheme changes inherited alternative-text color while the shared GRIT icon bytes remain invariant.", light.captured.textColor ?? "missing", dark.captured.textColor ?? "missing", light.captured.textColor !== dark.captured.textColor && rowAt(rows, "icon-content", 1, "light").iconComparison?.sourceRgbaSha256 === rowAt(rows, "icon-content", 1, "dark").iconComparison?.sourceRgbaSha256),
    result("gray-mountain-substitution", "A fixed gray framed mountain must fail the independent live icon-content comparison.", dpr1.iconComparison?.pass ?? false, grayComparison.pass, dpr1.iconComparison?.pass === true && grayComparison.pass === false),
    result("reuse-1x-at-2x", "Upscaling the 100% crop must fail against Chromium's independently selected 200% resource.", dpr2.iconComparison?.pass ?? false, reuseComparison.pass, dpr2.iconComparison?.pass === true && reuseComparison.pass === false),
  ];
}

export function validateBrokenImageGateCorpus(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const test of BROKEN_IMAGE_GATE_CASES) {
    if (ids.has(test.id)) errors.push(`duplicate case id: ${test.id}`);
    ids.add(test.id);
  }
  const families = new Set(BROKEN_IMAGE_GATE_CASES.map((test) => test.family));
  for (const family of ["source-state", "alt-title", "threshold", "direction", "writing-mode", "sizing-mode", "author-box", "clipping", "mixed-text", "zoom", "transform", "raster-negative", "icon-content"] as const) {
    if (!families.has(family)) errors.push(`missing case family: ${family}`);
  }
  for (const id of ["src-loading", "src-error", "src-success", "alt-missing", "alt-empty-auto", "alt-text", "title-fallback", "threshold-17", "threshold-18", "direction-ltr", "direction-rtl", "writing-horizontal", "writing-vertical", "standards-one-dimension", "standards-both-empty", "standards-aspect-ratio", "quirks-one-dimension", "author-box", "long-clipped-quirks", "mixed-astral-bidi", "zoom-1", "zoom-1-5", "ordinary-author-raster", "icon-content"]) {
    if (!ids.has(id)) errors.push(`missing required case: ${id}`);
  }
  if (new Set(REQUIRED_BROKEN_IMAGE_MUTATIONS).size !== REQUIRED_BROKEN_IMAGE_MUTATIONS.length) errors.push("mutation kinds are not unique");
  return errors;
}

async function chromiumRevision(): Promise<{ playwrightVersion: string; chromiumRevision: string }> {
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  try {
    const packagePath = require.resolve("playwright-core/package.json");
    const browsers = JSON.parse(readFileSync(resolve(dirname(packagePath), "browsers.json"), "utf8")) as { browsers?: Array<{ name?: string; revision?: string }> };
    return { playwrightVersion, chromiumRevision: browsers.browsers?.find(({ name }) => name === "chromium")?.revision ?? "unknown" };
  } catch {
    return { playwrightVersion, chromiumRevision: "unknown" };
  }
}

export async function runBrokenImageFallbackOracle(options: {
  deviceScaleFactors?: number[];
  colorSchemes?: Scheme[];
  artifactRoot?: string;
} = {}): Promise<BrokenImageGateReport> {
  const corpusErrors = validateBrokenImageGateCorpus();
  if (corpusErrors.length > 0) throw new Error(`invalid broken-image corpus:\n${corpusErrors.join("\n")}`);
  const currentPlatform = platform();
  if (!BROKEN_IMAGE_GATE_PLATFORMS.includes(currentPlatform as Platform)) throw new Error(`unsupported gate platform: ${currentPlatform}`);
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  const deviceScaleFactors = [...new Set(options.deviceScaleFactors ?? [...BROKEN_IMAGE_GATE_DPRS])].sort((a, b) => a - b);
  const colorSchemes = [...new Set(options.colorSchemes ?? [...BROKEN_IMAGE_GATE_SCHEMES])];
  const artifactRoot = resolve(options.artifactRoot ?? `tests/output/broken-image-fallback-${currentPlatform}/artifacts`);
  if (deviceScaleFactors.length === 0 || deviceScaleFactors.some((dpr) => !Number.isFinite(dpr) || dpr <= 0)) throw new Error("--dpr requires positive finite values");
  if (colorSchemes.length === 0) throw new Error("at least one color scheme is required");
  const browser = await launchChromium();
  try {
    const rows: BrokenImageGateRow[] = [];
    const direct = new Map<string, { sourcePng: Buffer; emittedPng: Buffer }>();
    const fonts = new Set<string>();
    let userAgent = "";
    let launchArguments: string[] = [];
    for (const scheme of colorSchemes) {
      for (const dpr of deviceScaleFactors) {
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr, colorScheme: scheme });
        const page = await context.newPage();
        const generatedPage = await context.newPage();
        const session = await context.newCDPSession(page);
        try {
          await Promise.all([session.send("DOM.enable"), session.send("CSS.enable"), session.send("Accessibility.enable")]);
          if (userAgent === "") userAgent = await page.evaluate(() => navigator.userAgent);
          if (launchArguments.length === 0) {
            const command = await session.send("Browser.getBrowserCommandLine").catch(() => ({ arguments: [] as string[] }));
            launchArguments = command.arguments ?? [];
          }
          for (const test of BROKEN_IMAGE_GATE_CASES) {
            const result = await runCase({ page, generatedPage, session, test, dpr, scheme, artifactRoot });
            rows.push(result.row);
            for (const font of result.row.captured.resolvedFonts) fonts.add(font);
            if (result.direct != null) direct.set(`${scheme}/${dpr}`, result.direct);
          }
        } finally {
          await session.detach().catch(() => undefined);
          await context.close();
        }
      }
    }
    const mutations = await buildMutations(rows, direct);
    const controls = {
      everyScenarioHasEveryCase: deviceScaleFactors.every((dpr) => colorSchemes.every((scheme) =>
        rows.filter((row) => row.deviceScaleFactor === dpr && row.colorScheme === scheme).length === BROKEN_IMAGE_GATE_CASES.length)),
      everyProductionRowPasses: rows.every((row) => row.pass),
      onlyVisibleBrokenIconsRasterize: rows.every((row) => row.output.iconMarkerCount === (row.expected.icon ? 1 : 0)),
      alternativeTextAlwaysVector: rows.every((row) => row.output.vectorTextMarkerCount === (row.expected.text ? 1 : 0)),
      successfulLoadingHiddenStayNegative: rows.filter((row) => ["src-loading", "src-success", "alt-empty-auto", "threshold-17", "ordinary-author-raster"].includes(row.id)).every((row) => row.output.iconMarkerCount === 0),
      noLegacyMountainOrRawText: rows.every((row) => row.output.legacyMountainCount === 0 && row.output.rawAlternativeTextCount === 0),
      directIconContentPasses: rows.filter((row) => row.id === "icon-content").every((row) => row.iconComparison?.pass === true),
      dprResourceSwitchObserved: rowAt(rows, "icon-content", 1).captured.resourceScale === 1 && rowAt(rows, "icon-content", 2).captured.resourceScale === 2,
      schemeKeepsSharedIcon: colorSchemes.length < 2 || deviceScaleFactors.every((dpr) => rowAt(rows, "icon-content", dpr, "light").iconComparison?.sourceRgbaSha256 === rowAt(rows, "icon-content", dpr, "dark").iconComparison?.sourceRgbaSha256),
      everyRequiredMutationMoves: mutations.length === REQUIRED_BROKEN_IMAGE_MUTATIONS.length && mutations.every((mutation) => mutation.moved),
    };
    const pass = rows.every((row) => row.pass) && mutations.every((mutation) => mutation.moved) && Object.values(controls).every(Boolean);
    const revision = await chromiumRevision();
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRevisions: BROKEN_IMAGE_GATE_SOURCE_REVISIONS,
      environment: {
        platform: currentPlatform as Platform,
        architecture: arch(),
        osRelease: release(),
        runnerImage: process.env.ImageOS ?? `${currentPlatform}-local`,
        runnerImageVersion: process.env.ImageVersion ?? "local",
        chromiumVersion: browser.version(),
        chromiumRevision: revision.chromiumRevision,
        playwrightVersion: revision.playwrightVersion,
        userAgent,
        node: process.version,
        launchArguments,
        deviceScaleFactors,
        colorSchemes,
        viewport: VIEWPORT,
        fontInventory: [...fonts].sort(),
      },
      corpus: {
        cases: BROKEN_IMAGE_GATE_CASES.length,
        families: [...new Set(BROKEN_IMAGE_GATE_CASES.map((test) => test.family))],
        mutationKinds: REQUIRED_BROKEN_IMAGE_MUTATIONS,
      },
      rows,
      mutations,
      controls,
      summary: {
        rowsPassed: rows.filter((row) => row.pass).length,
        rowsFailed: rows.filter((row) => !row.pass).length,
        mutationsMoved: mutations.filter((mutation) => mutation.moved).length,
        mutationsFailed: mutations.filter((mutation) => !mutation.moved).length,
      },
      verdict: pass ? "hard-broken-image-fallback-parity" : "broken-image-fallback-parity-failure",
    };
  } finally {
    await browser.close();
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const dprs = arg("--dpr")?.split(",").map(Number) ?? [...BROKEN_IMAGE_GATE_DPRS];
  const schemes = (arg("--scheme")?.split(",") ?? [...BROKEN_IMAGE_GATE_SCHEMES]) as Scheme[];
  const reportPath = resolve(arg("--json") ?? `tests/output/broken-image-fallback-${platform()}/report.json`);
  const artifactRoot = resolve(arg("--artifacts") ?? resolve(dirname(reportPath), "artifacts"));
  const report = await runBrokenImageFallbackOracle({ deviceScaleFactors: dprs, colorSchemes: schemes, artifactRoot });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`broken-image fallback gate: ${report.summary.rowsPassed}/${report.rows.length} rows, ${report.summary.mutationsMoved}/${report.mutations.length} mutations; ${report.verdict}`);
  for (const row of report.rows.filter((candidate) => !candidate.pass)) {
    console.log(`FAIL ${row.colorScheme}/${row.deviceScaleFactor}x ${row.id}: geometry=${row.comparison.maxGeometryDeltaCssPx}, baseline=${row.comparison.baselineDeltaCssPx}, marker=${row.comparison.markerRectDeltaCssPx}, warnings=${row.warnings.join(" | ")}`);
  }
  for (const mutation of report.mutations) if (!mutation.moved) console.log(`FAIL ${mutation.id}: baseline=${mutation.baseline}, mutated=${mutation.mutated}`);
  console.log(`controls: ${JSON.stringify(report.controls)}`);
  console.log(`report: ${relative(process.cwd(), reportPath)}`);
  return report.verdict === "hard-broken-image-fallback-parity" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
