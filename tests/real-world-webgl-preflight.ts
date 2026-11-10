import type { Page } from "@playwright/test";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { PreflightFrameGeometry } from "./real-world-webgl-frame-geometry.js";
import { intersectPolygons, offscreenPolygonClip, MAX_CANVAS_CLIP_SIDE } from "./real-world-webgl-geometry.js";

/** Small, fixed budget: one offscreen screenshot can trigger a full WebGL readback. */
const MAX_CANVASES = 8;
const MAX_CLIP_SIDE = MAX_CANVAS_CLIP_SIDE;
const MAX_DISCOVERY_MS = 3_000;
const MAX_PREFLIGHT_MS = 10_000;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Clip extends Rect {
  scale: number;
}

interface PageMetrics extends Rect {
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** A frame's canvas rect is projected into main-frame viewport coordinates first. */
export function offscreenCanvasClip(rect: Rect, page: PageMetrics, frameClips: Rect[] = []): Clip | null {
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  let visible = rect;
  for (const clip of frameClips) {
    const clipped = intersect(visible, clip);
    if (clipped == null) return null;
    visible = clipped;
  }
  if (intersect(visible, page) != null) return null;
  const x = Math.max(0, Math.floor(visible.x + page.scrollX));
  const y = Math.max(0, Math.floor(visible.y + page.scrollY));
  const width = Math.min(
    MAX_CLIP_SIDE,
    Math.ceil(visible.x + visible.width + page.scrollX) - x,
    page.documentWidth - x,
  );
  const height = Math.min(
    MAX_CLIP_SIDE,
    Math.ceil(visible.y + visible.height + page.scrollY) - y,
    page.documentHeight - y,
  );
  return width > 0 && height > 0 ? { x, y, width, height, scale: 1 } : null;
}

async function discoverCanvasClips(
  page: Page,
  onFailure?: (failure: CanvasPreflightFailure) => void,
): Promise<{ clips: Clip[]; failed: number; skipped: number }> {
  const deadline = Date.now() + MAX_DISCOVERY_MS;
  const metrics = await evaluateInFrame(page, (): PageMetrics => ({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    documentWidth: Math.max(
      document.scrollingElement?.scrollWidth ?? 0,
      document.documentElement.scrollWidth,
      window.innerWidth,
    ),
    documentHeight: Math.max(
      document.scrollingElement?.scrollHeight ?? 0,
      document.documentElement.scrollHeight,
      window.innerHeight,
    ),
  }));
  const geometry = new PreflightFrameGeometry(page, deadline);
  try {
    const outcomes = await Promise.all(
      page.frames().map(async (frame) => {
        try {
          if (frame !== page.mainFrame()) {
            const projected = await geometry.canvases(frame);
            const clips: Clip[] = [];
            let skipped = projected.skipped;
            for (const candidate of projected.candidates) {
              let visible = candidate.polygon;
              for (const clip of candidate.clips) visible = intersectPolygons(visible, clip);
              if (visible.length < 3) {
                skipped++;
                continue;
              }
              const clip = offscreenPolygonClip(visible, metrics);
              if (clip != null) clips.push(clip);
            }
            return { clips, failed: 0, skipped };
          }
          const own = await evaluateInFrame(frame, () => ({
            width: window.innerWidth,
            height: window.innerHeight,
            canvases: Array.from(document.querySelectorAll("canvas")).flatMap((canvas) => {
              const style = getComputedStyle(canvas);
              if (style.display === "none" || style.visibility === "hidden") return [];
              const r = canvas.getBoundingClientRect();
              return r.width > 0 && r.height > 0 ? [{ x: r.x, y: r.y, width: r.width, height: r.height }] : [];
            }),
          }));
          const clips: Clip[] = [];
          for (const rect of own.canvases) {
            const clip = offscreenCanvasClip(rect, metrics);
            if (clip != null) clips.push(clip);
          }
          return { clips, failed: 0, skipped: 0 };
        } catch (error: unknown) {
          onFailure?.({ phase: "discovery", error });
          return { clips: [], failed: 1, skipped: 0 };
        }
      }),
    );
    return {
      clips: outcomes.flatMap((outcome) => outcome.clips),
      failed: outcomes.reduce((total, outcome) => total + outcome.failed, 0),
      skipped: outcomes.reduce((total, outcome) => total + outcome.skipped, 0),
    };
  } finally {
    await geometry.dispose();
  }
}

export interface CanvasPreflightResult {
  /** Successful bounded capture requests; fully hidden cross-origin paint activation is not authenticated (DM-PCT7GR). */
  primed: number;
  failed: number;
  skipped: number;
}

export interface CanvasPreflightFailure {
  phase: "discovery" | "session" | "capture";
  error: unknown;
}

/**
 * Request bounded off-viewport canvas presentation before the WebGL freeze.
 * Ordinary page.screenshot clips cannot reach beyond the viewport, while CDP's
 * captureBeyondViewport does so without scrolling or changing the page's rAF.
 * Child-frame browser-owned content quads are projected through authenticated
 * local-root homographies and clipped as polygons by every enclosing frame.
 * Unproved camera/clip authority is explicitly skipped (DM-GQNPEN).
 * Screenshot success alone is not a paint witness for fully hidden cross-origin
 * frames; that existing presentation limitation is tracked by DM-PCT7GR.
 * The caller has already taken its reference screenshot. The capture context
 * is closed after the job, so this CDP session and its effects are job-scoped.
 */
export async function primeOffscreenCanvases(
  page: Page,
  onFailure?: (failure: CanvasPreflightFailure) => void,
): Promise<CanvasPreflightResult> {
  const discovery = discoverCanvasClips(page, onFailure).catch((error: unknown) => {
    onFailure?.({ phase: "discovery", error });
    return null;
  });
  let discoveryTimer: NodeJS.Timeout | undefined;
  const discoveryTimeout = new Promise<null>((resolve) => {
    discoveryTimer = setTimeout(() => resolve(null), MAX_DISCOVERY_MS);
  });
  const discovered = await Promise.race([discovery, discoveryTimeout]);
  clearTimeout(discoveryTimer);
  if (discovered == null) return { primed: 0, failed: 1, skipped: 0 };
  const chosen = discovered.clips.slice(0, MAX_CANVASES);
  const result: CanvasPreflightResult = {
    primed: 0,
    failed: discovered.failed,
    skipped: discovered.skipped + discovered.clips.length - chosen.length,
  };
  if (chosen.length === 0) return result;
  const session = await page
    .context()
    .newCDPSession(page)
    .catch((error: unknown) => {
      onFailure?.({ phase: "session", error });
      return null;
    });
  if (session == null) return { ...result, failed: result.failed + chosen.length };
  const deadline = Date.now() + MAX_PREFLIGHT_MS;
  try {
    for (const [index, clip] of chosen.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        result.skipped += chosen.length - index;
        break;
      }
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      });
      const captured = session
        .send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip })
        .then(() => true)
        .catch((error: unknown) => {
          onFailure?.({ phase: "capture", error });
          return false;
        });
      const ok = await Promise.race([captured, timedOut]);
      clearTimeout(timer);
      if (ok) result.primed++;
      else result.failed++;
      if (Date.now() >= deadline) {
        result.skipped += chosen.length - index - 1;
        break;
      }
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
  return result;
}
