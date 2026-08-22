/**
 * Source-owned `<summary>::marker` geometry (DM-2457).
 *
 * Blink exposes the generated list marker as a real CDP pseudo node.  Read its
 * first-line content quad without adding probe DOM, pair it with the computed
 * marker style/font metrics, and attach one physical fragment record to the
 * already-captured summary.  Missing or transformed protocol facts fail
 * closed; the renderer never reconstructs a disclosure marker from the
 * details/summary border boxes.
 */

import type { CDPSession, Page } from "@playwright/test";

import type { CapturedElement, CaptureWarning } from "./types.js";

interface CdpNode {
  nodeId: number;
  backendNodeId: number;
  pseudoType?: string;
  pseudoElements?: CdpNode[];
}

interface SnapshotDocument {
  nodes: { backendNodeId?: number[] };
  layout: { nodeIndex: number[]; bounds: number[][]; text: number[] };
}

interface SnapshotResult {
  documents: SnapshotDocument[];
}

interface MarkerStyleFact {
  suppressed: boolean;
  listStyleType: string;
  listStylePosition: string;
  color: string;
  fontSize: number;
  effectiveZoom: number;
  fontAscent: number;
  writingMode: string;
  direction: string;
  transformed: boolean;
}

const FEATURE = "summary-disclosure-marker-geometry";

function summaries(nodes: CapturedElement[]): CapturedElement[] {
  const result: CapturedElement[] = [];
  const visit = (items: CapturedElement[]): void => {
    for (const item of items) {
      if (item.tag === "summary" && item._summaryMarkerSourceNodeIndex != null) result.push(item);
      if (item.children != null) visit(item.children);
    }
  };
  visit(nodes);
  return result;
}

function axisAlignedRect(
  values: readonly number[],
  viewport: { x: number; y: number },
): { x: number; y: number; width: number; height: number } | null {
  if (values.length !== 8 || !values.every(Number.isFinite)) return null;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values;
  const epsilon = 1 / 64;
  if (Math.abs(y0 - y1) > epsilon || Math.abs(x1 - x2) > epsilon
      || Math.abs(y2 - y3) > epsilon || Math.abs(x3 - x0) > epsilon) return null;
  const left = Math.min(x0, x1, x2, x3);
  const top = Math.min(y0, y1, y2, y3);
  const right = Math.max(x0, x1, x2, x3);
  const bottom = Math.max(y0, y1, y2, y3);
  if (!(right > left && bottom > top)) return null;
  return { x: left - viewport.x, y: top - viewport.y, width: right - left, height: bottom - top };
}

/**
 * PaintSymbol receives the anonymous marker text fragment's physical offset,
 * not the pseudo's aggregate content quad. They coincide for inside markers;
 * an outside marker with a taller principal line box exposes both distinct
 * rows in DOMSnapshot. Select the single source text row and fail closed when
 * Chromium does not provide an unambiguous first-line paint fragment.
 */
function markerPaintFragmentRect(
  snapshot: SnapshotResult,
  backendNodeId: number,
  viewport: { x: number; y: number },
): { x: number; y: number; width: number; height: number } | null {
  for (const document of snapshot.documents) {
    const nodeIndex = document.nodes.backendNodeId?.indexOf(backendNodeId) ?? -1;
    if (nodeIndex < 0) continue;
    const rows: number[][] = [];
    for (let index = 0; index < document.layout.nodeIndex.length; index++) {
      if (document.layout.nodeIndex[index] !== nodeIndex || document.layout.text[index] < 0) continue;
      const bounds = document.layout.bounds[index];
      if (bounds.length !== 4 || !bounds.every(Number.isFinite) || !(bounds[2] > 0 && bounds[3] > 0)) continue;
      rows.push(bounds);
    }
    if (rows.length !== 1) return null;
    const [x, y, width, height] = rows[0];
    return { x: x - viewport.x, y: y - viewport.y, width, height };
  }
  return null;
}

async function markerStyle(page: Page, key: string, index: number): Promise<MarkerStyleFact | null> {
  return await page.evaluate(({ key, index }) => {
    const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[key] as Element[] | undefined;
    const summary = nodes?.[index];
    if (summary == null) return null;
    const style = getComputedStyle(summary);
    const marker = getComputedStyle(summary, "::marker");
    let effectiveZoom = 1;
    let transformed = false;
    for (let owner: Element | null = summary; owner != null; owner = owner.parentElement) {
      const ownerStyle = getComputedStyle(owner);
      const zoom = Number.parseFloat(ownerStyle.zoom);
      if (Number.isFinite(zoom) && zoom > 0) effectiveZoom *= zoom;
      transformed ||= (ownerStyle.transform !== "none" && ownerStyle.transform !== "")
        || (ownerStyle.translate !== "none" && ownerStyle.translate !== "")
        || (ownerStyle.rotate !== "none" && ownerStyle.rotate !== "")
        || (ownerStyle.scale !== "none" && ownerStyle.scale !== "")
        || (ownerStyle.perspective !== "none" && ownerStyle.perspective !== "");
    }
    const fontSize = Number.parseFloat(marker.fontSize);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context == null || !Number.isFinite(fontSize) || fontSize <= 0) return null;
    context.font = `${marker.fontStyle} ${marker.fontWeight} ${fontSize * effectiveZoom}px ${marker.fontFamily}`;
    const drawing = context as unknown as {
      fontStretch?: string;
      fontKerning?: string;
      fontVariantCaps?: string;
    };
    if ("fontStretch" in drawing) drawing.fontStretch = marker.fontStretch;
    if ("fontKerning" in drawing) drawing.fontKerning = marker.fontKerning;
    if ("fontVariantCaps" in drawing) drawing.fontVariantCaps = marker.fontVariantCaps;
    const measured = context.measureText("Hg");
    const color = marker.color;
    const transparent = color === "transparent"
      || /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0(?:\.0+)?\s*\)$/.test(color);
    return {
      suppressed: style.listStyleType === "none" || marker.content === "none" || transparent,
      listStyleType: style.listStyleType,
      listStylePosition: style.listStylePosition,
      color,
      fontSize,
      effectiveZoom,
      fontAscent: measured.fontBoundingBoxAscent,
      writingMode: marker.writingMode,
      direction: marker.direction,
      transformed,
    };
  }, { key, index }).catch(() => null);
}

