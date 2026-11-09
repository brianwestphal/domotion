import { randomUUID } from "node:crypto";
import type { Frame, Page, Worker } from "@playwright/test";
import { browserCallbackExpression } from "../src/capture/evaluate-in-frame.js";
import { WEBGL_PAINT_METHODS } from "../src/capture/webgl-output-freeze.js";
import { freezeWorkerLifecycle } from "./real-world-webgl-worker-lifecycle.js";

/**
 * Stop a real-world page's WebGL canvases from producing new frames once the
 * harness has taken its expected screenshot, so the rest of the capture does
 * not queue behind software-rasterized WebGL.
 *
 * Why: resend.com runs a continuous WebGL render loop. Headless Chromium
 * composites in software, so every main-frame commit in which a WebGL canvas
 * changed reads the drawing buffer back (`DrawingBuffer::
 * PrepareTransferableResource`, software branch → `ReadBackFramebuffer`), and
 * the renderer main thread blocks until the GPU process has rasterized the
 * queued draws. A trace taken mid-capture showed every commit spending
 * ~290 ms in `GLES2::ReadPixels` with the renderer main thread busy for the
 * whole capture (`TaskDuration` 562 s over 562 s of wall time, of which only
 * 3 s was script). Every CDP command and screenshot the capture issues waits
 * behind those commits. In one page, 40 `CSS.getComputedStyleForNode` round
 * trips took 3.6-5.8 s while WebGL drew (up to 37 s on a heavily loaded host)
 * and 0.1-0.2 s after this freeze, with the renderer main thread going from
 * fully busy to nearly idle. The fold capture
 * overran its six-minute job budget on idle CI runners as well as on loaded
 * dev hosts; Domotion's own Node-side CPU for the whole capture was about four
 * seconds.
 *
 * Mechanism, from Blink (chromium 7d859f27, `platform/graphics/gpu/
 * drawing_buffer.cc` and `modules/webgl/webgl_rendering_context_base.cc`):
 * the readback only happens when the drawing buffer's `contents_changed_` is
 * set, and only `WebGLRenderingContextBase::MarkContextChanged` sets it. Its callers are
 * `clear`, every draw call (`DrawWrapper` → `OnBeforeDrawCall`, including the
 * instanced and multi-draw extension entry points), and WebGL 2's
 * `blitFramebuffer` and `clearBuffer*`. Turning exactly those into no-ops
 * leaves the canvas displaying its last presented frame and stops all further
 * raster work, while the page's own script, timers and rAF keep running.
 *
 * Holding `requestAnimationFrame` instead does not work here: a wrapper
 * installed before navigation was found replaced by a native
 * `requestAnimationFrame` once resend.com had loaded, and its loop kept
 * running. The draw entry points live on the WebGL prototypes, which the
 * page's renderer calls through on every frame.
 *
 * Workers drawing transferred OffscreenCanvas surfaces have separate WebGL
 * prototypes. Observe Page-related dedicated workers with paused CDP attachment
 * and patch before module imports. SharedWorkers are observed across the job's
 * isolated BrowserContext, including workers already running when freeze starts.
 * The managed harness broker owns new SharedWorker startup through public CDP
 * before imports can cache native methods. Ordinary Playwright browsers retain
 * a partial fallback: independent resume can escape startup interception, so
 * late targets count as failures even when live calls are muted. Cached native
 * references in already-running realms remain outside prototype interception.
 *
 * Freeze follows the expected screenshot, preserving its reference pixels/crops.
 * The result owns reference-counted patches and bounded debugger sessions until
 * dispose(), also called on Page/context close. The harness disposes in finally.
 */

const FREEZE_KEY = "__domotionRealWorldWebGlFrozen";

export interface WebGlFreezeResult {
  /** Frames whose WebGL prototypes were patched. */
  frozenFrames: number;
  /** Frames that could not be patched (detached, navigating, crashed). */
  failedFrames: number;
  /** Patched targets; excludes late SharedWorkers with unsafe startup. */
  frozenWorkers: number;
  /** Failed patches/discovery and late SharedWorkers with unsafe startup. */
  failedWorkers: number;
  /** Live frames whose original methods could not be restored/verified. */
  failedFrameRestorations: number;
  /** Live workers whose original methods could not be restored/verified. */
  failedWorkerRestorations: number;
  /** Stop target observation and restore this capture's prototype patches. */
  dispose(): Promise<void>;
}

const GLOBAL_TIMEOUT_MS = 10_000;

