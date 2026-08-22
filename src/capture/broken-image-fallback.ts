/**
 * Chromium-owned broken-image fallback capture (DM-2463).
 *
 * Blink changes a failed HTMLImageElement from LayoutImage to a UA-shadow
 * LayoutBlockFlow. The closed tree is not visible to page JavaScript, so this
 * post-pass pierces it through CDP and attaches the used layout/text/AX facts
 * to the light-DOM image record produced by the synchronous capture bundle.
 */
import type { CDPSession, Page } from "@playwright/test";
import type {
  BrokenImageFallbackDisposition,
  CapturedBrokenImageFallback,
  CapturedBrokenImagePhysicalBox,
  CapturedBrokenImageQuad,
  CapturedElement,
  CaptureWarning,
  TextSegment,
} from "./types.js";
import { captureBrokenImageIconRaster } from "./broken-image-icon-raster.js";
import { resolveCharOrientation } from "./script/walker/text-segments.js";

const FEATURE = "broken-image-fallback";

interface CdpNode {
  nodeId?: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  shadowRootType?: string;
  shadowRoots?: CdpNode[];
  children?: CdpNode[];
}

interface SourceFacts {
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  currentSrc: string;
  src: { present: boolean; value: string | null };
  alt: { present: boolean; value: string | null };
  title: { present: boolean; value: string | null };
  resolvedText: string;
}

interface ProbeRecord extends Partial<CapturedBrokenImageFallback> {
  schemaVersion: 1;
  authority: "chromium-ua-shadow-v1";
  source: SourceFacts;
  sourceNodeIndex?: number;
  selector?: string;
  effectiveZoom?: number;
  hostRect?: { x: number; y: number; width: number; height: number };
}

interface TextProbe {
  text: string;
  style: CapturedBrokenImageFallback["text"] extends infer T
    ? T extends { style: infer S } ? S : never
    : never;
  metrics: {
    ascent: number;
    descent: number;
    actualAscent: number;
    actualDescent: number;
  };
  codepoints: Array<{
    text: string;
    start: number;
    end: number;
    rects: Array<{ x: number; y: number; width: number; height: number }>;
    naturalAdvance: number;
  }>;
}

function attributes(node: CdpNode): Record<string, string> {
  const result: Record<string, string> = {};
  const list = node.attributes ?? [];
  for (let index = 0; index + 1 < list.length; index += 2) result[list[index]] = list[index + 1];
  return result;
}

