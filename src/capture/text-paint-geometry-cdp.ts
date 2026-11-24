/** Chromium protocol prepass for exact affine text-fragment geometry (DM-2469). */

import type { CDPSession, Frame, Page } from "@playwright/test";
import type { AuthorShadowContextCapabilities, AuthorShadowExpectation } from "./author-shadow-context-record.js";
import { waitForCaptureAnimationFrames } from "./frame-scheduler.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import type { neutralizeTransformForFreeze as NeutralizeTransformForFreeze } from "./script/walker/transforms.js";
import { withCdpSession } from "./cdp-lifecycle.js";
import { createPageRegistry } from "./page-registry.js";
import type { CapturedElement, CapturedTextPaintQuad, CaptureWarning } from "./types.js";
import { probeFailureWarning } from "./probe-failure.js";
import { authenticBorderPaintSnap, snappedBorderEdges } from "../render/borders.js";
import { parseColor } from "../render/colors.js";
import { emittedElementTextAffine } from "../render/text-affine.js";
import { svgTransformCoefficient, svgTransformCoordinate } from "../render/transforms.js";
import { withTimeout } from "../utils/with-timeout.js";
import { buildCapturedTextPaintGeometry, type ProtocolTextNodeGeometry } from "./text-fragment-geometry.js";
import type { BlinkRangeFragmentProbe } from "./text-fragment-spans.js";
import {
  invertLiveTextQuad,
  invertLiveTextRect,
  liveTextInverse,
  type LiveTextInverse,
  type LiveTextRect,
} from "./live-text-inverse.js";

// Defined in every evaluateInFrame scope (browserCallbackExpression).
declare const neutralizeTransformForFreeze: typeof NeutralizeTransformForFreeze;

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
  hasTransformOwners: boolean;
  hasReadOnlyLiveTextCandidate?: boolean;
  hasLiveAffineBoxCandidates?: boolean;
}

interface MeasuredRow extends FrameRow {
  neutralQuads: CapturedTextPaintQuad[];
  paintQuads: CapturedTextPaintQuad[];
  rangeFragments: BlinkRangeFragmentProbe[];
  failureReason?: string;
}

interface ProbeTreeElement extends CapturedElement {
  _textPaintSourceKey?: string;
}

/** The page-side registry the prepare step stores under `globalThis[key]` (the fields later callbacks touch). */
interface PageTextPaintRegistry {
  owners: HTMLElement[];
  textRows: Array<{ element: Element; textNode: Text }>;
  snapshots: Array<{ owner: HTMLElement; styleAttribute: string | null; restore: () => void }> | null;
  factsByElement: Record<string, unknown>;
  liveTextInverse?: LiveTextInverse;
}
/** `globalThis` as the page callbacks see it: registries keyed by the probe key. */
type PageRegistryScope = typeof globalThis & Record<string, PageTextPaintRegistry | undefined>;

/** Serialized into the existing shadow carrier, before the first measured
 * frame. The actual registry Elements become the retained CDP participants. */
export function adoptReadOnlyLiveTextTopology(args: {
  textPaintGeometryKey: string;
  expectation: AuthorShadowExpectation;
  authorShadowContexts?: AuthorShadowContextCapabilities;
}): boolean {
  const registry = (globalThis as PageRegistryScope)[args.textPaintGeometryKey];
  const capability = args.authorShadowContexts?.liveAffineBoxes;
  const owner = registry?.owners[0];
  const member = registry?.textRows[0]?.element;
  if (owner == null || member == null || capability == null) return false;
  const elements = owner === member ? [owner] : [owner, member];
  const peek = { ...args.expectation, markUsed: false };
  return (
    elements.every((element) => capability.adopt(element, peek) === "none") &&
    elements.every((element) => capability.adopt(element, args.expectation) === "none")
  );
}

