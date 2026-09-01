import sharp from "sharp";
import type { CDPSession, ElementHandle, Page } from "@playwright/test";
import {
  axisAlignedQuadBounds,
  mapCssRectToSourcePixels,
  mapTranslatedQuadToScreenshot,
  type CssQuad,
} from "./replaced-snapshot-geometry.js";
import type { CapturedElement, CaptureWarning } from "./types.js";

export type ReplacedElementRasterFailurePhase =
  | "target-lookup"
  | "geometry"
  | "isolation"
  | "screenshot"
  | "cleanup";

export interface ReplacedElementRasterFailure {
  rid?: string;
  tag?: string;
  phase: ReplacedElementRasterFailurePhase;
  detail: string;
}

export interface ReplacedElementRasterReport {
  targetCount: number;
  rasterizedCount: number;
  skippedProjectiveCount: number;
  failures: ReplacedElementRasterFailure[];
}

export interface ReplacedElementRasterOptions {
  sourceImagePath?: string;
  /** Capture-owned sink. Failures stay non-fatal but are no longer silent. */
  warnings?: CaptureWarning[];
}

/**
 * Isolation stylesheet shared by replaced-element and mask-source rasterizers.
 * The replaced-element subsystem owns installing/removing its style handle;
 * other callers borrow only the immutable CSS text.
 */
export const SNAPSHOT_HIDE_CSS = [
  "*, *::before, *::after { visibility: hidden !important; }",
  "[data-domotion-snapshot-target], [data-domotion-snapshot-target] *,",
  "[data-domotion-snapshot-target] *::before, [data-domotion-snapshot-target] *::after,",
  "[data-domotion-snapshot-target]::before, [data-domotion-snapshot-target]::after { visibility: visible !important; }",
  "html, body { background: transparent !important; }",
].join("\n");

/**
 * DM-457: rasterize each <canvas> / <video> / <iframe> / <object> / <embed>
 * captured in the tree. CAPTURE_SCRIPT tagged the live DOM nodes with
 * `data-domotion-rid="dr<n>"` and recorded a bootstrap content-box rect on
 * `el.replacedSnapshot`; DM-2380 replaces it with Blink's CDP content quad.
 * We hide everything else on the page via a temporary stylesheet so the
 * screenshot of each target surface contains only that
 * element's painted pixels (not overlays, sticky chrome, sibling positioned
 * elements, or non-ancestor `::before`/`::after` pseudos), then attach the PNG
 * back to the captured tree as a data URI for the renderer to emit as an
 * <image>. See `docs/17-replaced-element-snapshots.md` for the contract.
 */
