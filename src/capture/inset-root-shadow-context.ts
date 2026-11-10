import type { CDPSession, Page } from "@playwright/test";
import { parseBoxShadow } from "../render/box-shadow.js";
import { isPaintedColor } from "../utils/transparent-background.js";
import { withTimeout } from "../utils/with-timeout.js";
import { detachQuietly, withCdpSession } from "./cdp-lifecycle.js";
import { privateCaptureKey } from "./private-key.js";
import { probeFailureWarning } from "./probe-failure.js";
import type { CaptureWarning } from "./types.js";

/** Private page-owned record; never serialized as a transferable boolean. */
export interface InsetRootShadowContextRecord {
  source: "domotion-inset-root-shadow-context-v1";
  owner: string;
  root: Element;
  document: Document;
  context: Window;
  disposition: "none" | "present" | "unavailable";
}

/** Minimal public DOM.getDocument(depth:-1,pierce:true) shape. */
export interface ShadowContextDomNode {
  backendNodeId: number;
  nodeType: number;
  children?: ShadowContextDomNode[];
  shadowRoots?: ShadowContextDomNode[];
  shadowRootType?: string;
  contentDocument?: ShadowContextDomNode;
}

/** Inspect the complete pierced DOM, including empty author shadow roots.
 * A light-DOM node's page-visible parent/assignedSlot cannot expose a closed
 * shadow composition. Refuse host chains rather than invent their paint map. */
