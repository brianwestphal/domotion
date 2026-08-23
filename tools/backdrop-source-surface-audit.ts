#!/usr/bin/env tsx
/**
 * DM-2357 source-surface transition audit for backdrop-filter.
 *
 * This is intentionally an investigation oracle, not a release gate.  It
 * records where Blink starts a Backdrop Root, compares Chromium with the
 * current SVG consumer, and proves the comparison is sensitive to both
 * under-capture (no backdrop surface) and over-capture (the final composited
 * target crop).  Known production gaps are findings; missing evidence makes
 * the audit incomplete.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { Page } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

export const BACKDROP_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const BACKDROP_REQUIRED_FAMILIES = [
  "nested-stacking-context",
  "isolation",
  "opacity",
  "transform",
  "clip-path",
  "mask",
  "scroll-container",
  "fixed-content",
  "sticky-content",
  "pseudo-element",
  "overlapping-backdrops",
] as const;

export const BACKDROP_PIXEL_CHANNEL_TOLERANCE = 4;
export const BACKDROP_EQUIVALENT_CHANGED_FRACTION = .01;
export const BACKDROP_MUTATION_MIN_CHANGED_FRACTION = .002;
export const BACKDROP_MUTATION_MIN_CHANNEL_DELTA = 12;

export type BackdropFamily = (typeof BACKDROP_REQUIRED_FAMILIES)[number]
  | "document-root"
  | "filter"
  | "target-filter-chain"
  | "nested-backdrops"
  | "overflow-clip"
  | "mix-blend-mode";

export type BackdropRootReason =
  | "document-root"
  | "opacity"
  | "filter"
  | "backdrop-filter"
  | "clip-path"
  | "mask"
  | "mix-blend-mode"
  | "will-change";

export interface BackdropStyleFacts {
  id: string;
  isDocumentRoot: boolean;
  opacity: string;
  filter: string;
  backdropFilter: string;
  clipPath: string;
  maskImage: string;
  maskBorderSource: string;
  mixBlendMode: string;
  isolation: string;
  transform: string;
  position: string;
  overflowX: string;
  overflowY: string;
  willChange: string;
}

const active = (value: string | undefined, initial: string): boolean =>
  value != null && value !== "" && value !== initial;

/** Source-derived Filter Effects 2 / Blink effect-tree Backdrop Root test. */
export function backdropRootReasons(style: BackdropStyleFacts): BackdropRootReason[] {
  const reasons: BackdropRootReason[] = [];
  if (style.isDocumentRoot) reasons.push("document-root");
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity < 1) reasons.push("opacity");
  if (active(style.filter, "none")) reasons.push("filter");
  if (active(style.backdropFilter, "none")) reasons.push("backdrop-filter");
  if (active(style.clipPath, "none")) reasons.push("clip-path");
  if (active(style.maskImage, "none") || active(style.maskBorderSource, "none")) reasons.push("mask");
  if (active(style.mixBlendMode, "normal")) reasons.push("mix-blend-mode");
  const willChange = new Set(style.willChange.split(",").map((part) => part.trim()).filter(Boolean));
  if (["opacity", "filter", "backdrop-filter", "clip-path", "mask", "mask-image", "mask-border", "mix-blend-mode"]
    .some((property) => willChange.has(property))) reasons.push("will-change");
  // Deliberate negatives: an ordinary stacking context, isolation:isolate,
  // transforms, scrolling/overflow, and fixed/sticky positioning are not
  // Backdrop Roots. They can still create other property-tree nodes.
  return reasons;
}

export function nearestBackdropRoot(chain: readonly BackdropStyleFacts[]): {
  id: string;
  reasons: BackdropRootReason[];
} | null {
  for (const style of chain) {
    const reasons = backdropRootReasons(style);
    if (reasons.length > 0) return { id: style.id, reasons };
  }
  return null;
}

interface AuditCase {
  id: string;
  family: BackdropFamily;
  expectedRoot: "document" | "wrapper" | "outer-target";
  expectedRasterOwners: number;
  kind?: "standard" | "pseudo" | "nested" | "overlap" | "scroll" | "sticky" | "fixed";
  wrapperCss?: string;
  targetCss?: string;
}