export async function rasterizeReplacedElements(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
  opts: ReplacedElementRasterOptions = {},
): Promise<ReplacedElementRasterReport> {
  interface Target {
    snapshot: NonNullable<CapturedElement["replacedSnapshot"]>;
    tag: string;
    imageReplacement: boolean;
    serializedTransform: boolean;
    projectiveOwner: boolean;
  }
  const targets: Target[] = [];
  const collectTargets = (
    nodes: CapturedElement[],
    inheritedSerializedTransform: boolean,
    inheritedProjectiveOwner: boolean,
  ): void => {
    for (const el of nodes) {
      const serializedTransform = inheritedSerializedTransform
        || (el.styles.transform != null && el.styles.transform !== "" && el.styles.transform !== "none");
      const projectiveOwner = inheritedProjectiveOwner || el.transformSubtreeRaster != null;
      if (el.replacedSnapshot != null) {
        targets.push({
          snapshot: el.replacedSnapshot,
          tag: el.tag,
          imageReplacement: el.imageReplacement != null,
          serializedTransform,
          projectiveOwner,
        });
      }
      collectTargets(el.children ?? [], serializedTransform, projectiveOwner);
    }
  };
  collectTargets(tree, false, false);
  const report: ReplacedElementRasterReport = {
    targetCount: targets.length,
    rasterizedCount: 0,
    skippedProjectiveCount: targets.filter((target) => target.projectiveOwner).length,
    failures: [],
  };
  const errorDetail = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const recordFailure = (
    target: Target | undefined,
    phase: ReplacedElementRasterFailurePhase,
    detail: string,
  ): void => {
    report.failures.push({
      ...(target == null ? {} : { rid: target.snapshot.rid, tag: target.tag }),
      phase,
      detail,
    });
    opts.warnings?.push({
      selector: target == null ? "document" : `[data-domotion-rid="${target.snapshot.rid}"]`,
      feature: "replaced-element snapshot",
      detail: `${phase}: ${detail}`,
      status: "partial",
    });
  };
  if (targets.length === 0) return report;

  const cleanupMarkers = async (): Promise<void> => {
    try {
      await page.evaluate(() => {
        document.querySelectorAll("[data-domotion-snapshot-target]").forEach(
          (el) => el.removeAttribute("data-domotion-snapshot-target"),
        );
        document.querySelectorAll("[data-domotion-rid]").forEach(
          (el) => el.removeAttribute("data-domotion-rid"),
        );
      });
    } catch (error) {
      recordFailure(undefined, "cleanup", `could not remove snapshot markers: ${errorDetail(error)}`);
    }
  };

  // A projective rendering context is already captured as one Chromium-owned
  // surface by transformSubtreeRaster. Sampling a nested canvas/video/frame as
  // well cannot affect output (the renderer returns at the outer owner) and
  // risks retaining a second, independently transformed bitmap in the tree.
  const activeTargets = targets.filter((target) => !target.projectiveOwner);
  if (activeTargets.length === 0) {
    await cleanupMarkers();
    return report;
  }

  let cdp: CDPSession | undefined;
  let rootNodeId: number | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    const documentResult = await cdp.send("DOM.getDocument", { depth: 1 });
    rootNodeId = documentResult.root.nodeId;
  } catch {
    await cdp?.detach().catch(() => undefined);
    cdp = undefined;
  }

  const rectQuad = (rect: { x: number; y: number; width: number; height: number }): CssQuad => [
    rect.x, rect.y,
    rect.x + rect.width, rect.y,
    rect.x + rect.width, rect.y + rect.height,
    rect.x, rect.y + rect.height,
  ];
  const localizeQuad = (quad: CssQuad): CssQuad => [
    quad[0] - viewport.x, quad[1] - viewport.y,
    quad[2] - viewport.x, quad[3] - viewport.y,
    quad[4] - viewport.x, quad[5] - viewport.y,
    quad[6] - viewport.x, quad[7] - viewport.y,
  ];
  const boxQuad = async (target: Target): Promise<CssQuad | null> => {
    if (cdp != null && rootNodeId != null) {
      try {
        const queried = await cdp.send("DOM.querySelector", {
          nodeId: rootNodeId,
          selector: `[data-domotion-rid="${target.snapshot.rid}"]`,
        });
        if (queried.nodeId !== 0) {
          const result = await cdp.send("DOM.getBoxModel", { nodeId: queried.nodeId });
          const values = target.imageReplacement ? result.model.border : result.model.content;
          if (Array.isArray(values) && values.length === 8) return values as CssQuad;
        }
      } catch {
        // The live node may have detached after the synchronous capture walk.
      }
    }
    if (target.serializedTransform) return null;
    const snapshot = target.snapshot;
    return rectQuad({
      x: snapshot.x + viewport.x,
      y: snapshot.y + viewport.y,
      width: snapshot.width,
      height: snapshot.height,
    });
  };
  const installRaster = (
    target: Target,
    uri: string,
    output: { x: number; y: number; width: number; height: number },
    contentQuad: CssQuad,
    pixelWidth: number,
    pixelHeight: number,
  ): void => {
    const snapshot = target.snapshot;
    snapshot.dataUri = uri;
    snapshot.x = output.x;
    snapshot.y = output.y;
    snapshot.width = output.width;
    snapshot.height = output.height;
    snapshot.rasterToOutput = {
      contentQuad: localizeQuad(contentQuad),
      pixelWidth,
      pixelHeight,
      cssPerPixelX: output.width / pixelWidth,
      cssPerPixelY: output.height / pixelHeight,
    };
  };

  // DM-562: custom elements (hyphenated tag — DM-511 routed them through
  // replacedSnapshot when they have shadow DOM) have light-DOM children that
  // ALSO paint inside the rect. Cropping from expected.png captures both the
  // shadow-DOM paint AND the overlapping light-DOM paint as a single image,
  // and then the renderer composites that crop on top of its own rendering
  // of the same light-DOM children — producing stacking artifacts (e.g.
  // doubled video-controls or text seen through translucent custom-element
  // backgrounds). For iframe / canvas / video / object / embed the rect is
  // truly opaque-replaced — there's no light-DOM content to double-paint —
  // so the image crop is clean. Split targets accordingly.
  const _replacedTagSet = new Set(["iframe", "canvas", "video", "object", "embed"]);
  const cropTargets = activeTargets.filter((target) =>
    opts?.sourceImagePath != null
    && _replacedTagSet.has(target.tag)
    && !target.serializedTransform);
  const screenshotTargets = activeTargets.filter((target) => !cropTargets.includes(target));

  // DM-562: when the caller supplies a `sourceImagePath` (the expected.png
  // already on disk), crop each rid's rect from it instead of taking fresh
  // page.screenshot calls. The per-rid screenshots originally provided
  // isolation via the hide-everything-else CSS trick, but they also happened
  // hundreds of milliseconds after the expected screenshot — so cross-origin
  // iframes with rotating carousels (Google Ads on NYT) ended up with
  // rasterized content that drifted from the expected. Cropping from the
  // SAME PNG that produced the expected eliminates the drift entirely. For
  // typical replaced elements (iframe / canvas / video / custom-element with
  // shadow DOM) the rid's content-box rect doesn't overlap with siblings, so
  // the loss of CSS-trick isolation is a no-op visually.
  if (cropTargets.length > 0 && opts?.sourceImagePath != null) {
    try {
      const srcMeta = await sharp(opts.sourceImagePath).metadata();
      const sourceSize = { width: srcMeta.width ?? 0, height: srcMeta.height ?? 0 };
      for (const target of cropTargets) {
        try {
          const contentQuad = await boxQuad(target);
          const bounds = contentQuad == null ? null : axisAlignedQuadBounds(contentQuad);
          if (contentQuad == null || bounds == null) {
            screenshotTargets.push(target);
            continue;
          }
          const mapped = mapCssRectToSourcePixels({
            x: bounds.x - viewport.x,
            y: bounds.y - viewport.y,
            width: bounds.width,
            height: bounds.height,
          }, viewport, sourceSize);
          if (mapped == null) {
            screenshotTargets.push(target);
            continue;
          }
          const buf = await sharp(opts.sourceImagePath)
            .extract(mapped.crop)
            .png()
            .toBuffer();
          installRaster(
            target,
            `data:image/png;base64,${buf.toString("base64")}`,
            mapped.output,
            contentQuad,
            mapped.crop.width,
            mapped.crop.height,
          );
          report.rasterizedCount++;
        } catch {
          screenshotTargets.push(target);
        }
      }
    } catch {
      // Source-image access is an optimization. Fall back to isolated live
      // screenshots without changing the rendered result or reporting a false
      // failure when those screenshots succeed.
      for (const target of cropTargets) {
        if (!screenshotTargets.includes(target)) screenshotTargets.push(target);
      }
    }
  }
  if (screenshotTargets.length === 0) {
    try { await cdp?.detach(); } catch (error) {
      recordFailure(undefined, "cleanup", `could not detach CDP session: ${errorDetail(error)}`);
    }
    await cleanupMarkers();
    return report;
  }

  // Inject the hide-everything-else stylesheet (shared SNAPSHOT_HIDE_CSS);
  // restored unconditionally in finally.
  let styleHandle: ElementHandle | null = null;
  try {
    styleHandle = await page.addStyleTag({ content: SNAPSHOT_HIDE_CSS });
    for (const target of screenshotTargets) {
      let prepared = false;
      let phase: ReplacedElementRasterFailurePhase = "target-lookup";
      try {
        prepared = await page.evaluate((rid) => {
          type SavedProperty = { name: string; value: string; priority: string };
          type SavedElement = {
            element: HTMLElement;
            properties: SavedProperty[];
            scrollLeft?: number;
            scrollTop?: number;
          };
          type SnapshotState = { target: HTMLElement; saved: SavedElement[] };
          const stateKey = "__domotionReplacedSnapshotState";
          const host = globalThis as unknown as {
            __domotionReplacedSnapshotState?: SnapshotState;
          };
          const previous = host[stateKey];
          if (previous != null) {
            for (let i = previous.saved.length - 1; i >= 0; i--) {
              const entry = previous.saved[i];
              for (const property of entry.properties) {
                if (property.value === "") entry.element.style.removeProperty(property.name);
                else entry.element.style.setProperty(property.name, property.value, property.priority);
              }
              if (entry.scrollLeft != null) entry.element.scrollLeft = entry.scrollLeft;
              if (entry.scrollTop != null) entry.element.scrollTop = entry.scrollTop;
            }
            delete host[stateKey];
          }
          const prev = document.querySelectorAll("[data-domotion-snapshot-target]");
          prev.forEach((el) => el.removeAttribute("data-domotion-snapshot-target"));
          const next = document.querySelector(`[data-domotion-rid="${rid}"]`);
          if (!(next instanceof HTMLElement)) return false;
          next.setAttribute("data-domotion-snapshot-target", "");

          const saved: SavedElement[] = [];
          for (let owner: HTMLElement | null = next; owner != null; owner = owner.parentElement) {
            const style = getComputedStyle(owner);
            const transform = style.transform;
            let needsRendererTransform = false;
            const matrix = /^matrix\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,/.exec(transform);
            if (matrix != null
                && (Math.abs(parseFloat(matrix[2])) > 1e-6 || Math.abs(parseFloat(matrix[3])) > 1e-6)) {
              needsRendererTransform = true;
            }
            const matrix3d = /^matrix3d\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*[-\d.eE]+\s*,\s*[-\d.eE]+\s*,\s*([-\d.eE]+)\s*,/.exec(transform);
            if (matrix3d != null
                && (Math.abs(parseFloat(matrix3d[2])) > 1e-6 || Math.abs(parseFloat(matrix3d[3])) > 1e-6)) {
              needsRendererTransform = true;
            }
            if (style.rotate != null && style.rotate !== "" && style.rotate !== "none") {
              const angle = /([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(deg|rad|grad|turn)?\s*$/i.exec(style.rotate);
              if (angle != null) {
                const value = parseFloat(angle[1]);
                const unit = angle[2]?.toLowerCase() ?? "deg";
                const degrees = unit === "rad" ? value * 180 / Math.PI
                  : unit === "grad" ? value * 0.9
                    : unit === "turn" ? value * 360 : value;
                if (Math.abs(degrees % 360) > 1e-6) needsRendererTransform = true;
              }
            }
            if (!needsRendererTransform) continue;
            const properties: SavedProperty[] = [];
            for (const name of ["transform", "translate", "rotate", "scale"]) {
              properties.push({
                name,
                value: owner.style.getPropertyValue(name),
                priority: owner.style.getPropertyPriority(name),
              });
            }
            saved.push({ element: owner, properties });
            owner.style.setProperty("transform", "translate(0)", "important");
            owner.style.setProperty("translate", "none", "important");
            owner.style.setProperty("rotate", "none", "important");
            owner.style.setProperty("scale", "none", "important");
          }
          host[stateKey] = { target: next, saved };
          // Force Blink to rebuild paint-property nodes before CDP asks for
          // LocalRectToAbsoluteQuad.
          void next.getBoundingClientRect();
          return true;
        }, target.snapshot.rid);
        if (!prepared) {
          recordFailure(target, "target-lookup", "live owner was unavailable after the capture walk");
          continue;
        }

        phase = "geometry";
        const outputQuad = await boxQuad(target);
        const outputBounds = outputQuad == null ? null : axisAlignedQuadBounds(outputQuad);
        if (outputQuad == null || outputBounds == null) {
          recordFailure(target, "geometry", "could not resolve an axis-aligned output quad");
          continue;
        }

        // The bitmap is the replaced element's local source surface. Blink
        // maps that surface through descendant/ancestor transforms before
        // intersecting ancestor clip nodes. Read `outputQuad` first, then
        // temporarily remove those paint clips: overflow changes can expose a
        // stored scroll offset or alter formatting, and only the later
        // same-size translation check is allowed to map that sample back.
        phase = "isolation";
        const clipsSuppressed = await page.evaluate(() => {
          type SavedProperty = { name: string; value: string; priority: string };
          type SavedElement = {
            element: HTMLElement;
            properties: SavedProperty[];
            scrollLeft?: number;
            scrollTop?: number;
          };
          type SnapshotState = { target: HTMLElement; saved: SavedElement[] };
          const stateKey = "__domotionReplacedSnapshotState";
          const host = globalThis as unknown as {
            __domotionReplacedSnapshotState?: SnapshotState;
          };
          const state = host[stateKey];
          if (state == null) return false;
          for (let ancestor = state.target.parentElement;
            ancestor != null && ancestor !== document.documentElement;
            ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const properties: SavedProperty[] = [];
            const scrollLeft = ancestor.scrollLeft;
            const scrollTop = ancestor.scrollTop;
            if (style.overflowX !== "visible" || style.overflowY !== "visible") {
              for (const name of ["overflow", "overflow-x", "overflow-y"]) {
                properties.push({
                  name,
                  value: ancestor.style.getPropertyValue(name),
                  priority: ancestor.style.getPropertyPriority(name),
                });
              }
              ancestor.style.setProperty("overflow", "visible", "important");
              ancestor.style.setProperty("overflow-x", "visible", "important");
              ancestor.style.setProperty("overflow-y", "visible", "important");
            }
            if (style.clip !== "auto") {
              properties.push({
                name: "clip",
                value: ancestor.style.getPropertyValue("clip"),
                priority: ancestor.style.getPropertyPriority("clip"),
              });
              ancestor.style.setProperty("clip", "auto", "important");
            }
            if (style.clipPath !== "none") {
              properties.push({
                name: "clip-path",
                value: ancestor.style.getPropertyValue("clip-path"),
                priority: ancestor.style.getPropertyPriority("clip-path"),
              });
              ancestor.style.setProperty("clip-path", "none", "important");
            }
            if (style.maskImage !== "none") {
              properties.push({
                name: "mask-image",
                value: ancestor.style.getPropertyValue("mask-image"),
                priority: ancestor.style.getPropertyPriority("mask-image"),
              });
              ancestor.style.setProperty("mask-image", "none", "important");
            }
            if (style.webkitMaskImage != null && style.webkitMaskImage !== "none") {
              properties.push({
                name: "-webkit-mask-image",
                value: ancestor.style.getPropertyValue("-webkit-mask-image"),
                priority: ancestor.style.getPropertyPriority("-webkit-mask-image"),
              });
              ancestor.style.setProperty("-webkit-mask-image", "none", "important");
            }
            if (properties.length > 0) {
              state.saved.push({
                element: ancestor,
                properties,
                scrollLeft,
                scrollTop,
              });
            }
          }
          void state.target.getBoundingClientRect();
          return true;
        });
        if (!clipsSuppressed) {
          recordFailure(target, "isolation", "temporary owner state disappeared before clip suppression");
          continue;
        }

        phase = "geometry";
        const unclippedQuad = await boxQuad(target);
        const unclippedBounds = unclippedQuad == null ? null : axisAlignedQuadBounds(unclippedQuad);
        if (unclippedQuad == null || unclippedBounds == null) {
          recordFailure(target, "geometry", "could not resolve the unclipped source quad");
          continue;
        }

        // A local surface may sit outside the viewport before its serialized
        // rotate/skew maps it back on-screen. Translate only the isolated
        // target for sampling, then map the resulting bitmap back by that
        // proven translation. When the surface already fits, no mutation is
        // made and sampledQuad === outputQuad.
        const margin = 1;
        const availableWidth = Math.max(0, viewport.width - margin * 2);
        const availableHeight = Math.max(0, viewport.height - margin * 2);
        let dx = 0;
        let dy = 0;
        if (unclippedBounds.width <= availableWidth) {
          if (unclippedBounds.x < viewport.x + margin) dx = viewport.x + margin - unclippedBounds.x;
          else if (unclippedBounds.x + unclippedBounds.width > viewport.x + viewport.width - margin) {
            dx = viewport.x + viewport.width - margin - unclippedBounds.x - unclippedBounds.width;
          }
        }
        if (unclippedBounds.height <= availableHeight) {
          if (unclippedBounds.y < viewport.y + margin) dy = viewport.y + margin - unclippedBounds.y;
          else if (unclippedBounds.y + unclippedBounds.height > viewport.y + viewport.height - margin) {
            dy = viewport.y + viewport.height - margin - unclippedBounds.y - unclippedBounds.height;
          }
        }
        if (dx !== 0 || dy !== 0) {
          await page.evaluate(({ dx, dy }) => {
            type SavedProperty = { name: string; value: string; priority: string };
            type SavedElement = {
              element: HTMLElement;
              properties: SavedProperty[];
              scrollLeft?: number;
              scrollTop?: number;
            };
            type SnapshotState = { target: HTMLElement; saved: SavedElement[] };
            const stateKey = "__domotionReplacedSnapshotState";
            const host = globalThis as unknown as {
              __domotionReplacedSnapshotState?: SnapshotState;
            };
            const state = host[stateKey];
            if (state == null) return;
            if (!state.saved.some((entry) => entry.element === state.target)) {
              state.saved.push({
                element: state.target,
                properties: [{
                  name: "translate",
                  value: state.target.style.getPropertyValue("translate"),
                  priority: state.target.style.getPropertyPriority("translate"),
                }],
              });
            }
            const computed = getComputedStyle(state.target).translate;
            const parts: string[] = [];
            if (computed !== "none" && computed !== "") {
              let start = 0;
              let depth = 0;
              const value = computed.trim();
              for (let i = 0; i <= value.length; i++) {
                const character = value[i];
                if (character === "(") depth++;
                else if (character === ")") depth--;
                if (i === value.length || (depth === 0 && character != null && /\s/.test(character))) {
                  if (i > start) parts.push(value.slice(start, i));
                  while (i + 1 < value.length && /\s/.test(value[i + 1])) i++;
                  start = i + 1;
                }
              }
            }
            const x = parts[0] ?? "0px";
            const y = parts[1] ?? "0px";
            const z = parts[2];
            const shiftedX = dx === 0 ? x : `calc(${x} + ${dx}px)`;
            const shiftedY = dy === 0 ? y : `calc(${y} + ${dy}px)`;
            state.target.style.setProperty(
              "translate",
              `${shiftedX} ${shiftedY}${z == null ? "" : ` ${z}`}`,
              "important",
            );
            void state.target.getBoundingClientRect();
          }, { dx, dy });
        }

        const sampledQuad = await boxQuad(target);
        if (sampledQuad == null) {
          recordFailure(target, "geometry", "could not resolve the sampled source quad");
          continue;
        }
        const mapping = mapTranslatedQuadToScreenshot(outputQuad, sampledQuad, viewport);
        if (mapping == null) {
          recordFailure(target, "geometry", "sampled source was not a same-size axis-aligned translation");
          continue;
        }
        phase = "screenshot";
        const buf = await page.screenshot({ clip: mapping.clip, omitBackground: true, type: "png" });
        const metadata = await sharp(buf).metadata();
        const pixelWidth = metadata.width ?? 0;
        const pixelHeight = metadata.height ?? 0;
        if (pixelWidth <= 0 || pixelHeight <= 0) {
          recordFailure(target, "screenshot", "Chromium returned an empty bitmap");
          continue;
        }
        installRaster(target, `data:image/png;base64,${Buffer.from(buf).toString("base64")}`, {
          x: mapping.output.x - viewport.x,
          y: mapping.output.y - viewport.y,
          width: mapping.output.width,
          height: mapping.output.height,
        }, outputQuad, pixelWidth, pixelHeight);
        report.rasterizedCount++;
      } catch (error) {
        // A detached/mutating live node leaves the normal element box in place.
        recordFailure(target, phase, errorDetail(error));
      } finally {
        if (prepared) {
          try {
            await page.evaluate(() => {
              type SavedProperty = { name: string; value: string; priority: string };
              type SavedElement = {
                element: HTMLElement;
                properties: SavedProperty[];
                scrollLeft?: number;
                scrollTop?: number;
              };
              type SnapshotState = { target: HTMLElement; saved: SavedElement[] };
              const stateKey = "__domotionReplacedSnapshotState";
              const host = globalThis as unknown as {
                __domotionReplacedSnapshotState?: SnapshotState;
              };
              const state = host[stateKey];
              if (state == null) return;
              for (let i = state.saved.length - 1; i >= 0; i--) {
                const entry = state.saved[i];
                for (const property of entry.properties) {
                  if (property.value === "") entry.element.style.removeProperty(property.name);
                  else entry.element.style.setProperty(property.name, property.value, property.priority);
                }
                if (entry.scrollLeft != null) entry.element.scrollLeft = entry.scrollLeft;
                if (entry.scrollTop != null) entry.element.scrollTop = entry.scrollTop;
              }
              delete host[stateKey];
            });
          } catch (error) {
            recordFailure(target, "cleanup", `could not restore authored styles: ${errorDetail(error)}`);
          }
        }
      }
    }
  } catch (error) {
    for (const target of screenshotTargets) {
      if (target.snapshot.dataUri == null
          && !report.failures.some((failure) => failure.rid === target.snapshot.rid)) {
        recordFailure(target, "isolation", `could not initialize raster isolation: ${errorDetail(error)}`);
      }
    }
  } finally {
    // Strip both attributes from every element we may have touched, plus
    // remove the hide stylesheet so the live page is back to its original
    // visual state (matters when the same page is captured again, or when
    // tests inspect the page after capture).
    await cleanupMarkers();
    if (styleHandle != null) {
      try { await styleHandle.evaluate((node: Element) => { node.remove(); }); } catch (error) {
        recordFailure(undefined, "cleanup", `could not remove raster isolation style: ${errorDetail(error)}`);
      }
    }
    try { await cdp?.detach(); } catch (error) {
      recordFailure(undefined, "cleanup", `could not detach CDP session: ${errorDetail(error)}`);
    }
  }
  return report;
}
