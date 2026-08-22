/** Chromium protocol prepass for exact affine text-fragment geometry (DM-2469). */

import type { CDPSession, Frame, Page } from "@playwright/test";
import type {
  CapturedElement,
  CapturedTextPaintQuad,
  CaptureWarning,
} from "./types.js";
import {
  buildCapturedTextPaintGeometry,
  type ProtocolTextNodeGeometry,
} from "./text-fragment-geometry.js";

interface FrameRow {
  sourceKey: string;
  sourceTextNodeIndex: number;
  surfaceOwnerKey: string;
  writingMode: string;
  direction: string;
  transformBox: string;
  transformOrigin: string;
  effectiveZoom: number;
}

interface PreparedFrame {
  frame: Frame;
  token: string;
  rows: FrameRow[];
}

interface MeasuredRow extends FrameRow {
  neutralQuads: CapturedTextPaintQuad[];
  paintQuads: CapturedTextPaintQuad[];
  failureReason?: string;
}

interface ProbeTreeElement extends CapturedElement {
  _textPaintSourceKey?: string;
}

export interface TextPaintGeometryProbe {
  key: string;
  warnings: CaptureWarning[];
  /** Run a post-capture materializer in the same pre-transform paint plane. */
  withNeutralTransforms<T>(work: () => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

const RESTORE_EPSILON = 0.05;

function asQuads(values: number[][], viewport: { x: number; y: number }): CapturedTextPaintQuad[] {
  return values
    .filter((quad) => quad.length === 8 && quad.every(Number.isFinite))
    .map((quad) => [
      quad[0] - viewport.x, quad[1] - viewport.y,
      quad[2] - viewport.x, quad[3] - viewport.y,
      quad[4] - viewport.x, quad[5] - viewport.y,
      quad[6] - viewport.x, quad[7] - viewport.y,
    ]);
}

function quadSetDistance(left: readonly CapturedTextPaintQuad[], right: readonly CapturedTextPaintQuad[]): number {
  if (left.length !== right.length) return Infinity;
  let distance = 0;
  for (let row = 0; row < left.length; row++) {
    for (let value = 0; value < 8; value++) {
      distance = Math.max(distance, Math.abs(left[row][value] - right[row][value]));
    }
  }
  return distance;
}

function walkProbeTree(
  elements: readonly ProbeTreeElement[],
  bySourceKey: Map<string, ProbeTreeElement>,
): void {
  for (const element of elements) {
    if (element._textPaintSourceKey != null) bySourceKey.set(element._textPaintSourceKey, element);
    walkProbeTree(element.children as ProbeTreeElement[], bySourceKey);
  }
}

async function setupFrameRegistry(
  frame: Frame,
  selector: string,
  key: string,
  token: string,
): Promise<PreparedFrame | null> {
  try {
    const rows = await frame.evaluate(({ selector, key, token, isTop }) => {
      const root = isTop ? document.querySelector(selector) : document.documentElement;
      if (root == null) return [];
      const elements = [root, ...Array.from(root.querySelectorAll("*"))];
      const indexByElement = new WeakMap<Element, number>();
      for (let index = 0; index < elements.length; index++) indexByElement.set(elements[index], index);
      const owners: Element[] = [];
      const ownerSeen = new Set<Element>();
      let ancestor: Element | null = root;
      while (ancestor != null) {
        ownerSeen.add(ancestor);
        ancestor = ancestor.parentElement;
      }
      for (const element of elements) ownerSeen.add(element);
      for (const element of ownerSeen) {
        const style = getComputedStyle(element);
        const ownsTransform = style.transform !== "none"
          || style.translate !== "none"
          || style.rotate !== "none"
          || style.scale !== "none"
          || style.perspective !== "none"
          || style.transformStyle === "preserve-3d";
        if (ownsTransform) owners.push(element);
      }
      const result: Array<{
        sourceKey: string;
        sourceTextNodeIndex: number;
        surfaceOwnerKey: string;
        writingMode: string;
        direction: string;
        transformBox: string;
        transformOrigin: string;
        effectiveZoom: number;
      }> = [];
      const textRows: Array<{ element: Element; textNode: Text }> = [];
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
        const element = elements[elementIndex];
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        let zoom = 1;
        let zoomOwner: Element | null = element;
        while (zoomOwner != null) {
          const ownZoom = Number.parseFloat(getComputedStyle(zoomOwner).zoom);
          if (Number.isFinite(ownZoom) && ownZoom > 0) zoom *= ownZoom;
          zoomOwner = zoomOwner.parentElement;
        }
        let surfaceOwner = element;
        let cursor: Element | null = element;
        while (cursor != null && ownerSeen.has(cursor)) {
          const cursorStyle = getComputedStyle(cursor);
          if (cursorStyle.transform !== "none"
            || cursorStyle.translate !== "none"
            || cursorStyle.rotate !== "none"
            || cursorStyle.scale !== "none"
            || cursorStyle.perspective !== "none"
            || cursorStyle.transformStyle === "preserve-3d") surfaceOwner = cursor;
          if (cursor === root) break;
          cursor = cursor.parentElement;
        }
        for (let childIndex = 0; childIndex < element.childNodes.length; childIndex++) {
          const child = element.childNodes[childIndex];
          if (child.nodeType !== Node.TEXT_NODE || child.textContent == null || child.textContent.trim() === "") continue;
          const sourceTextNodeIndex = textRows.length;
          const sourceKey = `${token}:${elementIndex}`;
          const surfaceIndex = indexByElement.get(surfaceOwner) ?? elementIndex;
          textRows.push({ element, textNode: child as Text });
          result.push({
            sourceKey,
            sourceTextNodeIndex,
            surfaceOwnerKey: `${token}:${surfaceIndex}`,
            writingMode: style.writingMode,
            direction: style.direction,
            transformBox: style.transformBox,
            transformOrigin: style.transformOrigin,
            effectiveZoom: zoom,
          });
        }
      }
      (globalThis as typeof globalThis & Record<string, unknown>)[key] = {
        token,
        root,
        elements,
        indexByElement,
        owners,
        textRows,
        snapshots: null,
        factsByElement: Object.create(null),
      };
      return result;
    }, { selector, key, token, isTop: frame === frame.page().mainFrame() });
    return { frame, token, rows };
  } catch {
    return null;
  }
}

async function mutateFrames(frames: readonly PreparedFrame[], key: string, neutral: boolean): Promise<void> {
  await Promise.all(frames.map(async ({ frame }) => {
    await frame.evaluate(({ key, neutral }) => {
      const registry = (globalThis as typeof globalThis & Record<string, any>)[key];
      if (registry == null) return;
      const properties = ["transform", "translate", "rotate", "scale", "perspective", "transform-style"];
      if (neutral) {
        registry.snapshots = [];
        for (const owner of registry.owners as HTMLElement[]) {
          const values: Array<[string, string, string]> = [];
          for (const property of properties) {
            values.push([property, owner.style.getPropertyValue(property), owner.style.getPropertyPriority(property)]);
          }
          registry.snapshots.push({ owner, values });
          owner.style.setProperty("transform", "matrix(1, 0, 0, 1, 0, 0)", "important");
          owner.style.setProperty("translate", "none", "important");
          owner.style.setProperty("rotate", "none", "important");
          owner.style.setProperty("scale", "none", "important");
          owner.style.setProperty("perspective", "none", "important");
          owner.style.setProperty("transform-style", "flat", "important");
        }
      } else {
        for (const snapshot of registry.snapshots ?? []) {
          for (const [property, value, priority] of snapshot.values) {
            if (value === "") snapshot.owner.style.removeProperty(property);
            else snapshot.owner.style.setProperty(property, value, priority);
          }
        }
        registry.snapshots = null;
      }
    }, { key, neutral });
  }));
}

async function settleFrames(frames: readonly PreparedFrame[]): Promise<void> {
  await Promise.all(frames.map(({ frame }) => frame.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  })).catch(() => undefined)));
}