export const BACKDROP_CASES: readonly AuditCase[] = [
  { id: "plain", family: "document-root", expectedRoot: "document", expectedRasterOwners: 1 },
  { id: "stacking", family: "nested-stacking-context", expectedRoot: "document", expectedRasterOwners: 1, wrapperCss: "position:relative;z-index:0" },
  { id: "isolation", family: "isolation", expectedRoot: "document", expectedRasterOwners: 1, wrapperCss: "isolation:isolate" },
  { id: "opacity", family: "opacity", expectedRoot: "wrapper", expectedRasterOwners: 1, wrapperCss: "opacity:.68" },
  { id: "transform", family: "transform", expectedRoot: "document", expectedRasterOwners: 1, wrapperCss: "transform:translate(5px,3px) rotate(.8deg);transform-origin:0 0" },
  { id: "clip-path", family: "clip-path", expectedRoot: "wrapper", expectedRasterOwners: 1, wrapperCss: "clip-path:polygon(3% 4%,96% 0,91% 94%,7% 100%)" },
  { id: "mask", family: "mask", expectedRoot: "wrapper", expectedRasterOwners: 1, wrapperCss: "-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 24%,#000 82%,transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 24%,#000 82%,transparent 100%)" },
  { id: "scroll", family: "scroll-container", expectedRoot: "document", expectedRasterOwners: 1, kind: "scroll", wrapperCss: "overflow:auto" },
  { id: "fixed", family: "fixed-content", expectedRoot: "document", expectedRasterOwners: 1, kind: "fixed" },
  { id: "sticky", family: "sticky-content", expectedRoot: "document", expectedRasterOwners: 1, kind: "sticky", wrapperCss: "overflow:auto" },
  { id: "pseudo", family: "pseudo-element", expectedRoot: "document", expectedRasterOwners: 1, kind: "pseudo" },
  { id: "nested", family: "nested-backdrops", expectedRoot: "outer-target", expectedRasterOwners: 2, kind: "nested" },
  { id: "overlap", family: "overlapping-backdrops", expectedRoot: "document", expectedRasterOwners: 2, kind: "overlap" },
  { id: "filter-root", family: "filter", expectedRoot: "wrapper", expectedRasterOwners: 1, wrapperCss: "filter:saturate(.72) contrast(1.12)" },
  { id: "target-filter", family: "target-filter-chain", expectedRoot: "document", expectedRasterOwners: 1, targetCss: "filter:opacity(.74) saturate(1.18)" },
  { id: "overflow-clip", family: "overflow-clip", expectedRoot: "document", expectedRasterOwners: 1, wrapperCss: "overflow:hidden;border-radius:18px" },
  { id: "blend-root", family: "mix-blend-mode", expectedRoot: "wrapper", expectedRasterOwners: 1, wrapperCss: "mix-blend-mode:multiply" },
] as const;

const CELL_WIDTH = 210;
const CELL_HEIGHT = 150;
const COLUMNS = 4;
export const BACKDROP_VIEWPORT = {
  width: CELL_WIDTH * COLUMNS,
  height: CELL_HEIGHT * Math.ceil(BACKDROP_CASES.length / COLUMNS),
} as const;

function ids(spec: AuditCase): { caseId: string; wrapperId: string; targetId: string; targetAnim: string } {
  return {
    caseId: `bd-${spec.id}-case`,
    wrapperId: `bd-${spec.id}-wrapper`,
    targetId: `bd-${spec.id}-target`,
    targetAnim: `bd-${spec.id}-target`,
  };
}

function standardMarkup(spec: AuditCase, index: number): string {
  const { caseId, wrapperId, targetId, targetAnim } = ids(spec);
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const fixedLeft = column * CELL_WIDTH + 52;
  const fixedTop = row * CELL_HEIGHT + 40;
  const kind = spec.kind ?? "standard";
  const wrapperAttributes = kind === "scroll" || kind === "sticky" ? ' data-audit-scroll="38"' : "";
  let contents: string;
  if (kind === "pseudo") {
    contents = `<div class="inner-under"></div><div id="${targetId}" class="pseudo-host" data-domotion-anim="${targetAnim}"></div><div class="later" data-domotion-anim="bd-${spec.id}-later"></div>`;
  } else if (kind === "nested") {
    contents = `<div class="inner-under"></div><div id="bd-${spec.id}-outer" class="target outer" data-domotion-anim="bd-${spec.id}-outer"><div class="nested-under"></div><div id="${targetId}" class="target inner" data-domotion-anim="${targetAnim}"><div class="vector" data-domotion-anim="bd-${spec.id}-vector"></div></div></div><div class="later" data-domotion-anim="bd-${spec.id}-later"></div>`;
  } else if (kind === "overlap") {
    contents = `<div class="inner-under"></div><div id="${targetId}" class="target primary" data-domotion-anim="${targetAnim}"><div class="vector" data-domotion-anim="bd-${spec.id}-vector"></div></div><div class="target secondary" data-domotion-anim="bd-${spec.id}-secondary"><div class="vector secondary-vector"></div></div><div class="later overlap-later" data-domotion-anim="bd-${spec.id}-later"></div>`;
  } else if (kind === "sticky") {
    contents = `<div class="scroll-canvas"><div class="inner-under"></div><div class="sticky-spacer"></div><div id="${targetId}" class="target sticky" data-domotion-anim="${targetAnim}"><div class="vector" data-domotion-anim="bd-${spec.id}-vector"></div></div><div class="later sticky-later" data-domotion-anim="bd-${spec.id}-later"></div></div>`;
  } else {
    const positionStyle = kind === "fixed" ? `position:fixed;left:${fixedLeft}px;top:${fixedTop}px` : "";
    const canvasOpen = kind === "scroll" ? '<div class="scroll-canvas">' : "";
    const canvasClose = kind === "scroll" ? "</div>" : "";
    contents = `${canvasOpen}<div class="inner-under"></div><div id="${targetId}" class="target primary" data-domotion-anim="${targetAnim}" style="${positionStyle};${spec.targetCss ?? ""}"><div class="vector" data-domotion-anim="bd-${spec.id}-vector"></div></div><div class="later" data-domotion-anim="bd-${spec.id}-later"></div>${canvasClose}`;
  }
  return `<section id="${caseId}" class="case case-${spec.id}" data-audit-case="${spec.id}" data-domotion-anim="${caseId}"><div class="under"></div><div id="${wrapperId}" class="wrapper" style="${spec.wrapperCss ?? ""}"${wrapperAttributes}>${contents}</div></section>`;
}

