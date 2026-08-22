/**
 * Blink scrollbar geometry/state capture (DM-2481).
 *
 * Stable web APIs do not expose Blink's Scrollbar/LayoutCustomScrollbarPart
 * objects.  Re-running PaintLayerScrollableArea's layout equations here would
 * create a second, host-dependent scrollbar engine.  Instead this pass asks
 * the same live Chromium frame to repaint existing scrollbar parts with
 * reserved marker colors, reads their device-pixel bounds, and restores the
 * page before the ordinary DOM walk.  Marker rules change paint only: sizing,
 * display, margins, overflow, direction, writing mode, zoom, transforms, and
 * clipping remain owned by Blink.
 *
 * Native scrollbars retain the native route by temporarily changing only the
 * standard `scrollbar-color` property.  Author WebKit scrollbars receive
 * color-only pseudo declarations.  If Chromium/OS paint cannot expose a fact
 * (notably a fully faded overlay, animator opacity, internal paint phase, or a
 * dynamic orientation/start/end pseudo winner), the record names that missing
 * fact and the renderer fails closed.  No scrollWidth/clientWidth thumb
 * estimator is permitted.
 *
 * Pinned ownership:
 * - paint_layer_scrollable_area.cc:1488-1528,1732-1848,2148-2180
 * - scrollable_area_painter.cc:176-260
 * - custom_scrollbar.cc:137-214,290-423
 * - scrollbar.cc:757-770,930-990
 */

import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import sharp from "sharp";

import type { ResolvedPseudoStyleCapture } from "./pseudo-style-cdp.js";
import type {
  CapturedElement,
  CapturedScrollbar,
  CapturedScrollbarPart,
  CapturedScrollbarPartKind,
  CapturedScrollbarPseudoStyle,
  CapturedScrollbarRect,
  CapturedScrollbarSet,
  CaptureWarning,
} from "./types.js";

export interface ScrollbarCaptureViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MarkerDefinition {
  kind: CapturedScrollbarPartKind;
  rgb: readonly [number, number, number];
}

export const SCROLLBAR_MARKERS: readonly MarkerDefinition[] = [
  { kind: "background", rgb: [251, 19, 113] },
  { kind: "track", rgb: [13, 227, 239] },
  { kind: "back-button", rgb: [251, 193, 17] },
  { kind: "forward-button", rgb: [127, 23, 251] },
  { kind: "back-track", rgb: [17, 241, 101] },
  { kind: "forward-track", rgb: [249, 113, 13] },
  { kind: "thumb", rgb: [23, 71, 239] },
  { kind: "corner", rgb: [17, 167, 71] },
] as const;

const MARKER_DISTANCE_SQUARED = 34 ** 2 * 3;
const REQUIRED_FACT_FEATURE = "scrollbar-capture";

interface BrowserCandidate {
  index: number;
  hostId?: string;
  selector: string;
  screenRect: CapturedScrollbarRect;
  outputRect: CapturedScrollbarRect;
  clipRect: CapturedScrollbarRect;
  hasOverflowControlsClip: boolean;
  clipExact: boolean;
  overflowX: string;
  overflowY: string;
  scrollbarWidth: string;
  scrollbarColor: string;
  scrollbarGutter: string;
  colorScheme: string;
  direction: string;
  writingMode: string;
  visibility: string;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  scrollLeft: number;
  scrollTop: number;
  layoutGutterVertical: number;
  layoutGutterHorizontal: number;
  effectiveZoom: number;
  devicePixelRatio: number;
  forcedColors: boolean;
  prefersDark: boolean;
  axisAlignedOutput: boolean;
  hostHovered: boolean;
  hostPressed: boolean;
  rootScroller: boolean;
}

interface MarkerComponent {
  kind: CapturedScrollbarPartKind;
  pixelRect: CapturedScrollbarRect;
  pixels: number;
}

interface ClassifiedComponent extends MarkerComponent {
  orientation: "horizontal" | "vertical" | "corner";
  rect: CapturedScrollbarRect;
}

