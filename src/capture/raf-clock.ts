import { randomUUID } from "node:crypto";
import type { BrowserContext, CDPSession, Frame, Page } from "@playwright/test";

export const CAPTURE_RAF_CLOCK_PROTOCOL = "domotion-capture-raf-clock-v1" as const;

export interface CaptureRafClockHandle {
  protocol: typeof CAPTURE_RAF_CLOCK_PROTOCOL;
  controlKey: string;
}

export interface CaptureRafTargetState {
  targetId: string;
  frameIdentity: string;
  frameUrl: string;
  requestedTimeMs: number;
  callbacksExecuted: number;
  callbacksPending: number;
  workerConstructionAttempts: number;
  offscreenTransferAttempts: number;
  sourceFingerprint: string;
}

export interface StableCaptureRafState {
  protocol: typeof CAPTURE_RAF_CLOCK_PROTOCOL;
  requestedTimeMs: number;
  targets: CaptureRafTargetState[];
}

type PageClockState = {
  protocol: string;
  callbacks: Map<number, FrameRequestCallback>;
  nextId: number;
  callbacksExecuted: number;
  workerConstructionAttempts: number;
  offscreenTransferAttempts: number;
  sourceFingerprint: string;
  currentTimeMs: number | null;
  remainingCallbacks: number;
};

/**
 * Install the capture rAF owner before the first navigation. Unlike
 * Playwright's page clock, the shim never publishes a saved native rAF
 * function. Dedicated workers and OffscreenCanvas transfers fail closed
 * because BrowserContext init scripts cannot instrument worker globals.
 */
export async function installCaptureRafClock(context: BrowserContext): Promise<CaptureRafClockHandle> {
  const controlKey = `__domotionRafClock_${randomUUID().replaceAll("-", "")}`;
  await context.addInitScript(({ key, protocol }) => {
    const scope = globalThis as typeof globalThis & Record<string, unknown>;
    const callbacks = new Map<number, FrameRequestCallback>();
    const state: PageClockState = {
      protocol,
      callbacks,
      nextId: 1,
      callbacksExecuted: 0,
      workerConstructionAttempts: 0,
      offscreenTransferAttempts: 0,
      sourceFingerprint: "window-raf-queue+worker-offscreen-fail-closed-v1",
      currentTimeMs: null,
      remainingCallbacks: 0,
    };

    const request = (callback: FrameRequestCallback): number => {
      if (typeof callback !== "function") throw new TypeError("requestAnimationFrame callback must be a function");
      const id = state.nextId++;
      if (state.currentTimeMs != null) {
        if (state.remainingCallbacks-- <= 0) throw new Error("capture rAF callback bound exceeded");
        state.callbacksExecuted++;
        callback(state.currentTimeMs);
        return id;
      }
      callbacks.set(id, callback);
      return id;
    };
    const cancel = (id: number): void => { callbacks.delete(Number(id)); };
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: false, writable: false, value: request });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: false, writable: false, value: cancel });

    const blockWorker = (): never => {
      state.workerConstructionAttempts++;
      throw new DOMException("Worker rAF is unavailable during an authenticated capture frame", "NotSupportedError");
    };
    if ("Worker" in globalThis) Object.defineProperty(globalThis, "Worker", { configurable: false, writable: false, value: blockWorker });
    if ("SharedWorker" in globalThis) Object.defineProperty(globalThis, "SharedWorker", { configurable: false, writable: false, value: blockWorker });
    const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
    if (canvasPrototype != null && "transferControlToOffscreen" in canvasPrototype) {
      Object.defineProperty(canvasPrototype, "transferControlToOffscreen", {
        configurable: false,
        writable: false,
        value(): never {
          state.offscreenTransferAttempts++;
          throw new DOMException("OffscreenCanvas is unavailable during an authenticated capture frame", "NotSupportedError");
        },
      });
    }

    Object.defineProperty(scope, key, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (timeMs: number, maxCallbacks: number) => {
        if (!Number.isFinite(timeMs) || timeMs < 0) throw new TypeError("invalid capture rAF time");
        if ((scope as { __pwClock?: unknown }).__pwClock != null) {
          throw new Error("page-visible Playwright native clock escape is present");
        }
        const batch = [...callbacks.entries()];
        callbacks.clear();
        if (batch.length > maxCallbacks) throw new Error(`capture rAF callback bound exceeded: ${batch.length}`);
        state.currentTimeMs = timeMs;
        state.remainingCallbacks = maxCallbacks;
        for (const [, callback] of batch) {
          if (state.remainingCallbacks-- <= 0) throw new Error("capture rAF callback bound exceeded");
          state.callbacksExecuted++;
          callback(timeMs);
        }
        return {
          protocol: state.protocol,
          requestedTimeMs: timeMs,
          callbacksExecuted: state.callbacksExecuted,
          callbacksPending: callbacks.size,
          workerConstructionAttempts: state.workerConstructionAttempts,
          offscreenTransferAttempts: state.offscreenTransferAttempts,
          sourceFingerprint: state.sourceFingerprint,
        };
      },
    });
  }, { key: controlKey, protocol: CAPTURE_RAF_CLOCK_PROTOCOL });
  return { protocol: CAPTURE_RAF_CLOCK_PROTOCOL, controlKey };
}