export function rootHasAuthorShadowContext(
  documentRoot: ShadowContextDomNode,
  backendNodeId: number,
  deadlineAt = Infinity,
): boolean | null {
  if (documentRoot.nodeType !== 9 || !Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
  const pending = [{ node: documentRoot, authorContext: false }];
  const visited = new Set<ShadowContextDomNode>();
  const matches: boolean[] = [];
  while (pending.length > 0) {
    if (performance.now() > deadlineAt) return null;
    const entry = pending.pop()!;
    if (visited.has(entry.node)) return null;
    visited.add(entry.node);
    const { node } = entry;
    const shadows = node.shadowRoots ?? [];
    if (shadows.some((shadow) => !["open", "closed", "user-agent"].includes(shadow.shadowRootType ?? ""))) return null;
    const authorContext = entry.authorContext || shadows.some((shadow) => shadow.shadowRootType !== "user-agent");
    if (node.backendNodeId === backendNodeId) matches.push(authorContext);
    for (const child of node.children ?? []) pending.push({ node: child, authorContext });
    for (const shadow of shadows) {
      pending.push({ node: shadow, authorContext: authorContext || shadow.shadowRootType !== "user-agent" });
    }
    if (node.contentDocument) pending.push({ node: node.contentDocument, authorContext });
  }
  return matches.length === 1 ? matches[0] : null;
}

export interface InsetRootShadowContextProbe {
  key?: string;
  warnings: CaptureWarning[];
  dispose(): Promise<void>;
}

/** Candidate-only internal admission fact. The private record binds CDP's
 * actual root backend identity to the live Element and its owning context.
 * Missing/late/failed provenance refuses the new shadow-only path. */
export async function prepareInsetRootShadowContext(
  page: Page,
  selector: string,
  timeoutMs = 3000,
): Promise<InsetRootShadowContextProbe> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      warnings: [
        probeFailureWarning({
          selector,
          feature: "box-shadow root admission",
          probe: "selected-element author-shadow context",
          cause: "invalid Node deadline",
          status: "unavailable",
          effect: "new shadow-only root admission is refused",
        }),
      ],
      dispose: async () => undefined,
    };
  }
  const key = privateCaptureKey("InsetRootShadowContext");
  const deadlineAt = performance.now() + timeoutMs;
  const warnings: CaptureWarning[] = [];
  let expired = false;
  let disposed = false;
  let initialComplete = false;
  let tagged = false;
  let session: CDPSession | undefined;
  const cleanup = async (): Promise<void> => {
    if (initialComplete && !tagged) return;
    await withTimeout(
      page
        .evaluate((property) => {
          const host = globalThis as typeof globalThis & Record<string, InsetRootShadowContextRecord | undefined>;
          if (host[property]?.owner === property) delete host[property];
        }, key)
        .catch(() => undefined),
      250,
    );
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    expired = true;
    await withTimeout(detachQuietly(session), 250);
    await cleanup();
  };
  const operation = (async (): Promise<"not-candidate" | "ready"> => {
    const style = await page.evaluate(
      ({ property, selector }) => {
        const root = document.querySelector(selector);
        if (!root) return null;
        const cs = getComputedStyle(root);
        if (!cs.boxShadow.includes("inset")) return null;
        const host = globalThis as typeof globalThis & Record<string, InsetRootShadowContextRecord | undefined>;
        host[property] = {
          source: "domotion-inset-root-shadow-context-v1",
          owner: property,
          root,
          document,
          context: window,
          disposition: "unavailable",
        };
        return {
          boxShadow: cs.boxShadow,
          background: cs.backgroundColor,
          backgroundImage: cs.backgroundImage,
          border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].some(
            (value) => (parseFloat(value) || 0) > 0,
          ),
          content:
            /^(?:img|svg|canvas|video|iframe|object|embed|input|textarea|select|button|progress|meter)$/.test(
              root.localName,
            ) ||
            (root.localName.includes("-") && root.shadowRoot != null),
          text: Array.from(root.childNodes).some(
            (node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "",
          ),
        };
      },
      { property: key, selector },
    );
    initialComplete = true;
    tagged = style != null;
    if (expired) return "not-candidate";
    const shadows = parseBoxShadow(style?.boxShadow ?? "none");
    if (
      !style ||
      shadows.length === 0 ||
      shadows.some((shadow) => !shadow.inset) ||
      isPaintedColor(style.background) ||
      !["", "none"].includes(style.backgroundImage) ||
      style.border ||
      style.content ||
      style.text
    )
      return "not-candidate";

    const disposition = await withCdpSession(page, async (cdp) => {
      session = cdp;
      if (expired) return null;
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `globalThis[${JSON.stringify(key)}]?.root`,
        objectGroup: key,
      });
      let backendNodeId: number;
      try {
        if (expired || result.objectId == null || result.subtype !== "node") return null;
        const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId, depth: 0 });
        backendNodeId = node.backendNodeId;
      } finally {
        await cdp.send("Runtime.releaseObjectGroup", { objectGroup: key }).catch(() => undefined);
      }
      if (expired) return null;
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      return rootHasAuthorShadowContext(root, backendNodeId, deadlineAt);
    });
    if (expired || disposition == null) throw new Error("selected-element author-shadow context unavailable");
    const bound = await page.evaluate(
      ({ property, selector, disposition }) => {
        const host = globalThis as typeof globalThis & Record<string, InsetRootShadowContextRecord | undefined>;
        const state = host[property];
        if (
          state?.owner === property &&
          state.root === document.querySelector(selector) &&
          state.document === document &&
          state.context === window &&
          state.root.isConnected
        ) {
          state.disposition = disposition ? "present" : "none";
          return true;
        }
        return false;
      },
      { property: key, selector, disposition },
    );
    if (!bound) throw new Error("selected element or source context changed before binding");
    return "ready";
  })();
  // A tag/evaluation may finish after its Node deadline. Always clear it again
  // after that late completion, rather than resurrect a disposed registry.
  void operation
    .then(
      () => {
        if (expired) return cleanup();
      },
      () => {
        if (expired) return cleanup();
      },
    )
    .catch(() => undefined);
  try {
    const result = await withTimeout(operation, timeoutMs);
    if (result == null) throw new Error(`inset root shadow-context exceeded ${timeoutMs}ms Node deadline`);
    if (result === "not-candidate") {
      await dispose();
      return { warnings, dispose };
    }
    return { key, warnings, dispose };
  } catch (cause) {
    warnings.push(
      probeFailureWarning({
        selector,
        feature: "box-shadow root admission",
        probe: "selected-element author-shadow context",
        cause,
        status: "unavailable",
        effect: "new shadow-only root admission is refused; existing independently painted and container routes remain",
      }),
    );
    await dispose();
    return { warnings, dispose };
  }
}
