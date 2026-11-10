import type { Frame, Page } from "@playwright/test";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";

/** Small, fixed budget: one offscreen screenshot can trigger a full WebGL readback. */
const MAX_CANVASES = 8;
const MAX_CLIP_SIDE = 512;
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

async function frameContentBox(frame: Frame): Promise<Rect | null> {
  const owner = await frame.frameElement();
  try {
    const [box, facts] = await Promise.all([
      owner.boundingBox(),
      owner.evaluate((element) => {
        // Playwright types frameElement as a Node; its live owner is an element.
        const frameOwner = element as Element;
        const style = getComputedStyle(frameOwner);
        const parent = (node: Element): Element | null => {
          const root = node.getRootNode();
          return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        };
        for (let ancestor: Element | null = frameOwner; ancestor != null; ancestor = parent(ancestor)) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (ancestorStyle.perspective !== "none" || !["none", "0deg"].includes(ancestorStyle.rotate)) return null;
          if (ancestorStyle.scale !== "none" && ancestorStyle.scale.split(/\s+/).some((n) => !(Number(n) > 0)))
            return null;
          if (ancestorStyle.transform !== "none") {
            const matrix = new DOMMatrixReadOnly(ancestorStyle.transform);
            if (!matrix.is2D || matrix.a <= 0 || matrix.d <= 0 || matrix.b !== 0 || matrix.c !== 0) return null;
          }
        }
        const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
        const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
        const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
        const contentWidth = parseFloat(style.width) - (style.boxSizing === "border-box" ? left + right : 0);
        const contentHeight = parseFloat(style.height) - (style.boxSizing === "border-box" ? top + bottom : 0);
        return {
          left,
          top,
          contentWidth,
          contentHeight,
          width: contentWidth + left + right,
          height: contentHeight + top + bottom,
        };
      }),
    ]);
    if (box == null || facts == null || facts.width <= 0 || facts.height <= 0) return null;
    // Playwright supplies main-frame coordinates, including nested iframe offsets.
    const scaleX = box.width / facts.width;
    const scaleY = box.height / facts.height;
    const content = {
      x: box.x + facts.left * scaleX,
      y: box.y + facts.top * scaleY,
      width: facts.contentWidth * scaleX,
      height: facts.contentHeight * scaleY,
    };
    return Object.values(content).every(Number.isFinite) && content.width > 0 && content.height > 0 ? content : null;
  } finally {
    await owner.dispose();
  }
}

async function discoverCanvasClips(page: Page): Promise<{ clips: Clip[]; failed: number; skipped: number }> {
  const metrics = await evaluateInFrame(page, (): PageMetrics => ({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    documentWidth: Math.max(document.documentElement.scrollWidth, window.innerWidth),
    documentHeight: Math.max(document.documentElement.scrollHeight, window.innerHeight),
  }));
  const boxes = new Map<Frame, Promise<Rect | null>>();
  const contentBox = (frame: Frame): Promise<Rect | null> => {
    const existing = boxes.get(frame);
    if (existing != null) return existing;
    const pending = frameContentBox(frame).catch(() => null);
    boxes.set(frame, pending);
    return pending;
  };
  const outcomes = await Promise.all(
    page.frames().map(async (frame) => {
      try {
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
        const frameClips: Rect[] = [];
        if (own.canvases.length === 0) return { clips, failed: 0, skipped: 0 };
        for (let ancestor: Frame | null = frame; ancestor?.parentFrame() != null; ancestor = ancestor.parentFrame()) {
          const box = await contentBox(ancestor);
          if (box == null) return { clips, failed: 0, skipped: own.canvases.length };
          frameClips.push(box);
        }
        const content = frameClips[0];
        const scaleX = content == null ? 1 : content.width / own.width;
        const scaleY = content == null ? 1 : content.height / own.height;
        let skipped = 0;
        for (const rect of own.canvases) {
          const projected = {
            x: (content?.x ?? 0) + rect.x * scaleX,
            y: (content?.y ?? 0) + rect.y * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY,
          };
          if (frameClips.some((box) => intersect(projected, box) == null)) skipped++;
          const clip = offscreenCanvasClip(projected, metrics, frameClips);
          if (clip != null) clips.push(clip);
        }
        return { clips, failed: 0, skipped };
      } catch {
        return { clips: [], failed: 1, skipped: 0 };
      }
    }),
  );
  return {
    clips: outcomes.flatMap((outcome) => outcome.clips),
    failed: outcomes.reduce((total, outcome) => total + outcome.failed, 0),
    skipped: outcomes.reduce((total, outcome) => total + outcome.skipped, 0),
  };
}

export interface CanvasPreflightResult {
  primed: number;
  failed: number;
  skipped: number;
}

export interface CanvasPreflightFailure {
  phase: "discovery" | "session" | "capture";
  error: unknown;
}

/**
 * Make off-viewport canvas layers compositor-visible before the WebGL freeze.
 * Ordinary page.screenshot clips cannot reach beyond the viewport, while CDP's
 * captureBeyondViewport does so without scrolling or changing the page's rAF.
 * Child-frame content boxes (including cross-origin and nested frames) are
 * projected using main-frame-relative owner bounds, then clipped by every
 * enclosing frame. Rotated/projective owners are explicitly skipped.
 * The caller has already taken its reference screenshot. The capture context
 * is closed after the job, so this CDP session and its effects are job-scoped.
 */
export async function primeOffscreenCanvases(
  page: Page,
  onFailure?: (failure: CanvasPreflightFailure) => void,
): Promise<CanvasPreflightResult> {
  const discovery = discoverCanvasClips(page).catch((error: unknown) => {
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