interface PreparedScrollbarCapture {
  propertyKey: string;
  warnings: CaptureWarning[];
  dispose(): Promise<void>;
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function intersectRect(a: CapturedScrollbarRect, b: CapturedScrollbarRect): CapturedScrollbarRect | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function unionRects(rects: readonly CapturedScrollbarRect[]): CapturedScrollbarRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function parseStandardColors(value: string): { thumb: string; track: string } | null {
  if (value === "" || value === "auto") return null;
  const colors = value.match(/rgba?\([^)]*\)|#[\da-f]{3,8}|\b[a-z-]+\b/gi) ?? [];
  return colors.length >= 2 ? { thumb: colors[0]!, track: colors[1]! } : null;
}

/** Resolve the used scheme without treating the ordered `light dark` list as light-only. */
export function usedScrollbarColorScheme(
  computedColorScheme: string,
  prefersDark: boolean,
): "light" | "dark" {
  const schemes = new Set(computedColorScheme.toLowerCase().trim().split(/\s+/));
  const allowsLight = schemes.has("light");
  const allowsDark = schemes.has("dark");
  if (allowsDark && !allowsLight) return "dark";
  if (allowsDark && allowsLight && prefersDark) return "dark";
  return "light";
}

/** Decode reserved marker pixels into connected source-frame components. */
export function scrollbarMarkerComponents(
  rgba: Uint8Array,
  width: number,
  height: number,
  restrictTo?: CapturedScrollbarRect,
  baselineRgba?: Uint8Array,
): MarkerComponent[] {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) return [];
  const labels = new Uint8Array(width * height);
  const left = restrictTo == null ? 0 : Math.max(0, Math.floor(restrictTo.x));
  const top = restrictTo == null ? 0 : Math.max(0, Math.floor(restrictTo.y));
  const right = restrictTo == null ? width : Math.min(width, Math.ceil(restrictTo.x + restrictTo.width));
  const bottom = restrictTo == null ? height : Math.min(height, Math.ceil(restrictTo.y + restrictTo.height));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      const rgb = [rgba[offset], rgba[offset + 1], rgba[offset + 2]] as const;
      if (baselineRgba?.length === rgba.length) {
        const baseline = [baselineRgba[offset], baselineRgba[offset + 1], baselineRgba[offset + 2]] as const;
        if (squaredDistance(rgb, baseline) <= 6 ** 2 * 3) continue;
      }
      let best = Number.POSITIVE_INFINITY;
      let label = 0;
      for (let marker = 0; marker < SCROLLBAR_MARKERS.length; marker++) {
        const distance = squaredDistance(rgb, SCROLLBAR_MARKERS[marker].rgb);
        if (distance < best) {
          best = distance;
          label = marker + 1;
        }
      }
      if (best <= MARKER_DISTANCE_SQUARED) labels[pixel] = label;
    }
  }

  const seen = new Uint8Array(labels.length);
  const components: MarkerComponent[] = [];
  for (let start = 0; start < labels.length; start++) {
    const label = labels[start];
    if (label === 0 || seen[start] !== 0) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const pixel = queue[cursor];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels++;
      const neighbors = [pixel - 1, pixel + 1, pixel - width, pixel + width];
      for (const next of neighbors) {
        if (next < 0 || next >= labels.length || seen[next] !== 0 || labels[next] !== label) continue;
        if ((next === pixel - 1 || next === pixel + 1) && Math.floor(next / width) !== y) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    if (pixels < 2) continue;
    components.push({
      kind: SCROLLBAR_MARKERS[label - 1].kind,
      pixelRect: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      pixels,
    });
  }
  return components;
}

function classifyComponent(
  component: MarkerComponent,
  scaleX: number,
  scaleY: number,
  target: BrowserCandidate,
  viewport: ScrollbarCaptureViewport,
): ClassifiedComponent | null {
  const absolute = {
    x: component.pixelRect.x / scaleX,
    y: component.pixelRect.y / scaleY,
    width: component.pixelRect.width / scaleX,
    height: component.pixelRect.height / scaleY,
  };
  const rect = { ...absolute, x: absolute.x - viewport.x, y: absolute.y - viewport.y };
  if (component.kind === "corner") return { ...component, orientation: "corner", rect };

  const targetRect = target.screenRect;
  const centerX = absolute.x + absolute.width / 2;
  const centerY = absolute.y + absolute.height / 2;
  const distanceLeft = Math.abs(centerX - targetRect.x);
  const distanceRight = Math.abs(centerX - (targetRect.x + targetRect.width));
  const distanceBottom = Math.abs(centerY - (targetRect.y + targetRect.height));
  const verticalDistance = Math.min(distanceLeft, distanceRight);
  const aspectHorizontal = absolute.width > absolute.height * 1.2;
  const aspectVertical = absolute.height > absolute.width * 1.2;
  const orientation = aspectHorizontal && !aspectVertical
    ? "horizontal"
    : aspectVertical && !aspectHorizontal
      ? "vertical"
      : distanceBottom < verticalDistance ? "horizontal" : "vertical";
  const edgeDistance = orientation === "horizontal" ? distanceBottom : verticalDistance;
  const edgeLimit = Math.max(8, Math.min(targetRect.width, targetRect.height) / 3);
  if (edgeDistance > edgeLimit) return null;
  return { ...component, orientation, rect };
}

