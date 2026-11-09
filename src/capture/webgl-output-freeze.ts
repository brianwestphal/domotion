import type { Frame, Page } from "@playwright/test";
import { evaluateInFrame } from "./evaluate-in-frame.js";

/** Blink marks the drawing buffer changed through these WebGL paint entry points. */
export const WEBGL_PAINT_METHODS: Record<string, readonly string[]> = {
  WebGLRenderingContext: ["clear", "drawArrays", "drawElements"],
  WebGL2RenderingContext: [
    "clear",
    "drawArrays",
    "drawElements",
    "drawArraysInstanced",
    "drawElementsInstanced",
    "drawRangeElements",
    "blitFramebuffer",
    "clearBufferfv",
    "clearBufferiv",
    "clearBufferuiv",
    "clearBufferfi",
  ],
  ANGLEInstancedArrays: ["drawArraysInstancedANGLE", "drawElementsInstancedANGLE"],
  WebGLMultiDraw: [
    "multiDrawArraysWEBGL",
    "multiDrawElementsWEBGL",
    "multiDrawArraysInstancedWEBGL",
    "multiDrawElementsInstancedWEBGL",
  ],
  WebGLDrawInstancedBaseVertexBaseInstance: [
    "drawArraysInstancedBaseInstanceWEBGL",
    "drawElementsInstancedBaseVertexBaseInstanceWEBGL",
  ],
  WebGLMultiDrawInstancedBaseVertexBaseInstance: [
    "multiDrawArraysInstancedBaseInstanceWEBGL",
    "multiDrawElementsInstancedBaseVertexBaseInstanceWEBGL",
  ],
};

const FREEZE_KEY = "__domotionCaptureWebGlFreeze";
const CANVAS_PROBE_TIMEOUT_MS = 5_000;

/** A child frame can stop answering after a prior iframe navigation even while
 * Playwright still lists it. Keep a missed probe visible as a capture warning
 * instead of letting one stale frame block every later fixture. */
async function frameHasCanvas(frame: Frame): Promise<boolean | null> {
  if (frame.isDetached()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluateInFrame(frame, () => document.querySelector("canvas") != null).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CANVAS_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export interface WebGlOutputFreeze {
  frozenFrames: number;
  /** Frames whose canvas presence was unknown or whose draw methods could not be muted. */
  failedFrames: number;
  dispose(): Promise<void>;
}

/**
 * Preserve the currently presented canvas frame during one capture. The
 * screenshot forces Chromium to finish presenting live WebGL before drawing
 * methods are muted; the caller restores them before seeking another frame.
 */
export async function freezeWebGlOutputForCapture(page: Page): Promise<WebGlOutputFreeze> {
  const frames = page.frames();
  const canvasPresence = await Promise.all(frames.map(frameHasCanvas));
  const missedProbes = canvasPresence.filter((present) => present == null).length;
  if (!canvasPresence.some(Boolean)) {
    return { frozenFrames: 0, failedFrames: missedProbes, dispose: async () => undefined };
  }
  const canvasFrames = frames.filter((_, index) => canvasPresence[index]);

  // One live screenshot is required before muting draws. A failed screenshot
  // leaves the page untouched and lets the ordinary capture report its error.
  await page.screenshot({ type: "png" });

  const patched = await Promise.all(
    canvasFrames.map(async (frame) => {
      try {
        return await evaluateInFrame(
          frame,
          ({ key, methods }: { key: string; methods: Record<string, readonly string[]> }) => {
            const scope = window as unknown as Record<string, unknown>;
            type Entry = { proto: Record<string, unknown>; name: string; descriptor: PropertyDescriptor | undefined };
            type State = { depth: number; entries: Entry[]; failedMethods: number };
            const existing = scope[key] as State | undefined;
            if (existing != null) {
              if (
                !Array.isArray(existing.entries) ||
                typeof existing.depth !== "number" ||
                typeof existing.failedMethods !== "number"
              ) {
                throw new Error("WebGL capture freeze key is already owned by the page");
              }
              existing.depth++;
              return existing.failedMethods;
            }
            const entries: Entry[] = [];
            const state: State = { depth: 1, entries, failedMethods: 0 };
            Object.defineProperty(scope, key, { value: state, configurable: true });
            const noDraw = (): undefined => undefined;
            let failedMethods = 0;
            for (const [iface, names] of Object.entries(methods)) {
              const ctor = scope[iface] as { prototype?: Record<string, unknown> } | undefined;
              const proto = ctor?.prototype;
              if (proto == null) continue;
              for (const name of names) {
                if (typeof proto[name] !== "function") continue;
                const descriptor = Object.getOwnPropertyDescriptor(proto, name);
                if (descriptor != null && !descriptor.configurable && !descriptor.writable) {
                  failedMethods++;
                  continue;
                }
                try {
                  Object.defineProperty(proto, name, { configurable: true, writable: true, value: noDraw });
                  entries.push({ proto, name, descriptor });
                } catch {
                  failedMethods++;
                }
              }
            }
            state.failedMethods = failedMethods;
            return failedMethods;
          },
          { key: FREEZE_KEY, methods: WEBGL_PAINT_METHODS },
        );
      } catch {
        return null;
      }
    }),
  );
  const frozenFrames = patched.filter((failedMethods) => failedMethods === 0).length;
  return {
    frozenFrames,
    failedFrames: missedProbes + patched.length - frozenFrames,
    dispose: async () => {
      const failures = await Promise.all(
        canvasFrames.map((frame) =>
          evaluateInFrame(
            frame,
            (key: string) => {
              const scope = window as unknown as Record<string, unknown>;
              type Entry = {
                proto: Record<string, unknown>;
                name: string;
                descriptor: PropertyDescriptor | undefined;
              };
              const state = scope[key] as { depth: number; entries: Entry[] } | undefined;
              if (state == null || !Array.isArray(state.entries) || typeof state.depth !== "number") return 0;
              if (--state.depth > 0) return 0;
              let failed = 0;
              for (const { proto, name, descriptor } of state.entries.reverse()) {
                try {
                  if (descriptor == null) {
                    if (!delete proto[name]) failed++;
                  } else Object.defineProperty(proto, name, descriptor);
                } catch {
                  failed++;
                }
              }
              delete scope[key];
              return failed;
            },
            FREEZE_KEY,
          ).catch(() => 0),
        ),
      );
      const unrestoredMethods = failures.reduce((total, count) => total + count, 0);
      if (unrestoredMethods > 0) {
        throw new Error(`could not restore ${unrestoredMethods} WebGL paint method(s) after capture`);
      }
    },
  };
}
