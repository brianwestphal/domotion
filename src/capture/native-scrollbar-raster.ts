/**
 * Lossless source-frame materialization for platform-native scrollbar strips.
 *
 * Blink records native scrollbars as platform display items; macOS animator,
 * Aura/Fluent, and Windows UXTheme pixels do not have a portable CSS recipe.
 * This module therefore crops the completed Chromium compositor frame at the
 * marker-owned physical rectangles without resampling. Overlay crops keep the
 * backdrop by design; a reversible width:none discriminator is used only to
 * prove source-frame no-ink, never as the emitted pixel source.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";

import type {
  CapturedNativeScrollbarRaster,
  CapturedScrollbarPlatformFingerprint,
  CapturedScrollbarRect,
} from "./types.js";
import { cropNativeControlRgba, nativeControlPixelCrop } from "./native-control-raster.js";

export interface NativeScrollbarFrame {
  data: Buffer;
  width: number;
  height: number;
  pngSha256: string;
}

export type NativeOverlayInkVerdict = "visible" | "empty" | "unstable" | "unavailable";

export interface NativeOverlayInkAnalysis {
  verdict: NativeOverlayInkVerdict;
  /** Connected changed-pixel bounds in capture-viewport CSS coordinates. */
  rects: CapturedScrollbarRect[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function intersectRect(a: CapturedScrollbarRect, b: CapturedScrollbarRect): CapturedScrollbarRect | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

async function decodeFrame(input: Buffer | string): Promise<NativeScrollbarFrame | null> {
  try {
    const encoded = typeof input === "string" ? await readFile(input) : input;
    const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width <= 0 || decoded.info.height <= 0 || decoded.info.channels !== 4) return null;
    return {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      pngSha256: sha256(encoded),
    };
  } catch {
    return null;
  }
}

/** Capture one unmodified compositor surface shared by every scrollbar owner. */
export async function captureNativeScrollbarSourceFrame(
  page: Page,
  viewport: CapturedScrollbarRect,
  sourceImagePath?: string,
): Promise<NativeScrollbarFrame | null> {
  const supplied = sourceImagePath == null ? null : await decodeFrame(sourceImagePath);
  if (supplied != null && nativeControlPixelCrop(
    { x: 0, y: 0, width: viewport.width, height: viewport.height },
    viewport,
    supplied,
  ) != null) return supplied;
  try {
    const png = await page.screenshot({ clip: viewport, type: "png" });
    return decodeFrame(Buffer.from(png));
  } catch {
    return null;
  }
}

/** Build the non-portable platform/browser identity attached to every crop. */
export async function captureNativeScrollbarFingerprint(
  page: Page,
): Promise<CapturedScrollbarPlatformFingerprint> {
  const require = createRequire(import.meta.url);
  const playwrightVersion = (require("playwright/package.json") as { version: string }).version;
  let chromiumRevision = "unknown";
  try {
    const packagePath = require.resolve("playwright-core/package.json");
    const browsers = JSON.parse(await readFile(resolve(dirname(packagePath), "browsers.json"), "utf8")) as {
      browsers?: Array<{ name?: string; revision?: string }>;
    };
    chromiumRevision = browsers.browsers?.find(({ name }) => name === "chromium")?.revision ?? "unknown";
  } catch {
    // The browser version and pinned source revision remain in the record; an
    // absent Playwright package revision is deliberately fingerprinted unknown.
  }
  let launchArguments: string[] = [];
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const commandLine = await session.send("Browser.getBrowserCommandLine") as { arguments?: string[] };
      launchArguments = commandLine.arguments ?? [];
    } finally {
      await session.detach();
    }
  } catch {
    // The raster remains usable, but the all-platform release gate rejects an
    // unknown launch fingerprint rather than substituting another host.
  }
  return {
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    runnerImage: process.env.ImageOS ?? `${platform()}-local`,
    runnerImageVersion: process.env.ImageVersion ?? "local",
    chromiumVersion: page.context().browser()?.version() ?? "unknown",
    chromiumRevision,
    playwrightVersion,
    launchArguments,
    hideScrollbarsDefaultRemoved: !launchArguments.some((argument) => argument === "--hide-scrollbars"),
  };
}