function finalStyleForPart(
  part: CapturedScrollbarPartKind,
  styles: Record<string, CapturedScrollbarPseudoStyle | undefined>,
): CapturedScrollbarPseudoStyle | undefined {
  if (part === "background") return styles.scrollbar;
  if (part === "back-button" || part === "forward-button") return styles["scrollbar-button"];
  if (part === "track") return styles["scrollbar-track"];
  if (part === "back-track" || part === "forward-track") return styles["scrollbar-track-piece"];
  if (part === "thumb") return styles["scrollbar-thumb"];
  if (part === "corner") return styles["scrollbar-corner"];
  return undefined;
}

function scrollbarForOrientation(
  orientation: "horizontal" | "vertical",
  candidate: BrowserCandidate,
  components: readonly ClassifiedComponent[],
  route: CapturedScrollbar["route"],
  styles: Record<string, CapturedScrollbarPseudoStyle | undefined>,
): CapturedScrollbar | null {
  const owned = components.filter((component) => component.orientation === orientation);
  if (owned.length === 0) return null;
  const backgroundRects = owned.filter(({ kind }) => kind === "background").map(({ rect }) => rect);
  const frameRect = unionRects(backgroundRects.length > 0 ? backgroundRects : owned.map(({ rect }) => rect));
  if (frameRect == null) return null;
  const parts: CapturedScrollbarPart[] = owned.map(({ kind, rect }) => ({
    kind,
    rect,
    finalPseudoStyle: finalStyleForPart(kind, styles),
  }));
  const missingFacts: string[] = [];
  if (backgroundRects.length === 0 && route === "native-raster") missingFacts.push("full-frame-rect");
  if (route === "native-raster") missingFacts.push("native-theme-part-rectangles", "animator-opacity");
  // CDP resolves unqualified scrollbar pseudos on the host, but Chromium does
  // not expose the anonymous orientation/start/end instances. Geometry stays
  // authoritative; DM-2482 must not vector-paint a dynamic-only winner until
  // an instrumented browser protocol supplies it.
  if (route === "author-custom") missingFacts.push("dynamic-scrollbar-pseudo-cascade");
  const hoveredPart = candidate.hostHovered ? "unknown" : null;
  const pressedPart = candidate.hostPressed ? "unknown" : null;
  if (hoveredPart === "unknown") missingFacts.push("hovered-part");
  if (pressedPart === "unknown") missingFacts.push("pressed-part");
  const layoutGutter = orientation === "horizontal"
    ? candidate.layoutGutterHorizontal
    : candidate.layoutGutterVertical;
  const isOverlay = route === "native-raster" && layoutGutter <= 0.5;
  if (isOverlay) missingFacts.push("overlay-hidden-state");
  const styleOpacity = Number.parseFloat(styles.scrollbar?.opacity ?? "1");
  return {
    orientation,
    route,
    frameRect,
    usedWidth: candidate.scrollbarWidth === "thin" ? "thin" : "auto",
    logicalSide: orientation === "horizontal"
      ? "bottom"
      : frameRect.x + frameRect.width / 2 < candidate.outputRect.x + candidate.outputRect.width / 2
        ? "left"
        : "right",
    visibleSize: orientation === "horizontal" ? candidate.clientWidth : candidate.clientHeight,
    totalSize: orientation === "horizontal" ? candidate.scrollWidth : candidate.scrollHeight,
    currentPosition: orientation === "horizontal" ? candidate.scrollLeft : candidate.scrollTop,
    enabled: orientation === "horizontal"
      ? candidate.scrollWidth > candidate.clientWidth
      : candidate.scrollHeight > candidate.clientHeight,
    hoveredPart,
    pressedPart,
    hiddenIfOverlay: isOverlay ? "unknown" : false,
    opacity: route === "author-custom" && Number.isFinite(styleOpacity) ? styleOpacity : null,
    usedColorScheme: usedScrollbarColorScheme(candidate.colorScheme, candidate.prefersDark),
    standardColors: parseStandardColors(candidate.scrollbarColor),
    parts,
    missingFacts: [...new Set(missingFacts)].sort(),
  };
}