/** Deterministic, font-free transition corpus. */
export function backdropAuditFixtureHtml(): string {
  const cases = BACKDROP_CASES.map(standardMarkup).join("");
  const perCase = BACKDROP_CASES.map((spec) => {
    if (spec.kind === "pseudo") {
      return `#bd-${spec.id}-target::before{content:"";position:absolute;left:42px;top:27px;width:108px;height:72px;border-radius:12px;border:2px solid rgba(255,255,255,.72);background:rgba(235,246,255,.22);-webkit-backdrop-filter:blur(6px) saturate(1.35);backdrop-filter:blur(6px) saturate(1.35)}`;
    }
    return "";
  }).join("");
  return `<!doctype html><html id="document"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;min-height:100%;background:#0b1220}body{overflow:hidden}
    #stage{position:relative;width:${BACKDROP_VIEWPORT.width}px;height:${BACKDROP_VIEWPORT.height}px;background:#10182c;overflow:hidden}
    .case{position:absolute;width:198px;height:138px;margin:6px;overflow:hidden;border:2px solid #41506d;border-radius:7px;background:#17213a}
    ${BACKDROP_CASES.map((spec, index) => `.case-${spec.id}{left:${index % COLUMNS * CELL_WIDTH}px;top:${Math.floor(index / COLUMNS) * CELL_HEIGHT}px}`).join("\n")}
    .under{position:absolute;inset:0;background:#ef4b38;border-right:64px solid #2166d1;border-bottom:53px solid #f2c94c;box-shadow:inset 42px 34px 0 #18a56d}
    .wrapper{position:absolute;inset:8px;min-height:118px}
    .inner-under{position:absolute;left:8px;top:8px;width:164px;height:96px;background:#2bd4aa;border:20px solid #6636d2;border-left-width:54px;border-bottom-color:#fff}
    .target{position:absolute;left:38px;top:26px;width:110px;height:72px;border:2px solid rgba(255,255,255,.72);border-radius:12px;background:rgba(235,246,255,.22);-webkit-backdrop-filter:blur(6px) saturate(1.35);backdrop-filter:blur(6px) saturate(1.35)}
    .vector{position:absolute;left:13px;top:15px;width:23px;height:19px;border-radius:4px;background:rgba(255,255,255,.58);border:3px solid rgba(23,33,58,.66)}
    .later{position:absolute;left:112px;top:62px;width:48px;height:35px;border-radius:6px;background:rgba(244,44,116,.58);border:3px solid rgba(52,16,62,.78)}
    .pseudo-host{position:absolute;inset:0}.outer{left:20px;top:15px;width:145px;height:92px}.outer>.nested-under{position:absolute;inset:9px;background:#00d4ff;border-right:48px solid #ff3cac}.outer>.inner{left:25px;top:18px;width:95px;height:58px}.secondary{left:72px;top:42px;width:90px;height:61px}.secondary-vector{left:44px;top:24px}.overlap-later{left:128px;top:78px;width:35px;height:23px}
    .scroll-canvas{position:relative;width:172px;height:190px}.case-scroll .target{top:68px}.case-scroll .later{top:91px}.case-scroll .wrapper,.case-sticky .wrapper{height:112px}.sticky-spacer{height:48px}.target.sticky{position:sticky;top:11px;left:36px}.sticky-later{top:118px}
    .case-fixed .target{z-index:0}.case-fixed .later{z-index:1}
    ${perCase}
  </style></head><body><main id="stage">${cases}</main><script>for(const node of document.querySelectorAll('[data-audit-scroll]'))node.scrollTop=Number(node.getAttribute('data-audit-scroll'));</script></body></html>`;
}

interface Rect { x: number; y: number; width: number; height: number }
interface DecodedImage { width: number; height: number; channels: number; data: Buffer }

export interface PixelComparison {
  pixels: number;
  changedPixels: number;
  changedFraction: number;
  meanAbsoluteChannelDelta: number;
  maxChannelDelta: number;
}

