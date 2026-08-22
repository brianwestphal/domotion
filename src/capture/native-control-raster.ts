/**
 * Chromium-owned native-control raster materialization (DM-2456).
 *
 * Blink dispatches effective native appearances through ThemePainter and the
 * platform WebThemeEngine.  The resulting pixels are part of a compositor
 * frame, not geometry that can be reconstructed from computed CSS.  This pass
 * therefore consumes exactly two page-wide surfaces at most:
 *
 *  - the caller's authoritative source frame (or one atomic live frame), and
 *  - one atomic isolation frame containing every non-overlapping native owner
 *    over a transparent canvas.
 *
 * Static controls take source RGB only where the isolated frame proves the
 * control is fully opaque. Alpha-bearing pixels remain isolation-owned so a
 * page background or positioned sibling can never be baked into the stamp.
 * Time-dependent controls instead consume their overlap-free authoritative
 * source crop atomically: mixing it with a later alpha readback would no
 * longer describe one frame. No target is screenshotted independently.
 *
 * Pinned source boundary (Chromium 7d859f271cbda744098ac69f44978d4edfa62be3):
 *  - third_party/blink/renderer/core/paint/theme_painter.cc dispatches the
 *    control's EffectiveAppearance to the platform painter.
 *  - theme_painter_default.cc forwards checkbox/radio/progress state, zoom,
 *    scheme, forced-colors, and accent data to WebThemeEngine::Paint.
 *  - headless/lib/browser/headless_web_contents_impl.cc captures a completed
 *    compositor surface through CopyFromSurface.
 */

import type { Page } from "@playwright/test";
import sharp from "sharp";

import type { CapturedElement, CaptureWarning } from "./types.js";

export interface NativeControlViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeControlClipPlan {
  /** Capture-local CSS destination, snapped outwards and viewport-clipped. */
  output: { x: number; y: number; width: number; height: number };
  /** Current Playwright screenshot-surface CSS clip (already scroll adjusted). */
  pageClip: { x: number; y: number; width: number; height: number };
}

export interface NativeControlPixelCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DecodedFrame {
  data: Buffer;
  width: number;
  height: number;
}

interface NativeControlTarget {
  element: CapturedElement;
  raster: NonNullable<CapturedElement["nativeControlRaster"]>;
}

interface IsolationFact {
  connected: boolean;
  sourceOccluded: boolean;
  overlapsNativeOwner: boolean;
}

const REQUIRED_RASTER_FEATURE = "native-control-raster";

/**
 * Snap the captured paint-overflow rectangle exactly once, then intersect it
 * with the capture viewport.  Unlike Playwright's per-target screenshot path,
 * this plan transfers the clipped delta to the SVG destination, so a control
 * crossing the top/left/right/bottom edge is never stretched back to its
 * original rectangle.
 */
export function planNativeControlClip(
  rect: { x: number; y: number; width: number; height: number },
  viewport: NativeControlViewport,
): NativeControlClipPlan | null {
  if (![rect.x, rect.y, rect.width, rect.height, viewport.x, viewport.y,
    viewport.width, viewport.height].every(Number.isFinite)) return null;
  if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;

  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) return null;

  return {
    output: { x: left, y: top, width: right - left, height: bottom - top },
    pageClip: {
      // Playwright clip coordinates are relative to the current screenshot
      // surface. window.scrollX/Y are already reflected in that surface;
      // adding them a second time makes a scrolled viewport clip off-image.
      x: viewport.x + left,
      y: viewport.y + top,
      width: right - left,
      height: bottom - top,
    },
  };
}