function makeScrollbarSet(
  candidate: BrowserCandidate,
  route: CapturedScrollbar["route"],
  components: readonly ClassifiedComponent[],
  styles: Record<string, CapturedScrollbarPseudoStyle | undefined>,
): CapturedScrollbarSet {
  const hasForcedScrollbar = candidate.overflowX === "scroll" || candidate.overflowY === "scroll";
  const hasRange = candidate.scrollWidth > candidate.clientWidth || candidate.scrollHeight > candidate.clientHeight;
  const transformUnresolved = !candidate.axisAlignedOutput
    && candidate.scrollbarWidth !== "none"
    && (hasForcedScrollbar || hasRange);
  const ownedComponents = transformUnresolved ? [] : components;
  const horizontal = scrollbarForOrientation("horizontal", candidate, ownedComponents, route, styles);
  const vertical = scrollbarForOrientation("vertical", candidate, ownedComponents, route, styles);
  const cornerComponent = ownedComponents.find(({ orientation, kind }) => orientation === "corner" && kind === "corner");
  const corner = cornerComponent == null ? undefined : {
    kind: "corner" as const,
    rect: cornerComponent.rect,
    finalPseudoStyle: finalStyleForPart("corner", styles),
  };
  const missingFacts = [...new Set([
    ...(horizontal?.missingFacts ?? []),
    ...(vertical?.missingFacts ?? []),
    ...(!candidate.clipExact ? ["exact-overflow-controls-clip"] : []),
    ...(candidate.rootScroller ? ["visual-viewport-scrollbar-transform"] : []),
    ...(transformUnresolved ? ["scrollbar-axis-under-non-axis-aligned-transform"] : []),
  ])].sort();
  const hasBar = horizontal != null || vertical != null;
  const layoutGutter = Math.max(
    vertical == null ? 0 : candidate.layoutGutterVertical,
    horizontal == null ? 0 : candidate.layoutGutterHorizontal,
  );
  const overlay = !hasBar ? null : route === "author-custom" ? false : layoutGutter <= 0.5;
  if (overlay === true) missingFacts.push("overflow-controls-paint-phase");

  let status: CapturedScrollbarSet["status"];
  if (candidate.scrollbarWidth === "none") {
    status = "absent";
  } else if (transformUnresolved) {
    status = "unavailable";
  } else if (hasBar) {
    status = missingFacts.length === 0 ? "captured" : "partial";
  } else {
    const noHorizontalRange = candidate.scrollWidth <= candidate.clientWidth;
    const noVerticalRange = candidate.scrollHeight <= candidate.clientHeight;
    const autoOnly = candidate.overflowX !== "scroll" && candidate.overflowY !== "scroll";
    status = autoOnly && noHorizontalRange && noVerticalRange ? "absent" : "unavailable";
    if (status === "unavailable") {
      missingFacts.push("scrollbar-object-existence", "marker-paint");
    }
  }
  return {
    status,
    source: "blink-live-marker-probe-v1",
    rootScroller: candidate.rootScroller,
    horizontal: horizontal ?? undefined,
    vertical: vertical ?? undefined,
    corner,
    overlay,
    paintPhase: overlay === false ? "background" : overlay === true ? "unknown" : "unknown",
    overflowControlsClip: candidate.hasOverflowControlsClip ? {
      x: candidate.clipRect.x,
      y: candidate.clipRect.y,
      width: candidate.clipRect.width,
      height: candidate.clipRect.height,
    } : null,
    outputTransform: { space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] },
    effectiveZoom: candidate.effectiveZoom,
    captureDpr: candidate.devicePixelRatio,
    forcedColors: candidate.forcedColors,
    missingFacts: [...new Set(missingFacts)].sort(),
  };
}