function pixelCropForRect(
  rect: CapturedScrollbarRect,
  clip: CapturedScrollbarRect | null,
  viewport: CapturedScrollbarRect,
  frame: NativeScrollbarFrame,
) {
  const viewportLocal = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const clipped = intersectRect(rect, viewportLocal);
  const finalRect = clipped == null || clip == null ? clipped : intersectRect(clipped, clip);
  if (finalRect == null) return null;
  const pixel = nativeControlPixelCrop(finalRect, viewport, frame);
  if (pixel == null) return null;
  const scaleX = frame.width / viewport.width;
  const scaleY = frame.height / viewport.height;
  return {
    pixel,
    output: {
      x: pixel.left / scaleX,
      y: pixel.top / scaleY,
      width: pixel.width / scaleX,
      height: pixel.height / scaleY,
    },
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Compare a source frame, a width:none underlay frame, and the restored frame
 * inside one already-resolved strip rectangle. Byte-stable restoration is a
 * prerequisite; otherwise elapsed animation could masquerade as scrollbar
 * ink or fade.
 */
export function classifyNativeOverlayInk(
  source: NativeScrollbarFrame | null,
  underlay: NativeScrollbarFrame | null,
  restored: NativeScrollbarFrame | null,
  rect: CapturedScrollbarRect,
  clip: CapturedScrollbarRect | null,
  viewport: CapturedScrollbarRect,
): NativeOverlayInkVerdict {
  return analyzeNativeOverlayInk(source, underlay, restored, rect, clip, viewport).verdict;
}

/**
 * Recover visible overlay geometry from the exact source-vs-width:none pixel
 * discriminator. Overlay scrollbars consume no layout space, so suppressing
 * them leaves the underlay geometry unchanged. The restored frame must match
 * the source byte-for-byte before any changed pixels are trusted.
 */
export function analyzeNativeOverlayInk(
  source: NativeScrollbarFrame | null,
  underlay: NativeScrollbarFrame | null,
  restored: NativeScrollbarFrame | null,
  rect: CapturedScrollbarRect,
  clip: CapturedScrollbarRect | null,
  viewport: CapturedScrollbarRect,
): NativeOverlayInkAnalysis {
  if (source == null || underlay == null || restored == null
      || source.width !== underlay.width || source.height !== underlay.height
      || source.width !== restored.width || source.height !== restored.height) {
    return { verdict: "unavailable", rects: [] };
  }
  const plan = pixelCropForRect(rect, clip, viewport, source);
  if (plan == null) return { verdict: "unavailable", rects: [] };
  const sourceCrop = cropNativeControlRgba(source, plan.pixel);
  const underlayCrop = cropNativeControlRgba(underlay, plan.pixel);
  const restoredCrop = cropNativeControlRgba(restored, plan.pixel);
  if (sourceCrop == null || underlayCrop == null || restoredCrop == null) {
    return { verdict: "unavailable", rects: [] };
  }
  if (equalBytes(sourceCrop, underlayCrop)) {
    return equalBytes(sourceCrop, restoredCrop)
      ? { verdict: "empty", rects: [] }
      : { verdict: "unstable", rects: [] };
  }

  const pixelCount = plan.pixel.width * plan.pixel.height;
  const changed = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    if (sourceCrop[offset] !== underlayCrop[offset]
        || sourceCrop[offset + 1] !== underlayCrop[offset + 1]
        || sourceCrop[offset + 2] !== underlayCrop[offset + 2]
        || sourceCrop[offset + 3] !== underlayCrop[offset + 3]) changed[pixel] = 1;
  }
  // A platform animator may legitimately advance the scrollbar alpha while
  // width:none is restored. Accept that only when every source/restored delta
  // is confined to the source-owned mask proven by source-vs-underlay. Any
  // changed backdrop pixel remains an incoherent-frame failure.
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const restoredChanged = sourceCrop[offset] !== restoredCrop[offset]
      || sourceCrop[offset + 1] !== restoredCrop[offset + 1]
      || sourceCrop[offset + 2] !== restoredCrop[offset + 2]
      || sourceCrop[offset + 3] !== restoredCrop[offset + 3];
    if (restoredChanged && changed[pixel] === 0) return { verdict: "unstable", rects: [] };
  }

  const seen = new Uint8Array(pixelCount);
  const scaleX = source.width / viewport.width;
  const scaleY = source.height / viewport.height;
  const rects: CapturedScrollbarRect[] = [];
  for (let start = 0; start < pixelCount; start++) {
    if (changed[start] === 0 || seen[start] !== 0) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = plan.pixel.width;
    let minY = plan.pixel.height;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const pixel = queue[cursor]!;
      const x = pixel % plan.pixel.width;
      const y = Math.floor(pixel / plan.pixel.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= plan.pixel.width || nextY < 0 || nextY >= plan.pixel.height) continue;
        const next = nextY * plan.pixel.width + nextX;
        if (changed[next] === 0 || seen[next] !== 0) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    // Single-pixel changes are indistinguishable from compositor/readback
    // noise and cannot define a platform owner rectangle.
    if (pixels < 2) continue;
    rects.push({
      x: (plan.pixel.left + minX) / scaleX,
      y: (plan.pixel.top + minY) / scaleY,
      width: (maxX - minX + 1) / scaleX,
      height: (maxY - minY + 1) / scaleY,
    });
  }
  return rects.length === 0
    ? { verdict: "unavailable", rects: [] }
    : { verdict: "visible", rects };
}

/** Encode one exact pixel crop without resampling or cross-platform paint. */
export async function materializeNativeScrollbarRaster(
  frame: NativeScrollbarFrame | null,
  rect: CapturedScrollbarRect,
  clip: CapturedScrollbarRect | null,
  viewport: CapturedScrollbarRect,
  captureDpr: number,
  fingerprint: CapturedScrollbarPlatformFingerprint,
  interaction: { hostHovered: boolean; hostPressed: boolean },
  empty = false,
): Promise<CapturedNativeScrollbarRaster | null> {
  if (frame == null) return null;
  const plan = pixelCropForRect(rect, clip, viewport, frame);
  if (plan == null) return null;
  const base = {
    ...plan.output,
    pixelWidth: plan.pixel.width,
    pixelHeight: plan.pixel.height,
    captureDpr,
    precomposited: true as const,
    sourceFrameSha256: frame.pngSha256,
    opacitySource: "precomposited-source-frame" as const,
    interaction,
    platformFingerprint: fingerprint,
  };
  if (empty) return { ...base, empty: true };
  const rgba = cropNativeControlRgba(frame, plan.pixel);
  if (rgba == null) return null;
  const png = await sharp(Buffer.from(rgba), {
    raw: { width: plan.pixel.width, height: plan.pixel.height, channels: 4 },
  }).png().toBuffer();
  return {
    ...base,
    cropSha256: sha256(png),
    dataUri: `data:image/png;base64,${png.toString("base64")}`,
  };
}
