/**
 * Source-owned `<summary>::marker` geometry (DM-2457).
 *
 * Blink exposes the generated list marker as a real CDP pseudo node.  Read its
 * first-line content quad without adding probe DOM, pair it with the computed
 * marker style/font metrics, and attach one physical fragment record to the
 * already-captured summary. Missing protocol facts fail closed. Frozen
 * planar wrappers read the same fragment in their verified neutral source
 * plane. The renderer never reconstructs a disclosure marker from the
 * details/summary border boxes.
 */

import type { CDPSession, Page } from "@playwright/test";
import { withCdpSession } from "./cdp-lifecycle.js";
import { withVerifiedFrozenTransformPlane, type FrozenTransformOwner } from "./frozen-transform-neutralizer.js";
import { rootHasAuthorShadowContext } from "./inset-root-shadow-context.js";

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
  nativeDisclosure: boolean;
}

const FEATURE = "summary-disclosure-marker-geometry";

function summaries(nodes: CapturedElement[]) {
  const result: Array<{
    element: CapturedElement;
    sourceNodeIndex: number;
    frozenOwners?: FrozenTransformOwner[];
  }> = [];
  const visit = (items: CapturedElement[]): void => {
    for (const element of items) {
      if (element.tag === "summary" && element._summaryMarkerSourceNodeIndex != null) {
        result.push({
          element,
          sourceNodeIndex: element._summaryMarkerSourceNodeIndex,
          frozenOwners: element._summaryMarkerFrozenOwners,
        });
        delete element._summaryMarkerSourceNodeIndex;
        delete element._summaryMarkerFrozenOwners;
      }
      if (element.children != null) visit(element.children);
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
  if (
    Math.abs(y0 - y1) > epsilon ||
    Math.abs(x1 - x2) > epsilon ||
    Math.abs(y2 - y3) > epsilon ||
    Math.abs(x3 - x0) > epsilon
  )
    return null;
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
  return await page
    .evaluate(
      ({ key, index }) => {
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
          transformed ||=
            (ownerStyle.transform !== "none" && ownerStyle.transform !== "") ||
            (ownerStyle.translate !== "none" && ownerStyle.translate !== "") ||
            (ownerStyle.rotate !== "none" && ownerStyle.rotate !== "") ||
            (ownerStyle.scale !== "none" && ownerStyle.scale !== "") ||
            (ownerStyle.perspective !== "none" && ownerStyle.perspective !== "");
        }
        const fontSize = Number.parseFloat(marker.fontSize);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context == null || !Number.isFinite(fontSize) || fontSize <= 0) return null;
        context.font = `${marker.fontStyle} ${marker.fontWeight} ${fontSize * effectiveZoom}px ${marker.fontFamily}`;
        const drawing = context as Omit<typeof context, "fontStretch" | "fontKerning" | "fontVariantCaps"> & {
          fontStretch?: string;
          fontKerning?: string;
          fontVariantCaps?: string;
        };
        if ("fontStretch" in drawing) drawing.fontStretch = marker.fontStretch;
        if ("fontKerning" in drawing) drawing.fontKerning = marker.fontKerning;
        if ("fontVariantCaps" in drawing) drawing.fontVariantCaps = marker.fontVariantCaps;
        const measured = context.measureText("Hg");
        const color = marker.color;
        const transparent =
          color === "transparent" || /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0(?:\.0+)?\s*\)$/.test(color);
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
          nativeDisclosure:
            marker.content === "normal" &&
            style.listStyleImage === "none" &&
            (style.listStyleType === "disclosure-open" || style.listStyleType === "disclosure-closed"),
        };
      },
      { key, index },
    )
    .catch(() => null);
}