function cssColor(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function customMarkerCss(attribute: string, token: string): string {
  const host = `[${attribute}="${token}"]`;
  const rule = (pseudo: string, marker: MarkerDefinition): string => {
    const color = cssColor(marker.rgb);
    return `${host}${pseudo}{background-color:${color}!important;background-image:linear-gradient(${color},${color})!important;box-shadow:inset 0 0 0 100vmax ${color}!important;border-color:${color}!important;border-radius:0!important;filter:none!important;}`;
  };
  const marker = (kind: CapturedScrollbarPartKind): MarkerDefinition => SCROLLBAR_MARKERS.find((entry) => entry.kind === kind)!;
  return [
    rule("::-webkit-scrollbar", marker("background")),
    rule("::-webkit-scrollbar-track", marker("track")),
    rule("::-webkit-scrollbar-button:decrement", marker("back-button")),
    rule("::-webkit-scrollbar-button:increment", marker("forward-button")),
    rule("::-webkit-scrollbar-track-piece:start", marker("back-track")),
    rule("::-webkit-scrollbar-track-piece:end", marker("forward-track")),
    rule("::-webkit-scrollbar-thumb", marker("thumb")),
    rule("::-webkit-scrollbar-corner", marker("corner")),
  ].join("\n");
}

async function restoreMarkerPaint(
  page: Page,
  args: { nodesKey: string; index: number; markerAttribute: string },
): Promise<void> {
  await page.evaluate(({ nodesKey, index, markerAttribute }) => {
    const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey] as Element[] | undefined;
    const element = nodes?.[index];
    const state = (globalThis as typeof globalThis & Record<string, unknown>)[`${nodesKey}_marker`] as {
      hadAttribute: boolean;
      attributeValue: string | null;
      scrollbarColor: string;
      scrollbarColorPriority: string;
      style: HTMLStyleElement | null;
    } | undefined;
    state?.style?.remove();
    if (element instanceof HTMLElement || element instanceof SVGElement) {
      if (state?.hadAttribute) element.setAttribute(markerAttribute, state.attributeValue ?? "");
      else element.removeAttribute(markerAttribute);
      const html = element as HTMLElement;
      if (state != null && state.scrollbarColor !== "") {
        html.style.setProperty("scrollbar-color", state.scrollbarColor, state.scrollbarColorPriority);
      } else {
        html.style.removeProperty("scrollbar-color");
      }
    }
    delete (globalThis as typeof globalThis & Record<string, unknown>)[`${nodesKey}_marker`];
  }, args).catch(() => undefined);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    .catch(() => undefined);
}

