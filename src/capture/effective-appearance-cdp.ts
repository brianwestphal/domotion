/**
 * CDP bridge for Blink's HasAuthorBackground / HasAuthorBorder facts.
 *
 * CSSOM cannot read cross-origin sheets and a resolved color comparison loses
 * cascade origin. Chromium's CSS agent can see the rules that Blink actually
 * matched (including cross-origin sheets, active conditions, layers, scopes,
 * and tree scopes), so attach the recovered flags to each live control through
 * a collision-resistant expando before the in-page capture walk.
 */

import type { Page } from "@playwright/test";
import { privateCaptureKey } from "./private-key.js";
import {
  authorControlStyleFactsFromMatchedStyles,
  type AuthorControlStyleFacts,
  type CdpMatchedStylesLike,
} from "./effective-appearance.js";

interface CdpNode {
  nodeId: number;
  backendNodeId?: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
  contentDocument?: CdpNode;
}

const CONTROL_NODE_NAMES = new Set(["BUTTON", "INPUT", "METER", "PROGRESS", "SELECT", "TEXTAREA"]);
// Keep CDP pressure bounded while overlapping independent matched-style
// queries. Serial visits on pages with many offscreen controls dominated every
// full-depth scroll anchor (Resend: about 77s in this pass alone).
const CONTROL_PROBE_CONCURRENCY = 8;
const VIEWPORT_FILTER_MIN_CONTROLS = 16;

