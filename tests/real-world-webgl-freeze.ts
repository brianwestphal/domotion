import type { Frame, Page, Worker } from "@playwright/test";
import { browserCallbackExpression } from "../src/capture/evaluate-in-frame.js";
import { WEBGL_PAINT_METHODS } from "../src/capture/webgl-output-freeze.js";

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
 * Dedicated Workers drawing transferred OffscreenCanvas surfaces have separate
 * WebGL prototypes, so patch their current globals too. The harness freezes
 * after the expected screenshot, so the reference pixels and the crops taken
 * from them are unaffected. Its capture context closes in a finally block,
 * so the next page starts with native prototypes.
 */

const FREEZE_KEY = "__domotionRealWorldWebGlFrozen";

export interface WebGlFreezeResult {
  /** Frames whose WebGL prototypes were patched. */
  frozenFrames: number;
  /** Frames that could not be patched (detached, navigating, crashed). */
  failedFrames: number;
  /** Dedicated Workers whose WebGL prototypes were patched. */
  frozenWorkers: number;
  /** Dedicated Workers that could not be patched (terminated, navigating, crashed). */
  failedWorkers: number;
}

const GLOBAL_TIMEOUT_MS = 10_000;

/** Runs inside either a Window or a dedicated Worker; no module closures. */
function patchWebGlGlobal({ key, methods }: { key: string; methods: Record<string, readonly string[]> }): boolean {
  const scope = globalThis as Record<string, unknown>;
  if (scope[key] === true) return true;
  const noDraw = (): undefined => undefined;
  for (const [iface, names] of Object.entries(methods)) {
    const ctor = scope[iface] as { prototype?: Record<string, unknown> } | undefined;
    const proto = ctor?.prototype;
    if (proto == null) continue;
    for (const name of names) {
      if (typeof proto[name] !== "function") continue;
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value: noDraw,
      });
    }
  }
  Object.defineProperty(scope, key, { value: true, configurable: true });
  return true;
}

async function freezeGlobal(target: Frame | Worker): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), GLOBAL_TIMEOUT_MS);
  });
  // browserCallbackExpression scopes tsx's `__name` keep-names helper to the
  // callback without changing either global. Frame and Worker both accept it.
  const expression = browserCallbackExpression(patchWebGlGlobal, {
    key: FREEZE_KEY,
    methods: WEBGL_PAINT_METHODS,
  });
  const patched = target.evaluate<boolean>(expression).catch(() => false);
  const result = await Promise.race([patched, timeout]);
  clearTimeout(timer);
  return result;
}

/** Freeze WebGL output in every current frame and dedicated Worker. Never throws. */
export async function freezeWebGlOutput(page: Page): Promise<WebGlFreezeResult> {
  const frames = page.frames();
  const workers = page.workers();
  const [frameOutcomes, workerOutcomes] = await Promise.all([
    Promise.all(frames.map(freezeGlobal)),
    Promise.all(workers.map(freezeGlobal)),
  ]);
  const frozenFrames = frameOutcomes.filter(Boolean).length;
  const frozenWorkers = workerOutcomes.filter(Boolean).length;
  return {
    frozenFrames,
    failedFrames: frames.length - frozenFrames,
    frozenWorkers,
    failedWorkers: workers.length - frozenWorkers,
  };
}
