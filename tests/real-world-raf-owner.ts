import type { BrowserContext, Frame, Page } from "@playwright/test";
import { browserCallbackExpression, evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { CAPTURE_FRAME_SCHEDULER_PROTOCOL, registerCaptureFrameScheduler } from "../src/capture/frame-scheduler.js";
import { privateCaptureKey } from "../src/capture/private-key.js";
import { withTimeout } from "../src/utils/with-timeout.js";

interface OwnerState {
  owned: boolean;
  parked: boolean;
  disposed: boolean;
  failure: string | null;
  queuedAuthorCallbacks: number;
  pendingCaptureWaits: number;
  deliveredAuthorCallbacks: number;
  deliveredCaptureFrames: number;
  restored?: boolean;
}

/** A terminal harness Context owns this shim; disposal never replays parked callbacks. */
export async function installRealWorldRafOwner(context: BrowserContext) {
  if (context.pages().length !== 0) throw new Error("rAF owner must be installed before pages are created");
  const key = privateCaptureKey("RealWorldRaf");
  const scheduler = registerCaptureFrameScheduler(context, key);
  try {
    const installed = await withTimeout(
      context.addInitScript(
        browserCallbackExpression(
          ({ key, protocol }) => {
            const scope = globalThis as typeof globalThis & Record<string, unknown>;
            const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
            const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
            const originalRequest = globalThis.requestAnimationFrame;
            const originalCancel = globalThis.cancelAnimationFrame;
            const nativeRequest = originalRequest.bind(globalThis);
            const nativeCancel = originalCancel.bind(globalThis);
            const author = new Map<number, { callback: FrameRequestCallback; nativeId: number | null }>();
            const captureIds = new Set<number>();
            const captureRejects = new Set<(error: Error) => void>();
            let nextId = 1;
            let parked = false;
            let disposed = false;
            let disposedForwarding = false;
            let deliveredAuthorCallbacks = 0;
            let deliveredCaptureFrames = 0;
            let failure: string | null =
              requestDescriptor?.configurable === false || cancelDescriptor?.configurable === false
                ? "foreign initial rAF ownership"
                : null;

            const scheduleAuthor = (id: number) => {
              const entry = author.get(id);
              if (entry == null || parked || disposed) return;
              entry.nativeId = nativeRequest((time) => {
                entry.nativeId = null;
                if (parked || disposed || failure != null || !author.has(id)) return;
                author.delete(id);
                deliveredAuthorCallbacks++;
                entry.callback.call(globalThis, time);
              });
            };
            const requestAuthor = (callback: FrameRequestCallback): number => {
              // A source decorator may retain this function after terminal
              // cleanup restores its public wrapper. New calls stay native;
              // parked callbacks are never replayed by cleanup.
              if (disposed) {
                if (!disposedForwarding) throw new Error("rAF owner disposed without ownership");
                return nativeRequest(callback);
              }
              if (failure != null) throw new Error(`rAF owner failed: ${failure}`);
              if (typeof callback !== "function") throw new TypeError("rAF callback must be a function");
              if (author.size >= 4096) {
                failure = "author rAF callback bound exceeded";
                throw new Error(failure);
              }
              const id = nextId++;
              author.set(id, { callback, nativeId: null });
              scheduleAuthor(id);
              return id;
            };
            const cancelAuthor = (id: number) => {
              if (disposed) {
                if (!disposedForwarding) throw new Error("rAF owner disposed without ownership");
                nativeCancel(id);
                return;
              }
              const entry = author.get(Number(id));
              if (entry?.nativeId != null) nativeCancel(entry.nativeId);
              author.delete(Number(id));
            };
            let acceptedRequest = requestAuthor;
            let acceptedCancel = cancelAuthor;
            const owned = () =>
              Object.getOwnPropertyDescriptor(scope, key)?.value === control &&
              Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")?.value === acceptedRequest &&
              Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame")?.value === acceptedCancel;
            const acquireWarmupDelegate = () => {
              const requestSlot = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
              const cancelSlot = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
              const requestValue: unknown = requestSlot?.value;
              const cancelValue: unknown = cancelSlot?.value;
              if (
                Object.getOwnPropertyDescriptor(scope, key)?.value !== control ||
                requestSlot?.configurable === false ||
                cancelSlot?.configurable === false ||
                typeof requestValue !== "function" ||
                typeof cancelValue !== "function"
              ) {
                failure = "foreign rAF ownership";
                return;
              }
              const request = requestValue as typeof requestAnimationFrame;
              const cancel = cancelValue as typeof cancelAnimationFrame;
              const before = new Set(author.keys());
              let delivered = false;
              let mapped: number[] = [];
              let cancelled = false;
              let refused = false;
              try {
                // Transparent source decorators must actually register with
                // and cancel through this owner. No callback gets delivered,
                // and no vendor metadata or function-source heuristic is used.
                const id = request.call(globalThis, () => {
                  delivered = true;
                });
                mapped = [...author.keys()].filter((id) => !before.has(id));
                cancel.call(globalThis, id);
                cancelled = mapped.every((id) => !author.has(id));
              } catch {
                refused = true;
              } finally {
                for (const id of author.keys()) if (!before.has(id)) cancelAuthor(id);
              }
              if (
                refused ||
                delivered ||
                mapped.length !== 1 ||
                !cancelled ||
                Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")?.value !== request ||
                Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame")?.value !== cancel
              ) {
                failure = "foreign rAF delegate bypassed owned registration or cancellation";
                return;
              }
              acceptedRequest = request;
              acceptedCancel = cancel;
            };
            const assertOwned = () => {
              // Only warmup can establish a forwarding decorator. Once parked,
              // any changed scheduler is an error, even if it later forwards.
              if (!disposed && failure == null && !parked && !owned()) acquireWarmupDelegate();
              if (disposed || failure != null || !owned()) {
                failure ??= "foreign rAF ownership";
                throw new Error(`capture frame scheduler ownership lost: ${failure}`);
              }
            };
            const snapshot = (): OwnerState => ({
              owned: owned(),
              parked,
              disposed,
              failure,
              queuedAuthorCallbacks: author.size,
              pendingCaptureWaits: captureRejects.size,
              deliveredAuthorCallbacks,
              deliveredCaptureFrames,
            });
            const control = {
              protocol,
              park(): OwnerState {
                assertOwned();
                parked = true;
                for (const entry of author.values()) {
                  if (entry.nativeId != null) nativeCancel(entry.nativeId);
                  entry.nativeId = null;
                }
                return snapshot();
              },
              inspect(): OwnerState {
                assertOwned();
                return snapshot();
              },
              waitForCaptureFrames(count: 1 | 2, requireParked: boolean): Promise<void> {
                assertOwned();
                if (requireParked && !parked) throw new Error("capture frame scheduler is not parked");
                if ((count !== 1 && count !== 2) || captureRejects.size >= 4096)
                  throw new Error("capture frame scheduler request bound exceeded");
                return new Promise<void>((resolve, reject) => {
                  captureRejects.add(reject);
                  let remaining: number = count;
                  const step = () => {
                    let id = 0;
                    id = nativeRequest(() => {
                      captureIds.delete(id);
                      try {
                        assertOwned();
                        if (requireParked && !parked) throw new Error("capture frame scheduler lost its park");
                        deliveredCaptureFrames++;
                        if (--remaining === 0) {
                          captureRejects.delete(reject);
                          resolve();
                        } else step();
                      } catch (error) {
                        captureRejects.delete(reject);
                        reject(error instanceof Error ? error : new Error(String(error)));
                      }
                    });
                    captureIds.add(id);
                  };
                  step();
                });
              },
              dispose(): OwnerState {
                const wasOwned = owned() && failure == null;
                disposedForwarding = wasOwned;
                disposed = true;
                for (const entry of author.values()) if (entry.nativeId != null) nativeCancel(entry.nativeId);
                author.clear();
                for (const id of captureIds) nativeCancel(id);
                captureIds.clear();
                for (const reject of captureRejects) reject(new Error("capture frame scheduler disposed"));
                captureRejects.clear();
                // Never overwrite another owner's scheduler during cleanup.
                if (Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")?.value === requestAuthor) {
                  if (requestDescriptor != null)
                    Object.defineProperty(globalThis, "requestAnimationFrame", requestDescriptor);
                  else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
                }
                if (Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame")?.value === cancelAuthor) {
                  if (cancelDescriptor != null)
                    Object.defineProperty(globalThis, "cancelAnimationFrame", cancelDescriptor);
                  else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
                }
                if (Object.getOwnPropertyDescriptor(scope, key)?.value === control) Reflect.deleteProperty(scope, key);
                return { ...snapshot(), owned: wasOwned, restored: wasOwned };
              },
            };
            Object.freeze(control);
            Object.defineProperty(scope, key, { configurable: true, value: control });
            if (failure == null) {
              Object.defineProperty(globalThis, "requestAnimationFrame", {
                configurable: true,
                enumerable: requestDescriptor?.enumerable ?? true,
                writable: true,
                value: requestAuthor,
              });
              Object.defineProperty(globalThis, "cancelAnimationFrame", {
                configurable: true,
                enumerable: cancelDescriptor?.enumerable ?? true,
                writable: true,
                value: cancelAuthor,
              });
            }
          },
          { key, protocol: CAPTURE_FRAME_SCHEDULER_PROTOCOL },
        ),
      ),
      2_000,
      false,
    );
    if (installed === false) throw new Error("real-world rAF installation exceeded 2000ms");
  } catch (error) {
    scheduler.dispose();
    throw error;
  }

  let disposed = false;
  let parkedFrames: Set<Frame> | undefined;
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const expired = Symbol("rAF-owner-deadline");
    const result = await withTimeout(operation, 2_000, expired);
    if (result === expired) throw new Error("real-world rAF owner exceeded 2000ms");
    return result;
  };
  const call = (frame: Frame, action: "park" | "inspect" | "dispose") =>
    bounded(
      evaluateInFrame(
        frame,
        ({ key, protocol, action }) => {
          const control = Object.getOwnPropertyDescriptor(globalThis, key)?.value as
            { protocol?: string; park(): OwnerState; inspect(): OwnerState; dispose(): OwnerState } | undefined;
          if (control?.protocol !== protocol || typeof control[action] !== "function")
            throw new Error("real-world rAF owner unavailable");
          return control[action]();
        },
        { key, protocol: CAPTURE_FRAME_SCHEDULER_PROTOCOL, action },
      ),
    );
  const verify = async (page: Page): Promise<OwnerState[]> => {
    if (disposed || parkedFrames == null) throw new Error("real-world rAF owner is not parked");
    scheduler.assertValid();
    const frames = page.frames();
    if (frames.length !== parkedFrames.size || frames.some((frame) => !parkedFrames!.has(frame)))
      throw new Error("real-world rAF frame set changed");
    const states = await Promise.all(frames.map((frame) => call(frame, "inspect")));
    if (
      states.some((state) => !state.owned || !state.parked || state.failure != null || state.pendingCaptureWaits !== 0)
    )
      throw new Error("real-world rAF owner did not preserve its parked state");
    return states;
  };
  context.once("close", () => scheduler.dispose());
  return {
    async park(page: Page) {
      if (disposed) throw new Error("real-world rAF owner disposed");
      scheduler.assertValid();
      const frames = page.frames();
      await Promise.all(frames.map((frame) => call(frame, "park")));
      parkedFrames = new Set(frames);
      scheduler.activate();
      return verify(page);
    },
    verify,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        const frames = context.pages().flatMap((page) => page.frames());
        const states = await Promise.all(
          frames.filter((frame) => !frame.isDetached()).map((frame) => call(frame, "dispose")),
        );
        if (states.some((state) => state.restored !== true)) throw new Error("real-world rAF cleanup lost ownership");
      } finally {
        scheduler.dispose();
      }
    },
  };
}