/** Map a capture-local CSS clip to the real DPR-scaled pixels in a frame. */
export function nativeControlPixelCrop(
  output: NativeControlClipPlan["output"],
  viewport: Pick<NativeControlViewport, "width" | "height">,
  frame: { width: number; height: number },
): NativeControlPixelCrop | null {
  if (![output.x, output.y, output.width, output.height, viewport.width,
    viewport.height, frame.width, frame.height].every(Number.isFinite)) return null;
  if (output.width <= 0 || output.height <= 0 || viewport.width <= 0
      || viewport.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scaleX = frame.width / viewport.width;
  const scaleY = frame.height / viewport.height;
  // Page screenshots use one device scale.  A mismatched aspect ratio means a
  // caller supplied a fold image for an entire-page capture (or vice versa),
  // so treating it as the same coordinate space would silently stretch paint.
  const scaleTolerance = Math.max(1 / viewport.width, 1 / viewport.height, 1e-6);
  if (Math.abs(scaleX - scaleY) > scaleTolerance) return null;

  const left = Math.max(0, Math.floor(output.x * scaleX));
  const top = Math.max(0, Math.floor(output.y * scaleY));
  const right = Math.min(frame.width, Math.ceil((output.x + output.width) * scaleX));
  const bottom = Math.min(frame.height, Math.ceil((output.y + output.height) * scaleY));
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Copy a rectangular RGBA region without asking an image codec to resample. */
export function cropNativeControlRgba(
  frame: { data: Uint8Array; width: number; height: number },
  crop: NativeControlPixelCrop,
): Uint8Array | null {
  if (crop.left < 0 || crop.top < 0 || crop.width <= 0 || crop.height <= 0
      || crop.left + crop.width > frame.width || crop.top + crop.height > frame.height
      || frame.data.length !== frame.width * frame.height * 4) return null;
  const result = new Uint8Array(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const sourceStart = ((crop.top + y) * frame.width + crop.left) * 4;
    result.set(frame.data.subarray(sourceStart, sourceStart + crop.width * 4), y * crop.width * 4);
  }
  return result;
}

export interface NativeControlAlphaStats {
  transparent: number;
  translucent: number;
  opaque: number;
}

export function nativeControlAlphaStats(rgba: Uint8Array): NativeControlAlphaStats | null {
  if (rgba.length === 0 || rgba.length % 4 !== 0) return null;
  const stats: NativeControlAlphaStats = { transparent: 0, translucent: 0, opaque: 0 };
  for (let offset = 3; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset];
    if (alpha === 0) stats.transparent++;
    else if (alpha === 255) stats.opaque++;
    else stats.translucent++;
  }
  return stats;
}

/**
 * Merge a same-coordinate source crop with the isolated alpha surface.
 * Source RGB is safe only for pixels whose isolated alpha is 255: no backdrop
 * can contribute there.  Partially transparent pixels retain Chromium's
 * isolated premultiplied result and alpha exactly.
 */
export function composeNativeControlFrames(
  isolated: Uint8Array,
  source: Uint8Array | null,
  sourceOccluded: boolean,
): Uint8Array | null {
  if (isolated.length === 0 || isolated.length % 4 !== 0) return null;
  if (source != null && source.length !== isolated.length) return null;
  const result = new Uint8Array(isolated);
  if (source == null || sourceOccluded) return result;
  for (let offset = 0; offset < result.length; offset += 4) {
    if (isolated[offset + 3] !== 255 || source[offset + 3] !== 255) continue;
    result[offset] = source[offset];
    result[offset + 1] = source[offset + 1];
    result[offset + 2] = source[offset + 2];
  }
  return result;
}

function collectNativeControlTargets(tree: CapturedElement[]): NativeControlTarget[] {
  const targets: NativeControlTarget[] = [];
  const visit = (nodes: CapturedElement[], projectiveOwner: boolean): void => {
    for (const element of nodes) {
      const ownedByProjectiveRaster = projectiveOwner || element.transformSubtreeRaster != null;
      if (element.nativeControlRaster != null && !ownedByProjectiveRaster) {
        targets.push({ element, raster: element.nativeControlRaster });
      }
      visit(element.children ?? [], ownedByProjectiveRaster);
    }
  };
  visit(tree, false);
  return targets;
}

function pushRequiredRasterWarning(
  warnings: CaptureWarning[],
  target: NativeControlTarget,
  reason: string,
): void {
  const selector = target.raster.selector ?? `${target.element.tag}${target.element.styles.inputType == null ? "" : `[type=${target.element.styles.inputType}]`}`;
  if (warnings.some((warning) => warning.selector === selector && warning.feature === REQUIRED_RASTER_FEATURE)) return;
  warnings.push({
    selector,
    feature: REQUIRED_RASTER_FEATURE,
    detail: `required Chromium native-control surface unavailable (${reason}); sampled SVG chrome is suppressed (DM-2456)`,
  });
}

async function decodeFrame(input: Buffer | string): Promise<DecodedFrame | null> {
  try {
    const decoded = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width <= 0 || decoded.info.height <= 0 || decoded.info.channels !== 4) return null;
    return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
  } catch {
    return null;
  }
}