async function decodePng(png: Buffer): Promise<DecodedImage> {
  const result = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: result.info.width, height: result.info.height, channels: result.info.channels, data: result.data };
}

export function compareDecodedRegion(left: DecodedImage, right: DecodedImage, rect: Rect, dpr: number): PixelComparison {
  if (left.width !== right.width || left.height !== right.height || left.channels !== right.channels) {
    throw new Error(`image shape mismatch: ${left.width}x${left.height}x${left.channels} vs ${right.width}x${right.height}x${right.channels}`);
  }
  const x0 = Math.max(0, Math.floor(rect.x * dpr));
  const y0 = Math.max(0, Math.floor(rect.y * dpr));
  const x1 = Math.min(left.width, Math.ceil((rect.x + rect.width) * dpr));
  const y1 = Math.min(left.height, Math.ceil((rect.y + rect.height) * dpr));
  let sum = 0;
  let maximum = 0;
  let changed = 0;
  let pixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * left.width + x) * left.channels;
      let pixelMaximum = 0;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(left.data[offset + channel] - right.data[offset + channel]);
        sum += delta;
        maximum = Math.max(maximum, delta);
        pixelMaximum = Math.max(pixelMaximum, delta);
      }
      if (pixelMaximum > BACKDROP_PIXEL_CHANNEL_TOLERANCE) changed++;
      pixels++;
    }
  }
  return {
    pixels,
    changedPixels: changed,
    changedFraction: pixels === 0 ? 0 : changed / pixels,
    meanAbsoluteChannelDelta: pixels === 0 ? 0 : sum / (pixels * 4),
    maxChannelDelta: maximum,
  };
}

export const mutationDiscriminates = (comparison: PixelComparison): boolean =>
  comparison.maxChannelDelta >= BACKDROP_MUTATION_MIN_CHANNEL_DELTA
  && comparison.changedFraction >= BACKDROP_MUTATION_MIN_CHANGED_FRACTION;

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function findByAnimId(tree: CapturedElement[], animId: string): CapturedElement | undefined {
  return flatten(tree).find((element) => element.animId === animId);
}

interface BackdropOwnerRef {
  record: { dataUri?: string };
  rect: Rect;
  ownerCount: number;
  screenshotPasses: number;
  source: "ordinary-boundary" | "ordinary-composite" | "generated-pseudo";
}

function backdropOwners(tree: CapturedElement[]): BackdropOwnerRef[] {
  const owners: BackdropOwnerRef[] = [];
  for (const element of flatten(tree)) {
    const composite = element.backdropCompositeRaster;
    if (composite?.dataUri != null) {
      owners.push({
        record: composite,
        rect: { x: composite.x, y: composite.y, width: composite.width, height: composite.height },
        ownerCount: composite.ownerCount,
        screenshotPasses: composite.screenshotPasses,
        source: "ordinary-composite",
      });
    } else {
      const raster = element.backdropFilterRaster;
      if (raster?.dataUri != null) {
        owners.push({
          record: raster,
          rect: { x: raster.x, y: raster.y, width: raster.width, height: raster.height },
          ownerCount: 1,
          screenshotPasses: 1,
          source: "ordinary-boundary",
        });
      }
    }
    for (const pseudo of element.pseudoFragments ?? []) {
      const raster = pseudo.backdropFilterRaster;
      if (raster?.dataUri == null) continue;
      owners.push({
        record: raster,
        rect: raster.rect,
        ownerCount: 1,
        screenshotPasses: 1,
        source: "generated-pseudo",
      });
    }
  }
  return owners;
}

function cloneTree(tree: CapturedElement[]): CapturedElement[] {
  return structuredClone(tree);
}

async function replaceBackdropRastersWithFinalCrops(
  tree: CapturedElement[],
  sourcePng: Buffer,
  dpr: number,
): Promise<void> {
  const metadata = await sharp(sourcePng).metadata();
  const imageWidth = metadata.width ?? 0;
  const imageHeight = metadata.height ?? 0;
  await Promise.all(backdropOwners(tree).map(async (owner) => {
    const raster = owner.rect;
    const left = Math.max(0, Math.floor(raster.x * dpr));
    const top = Math.max(0, Math.floor(raster.y * dpr));
    const right = Math.min(imageWidth, Math.ceil((raster.x + raster.width) * dpr));
    const bottom = Math.min(imageHeight, Math.ceil((raster.y + raster.height) * dpr));
    if (right <= left || bottom <= top) return;
    const crop = await sharp(sourcePng).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
    owner.record.dataUri = `data:image/png;base64,${crop.toString("base64")}`;
  }));
}

