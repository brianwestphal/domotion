import type { CDPSession, Page } from "@playwright/test";
import { withCdpSession } from "./cdp-lifecycle.js";
import type { CapturedElement, CaptureWarning } from "./types.js";

/** Warning feature name for a captured canvas whose rendering context was lost. */
export const LOST_CANVAS_CONTEXT_FEATURE = "canvas-context-lost";

export const LOST_CANVAS_CONTEXT_DETAIL =
  "the canvas's rendering context was lost when captured, so Chromium painted, and the capture recorded, " +
  "a broken or cleared canvas instead of its drawing. A canvas drawn on a browser's first page during GPU " +
  "startup loses its context this way: launch with launchChromium(), or call awaitGpuFeatureInfo(browser) " +
  "before creating the first page of a browser you launch yourself";

/** Rendering-context interfaces that implement `isContextLost()`. */
const CONTEXT_INTERFACES = ["CanvasRenderingContext2D", "WebGLRenderingContext", "WebGL2RenderingContext"] as const;

const OBJECT_GROUP = "domotion-lost-canvas-contexts";

/**
 * @internal Exported for unit tests. Runs on the array `Runtime.queryObjects` returned, with the capture root
 * selector as its argument. Kept as source text: it executes in the page and
 * must not pick up bundler helpers. The selector is built the way the capture
 * script's `shortSelector` builds it, so the warning names the same element as
 * the capture's own `<canvas>` warning.
 */
export const LOST_CANVAS_SELECTORS = `function (rootSelector) {
  var roots = Array.prototype.slice.call(document.querySelectorAll(rootSelector));
  var shortSelector = function (el) {
    var parts = [];
    var cur = el;
    while (cur != null && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      var p = cur.tagName.toLowerCase();
      if (cur.id) { p += "#" + cur.id; parts.unshift(p); break; }
      if (cur.className && typeof cur.className === "string") {
        var cls = cur.className.trim().split(/\\s+/).slice(0, 2).join(".");
        if (cls !== "") p += "." + cls;
      }
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  var out = [];
  for (var i = 0; i < this.length; i++) {
    var context = this[i];
    var canvas = context.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) continue;
    if (!roots.some(function (root) { return root.contains(canvas); })) continue;
    if (!context.isContextLost()) continue;
    var selector = shortSelector(canvas);
    if (out.indexOf(selector) < 0) out.push(selector);
  }
  return out;
}`;

function treeHasCanvas(nodes: readonly CapturedElement[]): boolean {
  return nodes.some((node) => node.tag === "canvas" || treeHasCanvas(node.children ?? []));
}

async function lostCanvasSelectors(session: CDPSession, rootSelector: string): Promise<string[]> {
  const selectors: string[] = [];
  try {
    for (const name of CONTEXT_INTERFACES) {
      const { result: prototype } = await session.send("Runtime.evaluate", {
        expression: `typeof ${name} === "function" ? ${name}.prototype : undefined`,
        objectGroup: OBJECT_GROUP,
      });
      if (prototype.objectId == null) continue;
      // Enumerates the contexts that already exist, without creating one:
      // calling getContext() on a canvas that has none would create a context
      // and change what later page code gets back.
      const { objects } = await session.send("Runtime.queryObjects", {
        prototypeObjectId: prototype.objectId,
        objectGroup: OBJECT_GROUP,
      });
      if (objects.objectId == null) continue;
      const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
        objectId: objects.objectId,
        functionDeclaration: LOST_CANVAS_SELECTORS,
        arguments: [{ value: rootSelector }],
        returnByValue: true,
        objectGroup: OBJECT_GROUP,
      });
      if (exceptionDetails != null || !Array.isArray(result.value)) continue;
      for (const selector of result.value as unknown[]) {
        if (typeof selector === "string" && !selectors.includes(selector)) selectors.push(selector);
      }
    }
  } finally {
    await session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  }
  return selectors;
}

/**
 * Warn for each captured `<canvas>` in the top-level document whose 2D or
 * WebGL context reports `isContextLost()`.
 *
 * Chromium paints a lost canvas as a broken-canvas placeholder, and a restored
 * 2D context as a cleared canvas, so the capture faithfully records a canvas
 * without its drawing. The most common cause in automation is GPU startup: a
 * browser's first page created right after launch (see `awaitGpuFeatureInfo`).
 * `launchChromium` prevents that, but a browser the caller launched itself
 * cannot be fixed at capture time: the loss has already happened when the page
 * exists. This makes it visible instead.
 *
 * Coverage is partial by construction. WebGL contexts stay lost unless the page
 * restores them, so their loss is reported at any later capture; Chromium
 * restores a lost 2D context, cleared, about 500 ms later, after which its loss
 * is no longer observable. Contexts are found through their script objects,
 * so a context the page no longer references can be missed once V8 has
 * dropped its wrapper (measured: a context obtained inside one `evaluate` and
 * not stored was not found). Canvases inside frames and in OffscreenCanvas
 * workers are not inspected. Best effort: a CDP failure adds no warning and
 * never fails the capture. Only runs when the captured tree has a canvas.
 */
export async function warnLostCanvasContexts(
  page: Page,
  tree: readonly CapturedElement[],
  rootSelector: string,
  warnings: CaptureWarning[],
): Promise<void> {
  if (!treeHasCanvas(tree)) return;
  let selectors: string[];
  try {
    selectors = await withCdpSession(page, (session) => lostCanvasSelectors(session, rootSelector));
  } catch {
    return;
  }
  for (const selector of selectors) {
    warnings.push({ selector, feature: LOST_CANVAS_CONTEXT_FEATURE, detail: LOST_CANVAS_CONTEXT_DETAIL });
  }
}
