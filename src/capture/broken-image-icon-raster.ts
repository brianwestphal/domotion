/**
 * Minimal Chromium-owned raster for HTML's closed-UA-shadow broken-image icon.
 *
 * The page compositor is the decoding/sampling authority. For one screenshot
 * we hide every light-DOM surface, restore only the correlated image host,
 * neutralize author-owned host paint without changing layout, and suppress the
 * UA container border/text while retaining `#alttext-image`. `omitBackground`
 * then preserves the icon resource's real alpha instead of baking the page
 * backdrop into the SVG stamp.
 */
import { createHash } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";
import sharp from "sharp";
import { createPageRegistry } from "./page-registry.js";
import { planNativeControlClip, type NativeControlViewport } from "./native-control-raster.js";

type StyleValue = { value: string; priority: string };
type RestoreEntry = {
  element: Element & { style: CSSStyleDeclaration };
  exact: boolean;
  originalStyle: string | null;
  isolatedStyle: string | null;
  properties: Array<{ name: string; original: StyleValue; isolated: StyleValue }>;
};

export interface CapturedBrokenImageIconRaster {
  source: "chromium-isolated-ua-shadow-icon-v1";
  dataUri: string;
  rect: { x: number; y: number; width: number; height: number };
  pixelWidth: number;
  pixelHeight: number;
  pngSha256: string;
  rgbaSha256: string;
}

interface CaptureBrokenImageIconOptions {
  sourceNodeKey: string;
  sourceNodeIndex: number;
  iconBackendNodeId: number;
  iconRect: { x: number; y: number; width: number; height: number };
  viewport: NativeControlViewport;
}

async function restoreLightDom(page: Page, restoreKey: string): Promise<void> {
  await page
    .evaluate((key) => {
      const pageGlobal = globalThis as typeof globalThis & Record<string, unknown>;
      const entries = pageGlobal[key] as RestoreEntry[] | undefined;
      for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
        const entry = entries![index];
        const { element, originalStyle, isolatedStyle, properties } = entry;
        const current = element.getAttribute("style");
        if (entry.exact && current === isolatedStyle) {
          if (current === originalStyle) continue;
          if (originalStyle == null) element.removeAttribute("style");
          else element.setAttribute("style", originalStyle);
          continue;
        }
        // Source observers can edit the declaration during the screenshot.
        // Roll back only declarations that still carry our isolated value.
        for (const { name, original, isolated } of properties) {
          if (
            element.style.getPropertyValue(name) !== isolated.value ||
            element.style.getPropertyPriority(name) !== isolated.priority
          )
            continue;
          if (original.value === "") element.style.removeProperty(name);
          else element.style.setProperty(name, original.value, original.priority);
        }
      }
    }, restoreKey)
    .catch(() => undefined);
}

