/**
 * Source-owned Chromium generated-pseudo fragment capture (DM-2467/DM-2459).
 *
 * A private per-frame registry retains candidate hosts without author-visible
 * ids. One DOMSnapshot epoch supplies every anonymous layout/text row; the
 * pseudo backend node supplies ordered physical box quads. The pure decoder is
 * shared with the DM-2466 oracle. Any unavailable or ambiguous row is replaced
 * by an isolated Chromium-painted pseudo surface, never by a cloned layout.
 */

import type { CDPSession, Frame, Page } from "@playwright/test";
import sharp from "sharp";

import {
  decodePseudoFragmentProtocol,
  type PhysicalEdges,
  type PseudoProtocolStyle,
  type Quad,
  type Rect,
  type SnapshotLayoutRow,
  type WritingMode,
} from "./pseudo-fragment-protocol.js";
import type {
  CapturedPseudoFragmentSet,
  CapturedPseudoPaintStyle,
  CapturedPseudoTypography,
  CaptureWarning,
} from "./types.js";

type PseudoName = "checkmark" | "before" | "after";

interface CandidateStyle {
  writingMode: string;
  direction: string;
  boxDecorationBreak: string;
  border: PhysicalEdges;
  padding: PhysicalEdges;
  margin: PhysicalEdges;
  typography: CapturedPseudoTypography;
  paint: CapturedPseudoPaintStyle;
  contentUrls: string[];
}

interface Candidate {
  frame: Frame;
  token: string;
  elementIndex: number;
  pseudo: PseudoName;
  correlationId: string;
  selector: string;
  style: CandidateStyle;
  backendNodeId?: number;
}

interface PreparedFrame {
  frame: Frame;
  token: string;
  candidates: Candidate[];
}

interface CdpNode {
  nodeId: number;
  backendNodeId: number;
  pseudoType?: string;
  pseudoElements?: CdpNode[];
}

interface SnapshotDocument {
  nodes: { backendNodeId?: number[] };
  layout: { nodeIndex: number[]; bounds: number[][]; text: number[] };
  textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] };
}

interface SnapshotResult {
  documents: SnapshotDocument[];
  strings: string[];
}

export interface PseudoFragmentProbe {
  key: string;
  warnings: CaptureWarning[];
  dispose(): Promise<void>;
}

const FEATURE = "generated-pseudo-fragment-geometry";

/**
 * tsx/esbuild's keep-names transform inserts a free `__name` call inside a
 * function serialized by Playwright. Browser globals do not normally carry
 * that helper. Install the identity helper only for this prepass and remove it
 * afterward; Vitest's transform does not need it, while the shipped `tsx`
 * oracle/CLI route does.
 */
async function installEvaluateNameShim(frames: readonly Frame[]): Promise<Frame[]> {
  const installed: Frame[] = [];
  for (const frame of frames) {
    const didInstall = await frame.evaluate(`(() => {
      if (typeof globalThis.__name === "function") return false;
      globalThis.__name = function(value) { return value; };
      return true;
    })()`).catch(() => false);
    if (didInstall) installed.push(frame);
  }
  return installed;
}

async function removeEvaluateNameShim(frames: readonly Frame[]): Promise<void> {
  await Promise.all(frames.map((frame) => frame.evaluate(`delete globalThis.__name`).catch(() => undefined)));
}