async function renderSvg(page: Page, svg: string): Promise<Buffer> {
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${BACKDROP_VIEWPORT.width}px;height:${BACKDROP_VIEWPORT.height}px}</style><img id="candidate" src="${uri}">`);
  await page.locator("#candidate").evaluate((image) => (image as HTMLImageElement).decode());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return Buffer.from(await page.screenshot({
    clip: { x: 0, y: 0, width: BACKDROP_VIEWPORT.width, height: BACKDROP_VIEWPORT.height },
    omitBackground: true,
    type: "png",
  }));
}

interface LiveCaseFacts {
  rect: Rect;
  targetBackdropFilter: string;
  chain: BackdropStyleFacts[];
}

export interface BackdropAuditRow {
  id: string;
  family: BackdropFamily;
  dpr: number;
  expectedRoot: string;
  observedRoot: string | null;
  rootReasons: BackdropRootReason[];
  rootMatchesSourceModel: boolean;
  targetBackdropFilter: string;
  expectedRasterOwners: number;
  actualRasterOwners: number;
  ownershipComplete: boolean;
  capturePasses: { surfaces: number; screenshots: number };
  sourceVsRendered: PixelComparison;
  productionEquivalent: boolean;
  underCapture: { applicable: boolean; comparison: PixelComparison; discriminated: boolean };
  overCapture: { applicable: boolean; comparison: PixelComparison; discriminated: boolean };
  vectorOrder: {
    sourceTargetBeforeLaterPaint: boolean | null;
    rasterBeforeTargetVector: boolean | null;
    rasterBeforeLaterPaint: boolean | null;
    matchesSourceSiblingOrder: boolean | null;
  };
  findings: string[];
  evidenceComplete: boolean;
}

export interface BackdropSourceSurfaceReport {
  schemaVersion: 1;
  sourcePins: typeof BACKDROP_SOURCE_PINS;
  producer: { chromiumVersion: string; platform: NodeJS.Platform; architecture: string };
  sourceRules: {
    backdropAndRegularFilterUseSeparateEffectSurfaces: true;
    regularFilterIsAppendedToBackdropOperations: true;
    skiaBackdropSource: "prior-parent-device";
    nonRootTransitions: readonly ["ordinary-stacking-context", "isolation", "transform", "scroll-container", "fixed", "sticky"];
  };
  requiredFamilies: typeof BACKDROP_REQUIRED_FAMILIES;
  thresholds: {
    pixelChannel: typeof BACKDROP_PIXEL_CHANNEL_TOLERANCE;
    equivalentChangedFraction: typeof BACKDROP_EQUIVALENT_CHANGED_FRACTION;
    mutationMinChangedFraction: typeof BACKDROP_MUTATION_MIN_CHANGED_FRACTION;
    mutationMinChannelDelta: typeof BACKDROP_MUTATION_MIN_CHANNEL_DELTA;
  };
  rows: BackdropAuditRow[];
  warnings: string[];
  blockers: string[];
  productionGaps: string[];
  strictVerdict: "source-exact" | "production-gaps" | "incomplete";
  verdict: "investigation-complete" | "incomplete";
}

async function liveFacts(page: Page): Promise<Record<string, LiveCaseFacts>> {
  // A string expression is intentional: tsx/esbuild's nested-function name
  // helper lives in Node and is not present in Playwright's utility world.
  const body = await page.evaluate(`JSON.stringify((function () {
    function styleFacts(element, isDocumentRoot) {
      var style = getComputedStyle(element);
      return {
        id: element.id || element.tagName.toLowerCase(),
        isDocumentRoot: isDocumentRoot,
        opacity: style.opacity,
        filter: style.filter,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || "none",
        clipPath: style.clipPath,
        maskImage: style.maskImage,
        maskBorderSource: style.maskBorderSource || "none",
        mixBlendMode: style.mixBlendMode,
        isolation: style.isolation,
        transform: style.transform,
        position: style.position,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        willChange: style.willChange
      };
    }
    var result = {};
    var elements = document.querySelectorAll("[data-audit-case]");
    for (var index = 0; index < elements.length; index++) {
      var caseElement = elements[index];
      var id = caseElement.getAttribute("data-audit-case");
      var pseudo = id === "pseudo";
      var target = caseElement.querySelector("#bd-" + id + "-target");
      var targetStyle = getComputedStyle(target, pseudo ? "::before" : null);
      var targetRect = target.getBoundingClientRect();
      var rect = pseudo ? {
        left: targetRect.left + parseFloat(targetStyle.left || "0"),
        top: targetRect.top + parseFloat(targetStyle.top || "0"),
        width: parseFloat(targetStyle.width || "0"),
        height: parseFloat(targetStyle.height || "0")
      } : targetRect;
      var chain = [];
      var ancestor = pseudo ? target : target.parentElement;
      while (ancestor != null) {
        chain.push(styleFacts(ancestor, ancestor === document.documentElement));
        ancestor = ancestor.parentElement;
      }
      result[id] = {
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        targetBackdropFilter: targetStyle.backdropFilter || targetStyle.webkitBackdropFilter || "none",
        chain: chain
      };
    }
    return result;
  })())`);
  return JSON.parse(String(body)) as Record<string, LiveCaseFacts>;
}

interface SourcePaintPosition { paintOrder: number; layoutOrder: number }

/** Independent DOMSnapshot paint-order facts, before Domotion mutates the page. */
async function sourcePaintOrderFacts(page: Page): Promise<Record<string, boolean | null>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [], includePaintOrder: true, includeDOMRects: true,
    }) as any;
    const document = snapshot.documents?.[0];
    const strings: string[] = snapshot.strings ?? [];
    const positions = new Map<number, SourcePaintPosition>();
    for (let index = 0; index < (document?.layout?.nodeIndex?.length ?? 0); index++) {
      const nodeIndex = document.layout.nodeIndex[index] as number;
      const paintOrder = document.layout.paintOrders?.[index] as number | undefined;
      if (paintOrder != null && !positions.has(nodeIndex)) positions.set(nodeIndex, { paintOrder, layoutOrder: index });
    }
    const attributeRows = new Map<number, number[]>();
    const attributes = document?.nodes?.attributes;
    if (Array.isArray(attributes)) {
      for (let index = 0; index < attributes.length; index++) attributeRows.set(index, attributes[index]);
    } else {
      for (let index = 0; index < (attributes?.index?.length ?? 0); index++) attributeRows.set(attributes.index[index], attributes.value[index]);
    }
    const byAnimId = new Map<string, SourcePaintPosition>();
    for (let nodeIndex = 0; nodeIndex < (document?.nodes?.backendNodeId?.length ?? 0); nodeIndex++) {
      const indexes = attributeRows.get(nodeIndex) ?? [];
      const row = indexes.map((value) => strings[value]);
      for (let attr = 0; attr + 1 < row.length; attr += 2) {
        if (row[attr] === "data-domotion-anim") {
          const position = positions.get(nodeIndex);
          if (position != null) byAnimId.set(row[attr + 1], position);
        }
      }
    }
    const result: Record<string, boolean | null> = {};
    for (const spec of BACKDROP_CASES) {
      if (spec.kind === "pseudo") { result[spec.id] = null; continue; }
      const target = byAnimId.get(`bd-${spec.id}-target`);
      const later = byAnimId.get(`bd-${spec.id}-later`);
      if (target == null || later == null) { result[spec.id] = null; continue; }
      result[spec.id] = target.paintOrder < later.paintOrder
        || (target.paintOrder === later.paintOrder && target.layoutOrder < later.layoutOrder);
    }
    return result;
  } finally {
    await cdp.detach();
  }
}

function expectedRootId(spec: AuditCase): string {
  if (spec.expectedRoot === "document") return "document";
  if (spec.expectedRoot === "outer-target") return `bd-${spec.id}-outer`;
  return `bd-${spec.id}-wrapper`;
}

export async function runBackdropSourceSurfaceAudit(
  dprs: number[] = [1, 2],
  artifactDir?: string,
): Promise<BackdropSourceSurfaceReport> {
  const browser = await launchChromium();
  const chromiumVersion = browser.version();
  const rows: BackdropAuditRow[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: BACKDROP_VIEWPORT, deviceScaleFactor: dpr });
      const sourcePage = await context.newPage();
      const renderPage = await context.newPage();
      try {
        // tsx/esbuild annotates nested browser callbacks with `__name`; page
        // globals do not inherit that helper from Node.
        await sourcePage.addInitScript({ content: "globalThis.__name=(target)=>target;" });
        await sourcePage.setContent(backdropAuditFixtureHtml(), { waitUntil: "load" });
        await sourcePage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const facts = await liveFacts(sourcePage);
        const sourceOrder = await sourcePaintOrderFacts(sourcePage);
        const sourcePng = Buffer.from(await sourcePage.screenshot({
          clip: { x: 0, y: 0, width: BACKDROP_VIEWPORT.width, height: BACKDROP_VIEWPORT.height },
          omitBackground: true,
          type: "png",
        }));
        const capture = await captureElementTreeWithWarnings(sourcePage, "#stage", {
          x: 0, y: 0, width: BACKDROP_VIEWPORT.width, height: BACKDROP_VIEWPORT.height,
        });
        warnings.push(...capture.warnings.map((warning) => `DPR${dpr}:${typeof warning === "string" ? warning : JSON.stringify(warning)}`));

        const svg = elementTreeToSvg(capture.tree, BACKDROP_VIEWPORT.width, BACKDROP_VIEWPORT.height);
        const underTree = cloneTree(capture.tree);
        for (const owner of backdropOwners(underTree)) owner.record.dataUri = undefined;
        const underSvg = elementTreeToSvg(underTree, BACKDROP_VIEWPORT.width, BACKDROP_VIEWPORT.height);
        const overTree = cloneTree(capture.tree);
        await replaceBackdropRastersWithFinalCrops(overTree, sourcePng, dpr);
        const overSvg = elementTreeToSvg(overTree, BACKDROP_VIEWPORT.width, BACKDROP_VIEWPORT.height);
        // One page is reused serially: setContent calls on the same page are
        // navigations and therefore cannot safely overlap.
        const renderedPng = await renderSvg(renderPage, svg);
        const underPng = await renderSvg(renderPage, underSvg);
        const overPng = await renderSvg(renderPage, overSvg);
        const [sourceImage, renderedImage, underImage, overImage] = await Promise.all([
          decodePng(sourcePng), decodePng(renderedPng), decodePng(underPng), decodePng(overPng),
        ]);

        for (const spec of BACKDROP_CASES) {
          const caseFacts = facts[spec.id];
          if (caseFacts == null) {
            blockers.push(`DPR${dpr}:${spec.id}:missing live case facts`);
            continue;
          }
          const root = nearestBackdropRoot(caseFacts.chain);
          const expectedRoot = expectedRootId(spec);
          const caseNode = findByAnimId(capture.tree, `bd-${spec.id}-case`);
          const owners = caseNode == null ? [] : backdropOwners([caseNode]);
          const actualRasterOwners = owners.reduce((sum, owner) => sum + owner.ownerCount, 0);
          const sourceVsRendered = compareDecodedRegion(sourceImage, renderedImage, caseFacts.rect, dpr);
          const underComparison = compareDecodedRegion(renderedImage, underImage, caseFacts.rect, dpr);
          const overComparison = compareDecodedRegion(renderedImage, overImage, caseFacts.rect, dpr);
          const targetUri = owners[0]?.record.dataUri;
          const targetRasterAt = targetUri == null ? -1 : svg.indexOf(targetUri);
          const vectorAt = svg.indexOf(`class="anim-bd-${spec.id}-vector"`);
          const laterAt = svg.indexOf(`class="anim-bd-${spec.id}-later"`);
          const rasterApplicable = actualRasterOwners > 0;
          const atomicComposite = owners.some((owner) => owner.source === "ordinary-composite");
          const findings: string[] = [];
          if (root?.id !== expectedRoot) findings.push(`source-root classifier resolved ${root?.id ?? "none"}, expected ${expectedRoot}`);
          if (caseFacts.targetBackdropFilter === "none") findings.push("Chromium target backdrop-filter did not activate");
          if (actualRasterOwners !== spec.expectedRasterOwners) findings.push(`serialized ${actualRasterOwners}/${spec.expectedRasterOwners} required backdrop surfaces`);
          if (sourceVsRendered.changedFraction > BACKDROP_EQUIVALENT_CHANGED_FRACTION) {
            findings.push(`production differs from Chromium on ${(sourceVsRendered.changedFraction * 100).toFixed(2)}% of case pixels`);
          }
          if (rasterApplicable && !mutationDiscriminates(underComparison)) findings.push("under-capture mutation did not move output");
          if (rasterApplicable && !mutationDiscriminates(overComparison)) findings.push("over-capture mutation did not move output");
          const rasterBeforeLaterPaint = !rasterApplicable
            ? null
            : atomicComposite && laterAt < 0
              ? true
              : laterAt < 0 ? null : targetRasterAt >= 0 && targetRasterAt < laterAt;
          const sourceTargetBeforeLaterPaint = sourceOrder[spec.id] ?? null;
          const vectorOrder = {
            sourceTargetBeforeLaterPaint,
            rasterBeforeTargetVector: atomicComposite && vectorAt < 0
              ? true
              : targetRasterAt < 0 || vectorAt < 0 ? null : targetRasterAt < vectorAt,
            rasterBeforeLaterPaint,
            matchesSourceSiblingOrder: sourceTargetBeforeLaterPaint == null || rasterBeforeLaterPaint == null
              ? null
              : sourceTargetBeforeLaterPaint === rasterBeforeLaterPaint,
          };
          if (vectorOrder.rasterBeforeTargetVector === false) findings.push("target vector paints before its backdrop surface");
          if (vectorOrder.matchesSourceSiblingOrder === false) findings.push("backdrop surface and later sibling reverse Chromium paint order");
          const evidenceComplete = root?.id === expectedRoot
            && caseFacts.targetBackdropFilter !== "none"
            && caseNode != null
            && (!rasterApplicable || (mutationDiscriminates(underComparison) && mutationDiscriminates(overComparison)))
            && (!rasterApplicable || spec.kind === "pseudo" || vectorOrder.rasterBeforeTargetVector != null)
            && (spec.kind === "pseudo" || vectorOrder.matchesSourceSiblingOrder != null);
          rows.push({
            id: spec.id,
            family: spec.family,
            dpr,
            expectedRoot,
            observedRoot: root?.id ?? null,
            rootReasons: root?.reasons ?? [],
            rootMatchesSourceModel: root?.id === expectedRoot,
            targetBackdropFilter: caseFacts.targetBackdropFilter,
            expectedRasterOwners: spec.expectedRasterOwners,
            actualRasterOwners,
            ownershipComplete: actualRasterOwners === spec.expectedRasterOwners,
            capturePasses: {
              surfaces: owners.length,
              screenshots: owners.reduce((sum, owner) => sum + owner.screenshotPasses, 0),
            },
            sourceVsRendered,
            productionEquivalent: sourceVsRendered.changedFraction <= BACKDROP_EQUIVALENT_CHANGED_FRACTION,
            underCapture: { applicable: rasterApplicable, comparison: underComparison, discriminated: rasterApplicable && mutationDiscriminates(underComparison) },
            overCapture: { applicable: rasterApplicable, comparison: overComparison, discriminated: rasterApplicable && mutationDiscriminates(overComparison) },
            vectorOrder,
            findings,
            evidenceComplete,
          });
        }

        if (artifactDir != null) {
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(`${artifactDir}/source-dpr${dpr}.png`, sourcePng);
          writeFileSync(`${artifactDir}/rendered-dpr${dpr}.png`, renderedPng);
          writeFileSync(`${artifactDir}/under-capture-dpr${dpr}.png`, underPng);
          writeFileSync(`${artifactDir}/over-capture-dpr${dpr}.png`, overPng);
          writeFileSync(`${artifactDir}/rendered-dpr${dpr}.svg`, svg);
        }
      } finally {
        await renderPage.close();
        await sourcePage.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  for (const dpr of dprs) {
    const families = new Set(rows.filter((row) => row.dpr === dpr).map((row) => row.family));
    for (const family of BACKDROP_REQUIRED_FAMILIES) if (!families.has(family)) blockers.push(`DPR${dpr}:missing required family ${family}`);
  }
  blockers.push(...rows.filter((row) => !row.evidenceComplete).map((row) => `DPR${row.dpr}:${row.id}:incomplete evidence`));
  const productionGaps = [...new Set(rows.flatMap((row) => {
    const gaps: string[] = [];
    if (!row.ownershipComplete) gaps.push(`${row.id}:serialized ownership ${row.actualRasterOwners}/${row.expectedRasterOwners}`);
    if (!row.productionEquivalent) gaps.push(`${row.id}:rendered/source drift`);
    if (row.underCapture.applicable && !row.underCapture.discriminated) gaps.push(`${row.id}:no-surface mutation inert`);
    if (row.overCapture.applicable && !row.overCapture.discriminated) gaps.push(`${row.id}:final-composite mutation inert`);
    if (row.vectorOrder.rasterBeforeTargetVector === false) gaps.push(`${row.id}:backdrop/vector order drift`);
    if (row.vectorOrder.matchesSourceSiblingOrder === false) gaps.push(`${row.id}:backdrop/sibling order drift`);
    return gaps;
  }))];
  return {
    schemaVersion: 1,
    sourcePins: BACKDROP_SOURCE_PINS,
    producer: { chromiumVersion, platform: process.platform, architecture: process.arch },
    sourceRules: {
      backdropAndRegularFilterUseSeparateEffectSurfaces: true,
      regularFilterIsAppendedToBackdropOperations: true,
      skiaBackdropSource: "prior-parent-device",
      nonRootTransitions: ["ordinary-stacking-context", "isolation", "transform", "scroll-container", "fixed", "sticky"],
    },
    requiredFamilies: BACKDROP_REQUIRED_FAMILIES,
    thresholds: {
      pixelChannel: BACKDROP_PIXEL_CHANNEL_TOLERANCE,
      equivalentChangedFraction: BACKDROP_EQUIVALENT_CHANGED_FRACTION,
      mutationMinChangedFraction: BACKDROP_MUTATION_MIN_CHANGED_FRACTION,
      mutationMinChannelDelta: BACKDROP_MUTATION_MIN_CHANNEL_DELTA,
    },
    rows,
    warnings,
    blockers,
    productionGaps,
    strictVerdict: blockers.length > 0 ? "incomplete" : productionGaps.length > 0 ? "production-gaps" : "source-exact",
    verdict: blockers.length === 0 ? "investigation-complete" : "incomplete",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dprAt = args.indexOf("--dpr");
  const jsonAt = args.indexOf("--json");
  const artifactAt = args.indexOf("--artifact-dir");
  const strict = args.includes("--strict");
  const dprs = dprAt < 0 ? [1, 2] : args[dprAt + 1].split(",").map(Number).filter((value) => value > 0 && Number.isFinite(value));
  const jsonPath = jsonAt < 0 ? undefined : args[jsonAt + 1];
  const artifactDir = artifactAt < 0 ? undefined : args[artifactAt + 1];
  const report = await runBackdropSourceSurfaceAudit(dprs, artifactDir);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonPath != null) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, body);
  }
  process.stdout.write(body);
  if (report.verdict !== "investigation-complete" || (strict && report.strictVerdict !== "source-exact")) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