/** Runs inside a Window, dedicated Worker or SharedWorker; no module closures. */
function patchWebGlGlobal({
  key,
  methods,
  owner,
}: {
  key: string;
  methods: Record<string, readonly string[]>;
  owner: string;
}): boolean {
  const scope = globalThis as Record<string, unknown>;
  type Entry = { proto: Record<string, unknown>; name: string; descriptor: PropertyDescriptor | undefined };
  type State = { owners: string[]; entries: Entry[]; failed: boolean };
  const existing = scope[key] as State | undefined;
  if (existing != null) {
    if (!Array.isArray(existing.owners) || !Array.isArray(existing.entries)) return false;
    if (!existing.owners.includes(owner)) existing.owners.push(owner);
    return !existing.failed;
  }
  const state: State = { owners: [owner], entries: [], failed: false };
  Object.defineProperty(scope, key, { value: state, configurable: true });
  const noDraw = (): undefined => undefined;
  for (const [iface, names] of Object.entries(methods)) {
    const ctor = scope[iface] as { prototype?: Record<string, unknown> } | undefined;
    const proto = ctor?.prototype;
    if (proto == null) continue;
    for (const name of names) {
      if (typeof proto[name] !== "function") continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      try {
        Object.defineProperty(proto, name, { configurable: true, writable: true, value: noDraw });
        state.entries.push({ proto, name, descriptor });
      } catch {
        state.failed = true;
      }
    }
  }
  return !state.failed;
}

function restoreWebGlGlobal({ key, owner }: { key: string; owner: string }): boolean {
  const scope = globalThis as Record<string, unknown>;
  type Entry = { proto: Record<string, unknown>; name: string; descriptor: PropertyDescriptor | undefined };
  const state = scope[key] as { owners: string[]; entries: Entry[]; failed: boolean } | undefined;
  if (state == null || !Array.isArray(state.owners) || !Array.isArray(state.entries) || !state.owners.includes(owner))
    return true;
  state.owners = state.owners.filter((value) => value !== owner);
  if (state.owners.length > 0) return true;
  const unrestored: Entry[] = [];
  for (const entry of [...state.entries].reverse()) {
    const { proto, name, descriptor } = entry;
    try {
      if (descriptor == null) {
        if (!delete proto[name]) unrestored.push(entry);
      } else Object.defineProperty(proto, name, descriptor);
    } catch {
      unrestored.push(entry);
    }
  }
  state.entries = unrestored.reverse();
  state.owners = [owner];
  state.failed = unrestored.length > 0;
  // Keep original descriptors and ownership when page code hardened a patched
  // prototype. A failed cleanup must not erase the evidence needed to diagnose it.
  if (state.failed) return false;
  try {
    if (delete scope[key]) return true;
  } catch {
    // A hardened marker is also an incomplete cleanup.
  }
  state.failed = true;
  return false;
}

async function evaluateGlobal(target: Frame | Worker, expression: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), GLOBAL_TIMEOUT_MS);
  });
  // browserCallbackExpression scopes tsx's `__name` keep-names helper to the
  // callback without changing either global. Frame and Worker both accept it.
  const patched = target.evaluate<boolean>(expression).catch(() => false);
  const result = await Promise.race([patched, timeout]);
  clearTimeout(timer);
  return result;
}

const activeFreezes = new WeakMap<Page, Promise<WebGlFreezeResult>>();

/** Freeze current frames and observe worker lifecycles until disposal/context close. */
export function freezeWebGlOutput(page: Page): Promise<WebGlFreezeResult> {
  const existing = activeFreezes.get(page);
  if (existing != null) return existing;
  const pending = prepareFreeze(page);
  activeFreezes.set(page, pending);
  return pending;
}

async function prepareFreeze(page: Page): Promise<WebGlFreezeResult> {
  const frames = page.frames();
  const owner = randomUUID();
  const patch = browserCallbackExpression(patchWebGlGlobal, { key: FREEZE_KEY, methods: WEBGL_PAINT_METHODS, owner });
  const restore = browserCallbackExpression(restoreWebGlGlobal, { key: FREEZE_KEY, owner });
  let workerLifecycle: Awaited<ReturnType<typeof freezeWorkerLifecycle>> | undefined;
  let initialized!: () => void;
  const ready = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  let disposing: Promise<void> | undefined;
  const result: WebGlFreezeResult = {
    frozenFrames: 0,
    failedFrames: 0,
    frozenWorkers: 0,
    failedWorkers: 0,
    failedFrameRestorations: 0,
    failedWorkerRestorations: 0,
    dispose: () =>
      (disposing ??= (async () => {
        await ready;
        page.off("close", close);
        page.context().off("close", close);
        await workerLifecycle?.dispose();
        await Promise.all(
          frames.map(async (frame) => {
            const restored = await evaluateGlobal(frame, restore);
            if (!restored && !page.isClosed() && !frame.isDetached()) result.failedFrameRestorations++;
          }),
        );
        activeFreezes.delete(page);
      })()),
  };
  const close = (): void => {
    void result.dispose().catch(() => undefined);
  };
  page.once("close", close);
  page.context().once("close", close);
  const [frameOutcomes, lifecycle] = await Promise.all([
    Promise.all(frames.map((frame) => evaluateGlobal(frame, patch))),
    freezeWorkerLifecycle(page, { patch, restore }, result),
  ]);
  workerLifecycle = lifecycle;
  initialized();
  result.frozenFrames = frameOutcomes.filter(Boolean).length;
  result.failedFrames = frames.length - result.frozenFrames;
  if (page.isClosed()) await result.dispose();
  return result;
}