function numeric(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeWritingMode(value: string): WritingMode {
  if (value === "vertical-rl" || value === "vertical-lr" || value === "sideways-rl" || value === "sideways-lr") return value;
  return "horizontal-tb";
}

function rect(values: readonly number[]): Rect {
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function quad(values: readonly number[], viewport: { x: number; y: number }): Quad {
  if (values.length !== 8 || !values.every(Number.isFinite)) throw new Error("invalid pseudo content quad");
  return [
    { x: values[0] - viewport.x, y: values[1] - viewport.y },
    { x: values[2] - viewport.x, y: values[3] - viewport.y },
    { x: values[4] - viewport.x, y: values[5] - viewport.y },
    { x: values[6] - viewport.x, y: values[7] - viewport.y },
  ];
}

function protocolStyle(style: CandidateStyle): PseudoProtocolStyle {
  return {
    writingMode: normalizeWritingMode(style.writingMode),
    direction: style.direction === "rtl" ? "rtl" : "ltr",
    boxDecorationBreak: style.boxDecorationBreak === "clone" ? "clone" : "slice",
    border: style.border,
    padding: style.padding,
    margin: style.margin,
    primaryFontAscent: style.typography.primaryFontAscent,
    fontSize: style.typography.paintFontSize,
    lineHeight: style.typography.lineHeight,
  };
}

async function setupFrame(
  frame: Frame,
  selector: string,
  key: string,
  token: string,
  top: boolean,
): Promise<PreparedFrame | null> {
  try {
    const raw = await frame.evaluate(({ selector, key, token, top }) => {
      const root = top ? document.querySelector(selector) : document.documentElement;
      if (root == null) return [];
      const elements = [root, ...Array.from(root.querySelectorAll("*"))];
      const indexByElement = new WeakMap<Element, number>();
      for (let index = 0; index < elements.length; index++) indexByElement.set(elements[index], index);
      const rows: Array<{
        elementIndex: number;
        pseudo: PseudoName;
        correlationId: string;
        selector: string;
        style: CandidateStyle;
      }> = [];
      function number(value: string): number {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      function edge(style: CSSStyleDeclaration, prefix: "border" | "padding" | "margin", side: "Top" | "Right" | "Bottom" | "Left"): number {
        const property = prefix === "border" ? `${prefix}${side}Width` : `${prefix}${side}`;
        return number(style[property as keyof CSSStyleDeclaration] as string);
      }
      function cssUrls(content: string): string[] {
        const output: string[] = [];
        const expression = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(content)) != null) {
          const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
          try { output.push(new URL(value, document.baseURI).href); } catch { output.push(value); }
        }
        return output;
      }
      function shortSelector(element: Element): string {
        if (element.id !== "") return `#${CSS.escape(element.id)}`;
        const marker = element.getAttribute("data-testid") ?? element.getAttribute("data-test");
        return marker == null ? element.localName : `${element.localName}[data-test="${marker}"]`;
      }
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
        const element = elements[elementIndex];
        // Blink attaches kPseudoIdCheckMark before kPseudoIdBefore. Preserve
        // that order so appearance:base checkbox/radio indicators enter the
        // same generated-child paint slot ahead of an authored ::before.
        for (const pseudo of ["checkmark", "before", "after"] as const) {
          const style = getComputedStyle(element, `::${pseudo}`);
          if (style.content === "none" || style.content === "normal" || style.display === "none") continue;
          let zoom = 1;
          for (let owner: Element | null = element; owner != null; owner = owner.parentElement) {
            const own = number(getComputedStyle(owner).zoom);
            if (own > 0) zoom *= own;
          }
          const paintFontSize = number(style.fontSize) * zoom;
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (context == null) continue;
          // Canvas's `font` parser still rejects the CSS Fonts 4 stretch slot
          // in Chromium. An invalid shorthand silently leaves the 10px
          // sans-serif default active, halving advances/ascent and poisoning
          // every retained baseline. Set the accepted core shorthand first,
          // then the extended TextDrawingStyles longhands when available.
          context.font = `${style.fontStyle} ${style.fontWeight} ${paintFontSize}px ${style.fontFamily}`;
          const drawing = context as unknown as {
            fontStretch?: string; fontKerning?: string; fontVariantCaps?: string;
            letterSpacing?: string; wordSpacing?: string;
          };
          if ("fontStretch" in drawing) drawing.fontStretch = style.fontStretch;
          if ("fontKerning" in drawing) drawing.fontKerning = style.fontKerning;
          if ("fontVariantCaps" in drawing) drawing.fontVariantCaps = style.fontVariantCaps;
          if ("letterSpacing" in drawing && style.letterSpacing !== "normal") drawing.letterSpacing = `${number(style.letterSpacing) * zoom}px`;
          if ("wordSpacing" in drawing && style.wordSpacing !== "normal") drawing.wordSpacing = `${number(style.wordSpacing) * zoom}px`;
          context.direction = style.direction === "rtl" ? "rtl" : "ltr";
          const metrics = context.measureText("Hg");
          const lineHeight = style.lineHeight === "normal" ? "normal" as const : number(style.lineHeight) * zoom;
          const zIndex = Number.parseInt(style.zIndex, 10);
          rows.push({
            elementIndex,
            pseudo,
            correlationId: `${token}:${elementIndex}:${pseudo}`,
            selector: `${shortSelector(element)}::${pseudo}`,
            style: {
              writingMode: style.writingMode,
              direction: style.direction,
              boxDecorationBreak: style.getPropertyValue("box-decoration-break") || style.getPropertyValue("-webkit-box-decoration-break"),
              border: { top: edge(style, "border", "Top") * zoom, right: edge(style, "border", "Right") * zoom, bottom: edge(style, "border", "Bottom") * zoom, left: edge(style, "border", "Left") * zoom },
              padding: { top: edge(style, "padding", "Top") * zoom, right: edge(style, "padding", "Right") * zoom, bottom: edge(style, "padding", "Bottom") * zoom, left: edge(style, "padding", "Left") * zoom },
              margin: { top: edge(style, "margin", "Top") * zoom, right: edge(style, "margin", "Right") * zoom, bottom: edge(style, "margin", "Bottom") * zoom, left: edge(style, "margin", "Left") * zoom },
              typography: {
                fontFamily: style.fontFamily,
                fontSize: number(style.fontSize),
                paintFontSize,
                fontWeight: style.fontWeight,
                fontStyle: style.fontStyle,
                fontStretch: style.fontStretch,
                fontVariant: style.fontVariant,
                fontFeatureSettings: style.fontFeatureSettings,
                fontVariationSettings: style.fontVariationSettings,
                fontKerning: style.fontKerning,
                lineHeight,
                letterSpacing: style.letterSpacing,
                wordSpacing: style.wordSpacing,
                textOrientation: style.textOrientation,
                whiteSpace: style.whiteSpace,
                language: element.closest("[lang]")?.getAttribute("lang") ?? document.documentElement.lang ?? "",
                effectiveZoom: zoom,
                primaryFontAscent: metrics.fontBoundingBoxAscent,
                primaryFontDescent: metrics.fontBoundingBoxDescent,
                resolvedFonts: [],
              },
              paint: {
                visibility: style.visibility,
                position: style.position,
                unicodeBidi: style.unicodeBidi,
                color: style.color,
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                backgroundPosition: style.backgroundPosition,
                backgroundSize: style.backgroundSize,
                backgroundRepeat: style.backgroundRepeat,
                borderTopColor: style.borderTopColor,
                borderRightColor: style.borderRightColor,
                borderBottomColor: style.borderBottomColor,
                borderLeftColor: style.borderLeftColor,
                borderTopStyle: style.borderTopStyle,
                borderRightStyle: style.borderRightStyle,
                borderBottomStyle: style.borderBottomStyle,
                borderLeftStyle: style.borderLeftStyle,
                borderRadius: style.borderRadius,
                opacity: number(style.opacity),
                filter: style.filter,
                transform: style.transform,
                transformOrigin: style.transformOrigin,
                ...(Number.isFinite(zIndex) ? { zIndex } : {}),
              },
              contentUrls: cssUrls(style.content),
            },
          });
        }
      }
      (globalThis as typeof globalThis & Record<string, unknown>)[key] = {
        token,
        elements,
        indexByElement,
        activeElement: document.activeElement,
        factsByElement: Object.create(null),
      };
      return rows;
    }, { selector, key, token, top });
    return {
      frame,
      token,
      candidates: raw.map((row) => ({ ...row, frame, token })),
    };
  } catch (error) {
    console.warn("[domotion] pseudo fragment frame setup failed", error);
    return null;
  }
}