async function takeAtomicFrame(
  page: Page,
  viewport: NativeControlViewport,
): Promise<DecodedFrame | null> {
  try {
    const png = await page.screenshot({
      clip: {
        x: viewport.x,
        y: viewport.y,
        width: viewport.width,
        height: viewport.height,
      },
      omitBackground: true,
      type: "png",
    });
    return decodeFrame(Buffer.from(png));
  } catch {
    return null;
  }
}

/**
 * Materialize every required native control without per-control screenshots.
 * Private source-node indexes are deleted before returning, successful or not.
 */
export async function rasterizeNativeControlSurfaces(
  page: Page,
  tree: CapturedElement[],
  viewport: NativeControlViewport,
  options: {
    warnings: CaptureWarning[];
    sourceNodeKey?: string;
    sourceImagePath?: string;
  },
): Promise<void> {
  const allNative = (() => {
    const result: NativeControlTarget[] = [];
    const visit = (nodes: CapturedElement[]): void => {
      for (const element of nodes) {
        if (element.nativeControlRaster != null) result.push({ element, raster: element.nativeControlRaster });
        visit(element.children ?? []);
      }
    };
    visit(tree);
    return result;
  })();
  const targets = collectNativeControlTargets(tree);
  const cleanupPrivateFacts = (): void => {
    for (const target of allNative) {
      delete target.raster.sourceNodeIndex;
      delete target.raster.selector;
      delete target.raster.frameSensitive;
    }
  };
  if (allNative.length === 0) return;
  if (targets.length === 0) {
    cleanupPrivateFacts();
    return;
  }

  const plans = targets.map((target) => planNativeControlClip(target.raster, viewport));
  for (let index = 0; index < targets.length; index++) {
    if (plans[index] == null) pushRequiredRasterWarning(options.warnings, targets[index], "invalid or fully viewport-clipped paint rectangle");
  }

  let sourceFrame = options.sourceImagePath == null ? null : await decodeFrame(options.sourceImagePath);
  if (sourceFrame != null && nativeControlPixelCrop(
    { x: 0, y: 0, width: viewport.width, height: viewport.height },
    viewport,
    sourceFrame,
  ) == null) sourceFrame = null;
  // A supplied expected/source image is preferred.  If it does not cover this
  // capture coordinate space, one unmodified compositor readback is the exact
  // atomic fallback; never take one screenshot per control.
  if (sourceFrame == null) sourceFrame = await takeAtomicFrame(page, viewport);

  const restoreKey = `__domotionNativeControlRestore_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let isolationFacts: IsolationFact[] = targets.map(() => ({
    connected: false,
    sourceOccluded: false,
    overlapsNativeOwner: false,
  }));
  let isolatedFrame: DecodedFrame | null = null;
  let isolationFailure: string | undefined;
  try {
    if (options.sourceNodeKey != null) {
      isolationFacts = await page.evaluate(({ sourceNodeKey, restoreKey, rows }) => {
        type RestoreEntry = {
          element: HTMLElement;
          property: string;
          value: string;
          priority: string;
        };
        const host = globalThis as typeof globalThis & Record<string, unknown>;
        const sourceNodes = host[sourceNodeKey] as Element[] | undefined;
        const targets = rows.map((row) => row.index == null ? null : sourceNodes?.[row.index] ?? null);
        const targetSet = new Set(targets.filter((target): target is Element => target != null && target.isConnected));
        const targetVisibility = new Map<Element, string>();
        for (const target of targetSet) targetVisibility.set(target, getComputedStyle(target).visibility);
        const elements = Array.from(document.querySelectorAll("*"));
        const facts = targets.map((target, targetIndex) => {
          if (target == null || !target.isConnected) {
            return { connected: false, sourceOccluded: false, overlapsNativeOwner: false };
          }
          const row = rows[targetIndex];
          const bounds = {
            left: row.x,
            top: row.y,
            right: row.x + row.width,
            bottom: row.y + row.height,
          };
          let sourceOccluded = false;
          let overlapsNativeOwner = false;
          for (const other of elements) {
            if (other === target || target.contains(other) || other.contains(target)) continue;
            let hit = false;
            for (const rect of Array.from(other.getClientRects())) {
              if (rect.right > bounds.left && rect.left < bounds.right
                  && rect.bottom > bounds.top && rect.top < bounds.bottom) { hit = true; break; }
            }
            if (!hit) continue;
            const style = getComputedStyle(other);
            if (style.display === "none" || style.visibility !== "visible" || Number.parseFloat(style.opacity) === 0) continue;
            let hasOwnPaint = style.backgroundImage !== "none" || style.boxShadow !== "none" || style.textShadow !== "none"
              || style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)"
              || [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
                .some((width) => Number.parseFloat(width) > 0)
              || other.namespaceURI === "http://www.w3.org/2000/svg"
              || /^(?:CANVAS|EMBED|IFRAME|IMG|INPUT|METER|OBJECT|PROGRESS|SELECT|TEXTAREA|VIDEO|BUTTON)$/.test(other.tagName);
            if (!hasOwnPaint) {
              for (const child of Array.from(other.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "") {
                  hasOwnPaint = true;
                  break;
                }
              }
            }
            if (!hasOwnPaint) {
              for (const pseudo of ["::before", "::after"]) {
                const content = getComputedStyle(other, pseudo).content;
                if (content !== "none" && content !== "normal" && content !== "") {
                  hasOwnPaint = true;
                  break;
                }
              }
            }
            if (!hasOwnPaint) continue;
            if (targetSet.has(other)) overlapsNativeOwner = true;
            else sourceOccluded = true;
          }
          return { connected: true, sourceOccluded, overlapsNativeOwner };
        });

        const restore: RestoreEntry[] = [];
        host[restoreKey] = restore;
        for (const element of elements) {
          let retained = false;
          for (const target of targetSet) {
            if (element === target || target.contains(element)) { retained = true; break; }
          }
          if (!retained) {
            const html = element as HTMLElement;
            restore.push({
              element: html,
              property: "visibility",
              value: html.style.getPropertyValue("visibility"),
              priority: html.style.getPropertyPriority("visibility"),
            });
            html.style.setProperty("visibility", "hidden", "important");
          }
        }
        // A hidden ancestor's visibility is inherited. Reassert the used value
        // on each owner; authored hidden descendants remain untouched.
        for (const target of targetSet) {
          const html = target as HTMLElement;
          restore.push({
            element: html,
            property: "visibility",
            value: html.style.getPropertyValue("visibility"),
            priority: html.style.getPropertyPriority("visibility"),
          });
          html.style.setProperty("visibility", targetVisibility.get(target) ?? "visible", "important");
        }
        for (const canvas of [document.documentElement, document.body]) {
          if (canvas != null && !targetSet.has(canvas)) {
            restore.push({
              element: canvas,
              property: "background",
              value: canvas.style.getPropertyValue("background"),
              priority: canvas.style.getPropertyPriority("background"),
            });
            canvas.style.setProperty("background", "transparent", "important");
          }
        }
        void document.documentElement.getBoundingClientRect();
        return facts;
      }, {
        sourceNodeKey: options.sourceNodeKey,
        restoreKey,
        rows: targets.map((target, index) => ({
          index: target.raster.sourceNodeIndex,
          x: viewport.x + (plans[index]?.output.x ?? 0),
          y: viewport.y + (plans[index]?.output.y ?? 0),
          width: plans[index]?.output.width ?? 0,
          height: plans[index]?.output.height ?? 0,
        })),
      });
      isolatedFrame = await takeAtomicFrame(page, viewport);
    }
  } catch (error) {
    isolationFailure = error instanceof Error ? error.message : "isolation preparation failed";
    isolatedFrame = null;
  } finally {
    await page.evaluate((restoreKey) => {
      type RestoreEntry = {
        element: HTMLElement;
        property: string;
        value: string;
        priority: string;
      };
      const host = globalThis as typeof globalThis & Record<string, unknown>;
      const restore = host[restoreKey] as RestoreEntry[] | undefined;
      for (let index = (restore?.length ?? 0) - 1; index >= 0; index--) {
        const entry = restore![index];
        if (entry.value === "") entry.element.style.removeProperty(entry.property);
        else entry.element.style.setProperty(entry.property, entry.value, entry.priority);
      }
      delete host[restoreKey];
    }, restoreKey).catch(() => undefined);
  }

  try {
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const plan = plans[index];
      if (plan == null) continue;
      const fact = isolationFacts[index];
      if (!fact.connected) {
        pushRequiredRasterWarning(
          options.warnings,
          target,
          isolationFailure ?? "live Chromium owner detached or lost source correlation",
        );
        continue;
      }
      if (fact.overlapsNativeOwner) {
        pushRequiredRasterWarning(options.warnings, target, "overlapping native owners cannot be separated by one atomic alpha frame");
        continue;
      }

      let source: Uint8Array | null = null;
      let sourceCrop: NativeControlPixelCrop | null = null;
      if (sourceFrame != null && !fact.sourceOccluded) {
        sourceCrop = nativeControlPixelCrop(plan.output, viewport, sourceFrame);
        if (sourceCrop != null) source = cropNativeControlRgba(sourceFrame, sourceCrop);
      }
      if (target.raster.frameSensitive === true) {
        if (source == null || sourceCrop == null || fact.sourceOccluded) {
          pushRequiredRasterWarning(options.warnings, target, "time-dependent paint could not retain one overlap-free source frame");
          continue;
        }
        // Alpha from the isolation screenshot belongs to a later compositor
        // frame. Even a byte-exact RGB merge would move antialiased pixels on
        // an indeterminate progress segment. With no intersecting owner, the
        // complete source crop is the only coherent atomic stamp; its backdrop
        // is already the same paint the structural renderer emits underneath.
        const png = await sharp(Buffer.from(source), {
          raw: { width: sourceCrop.width, height: sourceCrop.height, channels: 4 },
        }).png().toBuffer();
        target.raster.dataUri = `data:image/png;base64,${png.toString("base64")}`;
        target.raster.x = plan.output.x;
        target.raster.y = plan.output.y;
        target.raster.width = plan.output.width;
        target.raster.height = plan.output.height;
        continue;
      }
      if (isolatedFrame == null) {
        pushRequiredRasterWarning(options.warnings, target, "atomic isolated screenshot failed");
        continue;
      }
      const isolatedCrop = nativeControlPixelCrop(plan.output, viewport, isolatedFrame);
      const isolated = isolatedCrop == null ? null : cropNativeControlRgba(isolatedFrame, isolatedCrop);
      if (isolated == null) {
        pushRequiredRasterWarning(options.warnings, target, "isolated frame clip did not map to image pixels");
        continue;
      }
      const alpha = nativeControlAlphaStats(isolated);
      if (alpha == null) {
        pushRequiredRasterWarning(options.warnings, target, "isolated frame had invalid RGBA content");
        continue;
      }
      if (alpha.opaque + alpha.translucent === 0) {
        // A successful transparent isolation is authoritative: ancestor clips
        // or control state proved that this owner paints no pixels.
        target.raster.empty = true;
        target.raster.x = plan.output.x;
        target.raster.y = plan.output.y;
        target.raster.width = plan.output.width;
        target.raster.height = plan.output.height;
        continue;
      }

      if (sourceCrop == null || sourceCrop.width !== isolatedCrop!.width || sourceCrop.height !== isolatedCrop!.height) {
        source = null;
      }
      const composed = composeNativeControlFrames(isolated, source, fact.sourceOccluded);
      if (composed == null) {
        pushRequiredRasterWarning(options.warnings, target, "source and isolated frame clips were incoherent");
        continue;
      }
      const png = await sharp(Buffer.from(composed), {
        raw: { width: isolatedCrop!.width, height: isolatedCrop!.height, channels: 4 },
      }).png().toBuffer();
      target.raster.dataUri = `data:image/png;base64,${png.toString("base64")}`;
      target.raster.x = plan.output.x;
      target.raster.y = plan.output.y;
      target.raster.width = plan.output.width;
      target.raster.height = plan.output.height;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unexpected raster encoder failure";
    for (const target of targets) {
      if (target.raster.dataUri == null && target.raster.empty !== true) {
        pushRequiredRasterWarning(options.warnings, target, detail);
      }
    }
  } finally {
    cleanupPrivateFacts();
  }
}