async function resolveMarkerNode(
  session: CDPSession,
  key: string,
  index: number,
): Promise<{ objectId?: string; host?: CdpNode; marker?: CdpNode }> {
  const evaluated = await session.send("Runtime.evaluate", {
    expression: `globalThis[${JSON.stringify(key)}]?.[${index}]`,
    returnByValue: false,
    silent: true,
  });
  const objectId = evaluated.result.objectId;
  if (objectId == null) return {};
  const described = await session.send("DOM.describeNode", { objectId, depth: 1, pierce: true });
  const host = described.node as CdpNode;
  return { objectId, host, marker: host.pseudoElements?.find((node) => node.pseudoType === "marker") };
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
    for (const _candidate of candidates) {
      warnings.push({
        selector: "summary",
        feature: FEATURE,
        detail: "live Chromium source-node registry unavailable; disclosure paint omitted",
      });
    }
    return;
  }

  try {
    await withCdpSession(page, async (session) => {
      await Promise.all([session.send("DOM.enable"), session.send("Runtime.enable")]);
      const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
      const snapshot = (): Promise<SnapshotResult> =>
        session.send("DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includeDOMRects: true,
          includePaintOrder: true,
        });
      const liveSnapshot = await snapshot();
      for (const { element, sourceNodeIndex, frozenOwners } of candidates) {
        const style = await markerStyle(page, sourceNodeKey, sourceNodeIndex);
        if (style == null) {
          warnings.push({
            selector: "summary",
            feature: FEATURE,
            detail: "computed ::marker style/font facts unavailable; disclosure paint omitted",
          });
          continue;
        }
        if (style.suppressed) continue;
        if (style.transformed && (frozenOwners == null || !style.nativeDisclosure)) {
          warnings.push({
            selector: "summary",
            feature: FEATURE,
            detail:
              "marker has a transformed ancestor; untransformed source quad unavailable and disclosure paint omitted",
          });
          continue;
        }
        let objectId: string | undefined;
        try {
          const resolved = await resolveMarkerNode(session, sourceNodeKey, sourceNodeIndex);
          objectId = resolved.objectId;
          if (resolved.marker == null || resolved.host == null) throw new Error("Chromium marker pseudo node missing");
          const markerBackend = resolved.marker.backendNodeId;
          const sampleFragment = async (snapshotForPlane: SnapshotResult) => {
            const quads = await session.send("DOM.getContentQuads", { backendNodeId: markerBackend });
            const contentRect = quads.quads.length === 1 ? axisAlignedRect(quads.quads[0], viewport) : null;
            if (contentRect == null) throw new Error("Chromium marker did not expose one axis-aligned content quad");
            const fragmentRect = markerPaintFragmentRect(snapshotForPlane, markerBackend, viewport);
            if (fragmentRect == null)
              throw new Error("Chromium marker did not expose one authoritative paint fragment");
            return fragmentRect;
          };
          let fragmentRect;
          if (style.transformed && frozenOwners != null) {
            const backend = resolved.host.backendNodeId;
            if (rootHasAuthorShadowContext(root, backend) !== false)
              throw new Error("frozen marker has unavailable or changed author-shadow context");
            fragmentRect = await withVerifiedFrozenTransformPlane(
              page,
              {
                sourceNodeKey,
                index: sourceNodeIndex,
                owners: frozenOwners,
                sourceBox: {
                  x: element.x + viewport.x,
                  y: element.y + viewport.y,
                  width: element.width,
                  height: element.height,
                },
              },
              async () => {
                if (JSON.stringify(await markerStyle(page, sourceNodeKey, sourceNodeIndex)) !== JSON.stringify(style))
                  throw new Error("neutral marker style differs from the source marker");
                return sampleFragment(await snapshot());
              },
            );
            const { node: restored } = await session.send("DOM.describeNode", {
              backendNodeId: root.backendNodeId,
              depth: -1,
              pierce: true,
            });
            const sameMarker = await session.send("DOM.describeNode", {
              backendNodeId: backend,
              depth: 1,
              pierce: true,
            });
            const restoredMarker = sameMarker.node.pseudoElements?.find((node) => node.pseudoType === "marker");
            if (
              rootHasAuthorShadowContext(restored, backend) !== false ||
              restoredMarker?.backendNodeId !== markerBackend ||
              JSON.stringify(await markerStyle(page, sourceNodeKey, sourceNodeIndex)) !== JSON.stringify(style)
            )
              throw new Error("frozen marker source changed during capture");
          } else {
            fragmentRect = await sampleFragment(liveSnapshot);
          }
          element.summaryMarkerGeometry = {
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
    });
  } catch (error) {
    for (const _candidate of candidates) {
      warnings.push({
        selector: "summary",
        feature: FEATURE,
        detail: `Chromium marker protocol unavailable (${error instanceof Error ? error.message : String(error)}); disclosure paint omitted`,
      });
    }
  }
}