export interface TextPaintGeometryProbe {
  key: string;
  warnings: CaptureWarning[];
  verifyLiveTextFrame?: () => Promise<boolean>;
  hasLiveAffineBoxCandidates?: boolean;
  /** Run a post-capture materializer in the same pre-transform paint plane. */
  withNeutralTransforms<T>(work: () => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

const RESTORE_EPSILON = 0.05;
/** Keep protocol fan-out at a fixed conservative bound while collapsing the
 * 193-row counter fixture from serial round trips into bounded batches. Phase
 * barriers remain outside this worker pool. */
export const TEXT_PAINT_GEOMETRY_ROW_CONCURRENCY = 16;

function asQuads(values: number[][], viewport: { x: number; y: number }): CapturedTextPaintQuad[] {
  return values
    .filter((quad) => quad.length === 8 && quad.every(Number.isFinite))
    .map((quad) => [
      quad[0] - viewport.x,
      quad[1] - viewport.y,
      quad[2] - viewport.x,
      quad[3] - viewport.y,
      quad[4] - viewport.x,
      quad[5] - viewport.y,
      quad[6] - viewport.x,
      quad[7] - viewport.y,
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

function walkProbeTree(elements: readonly ProbeTreeElement[], bySourceKey: Map<string, ProbeTreeElement>): void {
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
    const prepared = await evaluateInFrame(
      frame,
      ({ selector, key, token, isTop }) => {
        const root = isTop ? document.querySelector(selector) : document.documentElement;
        if (root == null) return { rows: [], hasTransformOwners: false };
        const elements = [root, ...Array.from(root.querySelectorAll("*"))];
        const indexByElement = new WeakMap<Element, number>();
        for (let index = 0; index < elements.length; index++) indexByElement.set(elements[index], index);
        const owners = new Set<Element>();
        const affineBoxCandidates = new Set<Element>();
        const ownerSeen = new Set<Element>();
        let ancestor: Element | null = root;
        while (ancestor != null) {
          ownerSeen.add(ancestor);
          ancestor = ancestor.parentElement;
        }
        for (const element of elements) ownerSeen.add(element);
        for (const element of ownerSeen) {
          const style = getComputedStyle(element);
          const ownsTransform =
            style.transform !== "none" ||
            style.translate !== "none" ||
            style.rotate !== "none" ||
            style.scale !== "none" ||
            style.perspective !== "none" ||
            style.transformStyle === "preserve-3d";
          if (ownsTransform) owners.add(element);
          if (
            isTop &&
            element instanceof HTMLElement &&
            indexByElement.has(element) &&
            (style.transform !== "none" || style.scale !== "none") &&
            (style.transitionDuration !== "0s" || style.transitionDelay !== "0s" || element.getAnimations().length > 0)
          )
            affineBoxCandidates.add(element);
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
        const textTransformOwners = new Set<Element>();
        const indexByTextNode = new WeakMap<Text, number>();
        // Blink's generated text-overflow marker is not a DOM text interval.
        // An isolated Range therefore cannot reproduce its full FragmentItem,
        // even for untransformed single-line text. Leave that narrow case to
        // the captured source-run + marker painter instead of treating it as
        // an affine-geometry failure and rasterizing the whole element.
        // IsDisplayBlockContainer in computed_style.h (Chromium 7d859f27)
        // excludes flex/grid, whose anonymous text items do not get markers.
        const textOverflowContainers = new Set([
          "block",
          "list-item",
          "inline-block",
          "flow-root",
          "flow-root list-item",
          "inline flow-root list-item",
          "table-cell",
          "table-caption",
        ]);
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
            if (
              cursorStyle.transform !== "none" ||
              cursorStyle.translate !== "none" ||
              cursorStyle.rotate !== "none" ||
              cursorStyle.scale !== "none" ||
              cursorStyle.perspective !== "none" ||
              cursorStyle.transformStyle === "preserve-3d"
            )
              surfaceOwner = cursor;
            if (cursor === root) break;
            cursor = cursor.parentElement;
          }
          const directTextNodes = Array.from(element.childNodes).filter(
            (child): child is Text => child.nodeType === Node.TEXT_NODE && (child.textContent?.trim() ?? "") !== "",
          );
          const untransformedTextOverflow =
            owners.size === 0 &&
            directTextNodes.length === 1 &&
            style.textOverflow === "ellipsis" &&
            textOverflowContainers.has(style.display) &&
            (style.whiteSpace === "nowrap" || style.whiteSpace === "pre") &&
            style.overflowX === "hidden";
          if (untransformedTextOverflow) continue;
          if (directTextNodes.length > 0) {
            // Neutralize only transforms that affect a measured text node.
            // An unrelated live box can be reconstructed without changing its animation.
            for (let node: Element | null = element; node != null; node = node.parentElement)
              if (owners.has(node)) textTransformOwners.add(node);
          }
          for (let childIndex = 0; childIndex < element.childNodes.length; childIndex++) {
            const child = element.childNodes[childIndex];
            if (child.nodeType !== Node.TEXT_NODE || child.textContent == null || child.textContent.trim() === "")
              continue;
            const sourceTextNodeIndex = textRows.length;
            const sourceKey = `${token}:${elementIndex}`;
            const surfaceIndex = indexByElement.get(surfaceOwner) ?? elementIndex;
            textRows.push({ element, textNode: child as Text });
            indexByTextNode.set(child as Text, sourceTextNodeIndex);
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
          owners: [...owners].filter((owner) => textTransformOwners.has(owner)),
          textRows,
          indexByTextNode,
          snapshots: null,
          factsByElement: Object.create(null),
        };
        const hasReadOnlyLiveTextCandidate =
          isTop &&
          owners.size === 1 &&
          textRows.length > 0 &&
          (owners.has(textRows[0].element) ||
            (textRows[0].element.parentElement != null && owners.has(textRows[0].element.parentElement))) &&
          textRows.every(({ element }) => element === textRows[0].element);
        return {
          rows: result,
          hasTransformOwners: textTransformOwners.size > 0,
          hasReadOnlyLiveTextCandidate,
          hasLiveAffineBoxCandidates: [...affineBoxCandidates].some((element) => !textTransformOwners.has(element)),
        };
      },
      { selector, key, token, isTop: frame === frame.page().mainFrame() },
    );
    return {
      frame,
      token,
      rows: prepared.rows,
      hasTransformOwners: prepared.hasTransformOwners,
      hasReadOnlyLiveTextCandidate: prepared.hasReadOnlyLiveTextCandidate,
      hasLiveAffineBoxCandidates: prepared.hasLiveAffineBoxCandidates,
    };
  } catch {
    return null;
  }
}

async function mutateFrames(frames: readonly PreparedFrame[], key: string, neutral: boolean): Promise<void> {
  await Promise.all(
    frames.map(async ({ frame }) => {
      await evaluateInFrame(
        frame,
        ({ key, neutral }) => {
          const registry = (globalThis as PageRegistryScope)[key];
          if (registry == null) return;
          if (neutral) {
            registry.snapshots = [];
            for (const owner of registry.owners) {
              // An override animation, not an inline write: a running animation or
              // transition outranks inline style, and an inline write starts a declared
              // transition (neutralizeTransformForFreeze).
              registry.snapshots.push({
                owner,
                styleAttribute: owner.getAttribute("style"),
                restore: neutralizeTransformForFreeze(owner, true),
              });
            }
          } else {
            const snapshots = registry.snapshots ?? [];
            for (let index = snapshots.length - 1; index >= 0; index--) snapshots[index].restore();
            registry.snapshots = null;
          }
        },
        { key, neutral },
      );
    }),
  );
}

async function settleFrames(frames: readonly PreparedFrame[]): Promise<void> {
  await Promise.all(
    frames
      .filter(({ hasTransformOwners }) => hasTransformOwners)
      .map(async ({ frame }) => {
        // A hidden/throttled renderer can stop delivering rAF callbacks without
        // detaching the Frame, leaving Runtime.callFunctionOn pending forever.
        // The mutation is synchronous; this wait is only a best-effort compositor
        // settle, so cap it rather than wedging the entire fixture/worker.
        const settle = waitForCaptureAnimationFrames(frame, 2, 1_000).catch(() => undefined);
        await withTimeout(settle, 1_000);
      }),
  );
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
    const evaluated = await session
      .send("Runtime.evaluate", {
        expression: `globalThis[${JSON.stringify(key)}]?.token ?? ""`,
        contextId,
        returnByValue: true,
        silent: true,
      })
      .catch(() => null);
    const token = evaluated?.result.value;
    if (typeof token === "string" && token !== "") {
      result.set(token, contextId);
    }
  }
  return result;
}

/** @internal Exported so controlled CDP tests can prove the concurrency and
 * resource-lifetime contract without launching a browser. */
export async function measureTextPaintRows(
  session: CDPSession,
  key: string,
  frames: readonly PreparedFrame[],
  contexts: ReadonlyMap<string, number>,
  viewport: { x: number; y: number },
  concurrency = TEXT_PAINT_GEOMETRY_ROW_CONCURRENCY,
): Promise<Map<string, CapturedTextPaintQuad[]>> {
  const tasks: Array<{ frame: PreparedFrame; row: FrameRow }> = [];
  for (const frame of frames) {
    const contextId = contexts.get(frame.token);
    if (contextId == null) continue;
    for (const row of frame.rows) tasks.push({ frame, row });
  }
  const measured: Array<CapturedTextPaintQuad[] | undefined> = new Array(tasks.length);
  let nextTask = 0;
  const workerCount = Math.min(tasks.length, Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1)));
  const worker = async (): Promise<void> => {
    while (nextTask < tasks.length) {
      const taskIndex = nextTask++;
      const { frame, row } = tasks[taskIndex];
      const contextId = contexts.get(frame.token)!;
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
        const response = await session.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
        measured[taskIndex] = asQuads(response.quads, viewport);
      } catch {
        // Missing protocol geometry is handled by the explicit surface below.
      } finally {
        if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Populate only after every worker settles so Map iteration and downstream
  // row correlation remain in capture order regardless of response timing.
  const result = new Map<string, CapturedTextPaintQuad[]>();
  for (let index = 0; index < tasks.length; index++) {
    const quads = measured[index];
    if (quads == null) continue;
    const { frame, row } = tasks[index];
    result.set(`${frame.token}:${row.sourceTextNodeIndex}`, quads);
  }
  return result;
}

interface RangeMeasurement {
  fragments: BlinkRangeFragmentProbe[];
  failureReason?: string;
}

/**
 * Recover exact FragmentItem DOM intervals in the already-neutral frame.
 *
 * Pinned Blink returns a full `FragmentItem::LocalRect()` iff a queried Range
 * covers that item's complete `TextOffsetRange`; partial coverage returns the
 * shape-view sub-rect.  Prefixes therefore reveal the first full end and
 * suffixes reveal the last full start.  Exact-rectangle occurrence ranks keep
 * duplicate physical rectangles explicit instead of selecting by proximity.
 */
export async function measureRangeFragments(
  frames: readonly PreparedFrame[],
  key: string,
  /** Called once per frame whose whole probe failed; that frame contributes no rows. */
  onFrameFailure: (error: unknown) => void,
): Promise<Map<string, RangeMeasurement>> {
  const output = new Map<string, RangeMeasurement>();
  await Promise.all(
    frames.map(async ({ frame, token }) => {
      const rows = await evaluateInFrame(
        frame,
        ({ key }) => {
          const registry = (globalThis as PageRegistryScope)[key];
          if (registry == null) return [];
          const rect = (value: DOMRect): { x: number; y: number; width: number; height: number } => ({
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
          });
          const tokenFor = (value: { x: number; y: number; width: number; height: number }): string =>
            `${value.x}|${value.y}|${value.width}|${value.height}`;
          const rectsFor = (
            node: Text,
            start: number,
            end: number,
          ): Array<{ x: number; y: number; width: number; height: number }> => {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            return Array.from(range.getClientRects(), rect);
          };
          return registry.textRows.map((row: { textNode: Text }) => {
            try {
              const node = row.textNode;
              const textLength = node.data.length;
              const full = rectsFor(node, 0, textLength);
              if (full.length === 0)
                return { fragments: [], failureReason: "Range exposed no full text FragmentItems" };
              const fullTokens = full.map(tokenFor);
              const prefixCounts: Array<Map<string, number>> = [];
              const suffixCounts: Array<Map<string, number>> = [];
              const countsFor = (
                values: Array<{ x: number; y: number; width: number; height: number }>,
              ): Map<string, number> => {
                const counts = new Map<string, number>();
                for (const value of values) {
                  const token = tokenFor(value);
                  counts.set(token, (counts.get(token) ?? 0) + 1);
                }
                return counts;
              };
              for (let offset = 0; offset <= textLength; offset++) {
                prefixCounts.push(countsFor(rectsFor(node, 0, offset)));
                suffixCounts.push(countsFor(rectsFor(node, offset, textLength)));
              }
              const fragments: BlinkRangeFragmentProbe[] = [];
              for (let physicalFragmentIndex = 0; physicalFragmentIndex < full.length; physicalFragmentIndex++) {
                const token = fullTokens[physicalFragmentIndex];
                const forwardRank = fullTokens
                  .slice(0, physicalFragmentIndex + 1)
                  .filter((candidate) => candidate === token).length;
                const reverseRank = fullTokens
                  .slice(physicalFragmentIndex)
                  .filter((candidate) => candidate === token).length;
                const end = prefixCounts.findIndex((counts) => (counts.get(token) ?? 0) >= forwardRank);
                let start = -1;
                for (let offset = textLength; offset >= 0; offset--) {
                  if ((suffixCounts[offset].get(token) ?? 0) >= reverseRank) {
                    start = offset;
                    break;
                  }
                }
                if (start < 0 || end <= start) {
                  return {
                    fragments: [],
                    failureReason: "Range could not isolate an exact FragmentItem UTF-16 interval",
                  };
                }
                const isolated = rectsFor(node, start, end);
                if (isolated.length !== 1 || tokenFor(isolated[0]) !== token) {
                  return {
                    fragments: [],
                    failureReason: "isolated DOM UTF-16 interval does not reproduce one full FragmentItem",
                  };
                }
                fragments.push({
                  physicalFragmentIndex,
                  domUtf16Span: [start, end],
                  neutralRangeRect: full[physicalFragmentIndex],
                });
              }
              return { fragments };
            } catch (error) {
              return {
                fragments: [],
                failureReason: `Range FragmentItem probe failed: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          });
        },
        { key },
      ).catch((error: unknown) => {
        // A whole-frame failure drops every measured row, which downstream reads as
        // "no correlation" per element. Report it once so it is not mistaken for that.
        onFrameFailure(error);
        return [] as RangeMeasurement[];
      });
      for (let index = 0; index < rows.length; index++) {
        output.set(`${token}:${index}`, rows[index] as RangeMeasurement);
      }
    }),
  );
  return output;
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
    const built =
      failure != null || neutral == null
        ? { geometry: null, failureReason: failure ?? "neutral capture element correlation unavailable" }
        : buildCapturedTextPaintGeometry(
            neutral.textSegments ?? [],
            neutral.fontAscent,
            rows.map((row): ProtocolTextNodeGeometry => ({
              sourceTextNodeIndex: row.sourceTextNodeIndex,
              neutralQuads: row.neutralQuads,
              paintQuads: row.paintQuads,
              rangeFragments: row.rangeFragments,
              writingMode: row.writingMode,
              direction: row.direction,
              transformBox: row.transformBox,
              transformOrigin: row.transformOrigin,
              effectiveZoom: row.effectiveZoom,
            })),
          );
    // `geometry` is only built when `neutral` resolved; naming both lets the narrowing carry.
    if (built.geometry != null && neutral != null) {
      // DM-2470: retain the complete same-frame transform-neutral text bundle,
      // not only its correlated protocol quads. Pseudos, generated fragments,
      // decorations, raster candidates, and clips all share these coordinates
      // and must receive the one paint matrix together.
      built.geometry.neutral = {
        x: neutral.x,
        y: neutral.y,
        width: neutral.width,
        height: neutral.height,
        text: neutral.text,
        textSegments: built.splitSegments?.map((segment) => ({
          ...segment,
          xOffsets: segment.xOffsets == null ? undefined : [...segment.xOffsets],
          yOffsets: segment.yOffsets == null ? undefined : [...segment.yOffsets],
          xAdvances: segment.xAdvances == null ? undefined : [...segment.xAdvances],
          verticalAdvances: segment.verticalAdvances == null ? undefined : [...segment.verticalAdvances],
          verticalOrientations: segment.verticalOrientations == null ? undefined : [...segment.verticalOrientations],
          verticalNaturalWidths: segment.verticalNaturalWidths == null ? undefined : [...segment.verticalNaturalWidths],
          verticalCombineXOffsets:
            segment.verticalCombineXOffsets == null ? undefined : [...segment.verticalCombineXOffsets],
          sourceMapping:
            segment.sourceMapping == null
              ? undefined
              : {
                  ...segment.sourceMapping,
                  domUtf16Span: [...segment.sourceMapping.domUtf16Span],
                  renderedChunks: segment.sourceMapping.renderedChunks.map((chunk) => ({
                    renderedUtf16Span: [...chunk.renderedUtf16Span],
                    domUtf16Span: [...chunk.domUtf16Span],
                  })),
                },
          rasterRect: segment.rasterRect == null ? undefined : { ...segment.rasterRect },
          rasterGlyphs: segment.rasterGlyphs?.map((glyph) => ({ ...glyph, rect: { ...glyph.rect } })),
          pseudoBox: segment.pseudoBox == null ? undefined : { ...segment.pseudoBox },
        })),
        textTop: neutral.textTop,
        textLeft: neutral.textLeft,
        textHeight: neutral.textHeight,
        textWidth: neutral.textWidth,
        fontAscent: neutral.fontAscent,
        fontDescent: neutral.fontDescent,
        inputXOffsets: neutral.inputXOffsets == null ? undefined : [...neutral.inputXOffsets],
      };
      frameFacts[elementIndex] = { geometry: built.geometry };
      continue;
    }
    const ownerKey = rows[0].surfaceOwnerKey;
    const ownerToken = ownerKey.slice(0, ownerKey.indexOf(":"));
    const ownerIndex = ownerKey.slice(ownerKey.indexOf(":") + 1);
    const ownerFacts = output.get(ownerToken);
    if (ownerFacts != null)
      ownerFacts[ownerIndex] = {
        surfaceReason: built.failureReason ?? "authoritative text geometry unavailable",
      };
  }
  return output;
}

interface LiveTextFrameSample {
  ownerBox: LiveTextRect;
  memberBox?: LiveTextRect;
  memberStyles?: string[][];
  origin: { x: number; y: number };
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };
  children: { type: number; data: string | null }[];
  ranges: LiveTextRect[][];
  typography: string[];
  animations: { currentTime: number | null; playbackRate: number }[];
}

/** Read the candidate afresh, with no CSS writes, animation override or CDP
 * playback-rate change. All rows belong directly to one paused
 * top-document owner or its one static inline-block member. Each row may
 * contain several horizontal fragments. */
async function sampleReadOnlyLiveTextFrame(frame: Frame, key: string): Promise<LiveTextFrameSample | undefined> {
  return evaluateInFrame(
    frame,
    (registryKey) => {
      const { owners, textRows } = (globalThis as PageRegistryScope)[registryKey] ?? {};
      if (owners?.length !== 1 || textRows == null || textRows.length === 0) return;
      const [owner] = owners;
      const { element } = textRows[0];
      if (!owner.isConnected || !element.isConnected) return;
      if (element.ownerDocument.fonts.status !== "loaded") return;
      const children = Array.from(element.childNodes);
      const directTextNodes: Text[] = [];
      for (const child of children) {
        if (child.nodeType === Node.COMMENT_NODE) continue;
        if (!(child instanceof Text)) return;
        if (!child.data.trim()) continue;
        if (!/^[ -~]+$/.test(child.data)) return;
        directTextNodes.push(child);
      }
      if (
        directTextNodes.length !== textRows.length ||
        textRows.some((row, index) => row.element !== element || row.textNode !== directTextNodes[index])
      )
        return;

      const style = getComputedStyle(element);
      const ownerStyle = owner === element ? style : getComputedStyle(owner);
      const isMember = owner !== element;
      if (isMember) {
        if (
          devicePixelRatio !== 1 ||
          (visualViewport?.scale ?? 1) !== 1 ||
          element.parentElement !== owner ||
          Array.from(owner.childNodes).some(
            (node) =>
              node !== element &&
              node.nodeType !== Node.COMMENT_NODE &&
              (node.nodeType !== Node.TEXT_NODE || node.textContent?.trim() !== ""),
          ) ||
          style.display !== "inline-block" ||
          style.position !== "static" ||
          element.getAnimations().length !== 0
        )
          return;
        // An ancestor clip, transform, or compositing effect can move the
        // sample off the authenticated device basis even when its DOM box
        // stays fixed. Recheck those boundaries with each member sample.
        for (let ancestor = owner.parentElement; ancestor != null; ancestor = ancestor.parentElement) {
          const cs = getComputedStyle(ancestor);
          if (
            cs.transform !== "none" ||
            cs.translate !== "none" ||
            cs.rotate !== "none" ||
            cs.scale !== "none" ||
            cs.perspective !== "none" ||
            cs.transformStyle !== "flat" ||
            cs.contain !== "none" ||
            cs.opacity !== "1" ||
            cs.filter !== "none" ||
            cs.backdropFilter !== "none" ||
            cs.clipPath !== "none" ||
            cs.maskImage !== "none" ||
            cs.mixBlendMode !== "normal" ||
            cs.willChange !== "auto" ||
            cs.isolation !== "auto" ||
            cs.overflowX !== "visible" ||
            cs.overflowY !== "visible" ||
            ancestor.getAnimations().length !== 0
          )
            return;
        }
        for (const cs of [ownerStyle, style]) {
          if (
            cs.opacity !== "1" ||
            cs.mixBlendMode !== "normal" ||
            cs.willChange !== "auto" ||
            cs.appearance !== "none" ||
            cs.content !== "normal" ||
            cs.getPropertyValue("-webkit-box-reflect") !== "none" ||
            cs.boxShadow !== "none" ||
            cs.textShadow !== "none" ||
            cs.textDecorationLine !== "none" ||
            cs.textEmphasisStyle !== "none" ||
            cs.textOverflow !== "clip" ||
            cs.getPropertyValue("-webkit-line-clamp") !== "none" ||
            cs.getPropertyValue("-webkit-text-stroke-width") !== "0px" ||
            cs.backgroundClip !== "border-box" ||
            cs.backgroundBlendMode !== "normal" ||
            !["none", "solid"].includes(cs.outlineStyle) ||
            cs.outlineOffset !== "0px" ||
            [
              cs.borderLeftWidth,
              cs.borderTopWidth,
              cs.borderRightWidth,
              cs.borderBottomWidth,
              cs.borderTopLeftRadius,
              cs.borderTopRightRadius,
              cs.borderBottomRightRadius,
              cs.borderBottomLeftRadius,
            ].some((value) => value !== "0px") ||
            !["none", ""].includes(cs.getPropertyValue("border-shape"))
          )
            return;
        }
      }
      if (
        style.writingMode !== "horizontal-tb" ||
        style.direction !== "ltr" ||
        style.textTransform !== "none" ||
        ownerStyle.translate !== "none" ||
        ownerStyle.rotate !== "none" ||
        ownerStyle.scale !== "none" ||
        ownerStyle.transformBox === "content-box" ||
        ownerStyle.transformBox === "fill-box" ||
        !ownerStyle.transform.startsWith("matrix(")
      )
        return;

      const animations = owner.getAnimations();
      if (animations.length !== 1 || animations[0].playState !== "paused" || animations[0].pending) return;
      const active = animations[0];
      if (
        !(active.effect instanceof KeyframeEffect) ||
        active.effect.target !== owner ||
        !active.effect.getKeyframes().some((keyframe) => "transform" in keyframe) ||
        (active.currentTime != null && typeof active.currentTime !== "number")
      )
        return;
      for (const textBox of isMember ? [owner, element] : [element]) {
        for (const pseudo of ["::before", "::after"]) {
          if (!["none", "normal", ""].includes(getComputedStyle(textBox, pseudo).content)) return;
        }
      }
      const comparedProperties = ["font-size", "font-family", "font-weight", "font-style", "color", "text-shadow"];
      const spacingProperties = ["line-height", "letter-spacing", "word-spacing"];
      const rectRecord = ({ x, y, width, height }: DOMRect): LiveTextRect => ({ x, y, width, height });
      const ranges: LiveTextRect[][] = [];
      const range = document.createRange();
      for (const textNode of directTextNodes) {
        range.selectNodeContents(textNode);
        const rects = Array.from(range.getClientRects(), rectRecord);
        if (rects.length === 0 || rects.some(({ width, height }) => width === 0 || height === 0)) return;
        ranges.push(rects);
      }
      // The ordinary text walk applies first-line overrides to one segment.
      // With multiple rows or fragments require the same styles throughout.
      const pseudoProperties =
        ranges.length > 1 || ranges[0].length > 1
          ? [...comparedProperties, ...spacingProperties, "text-transform", "font-variant"]
          : comparedProperties;
      for (const pseudo of ["::first-letter", "::first-line"]) {
        const pseudoStyle = getComputedStyle(element, pseudo);
        if (!["", "auto", "normal"].includes(pseudoStyle.getPropertyValue("initial-letter"))) return;
        if (
          pseudoProperties.some((property) => {
            const value = pseudoStyle.getPropertyValue(property);
            return value !== "" && value !== style.getPropertyValue(property);
          })
        )
          return;
      }

      const originParts = ownerStyle.transformOrigin.trim().split(/\s+/);
      if (originParts.length !== 2 || originParts.some((part) => !/^-?(?:\d+\.?\d*|\.\d+)px$/.test(part))) return;
      const [originX, originY] = originParts.map(Number.parseFloat);
      const { a, b, c, d, e, f } = new DOMMatrix(ownerStyle.transform);
      return {
        ownerBox: rectRecord(owner.getBoundingClientRect()),
        ...(isMember
          ? {
              memberBox: rectRecord(element.getBoundingClientRect()),
              memberStyles: [ownerStyle, style].map((cs) => Array.from(cs, (name) => cs.getPropertyValue(name))),
            }
          : {}),
        origin: { x: originX, y: originY },
        transform: { a, b, c, d, e, f },
        children: children.map(({ nodeType, nodeValue }) => ({ type: nodeType, data: nodeValue })),
        ranges,
        typography: [...comparedProperties, ...spacingProperties].map((property) => style.getPropertyValue(property)),
        animations: [{ currentTime: active.currentTime, playbackRate: active.playbackRate }],
      };
    },
    key,
  );
}

async function storeLiveTextInverse(frame: Frame, key: string, inverse?: LiveTextInverse): Promise<void> {
  await evaluateInFrame(
    frame,
    ({ key, inverse }) => {
      const registry = (globalThis as PageRegistryScope)[key];
      if (registry != null) registry.liveTextInverse = inverse;
    },
    { key, inverse },
  );
}

interface TextProbeTree {
  tree: CapturedElement[];
}

/** Animated compositor paint with a fractional device edge can differ from
 * an exact SVG stroke or fill (DM-YG7K2M). Only admit whole device edges,
 * including the outer edges of solid outlines. */
function hasAlignedLiveTextMemberPaint(
  owner: CapturedElement,
  member: CapturedElement,
  viewport: { x: number; y: number },
  sample: LiveTextFrameSample,
): boolean {
  if (
    !Number.isInteger(viewport.x) ||
    !Number.isInteger(viewport.y) ||
    owner.elementRaster != null ||
    owner.transformSubtreeRaster != null ||
    member.elementRaster != null ||
    member.transformSubtreeRaster != null
  )
    return false;
  const matrix = emittedElementTextAffine(owner);
  const { a, d, e, f } = sample.transform;
  const shift = owner.styles.transformPaintShift ?? [0, 0];
  const coordinates = [owner.x + sample.origin.x, owner.y + sample.origin.y, e + shift[0], f + shift[1]];
  if (
    matrix == null ||
    matrix[0] !== a ||
    matrix[3] !== d ||
    matrix[1] !== 0 ||
    matrix[2] !== 0 ||
    [a, d].some((n) => svgTransformCoefficient(n) !== n) ||
    coordinates.some((n) => svgTransformCoordinate(n) !== n)
  )
    return false;
  for (const box of [owner, member]) {
    const background = parseColor(box.styles.backgroundColor);
    const outline =
      box.styles.outlineStyle === "solid" ? parseColor(box.styles.outlineColor ?? box.styles.color) : null;
    if (
      background == null ||
      (background.a !== 0 && background.a !== 1) ||
      (box.styles.outlineStyle === "solid" && outline?.a !== 0 && outline?.a !== 1)
    )
      return false;
    const width = outline?.a === 1 ? Number.parseFloat(box.styles.outlineWidth ?? "") : 0;
    if (!Number.isInteger(width) || width < 0) return false;
    if (background.a === 0 && width === 0) continue;
    if (authenticBorderPaintSnap(box) == null) return false;
    const { left, top, right, bottom } = snappedBorderEdges(box);
    if (right <= left || bottom <= top) return false;
    const xEdges = [left, right, left - width, right + width];
    const yEdges = [top, bottom, top - width, bottom + width];
    // The current opaque background and solid rectangular outline serialize
    // snap-backed coordinates to six decimals.
    if ([...xEdges, ...yEdges].some((n) => svgTransformCoordinate(n) !== n)) return false;
    if (
      xEdges.some((x) => !Number.isInteger(a * x + matrix[4])) ||
      yEdges.some((y) => !Number.isInteger(d * y + matrix[5]))
    )
      return false;
  }
  return true;
}

async function prepareReadOnlyLiveText(
  session: CDPSession,
  prepared: readonly PreparedFrame[],
  key: string,
  viewport: { x: number; y: number },
  captureReadOnlyTree: (key: string) => Promise<TextProbeTree>,
  adoptTopology?: (key: string) => Promise<boolean>,
): Promise<{ verify: () => Promise<boolean> } | undefined> {
  const preparedFrame = prepared[0];
  if (prepared.length !== 1 || !preparedFrame.hasReadOnlyLiveTextCandidate) return;
  const { frame, token, rows } = preparedFrame;
  const textKey = rows[0].sourceKey;
  const ownerKey = rows[0].surfaceOwnerKey;
  const start = await sampleReadOnlyLiveTextFrame(frame, key);
  if (start == null || start.ranges.length !== rows.length) return;
  const inverse = liveTextInverse(start.ownerBox, start.transform, start.origin);
  if (inverse == null) return;
  if (adoptTopology != null && !(await adoptTopology(key))) return;
  const verify = async () => JSON.stringify(await sampleReadOnlyLiveTextFrame(frame, key)) === JSON.stringify(start);
  let adopted = false;
  try {
    const contexts = await defaultRuntimeContexts(session, key);
    const [live, ranges] = await Promise.all([
      measureTextPaintRows(session, key, prepared, contexts, viewport),
      measureRangeFragments(prepared, key, () => {}),
    ]);
    const measured: MeasuredRow[] = [];
    for (const [index, row] of rows.entries()) {
      const measurementKey = `${token}:${row.sourceTextNodeIndex}`;
      const paintQuads = live.get(measurementKey);
      const range = ranges.get(measurementKey);
      const expected = start.ranges[index];
      if (
        paintQuads?.length !== expected.length ||
        range?.fragments.length !== expected.length ||
        range.failureReason != null ||
        JSON.stringify(range.fragments.map(({ neutralRangeRect }) => neutralRangeRect)) !== JSON.stringify(expected)
      )
        return;
      const neutralQuads: CapturedTextPaintQuad[] = [];
      const rangeFragments: BlinkRangeFragmentProbe[] = [];
      for (const [fragmentIndex, fragment] of range.fragments.entries()) {
        const neutralQuad = invertLiveTextQuad(paintQuads[fragmentIndex], inverse, viewport);
        const neutralRangeRect = invertLiveTextRect(fragment.neutralRangeRect, inverse);
        if (neutralQuad == null || neutralRangeRect == null) return;
        neutralQuads.push(neutralQuad);
        rangeFragments.push({ ...fragment, neutralRangeRect });
      }
      measured.push({ ...row, paintQuads, neutralQuads, rangeFragments });
    }
    if (!(await verify())) return;

    await storeLiveTextInverse(frame, key, inverse);
    const neutral = await captureReadOnlyTree(key);
    const localBox = invertLiveTextRect(start.ownerBox, inverse);
    const bySourceKey = new Map<string, ProbeTreeElement>();
    walkProbeTree(neutral.tree as ProbeTreeElement[], bySourceKey);
    const neutralOwner = bySourceKey.get(ownerKey);
    if (
      localBox == null ||
      neutralOwner == null ||
      neutralOwner.x !== localBox.x - viewport.x ||
      neutralOwner.y !== localBox.y - viewport.y ||
      neutralOwner.width !== localBox.width ||
      neutralOwner.height !== localBox.height
    )
      return;
    if (start.memberBox != null) {
      const member = bySourceKey.get(textKey);
      const localMember = invertLiveTextRect(start.memberBox, inverse);
      if (
        member == null ||
        localMember == null ||
        neutralOwner.children.length !== 1 ||
        neutralOwner.children[0] !== member ||
        member.children.length !== 0 ||
        member.x !== localMember.x - viewport.x ||
        member.y !== localMember.y - viewport.y ||
        member.width !== localMember.width ||
        member.height !== localMember.height ||
        !hasAlignedLiveTextMemberPaint(neutralOwner, member, viewport, start)
      )
        return;
    }
    const facts = factsByFrame(prepared, measured, neutral.tree as ProbeTreeElement[]).get(token);
    const textIndex = textKey.slice(textKey.indexOf(":") + 1);
    const text = facts?.[textIndex] as { geometry?: unknown } | undefined;
    if (text?.geometry == null || !(await verify())) return;
    const finalQuads = await measureTextPaintRows(session, key, prepared, contexts, viewport);
    for (const { sourceTextNodeIndex, paintQuads } of measured) {
      const lastQuads = finalQuads.get(`${token}:${sourceTextNodeIndex}`);
      if (lastQuads == null || quadSetDistance(paintQuads, lastQuads) !== 0) return;
    }
    if (!(await verify())) return;
    await evaluateInFrame(
      frame,
      ({ key, facts }) => {
        const registry = (globalThis as PageRegistryScope)[key];
        if (registry != null) registry.factsByElement = facts;
      },
      { key, facts: facts ?? {} },
    );
    adopted = true;
    return { verify };
  } catch {
    return;
  } finally {
    if (!adopted) await storeLiveTextInverse(frame, key).catch(() => undefined);
  }
}

/**
 * Measure one coherent live/neutral/restored frame and leave per-element facts
 * in private frame globals for the synchronous capture script to consume.
 */
export async function prepareTextPaintGeometry(
  page: Page,
  selector: string,
  viewport: { x: number; y: number; width: number; height: number },
  captureNeutralTree: (key: string) => Promise<TextProbeTree>,
  captureReadOnlyTree?: (key: string) => Promise<TextProbeTree>,
  adoptReadOnlyTopology?: (key: string) => Promise<boolean>,
): Promise<TextPaintGeometryProbe> {
  const registry = createPageRegistry<unknown>(page, "TextPaintGeometry");
  const key = registry.key;
  const prepared = (
    await Promise.all(page.frames().map((frame, index) => setupFrameRegistry(frame, selector, key, `f${index}`)))
  ).filter((frame): frame is PreparedFrame => frame != null);
  await Promise.all(
    prepared.map(({ frame }) =>
      registry
        .tag(frame, (probeKey) => (globalThis as typeof globalThis & Record<string, unknown>)[probeKey], key)
        .catch(() => undefined),
    ),
  );
  const warnings: CaptureWarning[] = [];
  let playbackRate: number | undefined;
  let neutral = false;
  const hasLiveAffineBoxCandidates = prepared.some((frame) => frame.hasLiveAffineBoxCandidates);
  if (
    captureReadOnlyTree != null &&
    page.frames().length === 1 &&
    prepared.length === 1 &&
    prepared[0].hasReadOnlyLiveTextCandidate
  ) {
    const readOnly = await withCdpSession(page, (session) =>
      prepareReadOnlyLiveText(session, prepared, key, viewport, captureReadOnlyTree, adoptReadOnlyTopology),
    ).catch(() => undefined);
    if (readOnly != null) {
      return {
        key,
        warnings,
        hasLiveAffineBoxCandidates,
        verifyLiveTextFrame: readOnly.verify,
        withNeutralTransforms: (work) => work(),
        dispose: () => registry.dispose(),
      };
    }
  }
  try {
    await withCdpSession(page, async (session) => {
      try {
        if (prepared.every(({ rows }) => rows.length === 0)) return;
        const contexts = await defaultRuntimeContexts(session, key);
        try {
          await session.send("Animation.enable");
          playbackRate = (await session.send("Animation.getPlaybackRate")).playbackRate;
          await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
        } catch {
          playbackRate = undefined;
        }
        const live = await measureTextPaintRows(session, key, prepared, contexts, viewport);
        await mutateFrames(prepared, key, true);
        neutral = true;
        await settleFrames(prepared);
        const [neutralQuads, neutralRangeFragments] = await Promise.all([
          measureTextPaintRows(session, key, prepared, contexts, viewport),
          measureRangeFragments(prepared, key, (cause) =>
            warnings.push(
              probeFailureWarning({
                selector,
                feature: "transform",
                probe: "Range FragmentItem probe for a frame",
                cause,
                effect: "its text elements take the legacy text path",
              }),
            ),
          ),
        ]);
        const neutralResult = await captureNeutralTree(key);
        await mutateFrames(prepared, key, false);
        neutral = false;
        await settleFrames(prepared);
        const restored = await measureTextPaintRows(session, key, prepared, contexts, viewport);

        const measured: MeasuredRow[] = [];
        for (const frame of prepared) {
          for (const row of frame.rows) {
            const measurementKey = `${frame.token}:${row.sourceTextNodeIndex}`;
            const paintQuads = live.get(measurementKey) ?? [];
            const localQuads = neutralQuads.get(measurementKey) ?? [];
            const rangeMeasurement = neutralRangeFragments.get(measurementKey);
            const rangeFragments = rangeMeasurement?.fragments ?? [];
            const restoredQuads = restored.get(measurementKey) ?? [];
            let failureReason: string | undefined = rangeMeasurement?.failureReason;
            if (paintQuads.length === 0 || localQuads.length === 0) {
              failureReason = "DOM.getContentQuads unavailable for text node";
            } else if (rangeFragments.length === 0) {
              failureReason ??= "Range FragmentItem source spans unavailable for text node";
            } else if (quadSetDistance(paintQuads, restoredQuads) > RESTORE_EPSILON) {
              failureReason = "text transform probe did not restore the source frame exactly";
            }
            measured.push({ ...row, neutralQuads: localQuads, paintQuads, rangeFragments, failureReason });
          }
        }
        const byFrame = factsByFrame(prepared, measured, neutralResult.tree as ProbeTreeElement[]);
        await Promise.all(
          prepared.map(({ frame, token }) =>
            evaluateInFrame(
              frame,
              ({ key, facts }) => {
                const registry = (globalThis as PageRegistryScope)[key];
                if (registry != null) registry.factsByElement = facts;
              },
              { key, facts: byFrame.get(token) ?? {} },
            ),
          ),
        );
      } finally {
        if (neutral) await mutateFrames(prepared, key, false).catch(() => undefined);
        if (playbackRate != null) {
          await session.send("Animation.setPlaybackRate", { playbackRate }).catch(() => undefined);
        }
        await session.send("Animation.disable").catch(() => undefined);
      }
    });
  } catch (error) {
    warnings.push({
      selector,
      feature: "transform",
      detail: `authoritative affine text-fragment probe failed closed: ${error instanceof Error ? error.message : String(error)}`,
    });
    // Ensure every text-bearing element selects a Chromium-owned surface.
    await Promise.all(
      prepared.map(({ frame, rows }) => {
        const facts: Record<string, unknown> = {};
        for (const row of rows) {
          const ownerIndex = row.surfaceOwnerKey.slice(row.surfaceOwnerKey.indexOf(":") + 1);
          facts[ownerIndex] = { surfaceReason: "authoritative affine text-fragment probe unavailable" };
        }
        return evaluateInFrame(
          frame,
          ({ key, facts }) => {
            const registry = (globalThis as PageRegistryScope)[key];
            if (registry != null) registry.factsByElement = facts;
          },
          { key, facts },
        ).catch(() => undefined);
      }),
    );
  }

  return {
    key,
    warnings,
    hasLiveAffineBoxCandidates,
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
    dispose: () => registry.dispose(),
  };
}