async function runtimeContexts(session: CDPSession, key: string): Promise<Map<string, number>> {
  const ids: number[] = [];
  session.on("Runtime.executionContextCreated", (event) => {
    if (event.context.auxData?.isDefault) ids.push(event.context.id);
  });
  await Promise.all([session.send("Runtime.enable"), session.send("DOM.enable"), session.send("CSS.enable")]);
  const contexts = new Map<string, number>();
  for (const contextId of ids) {
    const result = await session.send("Runtime.evaluate", {
      expression: `globalThis[${JSON.stringify(key)}]?.token ?? ""`,
      contextId,
      returnByValue: true,
      silent: true,
    }).catch(() => null);
    if (typeof result?.result.value === "string" && result.result.value !== "") contexts.set(result.result.value, contextId);
  }
  return contexts;
}

async function resolvePseudoNodes(
  session: CDPSession,
  key: string,
  frames: readonly PreparedFrame[],
  contexts: ReadonlyMap<string, number>,
): Promise<void> {
  await Promise.all(frames.flatMap((prepared) => prepared.candidates.map(async (candidate) => {
    const contextId = contexts.get(prepared.token);
    if (contextId == null) return;
    let objectId: string | undefined;
    try {
      const evaluated = await session.send("Runtime.evaluate", {
        expression: `globalThis[${JSON.stringify(key)}]?.elements?.[${candidate.elementIndex}]`,
        contextId,
        returnByValue: false,
        silent: true,
      });
      objectId = evaluated.result.objectId;
      if (objectId == null) return;
      const described = await session.send("DOM.describeNode", { objectId, depth: 1, pierce: true });
      const host = described.node as CdpNode;
      const pseudo = host.pseudoElements?.find((node) => node.pseudoType === candidate.pseudo);
      candidate.backendNodeId = pseudo?.backendNodeId;
      if (pseudo != null && pseudo.nodeId > 0) {
        const platform = await session.send("CSS.getPlatformFontsForNode", { nodeId: pseudo.nodeId }).catch(() => null);
        candidate.style.typography.resolvedFonts = platform?.fonts.map((font) => ({
          familyName: font.familyName,
          postScriptName: font.postScriptName,
          isCustomFont: font.isCustomFont,
          glyphCount: font.glyphCount,
        })) ?? [];
      }
    } finally {
      if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  })));
}

function snapshotRows(snapshot: SnapshotResult, backendNodeId: number): SnapshotLayoutRow[] {
  for (const document of snapshot.documents) {
    const nodeIndex = document.nodes.backendNodeId?.indexOf(backendNodeId) ?? -1;
    if (nodeIndex < 0) continue;
    const boxes = new Map<number, SnapshotLayoutRow["textBoxes"]>();
    for (let index = 0; index < document.textBoxes.layoutIndex.length; index++) {
      const layoutIndex = document.textBoxes.layoutIndex[index];
      const rows = boxes.get(layoutIndex) ?? [];
      rows.push({
        bounds: rect(document.textBoxes.bounds[index]),
        startUtf16: document.textBoxes.start[index],
        lengthUtf16: document.textBoxes.length[index],
      });
      boxes.set(layoutIndex, rows);
    }
    const rows: SnapshotLayoutRow[] = [];
    for (let index = 0; index < document.layout.nodeIndex.length; index++) {
      if (document.layout.nodeIndex[index] !== nodeIndex) continue;
      const textIndex = document.layout.text[index];
      rows.push({
        layoutIndex: index,
        bounds: rect(document.layout.bounds[index]),
        ...(textIndex >= 0 ? { text: snapshot.strings[textIndex] } : {}),
        textBoxes: boxes.get(index) ?? [],
      });
    }
    return rows;
  }
  return [];
}

async function addShapedAdvances(candidate: Candidate, rows: SnapshotLayoutRow[], key: string): Promise<SnapshotLayoutRow[]> {
  const strings = rows.flatMap((row) => row.text == null
    ? []
    : row.textBoxes.map((box) => row.text!.slice(box.startUtf16, box.startUtf16 + box.lengthUtf16)));
  if (strings.length === 0) return rows;
  const advances = await candidate.frame.evaluate(({ key, elementIndex, pseudo, strings }) => {
    const registry = (globalThis as typeof globalThis & Record<string, unknown>)[key] as { elements?: Element[] } | undefined;
    const host = registry?.elements?.[elementIndex];
    if (host == null) return [];
    const style = getComputedStyle(host, `::${pseudo}`);
    let zoom = 1;
    for (let owner: Element | null = host; owner != null; owner = owner.parentElement) {
      const own = Number.parseFloat(getComputedStyle(owner).zoom);
      if (Number.isFinite(own) && own > 0) zoom *= own;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context == null) return [];
    context.font = `${style.fontStyle} ${style.fontWeight} ${Number.parseFloat(style.fontSize) * zoom}px ${style.fontFamily}`;
    context.direction = style.direction === "rtl" ? "rtl" : "ltr";
    const spacing = context as unknown as {
      fontStretch?: string; fontKerning?: string; fontVariantCaps?: string;
      letterSpacing?: string; wordSpacing?: string;
    };
    if ("fontStretch" in spacing) spacing.fontStretch = style.fontStretch;
    if ("fontKerning" in spacing) spacing.fontKerning = style.fontKerning;
    if ("fontVariantCaps" in spacing) spacing.fontVariantCaps = style.fontVariant;
    if ("letterSpacing" in spacing && style.letterSpacing !== "normal") spacing.letterSpacing = `${Number.parseFloat(style.letterSpacing) * zoom}px`;
    if ("wordSpacing" in spacing && style.wordSpacing !== "normal") spacing.wordSpacing = `${Number.parseFloat(style.wordSpacing) * zoom}px`;
    return strings.map((text) => context.measureText(text).width);
  }, { key, elementIndex: candidate.elementIndex, pseudo: candidate.pseudo, strings }).catch(() => [] as number[]);
  let cursor = 0;
  return rows.map((row) => ({
    ...row,
    textBoxes: row.textBoxes.map((box) => ({ ...box, shapedAdvance: advances[cursor++] })),
  }));
}

function exactRecord(
  candidate: Candidate,
  decoded: ReturnType<typeof decodePseudoFragmentProtocol>,
): CapturedPseudoFragmentSet {
  let imageIndex = 0;
  const itemIndexes = new Map<number, number>();
  const contentItems: CapturedPseudoFragmentSet["contentItems"] = [];
  for (const item of decoded.contentItems) {
    if (item.kind === "image") {
      // DOMSnapshot exposes the anonymous box row for `content:""` with no
      // text, which the generic protocol decoder must conservatively classify
      // as image-like. The computed content URL list is the independent source
      // discriminator: without a URL this is the pseudo's own paint box, not a
      // replaced generated child.
      const resolvedUrl = candidate.style.contentUrls[imageIndex++];
      if (resolvedUrl == null) continue;
      itemIndexes.set(item.index, contentItems.length);
      contentItems.push({ ...item, index: contentItems.length, resolvedUrl });
      continue;
    }
    itemIndexes.set(item.index, contentItems.length);
    contentItems.push({ ...item, index: contentItems.length });
  }
  const fragments = decoded.fragments.flatMap((fragment) => {
    const contentItemIndex = itemIndexes.get(fragment.contentItemIndex);
    return contentItemIndex == null ? [] : [{ ...fragment, contentItemIndex }];
  }).map((fragment, visualOrder) => ({ ...fragment, visualOrder }));
  return {
    source: "blink-pseudo-fragment-v1",
    pseudo: `::${candidate.pseudo}`,
    status: decoded.status === "unpainted" ? "unpainted" : "exact",
    reason: decoded.reason,
    writingMode: decoded.writingMode,
    direction: decoded.direction,
    boxDecorationBreak: candidate.style.boxDecorationBreak === "clone" ? "clone" : "slice",
    edges: { border: candidate.style.border, padding: candidate.style.padding, margin: candidate.style.margin },
    contentItems,
    boxFragments: decoded.boxFragments,
    fragments,
    typography: candidate.style.typography,
    paint: candidate.style.paint,
  };
}

async function cropTransparentSurface(
  png: Buffer,
  viewport: { width: number; height: number },
): Promise<NonNullable<CapturedPseudoFragmentSet["terminalRaster"]>> {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (decoded.data[(y * width + x) * channels + 3] === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return { rect: { x: 0, y: 0, width: 0, height: 0 }, isolated: true };
  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const cropped = await sharp(png).extract({ left, top, width: cropWidth, height: cropHeight }).png().toBuffer();
  return {
    dataUri: `data:image/png;base64,${cropped.toString("base64")}`,
    rect: {
      x: left * viewport.width / width,
      y: top * viewport.height / height,
      width: cropWidth * viewport.width / width,
      height: cropHeight * viewport.height / height,
    },
    isolated: true,
  };
}

async function isolatePseudoSurface(
  page: Page,
  prepared: readonly PreparedFrame[],
  candidate: Candidate,
  key: string,
  viewport: { x: number; y: number; width: number; height: number },
): Promise<NonNullable<CapturedPseudoFragmentSet["terminalRaster"]>> {
  const marker = `dm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const styleId = `__domotionPseudoIsolation_${marker}`;
  const ancestorFrames = new Set<Frame>();
  for (let cursor: Frame | null = candidate.frame; cursor != null; cursor = cursor.parentFrame()) ancestorFrames.add(cursor);
  try {
    await Promise.all(prepared.map(({ frame }) => frame.evaluate(({ styleId, marker, active, key, elementIndex, pseudo }) => {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `*{visibility:hidden!important}html[data-domotion-pseudo-ancestor="${marker}"],body[data-domotion-pseudo-ancestor="${marker}"],[data-domotion-pseudo-ancestor="${marker}"]{visibility:visible!important;background-color:transparent!important;background-image:none!important;border-color:transparent!important;box-shadow:none!important;outline-color:transparent!important}${active ? `[data-domotion-pseudo-target="${marker}"]::${pseudo}{visibility:visible!important}` : ""}`;
      (document.head ?? document.documentElement).appendChild(style);
      if (active) {
        document.documentElement.setAttribute("data-domotion-pseudo-ancestor", marker);
        document.body?.setAttribute("data-domotion-pseudo-ancestor", marker);
        const registry = (globalThis as typeof globalThis & Record<string, unknown>)[key] as { elements?: Element[] } | undefined;
        registry?.elements?.[elementIndex]?.setAttribute("data-domotion-pseudo-target", marker);
      }
    }, {
      styleId,
      marker,
      active: frame === candidate.frame,
      key,
      elementIndex: candidate.elementIndex,
      pseudo: candidate.pseudo,
    })));
    for (let cursor: Frame | null = candidate.frame; cursor.parentFrame() != null; cursor = cursor.parentFrame()!) {
      const handle = await cursor.frameElement();
      await handle.evaluate((element, value) => {
        for (let owner: Element | null = element as Element; owner != null; owner = owner.parentElement) owner.setAttribute("data-domotion-pseudo-ancestor", value);
        document.documentElement.setAttribute("data-domotion-pseudo-ancestor", value);
        document.body?.setAttribute("data-domotion-pseudo-ancestor", value);
      }, marker);
      await handle.dispose();
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = Buffer.from(await page.screenshot({
      clip: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
      omitBackground: true,
      type: "png",
      animations: "allow",
    }));
    return await cropTransparentSurface(png, viewport);
  } finally {
    await Promise.all(prepared.map(({ frame }) => frame.evaluate(({ styleId, marker }) => {
      document.getElementById(styleId)?.remove();
      for (const element of document.querySelectorAll(`[data-domotion-pseudo-ancestor="${marker}"],[data-domotion-pseudo-target="${marker}"]`)) {
        if (element.getAttribute("data-domotion-pseudo-ancestor") === marker) element.removeAttribute("data-domotion-pseudo-ancestor");
        if (element.getAttribute("data-domotion-pseudo-target") === marker) element.removeAttribute("data-domotion-pseudo-target");
      }
    }, { styleId, marker }).catch(() => undefined)));
  }
}

async function installFacts(
  prepared: readonly PreparedFrame[],
  key: string,
  facts: ReadonlyMap<string, Record<number, CapturedPseudoFragmentSet[]>>,
): Promise<void> {
  await Promise.all(prepared.map(({ frame, token }) => frame.evaluate(({ key, facts }) => {
    const registry = (globalThis as typeof globalThis & Record<string, unknown>)[key] as {
      elements?: Element[];
      activeElement?: Element | null;
      factsByElement?: unknown;
    } | undefined;
    if (registry != null) {
      // An empty array is an authoritative "no generated pseudo paint" fact.
      // Seed every walked host so content:none/display:none/absent pseudos do
      // not fall through to the retired clone/host-edge capture path.
      const complete: Record<number, CapturedPseudoFragmentSet[]> = Object.create(null) as Record<number, CapturedPseudoFragmentSet[]>;
      for (let index = 0; index < (registry.elements?.length ?? 0); index++) complete[index] = [];
      for (const [index, records] of Object.entries(facts)) complete[Number(index)] = records;
      registry.factsByElement = complete;
      // A terminal pseudo isolation temporarily hides the rest of the page.
      // Blink blurs a focused control when that stylesheet makes it hidden;
      // restore the source-owned interaction state before downstream native
      // decoration/control atlases snapshot :focus paint.
      const activeElement = registry.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.isConnected
          && document.activeElement !== activeElement) {
        activeElement.focus({ preventScroll: true });
      }
    }
  }, { key, facts: facts.get(token) ?? {} })));
}

/** Prepare immutable generated-pseudo facts for the synchronous capture walk. */
export async function preparePseudoFragmentGeometry(
  page: Page,
  selector: string,
  viewport: { x: number; y: number; width: number; height: number },
): Promise<PseudoFragmentProbe> {
  const key = `__domotionPseudoFragments_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const initialFrames = page.frames();
  const nameShimFrames = await installEvaluateNameShim(initialFrames);
  const prepared = (await Promise.all(initialFrames.map((frame, index) =>
    setupFrame(frame, selector, key, `f${index}`, frame === page.mainFrame()))))
    .filter((row): row is PreparedFrame => row != null);
  const candidates = prepared.flatMap((row) => row.candidates);
  const warnings: CaptureWarning[] = [];
  const facts = new Map<string, Record<number, CapturedPseudoFragmentSet[]>>();
  for (const frame of prepared) facts.set(frame.token, {});
  let session: CDPSession | undefined;
  let playbackRate: number | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const contexts = await runtimeContexts(session, key);
    // Populate stable frontend node ids so CSS.getPlatformFontsForNode can
    // report the exact faces selected for anonymous pseudo text.
    await session.send("DOM.getDocument", { depth: -1, pierce: true });
    await resolvePseudoNodes(session, key, prepared, contexts);
    try {
      await session.send("Animation.enable");
      playbackRate = (await session.send("Animation.getPlaybackRate")).playbackRate;
      await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
    } catch {
      playbackRate = undefined;
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: true,
      includeDOMRects: true,
    }) as unknown as SnapshotResult;
    for (const candidate of candidates) {
      if (candidate.backendNodeId == null) {
        const reason = "computed generated content had no correlatable Chromium pseudo backend node";
        const terminalRaster = await isolatePseudoSurface(page, prepared, candidate, key, viewport).catch(() => ({
          rect: { x: 0, y: 0, width: 0, height: 0 }, isolated: true as const,
        }));
        const frameFacts = facts.get(candidate.token)!;
        (frameFacts[candidate.elementIndex] ??= []).push({
          source: "blink-pseudo-fragment-v1",
          pseudo: `::${candidate.pseudo}`,
          status: "terminal-raster",
          reason,
          writingMode: candidate.style.writingMode,
          direction: candidate.style.direction === "rtl" ? "rtl" : "ltr",
          boxDecorationBreak: candidate.style.boxDecorationBreak === "clone" ? "clone" : "slice",
          edges: { border: candidate.style.border, padding: candidate.style.padding, margin: candidate.style.margin },
          contentItems: [], boxFragments: [], fragments: [],
          typography: candidate.style.typography,
          paint: candidate.style.paint,
          terminalRaster,
        });
        warnings.push({
          selector: candidate.selector,
          feature: FEATURE,
          detail: `${reason}; retained one isolated Chromium-painted pseudo surface`,
        });
        continue;
      }
      let rows = snapshotRows(snapshot, candidate.backendNodeId);
      rows = await addShapedAdvances(candidate, rows, key);
      const quads = await session.send("DOM.getContentQuads", { backendNodeId: candidate.backendNodeId })
        .then((result) => result.quads.map((value) => quad(value, viewport)))
        .catch(() => [] as Quad[]);
      const decoded = decodePseudoFragmentProtocol({
        hostCorrelationId: candidate.correlationId,
        pseudo: candidate.pseudo,
        layoutRows: rows,
        contentQuads: quads,
        style: protocolStyle(candidate.style),
      });
      let record: CapturedPseudoFragmentSet;
      if (decoded.status === "exact" || decoded.status === "unpainted") {
        record = exactRecord(candidate, decoded);
      } else {
        const reason = decoded.reason ?? decoded.status;
        const terminalRaster = await isolatePseudoSurface(page, prepared, candidate, key, viewport).catch(() => ({
          rect: { x: 0, y: 0, width: 0, height: 0 }, isolated: true as const,
        }));
        record = {
          source: "blink-pseudo-fragment-v1",
          pseudo: `::${candidate.pseudo}`,
          status: "terminal-raster",
          reason,
          writingMode: candidate.style.writingMode,
          direction: candidate.style.direction === "rtl" ? "rtl" : "ltr",
          boxDecorationBreak: candidate.style.boxDecorationBreak === "clone" ? "clone" : "slice",
          edges: { border: candidate.style.border, padding: candidate.style.padding, margin: candidate.style.margin },
          contentItems: [], boxFragments: [], fragments: [],
          typography: candidate.style.typography,
          paint: candidate.style.paint,
          terminalRaster,
        };
        warnings.push({
          selector: candidate.selector,
          feature: FEATURE,
          detail: `authoritative Chromium pseudo geometry unavailable (${reason}); retained one isolated Chromium-painted pseudo surface`,
        });
      }
      const frameFacts = facts.get(candidate.token)!;
      (frameFacts[candidate.elementIndex] ??= []).push(record);
    }
  } catch (error) {
    for (const candidate of candidates) {
      const reason = error instanceof Error ? error.message : String(error);
      const terminalRaster = await isolatePseudoSurface(page, prepared, candidate, key, viewport).catch(() => ({
        rect: { x: 0, y: 0, width: 0, height: 0 }, isolated: true as const,
      }));
      const frameFacts = facts.get(candidate.token)!;
      (frameFacts[candidate.elementIndex] ??= []).push({
        source: "blink-pseudo-fragment-v1",
        pseudo: `::${candidate.pseudo}`,
        status: "terminal-raster",
        reason,
        writingMode: candidate.style.writingMode,
        direction: candidate.style.direction === "rtl" ? "rtl" : "ltr",
        boxDecorationBreak: candidate.style.boxDecorationBreak === "clone" ? "clone" : "slice",
        edges: { border: candidate.style.border, padding: candidate.style.padding, margin: candidate.style.margin },
        contentItems: [], boxFragments: [], fragments: [],
        typography: candidate.style.typography,
        paint: candidate.style.paint,
        terminalRaster,
      });
      warnings.push({
        selector: candidate.selector,
        feature: FEATURE,
        detail: `Chromium pseudo protocol prepass failed closed (${reason}); retained one isolated Chromium-painted pseudo surface`,
      });
    }
  } finally {
    if (session != null && playbackRate != null) await session.send("Animation.setPlaybackRate", { playbackRate }).catch(() => undefined);
    await session?.send("Animation.disable").catch(() => undefined);
    await session?.detach().catch(() => undefined);
  }
  await installFacts(prepared, key, facts);
  await removeEvaluateNameShim(nameShimFrames);
  return {
    key,
    warnings,
    dispose: async () => {
      await Promise.all(prepared.map(({ frame }) => frame.evaluate((probeKey) => {
        delete (globalThis as typeof globalThis & Record<string, unknown>)[probeKey];
      }, key).catch(() => undefined)));
    },
  };
}