export function controlBoxMayPaintViewport(
  bounds: readonly number[],
  scrollX: number,
  scrollY: number,
  viewport: { x: number; y: number; width: number; height: number },
): boolean {
  const [documentX, documentY, width, height] = bounds;
  // Unknown or degenerate layout is not proof that a control cannot paint.
  if (![documentX, documentY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return true;
  const x = documentX - scrollX;
  const y = documentY - scrollY;
  return (
    x + width >= viewport.x &&
    x <= viewport.x + viewport.width &&
    y + height >= viewport.y &&
    y <= viewport.y + viewport.height
  );
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 240);
}

function computedMap(properties: Array<{ name: string; value: string }> | undefined): Map<string, string> {
  return new Map((properties ?? []).map(({ name, value }) => [name, value]));
}

export interface EffectiveAppearanceFactCapture {
  propertyKey: string;
  setupFailure?: string;
  dispose(): Promise<void>;
}

/**
 * Capture origin-sensitive style facts without ever falling back to CSSOM.
 * A per-node/protocol failure is stored as an unavailable fact; the in-page
 * classifier then warns and keeps a conservative Chromium-owned host raster.
 */
export async function captureEffectiveAppearanceFacts(
  page: Page,
  viewport: { x: number; y: number; width: number; height: number },
): Promise<EffectiveAppearanceFactCapture> {
  const session = await page.context().newCDPSession(page);
  const propertyKey = privateCaptureKey("EffectiveAppearance");
  const objectGroup = `${propertyKey}_objects`;
  const hostObjectIds = new Set<string>();
  let setupFailure: string | undefined;

  const attach = async (nodeId: number, facts: AuthorControlStyleFacts): Promise<void> => {
    const resolved = await session.send("DOM.resolveNode", { nodeId, objectGroup });
    const objectId = resolved.object.objectId;
    if (objectId == null) throw new Error(`Chromium did not expose control node ${nodeId}`);
    await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(key, value) {
        Object.defineProperty(this, key, { value, configurable: true });
      }`,
      arguments: [{ value: propertyKey }, { value: facts }],
    });
    hostObjectIds.add(objectId);
  };

  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const documentResult = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const visited = new Set<number>();
    const controls: Array<{ nodeId: number; backendNodeId?: number; childFrame: boolean }> = [];
    const collect = (node: CdpNode, childFrame: boolean): void => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      if (CONTROL_NODE_NAMES.has(node.nodeName)) {
        controls.push({ nodeId: node.nodeId, backendNodeId: node.backendNodeId, childFrame });
      }
      for (const child of node.children ?? []) collect(child, childFrame);
      if (node.contentDocument != null) collect(node.contentDocument, true);
      for (const shadow of node.shadowRoots ?? []) {
        // Native UA-shadow parts have independent appearance values but are
        // not capture-tree hosts. Author shadow roots may contain real hosts.
        if (shadow.shadowRootType !== "user-agent") collect(shadow, childFrame);
      }
    };
    collect(documentResult.root as CdpNode, false);

    // The capture walker prunes controls whose layout boxes are outside its
    // viewport. A single DOMSnapshot supplies bounds for all live controls
    // and avoids dozens of expensive CSS-agent requests for offscreen hosts.
    // Snapshot bounds are document coordinates; subtract the current scroll
    // offset before comparing to the capture viewport. A missing fact, frame
    // boundary, or snapshot failure retains the control for exact CDP reads.
    let selectedControls = controls;
    if (controls.length >= VIEWPORT_FILTER_MIN_CONTROLS) {
      try {
        const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includeDOMRects: true,
        });
        const main = snapshot.documents[0];
        if (main?.nodes.backendNodeId != null && main.scrollOffsetX != null && main.scrollOffsetY != null) {
          const backendIds = main.nodes.backendNodeId;
          const scrollX = main.scrollOffsetX;
          const scrollY = main.scrollOffsetY;
          const boundsByBackend = new Map<number, number[]>();
          main.layout.nodeIndex.forEach((nodeIndex, index) => {
            const backendNodeId = backendIds[nodeIndex];
            const bounds = main.layout.bounds[index];
            if (backendNodeId != null && bounds != null) boundsByBackend.set(backendNodeId, bounds);
          });
          selectedControls = controls.filter(({ backendNodeId, childFrame }) => {
            if (childFrame || backendNodeId == null) return true;
            const bounds = boundsByBackend.get(backendNodeId);
            return bounds == null || controlBoxMayPaintViewport(bounds, scrollX, scrollY, viewport);
          });
        }
      } catch {
        selectedControls = controls;
      }
    }

    let nextControl = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONTROL_PROBE_CONCURRENCY, selectedControls.length) }, async () => {
        while (nextControl < selectedControls.length) {
          const nodeId = selectedControls[nextControl++].nodeId;
          let facts: AuthorControlStyleFacts;
          try {
            const [matched, computed, animated] = await Promise.all([
              session.send("CSS.getMatchedStylesForNode", { nodeId }),
              session.send("CSS.getComputedStyleForNode", { nodeId }),
              session.send("CSS.getAnimatedStylesForNode", { nodeId }),
            ]);
            const computedStyle = computedMap(computed.computedStyle);
            facts = authorControlStyleFactsFromMatchedStyles(
              {
                ...(matched as CdpMatchedStylesLike),
                animationStyles: animated.animationStyles,
                transitionsStyle: animated.transitionsStyle,
              },
              {
                direction: computedStyle.get("direction"),
                writingMode: computedStyle.get("writing-mode"),
              },
            );
          } catch (error) {
            facts = {
              available: false,
              hasAuthorBackground: false,
              hasAuthorBorder: false,
              reason: `matched styles unavailable: ${errorText(error)}`,
            };
          }
          // If a node detached between the CSS query and attachment, the page
          // walk cannot see it either. Other controls retain their exact facts.
          await attach(nodeId, facts).catch(() => undefined);
        }
      }),
    );
  } catch (error) {
    // Capture itself remains possible. Every control that needs these facts
    // will take the explicit warning + conservative source-raster route.
    setupFailure = `Chromium matched-style pre-pass unavailable: ${errorText(error)}`;
  }

  return {
    propertyKey,
    setupFailure,
    async dispose(): Promise<void> {
      await Promise.all(
        [...hostObjectIds].map(async (objectId) => {
          await session
            .send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function(key) { delete this[key]; }",
              arguments: [{ value: propertyKey }],
            })
            .catch(() => undefined);
        }),
      );
      await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}