async function targetId(session: CDPSession): Promise<string> {
  const result = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
  return result.targetInfo.targetId;
}

async function commitRendering(session: CDPSession): Promise<void> {
  await session.send("Runtime.evaluate", {
    expression: "document.documentElement?.getBoundingClientRect(); getComputedStyle(document.documentElement).display",
    awaitPromise: true,
    returnByValue: true,
  });
  await session.send("Page.getLayoutMetrics");
}

async function sampleFrame(
  page: Page,
  frame: Frame,
  handle: CaptureRafClockHandle,
  requestedTimeMs: number,
  maxCallbacks: number,
): Promise<CaptureRafTargetState> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(frame);
  } catch (error) {
    if (!/part of the parent frame's session/i.test(String(error))) throw error;
    session = await page.context().newCDPSession(page);
  }
  try {
    const result = await frame.evaluate(({ key, timeMs, bound }) => {
      const control = (globalThis as typeof globalThis & Record<string, unknown>)[key];
      if (typeof control !== "function") throw new Error("capture rAF clock was not installed before navigation");
      return (control as (time: number, max: number) => Omit<CaptureRafTargetState, "targetId" | "frameUrl" | "frameIdentity">)(timeMs, bound);
    }, { key: handle.controlKey, timeMs: requestedTimeMs, bound: maxCallbacks });
    await commitRendering(session);
    if (result.callbacksPending !== 0) {
      throw new Error(`capture rAF callbacks rescheduled during controlled commit: ${result.callbacksPending}`);
    }
    return {
      ...result,
      targetId: await targetId(session),
      frameIdentity: frame === page.mainFrame() ? "main" : frame.url(),
      frameUrl: frame.url(),
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function sampleCaptureRafClock(
  page: Page,
  handle: CaptureRafClockHandle,
  requestedTimeMs: number,
  maxCallbacks = 256,
): Promise<StableCaptureRafState> {
  if (handle.protocol !== CAPTURE_RAF_CLOCK_PROTOCOL) throw new Error("unsupported capture rAF clock handle");
  const before = page.frames();
  const targets = await Promise.all(before.map((frame) => sampleFrame(page, frame, handle, requestedTimeMs, maxCallbacks)));
  const after = page.frames();
  if (before.length !== after.length || before.some((frame, index) => frame !== after[index])) {
    throw new Error("capture target set changed during controlled rAF commit");
  }
  const oopifTargets = targets.filter((target) => target.targetId !== targets[0]?.targetId);
  if (new Set(oopifTargets.map((target) => target.targetId)).size !== oopifTargets.length) {
    throw new Error("capture rAF OOPIF target identities are not distinct");
  }
  return { protocol: CAPTURE_RAF_CLOCK_PROTOCOL, requestedTimeMs, targets };
}

export async function reverifyCaptureRafClock(
  page: Page,
  handle: CaptureRafClockHandle,
  expected: StableCaptureRafState,
): Promise<void> {
  const actual = await sampleCaptureRafClock(page, handle, expected.requestedTimeMs, 256);
  const exactAuthority = actual.protocol === expected.protocol
    && actual.requestedTimeMs === expected.requestedTimeMs
    && actual.targets.length === expected.targets.length
    && actual.targets.every((target, index) => {
      const prior = expected.targets[index];
      return prior != null
        && target.targetId === prior.targetId
        && target.frameIdentity === prior.frameIdentity
        && target.frameUrl === prior.frameUrl
        && target.requestedTimeMs === prior.requestedTimeMs
        && target.callbacksPending === 0
        && target.callbacksExecuted >= prior.callbacksExecuted
        && target.workerConstructionAttempts === prior.workerConstructionAttempts
        && target.offscreenTransferAttempts === prior.offscreenTransferAttempts
        && target.sourceFingerprint === prior.sourceFingerprint;
    });
  if (!exactAuthority) {
    throw new Error("capture rAF target state changed between prepasses");
  }
}