async function resolveMarkerNode(
  session: CDPSession,
  key: string,
  index: number,
): Promise<{ objectId?: string; marker?: CdpNode }> {
  const evaluated = await session.send("Runtime.evaluate", {
    expression: `globalThis[${JSON.stringify(key)}]?.[${index}]`,
    returnByValue: false,
    silent: true,
  });
  const objectId = evaluated.result.objectId;
  if (objectId == null) return {};
  const described = await session.send("DOM.describeNode", { objectId, depth: 1, pierce: true });
  const host = described.node as CdpNode;
  return { objectId, marker: host.pseudoElements?.find((node) => node.pseudoType === "marker") };
}

/** Attach exact live Blink marker facts and delete private correlation fields. */
export async function captureSummaryMarkerGeometry(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
  warnings: CaptureWarning[],
  sourceNodeKey?: string,
): Promise<void> {
  const candidates = summaries(tree);
  if (candidates.length === 0) return;
  if (sourceNodeKey == null || sourceNodeKey === "") {
    for (const candidate of candidates) {
      delete candidate._summaryMarkerSourceNodeIndex;
      warnings.push({ selector: "summary", feature: FEATURE, detail: "live Chromium source-node registry unavailable; disclosure paint omitted" });
    }
    return;
  }

  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    await Promise.all([session.send("DOM.enable"), session.send("Runtime.enable")]);
    await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: true,
    }) as unknown as SnapshotResult;
    for (const candidate of candidates) {
      const index = candidate._summaryMarkerSourceNodeIndex!;
      delete candidate._summaryMarkerSourceNodeIndex;
      const style = await markerStyle(page, sourceNodeKey, index);
      if (style == null) {
        warnings.push({ selector: "summary", feature: FEATURE, detail: "computed ::marker style/font facts unavailable; disclosure paint omitted" });
        continue;
      }
      if (style.suppressed) continue;
      if (style.transformed) {
        warnings.push({ selector: "summary", feature: FEATURE, detail: "marker has a transformed ancestor; untransformed source quad unavailable and disclosure paint omitted" });
        continue;
      }
      let objectId: string | undefined;
      try {
        const resolved = await resolveMarkerNode(session, sourceNodeKey, index);
        objectId = resolved.objectId;
        if (resolved.marker == null) throw new Error("Chromium marker pseudo node missing");
        const quads = await session.send("DOM.getContentQuads", { backendNodeId: resolved.marker.backendNodeId });
        const contentRect = quads.quads.length === 1 ? axisAlignedRect(quads.quads[0], viewport) : null;
        if (contentRect == null) throw new Error("Chromium marker did not expose one axis-aligned content quad");
        const fragmentRect = markerPaintFragmentRect(snapshot, resolved.marker.backendNodeId, viewport);
        if (fragmentRect == null) throw new Error("Chromium marker did not expose one authoritative paint fragment");
        candidate.summaryMarkerGeometry = {
          source: "blink-list-marker-v1",
          fragmentRect,
          fontAscent: style.fontAscent,
          specifiedFontSize: style.fontSize,
          effectiveZoom: style.effectiveZoom,
          color: style.color,
          listStyleType: style.listStyleType,
          listStylePosition: style.listStylePosition === "inside" ? "inside" : "outside",
          writingMode: style.writingMode,
          direction: style.direction === "rtl" ? "rtl" : "ltr",
        };
      } catch (error) {
        warnings.push({
          selector: "summary",
          feature: FEATURE,
          detail: `${error instanceof Error ? error.message : String(error)}; disclosure paint omitted`,
        });
      } finally {
        if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  } catch (error) {
    for (const candidate of candidates) {
      delete candidate._summaryMarkerSourceNodeIndex;
      warnings.push({
        selector: "summary",
        feature: FEATURE,
        detail: `Chromium marker protocol unavailable (${error instanceof Error ? error.message : String(error)}); disclosure paint omitted`,
      });
    }
  } finally {
    await session?.detach().catch(() => undefined);
  }
}