/** Attach source-owned sets as private element expandos for CAPTURE_SCRIPT. */
export async function prepareCapturedScrollbarSets(
  page: Page,
  selector: string,
  viewport: ScrollbarCaptureViewport,
  pseudoCapture: Pick<ResolvedPseudoStyleCapture, "propertyKey" | "stylesByHost">,
): Promise<PreparedScrollbarCapture> {
  const propertyKey = `__domotionCapturedScrollbars_${randomUUID().replaceAll("-", "")}`;
  const nodesKey = `${propertyKey}_nodes`;
  const markerAttribute = `data-${propertyKey.toLowerCase().replaceAll("_", "-")}`;
  let candidates: BrowserCandidate[];
  try {
    candidates = await page.evaluate(({ selector, viewport, nodesKey, pseudoKey }) => {
    const root = document.querySelector(selector);
    if (root == null) return [];
    const nodes: Element[] = [];
    const seen = new Set<Element>();
    const stack: Element[] = [root];
    if (document.scrollingElement != null && !root.contains(document.scrollingElement)) {
      stack.push(document.scrollingElement);
    }
    while (stack.length > 0) {
      const element = stack.pop()!;
      if (seen.has(element)) continue;
      seen.add(element);
      let style: CSSStyleDeclaration;
      try { style = getComputedStyle(element); } catch { continue; }
      const rootScroller = element === document.scrollingElement;
      const html = element as HTMLElement;
      const rootRange = rootScroller && (
        (style.overflowX !== "hidden" && style.overflowX !== "clip" && html.scrollWidth > html.clientWidth)
        || (style.overflowY !== "hidden" && style.overflowY !== "clip" && html.scrollHeight > html.clientHeight)
        || style.scrollbarGutter !== "auto"
      );
      if (["auto", "scroll"].includes(style.overflowX)
          || ["auto", "scroll"].includes(style.overflowY)
          || rootRange) nodes.push(element);
      for (const child of element.children) stack.push(child);
      if (element.shadowRoot != null) for (const child of element.shadowRoot.children) stack.push(child);
      // Same-origin iframe documents recurse through CAPTURE_SCRIPT with their
      // own viewport mapping. Do not attach main-frame screenshot coordinates
      // to those inner nodes; the walker emits an explicit correlation warning
      // until a frame-local marker surface is added.
    }
    (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey] = nodes;
    return nodes.map((element, index) => {
      const style = getComputedStyle(element);
      const rootScroller = element === document.scrollingElement;
      const measuredRect = element.getBoundingClientRect();
      const rect = rootScroller
        ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
        : measuredRect;
      let clip = { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height };
      let hasOverflowControlsClip = false;
      let clipExact = style.clipPath === "none" && style.maskImage === "none"
        && style.borderRadius === "0px";
      for (let ancestor = element.parentElement; ancestor != null; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        const clipsOverflow = [ancestorStyle.overflowX, ancestorStyle.overflowY]
          .some((value) => value !== "visible");
        if (ancestorStyle.clipPath !== "none" || ancestorStyle.maskImage !== "none"
            || (clipsOverflow && (ancestorStyle.transform !== "none" || ancestorStyle.borderRadius !== "0px"))) {
          clipExact = false;
        }
        if (clipsOverflow) {
          hasOverflowControlsClip = true;
          const ancestorRect = ancestor.getBoundingClientRect();
          const ancestorClip = {
            x: ancestorRect.x + ancestor.clientLeft,
            y: ancestorRect.y + ancestor.clientTop,
            width: ancestor.clientWidth,
            height: ancestor.clientHeight,
          };
          const left = Math.max(clip.x, ancestorClip.x);
          const top = Math.max(clip.y, ancestorClip.y);
          const right = Math.min(clip.x + clip.width, ancestorClip.x + ancestorClip.width);
          const bottom = Math.min(clip.y + clip.height, ancestorClip.y + ancestorClip.height);
          clip = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
        }
      }
      let zoom = 1;
      let axisAlignedOutput = true;
      for (let current: Element | null = element; current != null; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        const value = Number.parseFloat(currentStyle.zoom || "1");
        if (Number.isFinite(value) && value > 0) zoom *= value;
        if (currentStyle.transform !== "none") {
          try {
            const matrix = new DOMMatrixReadOnly(currentStyle.transform);
            if (!matrix.is2D || Math.abs(matrix.b) > 1e-7 || Math.abs(matrix.c) > 1e-7) {
              axisAlignedOutput = false;
            }
          } catch {
            axisAlignedOutput = false;
          }
        }
      }
      const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
      const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
      const layoutWidth = element instanceof HTMLElement ? element.offsetWidth : rect.width / zoom;
      const layoutHeight = element instanceof HTMLElement ? element.offsetHeight : rect.height / zoom;
      const selectorText = element.id !== ""
        ? `${element.localName}#${element.id}`
        : element.localName;
      return {
        index,
        hostId: pseudoKey === "" ? undefined : (element as Element & Record<string, string>)[pseudoKey],
        selector: selectorText,
        screenRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        outputRect: { x: rect.x - viewport.x, y: rect.y - viewport.y, width: rect.width, height: rect.height },
        clipRect: { x: clip.x - viewport.x, y: clip.y - viewport.y, width: clip.width, height: clip.height },
        hasOverflowControlsClip,
        clipExact,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollbarWidth: style.scrollbarWidth || "auto",
        scrollbarColor: style.scrollbarColor || "auto",
        scrollbarGutter: style.scrollbarGutter || "auto",
        colorScheme: style.colorScheme || "normal",
        direction: style.direction,
        writingMode: style.writingMode,
        visibility: style.visibility,
        scrollWidth: (element as HTMLElement).scrollWidth ?? 0,
        scrollHeight: (element as HTMLElement).scrollHeight ?? 0,
        clientWidth: (element as HTMLElement).clientWidth ?? 0,
        clientHeight: (element as HTMLElement).clientHeight ?? 0,
        scrollLeft: (element as HTMLElement).scrollLeft ?? 0,
        scrollTop: (element as HTMLElement).scrollTop ?? 0,
        layoutGutterVertical: Math.max(0, layoutWidth - (element as HTMLElement).clientWidth - borderLeft - borderRight),
        layoutGutterHorizontal: Math.max(0, layoutHeight - (element as HTMLElement).clientHeight - borderTop - borderBottom),
        effectiveZoom: zoom,
        devicePixelRatio: window.devicePixelRatio,
        forcedColors: matchMedia("(forced-colors: active)").matches,
        prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
        axisAlignedOutput,
        hostHovered: element.matches(":hover"),
        hostPressed: element.matches(":active"),
        rootScroller,
      };
    });
    }, { selector, viewport, nodesKey, pseudoKey: pseudoCapture.propertyKey }) as BrowserCandidate[];
  } catch (error) {
    return {
      propertyKey,
      warnings: [{
        selector,
        feature: REQUIRED_FACT_FEATURE,
        detail: `authoritative scrollbar discovery failed (${error instanceof Error ? error.message : String(error)}); legacy synthesis is disabled`,
      }],
      async dispose(): Promise<void> {},
    };
  }

  const warnings: CaptureWarning[] = [];
  const viewportSize = page.viewportSize();
  try {
    for (const candidate of candidates) {
      const hostStyles = candidate.hostId == null ? undefined : pseudoCapture.stylesByHost[candidate.hostId];
      const standardRoute = candidate.scrollbarWidth !== "auto" || candidate.scrollbarColor !== "auto";
      const hasAuthorWebKitScrollbar = Object.entries(hostStyles ?? {}).some(([kind, style]) => (
        kind.startsWith("scrollbar") && style?.matched === true
      ));
      const route: CapturedScrollbar["route"] = hasAuthorWebKitScrollbar && !standardRoute
        ? "author-custom"
        : "native-raster";
      if (candidate.scrollbarWidth === "none") {
        const record = makeScrollbarSet(candidate, route, [], {});
        await page.evaluate(({ nodesKey, index, propertyKey, record }) => {
          const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey] as Element[] | undefined;
          const element = nodes?.[index];
          if (element != null) Object.defineProperty(element, propertyKey, { value: record, configurable: true });
        }, { nodesKey, index: candidate.index, propertyKey, record });
        continue;
      }
      const baselinePng = await page.screenshot({ type: "png" });
      const token = `${candidate.index}-${randomUUID().replaceAll("-", "")}`;
      await page.evaluate(({
        nodesKey,
        index,
        markerAttribute,
        token,
        route,
        css,
        thumb,
        track,
        rootScroller,
        overflowX,
        overflowY,
      }) => {
        const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey] as Element[] | undefined;
        const element = nodes?.[index];
        if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
        const state = {
          hadAttribute: element.hasAttribute(markerAttribute),
          attributeValue: element.getAttribute(markerAttribute),
          scrollbarColor: (element as HTMLElement).style.getPropertyValue("scrollbar-color"),
          scrollbarColorPriority: (element as HTMLElement).style.getPropertyPriority("scrollbar-color"),
          style: null as HTMLStyleElement | null,
        };
        if (route === "author-custom") {
          element.setAttribute(markerAttribute, token);
          const style = element.ownerDocument.createElement("style");
          style.textContent = css;
          const owner = element.getRootNode();
          if (owner instanceof ShadowRoot) owner.append(style);
          else (element.ownerDocument.head ?? element.ownerDocument.documentElement).append(style);
          state.style = style;
        } else {
          (element as HTMLElement).style.setProperty("scrollbar-color", `${thumb} ${track}`, "important");
        }
        // Blink propagates `visible` root overflow to the viewport as used
        // `auto`, but a newly inserted root pseudo rule does not invalidate
        // that already-built scrollbar. Flip only those visible longhands to
        // their equivalent used value and restore them synchronously; the
        // measured animation frame therefore retains the source declarations.
        if (rootScroller) {
          const html = element as HTMLElement;
          const previousX = html.style.getPropertyValue("overflow-x");
          const previousXPriority = html.style.getPropertyPriority("overflow-x");
          const previousY = html.style.getPropertyValue("overflow-y");
          const previousYPriority = html.style.getPropertyPriority("overflow-y");
          try {
            if (overflowX === "visible") html.style.setProperty("overflow-x", "auto", "important");
            if (overflowY === "visible") html.style.setProperty("overflow-y", "auto", "important");
            void html.clientWidth;
          } finally {
            if (previousX !== "") html.style.setProperty("overflow-x", previousX, previousXPriority);
            else html.style.removeProperty("overflow-x");
            if (previousY !== "") html.style.setProperty("overflow-y", previousY, previousYPriority);
            else html.style.removeProperty("overflow-y");
            void html.clientWidth;
          }
        }
        (globalThis as typeof globalThis & Record<string, unknown>)[`${nodesKey}_marker`] = state;
      }, {
        nodesKey,
        index: candidate.index,
        markerAttribute,
        token,
        route,
        css: customMarkerCss(markerAttribute, token),
        thumb: cssColor(SCROLLBAR_MARKERS.find(({ kind }) => kind === "thumb")!.rgb),
        track: cssColor(SCROLLBAR_MARKERS.find(({ kind }) => kind === "track")!.rgb),
        rootScroller: candidate.rootScroller,
        overflowX: candidate.overflowX,
        overflowY: candidate.overflowY,
      });
      let components: ClassifiedComponent[] = [];
      try {
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const png = await page.screenshot({ type: "png" });
        const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const baseline = await sharp(baselinePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const surfaceWidth = viewportSize?.width ?? decoded.info.width / Math.max(1, candidate.devicePixelRatio);
        const surfaceHeight = viewportSize?.height ?? decoded.info.height / Math.max(1, candidate.devicePixelRatio);
        const scaleX = decoded.info.width / surfaceWidth;
        const scaleY = decoded.info.height / surfaceHeight;
        const restriction = {
          x: Math.max(0, candidate.screenRect.x * scaleX),
          y: Math.max(0, candidate.screenRect.y * scaleY),
          width: Math.max(0, candidate.screenRect.width * scaleX),
          height: Math.max(0, candidate.screenRect.height * scaleY),
        };
        components = scrollbarMarkerComponents(
          decoded.data,
          decoded.info.width,
          decoded.info.height,
          restriction,
          baseline.info.width === decoded.info.width && baseline.info.height === decoded.info.height
            ? baseline.data
            : undefined,
        ).map((component) => classifyComponent(component, scaleX, scaleY, candidate, viewport))
          .filter((component): component is ClassifiedComponent => component != null);
      } finally {
        await restoreMarkerPaint(page, { nodesKey, index: candidate.index, markerAttribute });
      }

      const styles = (hostStyles ?? {}) as Record<string, CapturedScrollbarPseudoStyle | undefined>;
      const record = makeScrollbarSet(candidate, route, components, styles);
      await page.evaluate(({ nodesKey, index, propertyKey, record }) => {
        const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey] as Element[] | undefined;
        const element = nodes?.[index];
        if (element == null) return;
        Object.defineProperty(element, propertyKey, { value: record, configurable: true });
      }, { nodesKey, index: candidate.index, propertyKey, record });
      if (record.status === "partial" || record.status === "unavailable") {
        warnings.push({
          selector: candidate.selector,
          feature: REQUIRED_FACT_FEATURE,
          detail: `authoritative scrollbar record is ${record.status}; missing ${record.missingFacts.join(", ") || "marker-owned geometry"}; legacy synthesis is disabled`,
        });
      }
    }
  } catch (error) {
    warnings.push({
      selector,
      feature: REQUIRED_FACT_FEATURE,
      detail: `authoritative scrollbar probe failed (${error instanceof Error ? error.message : String(error)}); legacy synthesis is disabled`,
    });
  }

  return {
    propertyKey,
    warnings,
    async dispose(): Promise<void> {
      await page.evaluate(({ nodesKey, propertyKey }) => {
        const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey] as Element[] | undefined;
        for (const element of nodes ?? []) {
          try { delete (element as Element & Record<string, unknown>)[propertyKey]; } catch { /* Detached node. */ }
        }
        delete (globalThis as typeof globalThis & Record<string, unknown>)[nodesKey];
        delete (globalThis as typeof globalThis & Record<string, unknown>)[`${nodesKey}_marker`];
      }, { nodesKey, propertyKey }).catch(() => undefined);
    },
  };
}

/** ScrollableAreaPainter paints the resizer after the corner. */
export function finalizeScrollbarResizerOverlap(elements: CapturedElement[]): void {
  const visit = (nodes: CapturedElement[]): void => {
    for (const element of nodes) {
      const set = element.scrollbars;
      const resize = element.resizeHandle;
      if (set != null && set.corner != null && resize != null) {
        const overlap = intersectRect(set.corner.rect, resize);
        if (overlap != null) {
          set.resizerOverlap = { rect: overlap, paintOrder: "corner-before-resizer" };
        }
      }
      visit(element.children ?? []);
    }
  };
  visit(elements);
}
