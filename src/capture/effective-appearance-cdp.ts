/**
 * CDP bridge for Blink's HasAuthorBackground / HasAuthorBorder facts.
 *
 * CSSOM cannot read cross-origin sheets and a resolved color comparison loses
 * cascade origin. Chromium's CSS agent can see the rules that Blink actually
 * matched (including cross-origin sheets, active conditions, layers, scopes,
 * and tree scopes), so attach the recovered flags to each live control through
 * a collision-resistant expando before the in-page capture walk.
 */

import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";
import {
  authorControlStyleFactsFromMatchedStyles,
  type AuthorControlStyleFacts,
  type CdpMatchedStylesLike,
} from "./effective-appearance.js";

interface CdpNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
  contentDocument?: CdpNode;
}

const CONTROL_NODE_NAMES = new Set([
  "BUTTON", "INPUT", "METER", "PROGRESS", "SELECT", "TEXTAREA",
]);

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
export async function captureEffectiveAppearanceFacts(page: Page): Promise<EffectiveAppearanceFactCapture> {
  const session = await page.context().newCDPSession(page);
  const propertyKey = `__domotionEffectiveAppearance_${randomUUID().replaceAll("-", "")}`;
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

    const visit = async (node: CdpNode): Promise<void> => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);

      if (CONTROL_NODE_NAMES.has(node.nodeName)) {
        let facts: AuthorControlStyleFacts;
        try {
          const [matched, computed, animated] = await Promise.all([
            session.send("CSS.getMatchedStylesForNode", { nodeId: node.nodeId }),
            session.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId }),
            session.send("CSS.getAnimatedStylesForNode", { nodeId: node.nodeId }),
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
        await attach(node.nodeId, facts).catch(() => undefined);
      }

      for (const child of node.children ?? []) await visit(child);
      if (node.contentDocument != null) await visit(node.contentDocument);
      for (const shadow of node.shadowRoots ?? []) {
        // Native UA-shadow parts have independent appearance values but are
        // not capture-tree hosts. Author shadow roots may contain real hosts.
        if (shadow.shadowRootType !== "user-agent") await visit(shadow);
      }
    };

    await visit(documentResult.root as CdpNode);
  } catch (error) {
    // Capture itself remains possible. Every control that needs these facts
    // will take the explicit warning + conservative source-raster route.
    setupFailure = `Chromium matched-style pre-pass unavailable: ${errorText(error)}`;
  }

  return {
    propertyKey,
    setupFailure,
    async dispose(): Promise<void> {
      await Promise.all([...hostObjectIds].map(async (objectId) => {
        await session.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(key) { delete this[key]; }",
          arguments: [{ value: propertyKey }],
        }).catch(() => undefined);
      }));
      await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}