function descendants(node: CdpNode): CdpNode[] {
  const result: CdpNode[] = [];
  const visit = (current: CdpNode): void => {
    result.push(current);
    for (const child of current.shadowRoots ?? []) visit(child);
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return result;
}

function childById(root: CdpNode, id: string): CdpNode | null {
  return descendants(root).find((node) => attributes(node).id === id) ?? null;
}

function textDescendant(root: CdpNode): CdpNode | null {
  return descendants(root).find((node) => node.nodeType === 3) ?? null;
}

function finiteQuad(values: readonly number[] | undefined): values is CapturedBrokenImageQuad {
  return values?.length === 8 && values.every(Number.isFinite);
}

function localizeQuad(
  values: readonly number[],
  viewport: { x: number; y: number },
): CapturedBrokenImageQuad {
  return values.map((value, index) => value - (index % 2 === 0 ? viewport.x : viewport.y)) as CapturedBrokenImageQuad;
}

function quadRect(quad: CapturedBrokenImageQuad): { x: number; y: number; width: number; height: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function rectQuad(rect: { x: number; y: number; width: number; height: number }): CapturedBrokenImageQuad {
  return [
    rect.x, rect.y,
    rect.x + rect.width, rect.y,
    rect.x + rect.width, rect.y + rect.height,
    rect.x, rect.y + rect.height,
  ];
}

function boxFromRect(rect: { x: number; y: number; width: number; height: number }): CapturedBrokenImagePhysicalBox {
  const quad = rectQuad(rect);
  return { rect, content: quad, padding: quad, border: quad, margin: quad };
}

async function readBox(
  session: CDPSession,
  backendNodeId: number,
  viewport: { x: number; y: number },
): Promise<CapturedBrokenImagePhysicalBox | null> {
  try {
    const { model } = await session.send("DOM.getBoxModel", { backendNodeId });
    if (!finiteQuad(model.content) || !finiteQuad(model.padding)
        || !finiteQuad(model.border) || !finiteQuad(model.margin)) return null;
    const content = localizeQuad(model.content, viewport);
    const padding = localizeQuad(model.padding, viewport);
    const border = localizeQuad(model.border, viewport);
    const margin = localizeQuad(model.margin, viewport);
    return { rect: quadRect(border), content, padding, border, margin };
  } catch {
    return null;
  }
}

async function frontendNodeId(session: CDPSession, node: CdpNode): Promise<number> {
  if (node.nodeId != null && node.nodeId !== 0) return node.nodeId;
  const pushed = await session.send("DOM.pushNodesByBackendIdsToFrontend", {
    backendNodeIds: [node.backendNodeId],
  });
  const nodeId = pushed.nodeIds[0];
  if (nodeId == null || nodeId === 0) throw new Error(`could not push backend node ${node.backendNodeId}`);
  return nodeId;
}

async function computedStyle(session: CDPSession, node: CdpNode): Promise<Record<string, string>> {
  const nodeId = await frontendNodeId(session, node);
  const response = await session.send("CSS.getComputedStyleForNode", { nodeId });
  return Object.fromEntries(response.computedStyle.map(({ name, value }) => [name, value]));
}

function numberStyle(style: Record<string, string>, property: string): number {
  const value = Number.parseFloat(style[property] ?? "");
  return Number.isFinite(value) ? value : 0;
}

function loadState(source: SourceFacts): CapturedBrokenImageFallback["loadState"] {
  if (!source.src.present) return "no-source";
  if (!source.complete) return "loading";
  if (source.naturalWidth > 0 && source.naturalHeight > 0) return "loaded";
  return "failed";
}

export function classifyBrokenImageDisposition(input: {
  source: SourceFacts;
  uaShadowPresent: boolean;
  containerDisplay?: string;
  iconVisible?: boolean;
}): BrokenImageFallbackDisposition {
  if (!input.uaShadowPresent) {
    if (!input.source.complete) return "loading";
    if (input.source.naturalWidth > 0 || !input.source.src.present) return "primary";
    return "collapsed";
  }
  if (input.containerDisplay === "flow-root") return "replaced-flow-root-fallback";
  if (input.iconVisible === false && input.source.resolvedText === "") return "empty-inline";
  return "non-replaced-fallback";
}

function textBounds(codepoints: TextProbe["codepoints"]): { x: number; y: number; width: number; height: number } | null {
  const rects = codepoints.flatMap((point) => point.rects).filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function buildTextSegments(probe: TextProbe): TextSegment[] {
  const vertical = /^(?:vertical|sideways)-/.test(probe.style.writingMode);
  const placed = probe.codepoints
    .map((point) => ({ point, rect: point.rects.find((rect) => rect.width > 0 || rect.height > 0) }))
    .filter((entry): entry is { point: TextProbe["codepoints"][number]; rect: { x: number; y: number; width: number; height: number } } => entry.rect != null);
  if (placed.length === 0) return [];
  const groups: typeof placed[] = [];
  for (const entry of placed) {
    const coordinate = vertical ? entry.rect.x : entry.rect.y;
    let group = groups.find((candidate) => {
      const first = candidate[0].rect;
      return Math.abs(coordinate - (vertical ? first.x : first.y)) <= 1;
    });
    if (group == null) {
      group = [];
      groups.push(group);
    }
    group.push(entry);
  }
  return groups.map((group) => {
    const x = Math.min(...group.map(({ rect }) => rect.x));
    const y = Math.min(...group.map(({ rect }) => rect.y));
    const right = Math.max(...group.map(({ rect }) => rect.x + rect.width));
    const bottom = Math.max(...group.map(({ rect }) => rect.y + rect.height));
    const text = group.map(({ point }) => point.text).join("");
    const xOffsets: number[] = [];
    const yOffsets: number[] = [];
    const verticalAdvances: number[] = [];
    const verticalNaturalWidths: number[] = [];
    const verticalOrientations: Array<"upright" | "rotated"> = [];
    for (const { point, rect } of group) {
      const effectiveOrientation = /^(?:sideways)-/.test(probe.style.writingMode)
        ? "sideways"
        : probe.style.textOrientation;
      const orientation = resolveCharOrientation(point.text, effectiveOrientation) as "upright" | "rotated";
      for (let offset = point.start; offset < point.end; offset++) {
        xOffsets.push(rect.x);
        yOffsets.push(rect.y);
        verticalAdvances.push(rect.height);
        verticalNaturalWidths.push(point.naturalAdvance);
        verticalOrientations.push(orientation);
      }
    }
    const sidewaysLr = probe.style.writingMode === "sideways-lr";
    const baseline = !vertical
      ? y + probe.metrics.ascent
      : sidewaysLr ? x + probe.metrics.ascent : right - probe.metrics.ascent;
    return {
      text,
      sourceText: text,
      x,
      y,
      width: right - x,
      height: bottom - y,
      shapedWidth: vertical ? bottom - y : right - x,
      baseline,
      inlineOffset: vertical ? y : x,
      color: probe.style.color,
      fontFamily: probe.style.fontFamily,
      fontSize: probe.style.fontSize,
      fontStyle: probe.style.fontStyle,
      fontWeight: probe.style.fontWeight,
      fontVariant: probe.style.fontVariant,
      fontAscent: probe.metrics.ascent,
      ...(vertical ? {
        verticalWritingMode: probe.style.writingMode,
        verticalOrientations,
        yOffsets,
        verticalAdvances,
        verticalNaturalWidths,
      } : { xOffsets }),
    } satisfies TextSegment;
  });
}

async function readTextProbe(
  session: CDPSession,
  node: CdpNode,
  viewport: { x: number; y: number },
): Promise<TextProbe> {
  const resolved = await session.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
  const objectId = resolved.object.objectId;
  if (objectId == null) throw new Error("hidden alternative-text node could not be resolved");
  try {
    const response = await session.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const text = this.textContent || "";
        const owner = this.parentElement;
        if (!owner) throw new Error("alternative-text node is detached");
        const style = getComputedStyle(owner);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D text metrics unavailable");
        context.font = (style.fontStyle || "normal") + " "
          + (style.fontWeight || "400") + " " + style.fontSize + " " + style.fontFamily;
        const metrics = context.measureText("Mxgp");
        const codepoints = [];
        for (let start = 0; start < text.length;) {
          const codepoint = text.codePointAt(start);
          const chunk = String.fromCodePoint(codepoint);
          const end = start + chunk.length;
          const range = document.createRange();
          range.setStart(this, start);
          range.setEnd(this, end);
          const rects = Array.from(range.getClientRects(), rect => ({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          }));
          codepoints.push({ text: chunk, start, end, rects, naturalAdvance: context.measureText(chunk).width });
          start = end;
        }
        return {
          text,
          style: {
            color: style.color,
            fontFamily: style.fontFamily,
            fontSize: parseFloat(style.fontSize),
            fontStyle: style.fontStyle,
            fontWeight: style.fontWeight,
            fontStretch: style.fontStretch,
            fontVariant: style.fontVariant,
            fontFeatureSettings: style.fontFeatureSettings,
            fontVariationSettings: style.fontVariationSettings,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
            textTransform: style.textTransform,
            whiteSpace: style.whiteSpace,
            direction: style.direction,
            writingMode: style.writingMode,
            textOrientation: style.textOrientation,
          },
          metrics: {
            ascent: metrics.fontBoundingBoxAscent,
            descent: metrics.fontBoundingBoxDescent,
            actualAscent: metrics.actualBoundingBoxAscent,
            actualDescent: metrics.actualBoundingBoxDescent,
          },
          codepoints,
        };
      }`,
    });
    if (response.exceptionDetails != null) throw new Error(response.exceptionDetails.text);
    const value = response.result.value as TextProbe | undefined;
    if (value == null || value.text == null) throw new Error("hidden alternative-text metrics were unavailable");
    for (const key of ["ascent", "descent", "actualAscent", "actualDescent"] as const) {
      if (!Number.isFinite(value.metrics[key])) throw new Error(`alternative-text ${key} was unavailable`);
    }
    value.codepoints = value.codepoints.map((point) => ({
      ...point,
      rects: point.rects.map((rect) => ({ ...rect, x: rect.x - viewport.x, y: rect.y - viewport.y })),
    }));
    return value;
  } finally {
    await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function readTextQuads(
  session: CDPSession,
  node: CdpNode,
  viewport: { x: number; y: number },
): Promise<CapturedBrokenImageQuad[]> {
  try {
    const response = await session.send("DOM.getContentQuads", { backendNodeId: node.backendNodeId });
    return response.quads.filter(finiteQuad).map((quad) => localizeQuad(quad, viewport));
  } catch {
    return [];
  }
}

async function readPlatformFonts(session: CDPSession, node: CdpNode): Promise<Array<{
  familyName: string;
  postScriptName: string;
  isCustomFont: boolean;
  glyphCount: number;
}>> {
  try {
    const nodeId = await frontendNodeId(session, node);
    const response = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return response.fonts.map((font) => ({
      familyName: font.familyName,
      postScriptName: font.postScriptName,
      isCustomFont: font.isCustomFont,
      glyphCount: font.glyphCount,
    }));
  } catch {
    return [];
  }
}

async function readAccessibility(session: CDPSession, backendNodeId: number): Promise<CapturedBrokenImageFallback["accessibility"]> {
  try {
    const response = await session.send("Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: false,
    });
    const node = response.nodes[0];
    if (node == null) return { unavailableReason: "Chromium returned no AX node" };
    const stringValue = (value: { value?: unknown } | undefined): string | null =>
      typeof value?.value === "string" ? value.value : null;
    return {
      ignored: node.ignored,
      role: stringValue(node.role),
      name: stringValue(node.name),
      description: stringValue(node.description),
    };
  } catch (error) {
    return { unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

function warningFor(target: CapturedElement, probe: ProbeRecord, warnings: CaptureWarning[], reason: string): void {
  const selector = probe.selector ?? "img";
  if (!warnings.some((warning) => warning.feature === FEATURE && warning.selector === selector)) {
    warnings.push({ selector, feature: FEATURE, detail: `${reason}; terminal Chromium raster required` });
  }
  const hostRect = probe.hostRect ?? { x: target.x, y: target.y, width: target.width, height: target.height };
  target.brokenImageFallback = {
    schemaVersion: 1,
    authority: "chromium-ua-shadow-v1",
    disposition: classifyBrokenImageDisposition({ source: probe.source, uaShadowPresent: false }),
    captureStatus: "terminal-raster",
    paintOwnership: "terminal-raster",
    loadState: loadState(probe.source),
    source: probe.source,
    hostBox: boxFromRect(hostRect),
    accessibility: { unavailableReason: reason },
    terminalRaster: { rect: hostRect, reason },
  };
}

/**
 * Enrich every live `<img>` record with Chromium UA-shadow fallback facts.
 * The source-node registry is shared with the projective/control post-passes
 * and remains live only until this function returns.
 */
export async function captureBrokenImageFallbackFacts(
  page: Page,
  elements: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
  warnings: CaptureWarning[],
  sourceNodeKey?: string,
): Promise<void> {
  const targets: Array<{ element: CapturedElement; probe: ProbeRecord }> = [];
  const visit = (nodes: CapturedElement[]): void => {
    for (const element of nodes) {
      if (element.tag === "img" && element.brokenImageFallback != null) {
        targets.push({ element, probe: element.brokenImageFallback as unknown as ProbeRecord });
      }
      visit(element.children ?? []);
    }
  };
  visit(elements);
  if (targets.length === 0) return;
  if (sourceNodeKey == null) {
    for (const target of targets) warningFor(target.element, target.probe, warnings, "live image-node registry unavailable");
    return;
  }

  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    await Promise.all([
      session.send("DOM.enable"),
      session.send("Runtime.enable"),
      session.send("CSS.enable"),
      session.send("Accessibility.enable"),
    ]);
    // CDP requires a frontend document to exist before backend UA-shadow ids
    // can be pushed for computed-style/font queries.
    await session.send("DOM.getDocument", { depth: 0, pierce: true });
    for (const target of targets) {
      const sourceNodeIndex = target.probe.sourceNodeIndex;
      if (sourceNodeIndex == null) {
        warningFor(target.element, target.probe, warnings, "image source-node correlation missing");
        continue;
      }
      let objectId: string | undefined;
      try {
        const evaluated = await session.send("Runtime.evaluate", {
          expression: `globalThis[${JSON.stringify(sourceNodeKey)}]?.[${sourceNodeIndex}]`,
          returnByValue: false,
          silent: true,
        });
        objectId = evaluated.result.objectId;
        if (objectId == null) throw new Error("image source node detached");
        const described = await session.send("DOM.describeNode", {
          objectId,
          depth: -1,
          pierce: true,
        });
        const host = described.node as unknown as CdpNode;
        const shadow = (host.shadowRoots ?? []).find((root) => root.shadowRootType === "user-agent") ?? null;
        const hostBox = await readBox(session, host.backendNodeId, viewport)
          ?? (target.probe.hostRect != null ? boxFromRect(target.probe.hostRect) : null);
        const accessibility = await readAccessibility(session, host.backendNodeId);
        if (shadow == null) {
          const disposition = classifyBrokenImageDisposition({ source: target.probe.source, uaShadowPresent: false });
          target.element.brokenImageFallback = {
            schemaVersion: 1,
            authority: "chromium-ua-shadow-v1",
            disposition,
            captureStatus: "exact",
            paintOwnership: "none",
            loadState: loadState(target.probe.source),
            source: target.probe.source,
            hostBox,
            accessibility,
          };
          continue;
        }

        const containerNode = childById(shadow, "alttext-container");
        const iconNode = childById(shadow, "alttext-image");
        const textHostNode = childById(shadow, "alttext");
        if (containerNode == null || iconNode == null || textHostNode == null) {
          throw new Error("pierced UA fallback tree was missing a required owner");
        }
        const [containerStyle, iconStyle, containerBox, iconBox] = await Promise.all([
          computedStyle(session, containerNode),
          computedStyle(session, iconNode),
          readBox(session, containerNode.backendNodeId, viewport),
          readBox(session, iconNode.backendNodeId, viewport),
        ]);
        const iconVisible = iconStyle.display !== "none" && iconBox != null
          && iconBox.rect.width > 0 && iconBox.rect.height > 0;
        const disposition = classifyBrokenImageDisposition({
          source: target.probe.source,
          uaShadowPresent: true,
          containerDisplay: containerStyle.display,
          iconVisible,
        });

        let text: CapturedBrokenImageFallback["text"] | undefined;
        const textNode = textDescendant(textHostNode);
        if (target.probe.source.resolvedText !== "") {
          if (textNode == null) throw new Error("resolved alternative text had no pierced Text node");
          const [probe, quads, resolvedFonts] = await Promise.all([
            readTextProbe(session, textNode, viewport),
            readTextQuads(session, textNode, viewport),
            readPlatformFonts(session, textHostNode),
          ]);
          if (probe.text !== target.probe.source.resolvedText) {
            throw new Error("pierced alternative text disagreed with HTMLImageElement::AltText");
          }
          text = {
            value: probe.text,
            box: textBounds(probe.codepoints),
            quads,
            codepoints: probe.codepoints,
            segments: buildTextSegments(probe),
            style: probe.style,
            fontMetrics: probe.metrics,
            resolvedFonts,
          };
        }

        const border = {
          top: numberStyle(containerStyle, "border-top-width"),
          right: numberStyle(containerStyle, "border-right-width"),
          bottom: numberStyle(containerStyle, "border-bottom-width"),
          left: numberStyle(containerStyle, "border-left-width"),
          topStyle: containerStyle["border-top-style"] ?? "none",
          rightStyle: containerStyle["border-right-style"] ?? "none",
          bottomStyle: containerStyle["border-bottom-style"] ?? "none",
          leftStyle: containerStyle["border-left-style"] ?? "none",
          topColor: containerStyle["border-top-color"] ?? "rgba(0, 0, 0, 0)",
          rightColor: containerStyle["border-right-color"] ?? "rgba(0, 0, 0, 0)",
          bottomColor: containerStyle["border-bottom-color"] ?? "rgba(0, 0, 0, 0)",
          leftColor: containerStyle["border-left-color"] ?? "rgba(0, 0, 0, 0)",
        };
        const padding = {
          top: numberStyle(containerStyle, "padding-top"),
          right: numberStyle(containerStyle, "padding-right"),
          bottom: numberStyle(containerStyle, "padding-bottom"),
          left: numberStyle(containerStyle, "padding-left"),
        };
        const iconRaster = iconVisible ? await captureBrokenImageIconRaster(page, session, {
          sourceNodeKey,
          sourceNodeIndex,
          iconBackendNodeId: iconNode.backendNodeId,
          iconRect: iconBox!.rect,
          viewport,
        }) : undefined;
        const record: CapturedBrokenImageFallback = {
          schemaVersion: 1,
          authority: "chromium-ua-shadow-v1",
          disposition,
          captureStatus: "exact",
          paintOwnership: iconVisible || text != null ? "hybrid-icon-raster-vector-text" : "none",
          loadState: loadState(target.probe.source),
          source: target.probe.source,
          hostBox,
          container: {
            box: containerBox,
            display: containerStyle.display ?? "",
            float: containerStyle.float ?? "none",
            overflowX: containerStyle["overflow-x"] ?? "visible",
            overflowY: containerStyle["overflow-y"] ?? "visible",
            overflowClip: /^(?:hidden|clip|scroll|auto)$/.test(containerStyle["overflow-x"] ?? "")
              || /^(?:hidden|clip|scroll|auto)$/.test(containerStyle["overflow-y"] ?? "")
              ? containerBox?.padding ?? null : null,
            direction: containerStyle.direction ?? "ltr",
            writingMode: containerStyle["writing-mode"] ?? "horizontal-tb",
            effectiveZoom: target.probe.effectiveZoom
              ?? (numberStyle(containerStyle, "zoom") || 1),
            border,
            padding,
          },
          icon: {
            box: iconBox,
            display: iconStyle.display ?? "none",
            float: iconStyle.float ?? "none",
            visible: iconVisible,
            cssWidth: numberStyle(iconStyle, "width"),
            cssHeight: numberStyle(iconStyle, "height"),
            devicePixelRatio: await page.evaluate(() => devicePixelRatio),
            resourceScale: await page.evaluate(() => devicePixelRatio >= 2 ? 2 as const : 1 as const),
            raster: iconRaster,
          },
          text,
          accessibility,
        };
        if ("unavailableReason" in accessibility) {
          throw new Error(`accessibility semantics unavailable: ${accessibility.unavailableReason}`);
        }
        target.element.brokenImageFallback = record;
      } catch (error) {
        warningFor(
          target.element,
          target.probe,
          warnings,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const target of targets) {
      if (target.element.brokenImageFallback?.captureStatus !== "exact") {
        warningFor(target.element, target.probe, warnings, reason);
      }
    }
  } finally {
    await session?.detach().catch(() => undefined);
  }
}