async function defaultRuntimeContexts(session: CDPSession, key: string): Promise<Map<string, number>> {
  const contextIds: number[] = [];
  session.on("Runtime.executionContextCreated", (event) => {
    if (event.context.auxData?.isDefault) contextIds.push(event.context.id);
  });
  await Promise.all([session.send("Runtime.enable"), session.send("DOM.enable")]);
  const result = new Map<string, number>();
  for (const contextId of contextIds) {
    // Registry presence selects accessible default worlds without relying on
    // frame URL/name correlation (which is ambiguous for repeated srcdoc).
    const evaluated = await session.send("Runtime.evaluate", {
      expression: `globalThis[${JSON.stringify(key)}]?.token ?? ""`,
      contextId,
      returnByValue: true,
      silent: true,
    }).catch(() => null);
    const token = evaluated?.result.value;
    if (typeof token === "string" && token !== "") {
      result.set(token, contextId);
    }
  }
  return result;
}

async function measureRows(
  session: CDPSession,
  key: string,
  frames: readonly PreparedFrame[],
  contexts: ReadonlyMap<string, number>,
  viewport: { x: number; y: number },
): Promise<Map<string, CapturedTextPaintQuad[]>> {
  const result = new Map<string, CapturedTextPaintQuad[]>();
  for (const frame of frames) {
    const contextId = contexts.get(frame.token);
    if (contextId == null) continue;
    for (const row of frame.rows) {
      let objectId: string | undefined;
      try {
        const evaluated = await session.send("Runtime.evaluate", {
          expression: `globalThis[${JSON.stringify(key)}]?.textRows?.[${row.sourceTextNodeIndex}]?.textNode`,
          contextId,
          returnByValue: false,
          silent: true,
        });
        objectId = evaluated.result.objectId;
        if (objectId == null) continue;
        const described = await session.send("DOM.describeNode", { objectId });
        const measured = await session.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
        result.set(`${frame.token}:${row.sourceTextNodeIndex}`, asQuads(measured.quads, viewport));
      } catch {
        // Missing protocol geometry is handled by the explicit surface below.
      } finally {
        if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  }
  return result;
}

function factsByFrame(
  frames: readonly PreparedFrame[],
  measured: readonly MeasuredRow[],
  neutralTree: readonly ProbeTreeElement[],
): Map<string, Record<string, unknown>> {
  const neutralBySourceKey = new Map<string, ProbeTreeElement>();
  walkProbeTree(neutralTree, neutralBySourceKey);
  const rowsByElement = new Map<string, MeasuredRow[]>();
  for (const row of measured) {
    const list = rowsByElement.get(row.sourceKey) ?? [];
    list.push(row);
    rowsByElement.set(row.sourceKey, list);
  }
  const output = new Map<string, Record<string, unknown>>();
  for (const frame of frames) output.set(frame.token, Object.create(null) as Record<string, unknown>);

  for (const [sourceKey, rows] of rowsByElement) {
    const token = sourceKey.slice(0, sourceKey.indexOf(":"));
    const elementIndex = sourceKey.slice(sourceKey.indexOf(":") + 1);
    const frameFacts = output.get(token);
    if (frameFacts == null) continue;
    const failure = rows.find((row) => row.failureReason != null)?.failureReason;
    const neutral = neutralBySourceKey.get(sourceKey);
    const built = failure != null || neutral == null
      ? { geometry: null, failureReason: failure ?? "neutral capture element correlation unavailable" }
      : buildCapturedTextPaintGeometry(
        neutral.textSegments ?? [],
        neutral.fontAscent,
        rows.map((row): ProtocolTextNodeGeometry => ({
          sourceTextNodeIndex: row.sourceTextNodeIndex,
          neutralQuads: row.neutralQuads,
          paintQuads: row.paintQuads,
          writingMode: row.writingMode,
          direction: row.direction,
          transformBox: row.transformBox,
          transformOrigin: row.transformOrigin,
          effectiveZoom: row.effectiveZoom,
        })),
      );
    if (built.geometry != null) {
      // DM-2470: retain the complete same-frame transform-neutral text bundle,
      // not only its correlated protocol quads. Pseudos, generated fragments,
      // decorations, raster candidates, and clips all share these coordinates
      // and must receive the one paint matrix together.
      built.geometry.neutral = {
        x: neutral!.x,
        y: neutral!.y,
        width: neutral!.width,
        height: neutral!.height,
        text: neutral!.text,
        textSegments: neutral!.textSegments?.map((segment) => ({
          ...segment,
          xOffsets: segment.xOffsets == null ? undefined : [...segment.xOffsets],
          yOffsets: segment.yOffsets == null ? undefined : [...segment.yOffsets],
          xAdvances: segment.xAdvances == null ? undefined : [...segment.xAdvances],
          verticalAdvances: segment.verticalAdvances == null ? undefined : [...segment.verticalAdvances],
          rasterRect: segment.rasterRect == null ? undefined : { ...segment.rasterRect },
          rasterGlyphs: segment.rasterGlyphs?.map((glyph) => ({ ...glyph, rect: { ...glyph.rect } })),
          pseudoBox: segment.pseudoBox == null ? undefined : { ...segment.pseudoBox },
        })),
        textTop: neutral!.textTop,
        textLeft: neutral!.textLeft,
        textHeight: neutral!.textHeight,
        textWidth: neutral!.textWidth,
        fontAscent: neutral!.fontAscent,
        fontDescent: neutral!.fontDescent,
        inputXOffsets: neutral!.inputXOffsets == null ? undefined : [...neutral!.inputXOffsets],
      };
      frameFacts[elementIndex] = { geometry: built.geometry };
      continue;
    }
    const ownerKey = rows[0].surfaceOwnerKey;
    const ownerToken = ownerKey.slice(0, ownerKey.indexOf(":"));
    const ownerIndex = ownerKey.slice(ownerKey.indexOf(":") + 1);
    const ownerFacts = output.get(ownerToken);
    if (ownerFacts != null) ownerFacts[ownerIndex] = {
      surfaceReason: built.failureReason ?? "authoritative text geometry unavailable",
    };
  }
  return output;
}

/**
 * Measure one coherent live/neutral/restored frame and leave per-element facts
 * in private frame globals for the synchronous capture script to consume.
 */
export async function prepareTextPaintGeometry(
  page: Page,
  selector: string,
  viewport: { x: number; y: number; width: number; height: number },
  captureNeutralTree: (key: string) => Promise<{ tree: CapturedElement[] }>,
): Promise<TextPaintGeometryProbe> {
  const key = `__domotionTextPaintGeometry_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const prepared = (await Promise.all(page.frames().map((frame, index) =>
    setupFrameRegistry(frame, selector, key, `f${index}`)))).filter((frame): frame is PreparedFrame => frame != null);
  const warnings: CaptureWarning[] = [];
  let session: CDPSession | undefined;
  let playbackRate: number | undefined;
  let neutral = false;
  try {
    session = await page.context().newCDPSession(page);
    const contexts = await defaultRuntimeContexts(session, key);
    try {
      await session.send("Animation.enable");
      playbackRate = (await session.send("Animation.getPlaybackRate")).playbackRate;
      await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
    } catch {
      playbackRate = undefined;
    }
    const live = await measureRows(session, key, prepared, contexts, viewport);
    await mutateFrames(prepared, key, true);
    neutral = true;
    await settleFrames(prepared);
    const neutralQuads = await measureRows(session, key, prepared, contexts, viewport);
    const neutralResult = await captureNeutralTree(key);
    await mutateFrames(prepared, key, false);
    neutral = false;
    await settleFrames(prepared);
    const restored = await measureRows(session, key, prepared, contexts, viewport);

    const measured: MeasuredRow[] = [];
    for (const frame of prepared) {
      for (const row of frame.rows) {
        const measurementKey = `${frame.token}:${row.sourceTextNodeIndex}`;
        const paintQuads = live.get(measurementKey) ?? [];
        const localQuads = neutralQuads.get(measurementKey) ?? [];
        const restoredQuads = restored.get(measurementKey) ?? [];
        let failureReason: string | undefined;
        if (paintQuads.length === 0 || localQuads.length === 0) {
          failureReason = "DOM.getContentQuads unavailable for text node";
        } else if (quadSetDistance(paintQuads, restoredQuads) > RESTORE_EPSILON) {
          failureReason = "text transform probe did not restore the source frame exactly";
        }
        measured.push({ ...row, neutralQuads: localQuads, paintQuads, failureReason });
      }
    }
    const byFrame = factsByFrame(prepared, measured, neutralResult.tree as ProbeTreeElement[]);
    await Promise.all(prepared.map(({ frame, token }) => frame.evaluate(({ key, facts }) => {
      const registry = (globalThis as typeof globalThis & Record<string, any>)[key];
      if (registry != null) registry.factsByElement = facts;
    }, { key, facts: byFrame.get(token) ?? {} })));
  } catch (error) {
    warnings.push({
      selector,
      feature: "transform",
      detail: `authoritative affine text-fragment probe failed closed: ${error instanceof Error ? error.message : String(error)}`,
    });
    // Ensure every text-bearing element selects a Chromium-owned surface.
    await Promise.all(prepared.map(({ frame, rows }) => {
      const facts: Record<string, unknown> = {};
      for (const row of rows) {
        const ownerIndex = row.surfaceOwnerKey.slice(row.surfaceOwnerKey.indexOf(":") + 1);
        facts[ownerIndex] = { surfaceReason: "authoritative affine text-fragment probe unavailable" };
      }
      return frame.evaluate(({ key, facts }) => {
        const registry = (globalThis as typeof globalThis & Record<string, any>)[key];
        if (registry != null) registry.factsByElement = facts;
      }, { key, facts }).catch(() => undefined);
    }));
  } finally {
    if (neutral) await mutateFrames(prepared, key, false).catch(() => undefined);
    if (session != null && playbackRate != null) {
      await session.send("Animation.setPlaybackRate", { playbackRate }).catch(() => undefined);
    }
    await session?.send("Animation.disable").catch(() => undefined);
    await session?.detach().catch(() => undefined);
  }

  return {
    key,
    warnings,
    withNeutralTransforms: async <T>(work: () => Promise<T>): Promise<T> => {
      await mutateFrames(prepared, key, true);
      await settleFrames(prepared);
      try {
        return await work();
      } finally {
        await mutateFrames(prepared, key, false);
        await settleFrames(prepared);
      }
    },
    dispose: async () => {
      await Promise.all(prepared.map(({ frame }) => frame.evaluate((probeKey) => {
        delete (globalThis as typeof globalThis & Record<string, unknown>)[probeKey];
      }, key).catch(() => undefined)));
    },
  };
}