/** Capture one exact, alpha-bearing icon crop without host/text paint. */
export async function captureBrokenImageIconRaster(
  page: Page,
  session: CDPSession,
  options: CaptureBrokenImageIconOptions,
): Promise<CapturedBrokenImageIconRaster> {
  const plan = planNativeControlClip(options.iconRect, options.viewport);
  if (plan == null) throw new Error("visible broken-image icon is outside the capture viewport");

  const restoreRegistry = createPageRegistry<RestoreEntry[]>(page, "BrokenIconRestore");
  const restoreKey = restoreRegistry.key;
  let iconObjectId: string | undefined;
  let uaRestore: unknown;
  try {
    await restoreRegistry.tag(page, () => []);
    const prepared = await page.evaluate(
      ({ sourceNodeKey, sourceNodeIndex, restoreKey }) => {
        const pageGlobal = globalThis as typeof globalThis & Record<string, unknown>;
        const sourceNodes = pageGlobal[sourceNodeKey] as Element[] | undefined;
        const host = sourceNodes?.[sourceNodeIndex];
        if (!(host instanceof HTMLElement) || !host.isConnected) return false;
        const entries = pageGlobal[restoreKey] as RestoreEntry[];

        const canvasValues: Array<[string, string]> = [
          ["background-color", "transparent"],
          ["background-image", "none"],
        ];
        const hostValues: Array<[string, string]> = [
          ["visibility", "visible"],
          ["opacity", "1"],
          ["filter", "none"],
          ["backdrop-filter", "none"],
          ["mix-blend-mode", "normal"],
          ...canvasValues,
          ["border-top-color", "transparent"],
          ["border-right-color", "transparent"],
          ["border-bottom-color", "transparent"],
          ["border-left-color", "transparent"],
          ["border-image-source", "none"],
          ["box-shadow", "none"],
          ["outline-style", "none"],
          ["clip-path", "none"],
          ["mask-image", "none"],
        ];

        // Derive what the isolated attribute should contain on an inert node.
        // Reading it off a source node after writing could claim a synchronous
        // custom-element callback's change as part of our own transaction.
        const witness = document.createElement("span");
        for (const node of document.querySelectorAll("*")) {
          if (!("style" in node)) continue;
          const element = node as RestoreEntry["element"];
          const originalStyle = element.getAttribute("style");
          if (originalStyle == null) witness.removeAttribute("style");
          else witness.setAttribute("style", originalStyle);
          const entry: RestoreEntry = {
            element,
            exact: true,
            originalStyle,
            isolatedStyle: originalStyle,
            properties: [],
          };
          entries.push(entry);
          const values: Array<[string, string]> = element === host ? hostValues : [["visibility", "hidden"]];
          if (element === document.documentElement || element === document.body) values.push(...canvasValues);
          for (const [name, value] of values) {
            const original = {
              value: element.style.getPropertyValue(name),
              priority: element.style.getPropertyPriority(name),
            };
            witness.style.setProperty(name, value, "important");
            entry.isolatedStyle = witness.getAttribute("style");
            entry.properties.push({
              name,
              original,
              isolated: {
                value: witness.style.getPropertyValue(name),
                priority: witness.style.getPropertyPriority(name),
              },
            });
            element.style.setProperty(name, value, "important");
            if (entry.exact && element.getAttribute("style") !== entry.isolatedStyle) entry.exact = false;
          }
        }
        return true;
      },
      {
        sourceNodeKey: options.sourceNodeKey,
        sourceNodeIndex: options.sourceNodeIndex,
        restoreKey,
      },
    );
    if (!prepared) throw new Error("broken-image host lost live-node correlation during icon isolation");

    const resolved = await session.send("DOM.resolveNode", { backendNodeId: options.iconBackendNodeId });
    iconObjectId = resolved.object.objectId;
    if (iconObjectId == null) throw new Error("broken-image icon UA node could not be resolved");
    const isolated = await session.send("Runtime.callFunctionOn", {
      objectId: iconObjectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const root = this.getRootNode();
        const container = root && root.querySelector ? root.querySelector("#alttext-container") : null;
        const text = root && root.querySelector ? root.querySelector("#alttext") : null;
        if (!container || !text || this.id !== "alttext-image") {
          throw new Error("broken-image UA owner identity changed during icon isolation");
        }
        const entries = [];
        const set = (element, property, value) => {
          entries.push({ property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property), owner: element.id });
          element.style.setProperty(property, value, "important");
        };
        set(container, "background-color", "transparent");
        set(container, "background-image", "none");
        set(container, "border-top-color", "transparent");
        set(container, "border-right-color", "transparent");
        set(container, "border-bottom-color", "transparent");
        set(container, "border-left-color", "transparent");
        set(container, "box-shadow", "none");
        set(container, "outline", "none");
        set(text, "visibility", "hidden");
        set(this, "visibility", "visible");
        set(this, "opacity", "1");
        set(this, "filter", "none");
        set(this, "mix-blend-mode", "normal");
        set(this, "background-color", "transparent");
        set(this, "background-image", "none");
        return entries;
      }`,
    });
    if (isolated.exceptionDetails != null) throw new Error(isolated.exceptionDetails.text);
    uaRestore = isolated.result.value;

    // Force style/paint invalidation before CopyFromSurface.
    await page.evaluate(() => document.documentElement.getBoundingClientRect().width);
    const png = Buffer.from(
      await page.screenshot({
        clip: plan.pageClip,
        omitBackground: true,
        type: "png",
        animations: "allow",
        caret: "initial",
      }),
    );
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.channels !== 4 || decoded.info.width <= 0 || decoded.info.height <= 0) {
      throw new Error("isolated broken-image icon crop did not decode as RGBA");
    }
    let painted = false;
    for (let offset = 3; offset < decoded.data.length; offset += 4) {
      if (decoded.data[offset] !== 0) {
        painted = true;
        break;
      }
    }
    if (!painted) throw new Error("isolated broken-image icon crop contained no pixels");
    return {
      source: "chromium-isolated-ua-shadow-icon-v1",
      dataUri: `data:image/png;base64,${png.toString("base64")}`,
      rect: plan.output,
      pixelWidth: decoded.info.width,
      pixelHeight: decoded.info.height,
      pngSha256: createHash("sha256").update(png).digest("hex"),
      rgbaSha256: createHash("sha256").update(decoded.data).digest("hex"),
    };
  } finally {
    if (iconObjectId != null && uaRestore != null) {
      await session
        .send("Runtime.callFunctionOn", {
          objectId: iconObjectId,
          arguments: [{ value: uaRestore }],
          functionDeclaration: `function(entries) {
          const root = this.getRootNode();
          for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            const element = entry.owner === "alttext-image" ? this
              : root.querySelector("#" + entry.owner);
            if (!element) continue;
            if (entry.value === "" && entry.priority === "") element.style.removeProperty(entry.property);
            else element.style.setProperty(entry.property, entry.value, entry.priority);
          }
        }`,
        })
        .catch(() => undefined);
    }
    if (iconObjectId != null) {
      await session.send("Runtime.releaseObject", { objectId: iconObjectId }).catch(() => undefined);
    }
    await restoreLightDom(page, restoreKey);
    await restoreRegistry.dispose();
  }
}
