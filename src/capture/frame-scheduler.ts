import type { BrowserContext, Frame, Page } from "@playwright/test";
import { withTimeout } from "../utils/with-timeout.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";

export const CAPTURE_FRAME_SCHEDULER_PROTOCOL = "domotion-capture-frame-scheduler-v1";

interface SchedulerRegistration {
  key: string;
  active: boolean;
  failure: string | null;
}

const schedulers = new WeakMap<BrowserContext, SchedulerRegistration>();

/** Internal capability used only by the real-world harness; absent in ordinary captures. */
export function registerCaptureFrameScheduler(context: BrowserContext, key: string) {
  if (schedulers.has(context)) throw new Error("capture frame scheduler already registered");
  const registration: SchedulerRegistration = { key, active: false, failure: null };
  schedulers.set(context, registration);
  return {
    activate() {
      if (schedulers.get(context) !== registration) throw new Error("capture frame scheduler ownership lost");
      this.assertValid();
      registration.active = true;
    },
    assertValid() {
      if (registration.failure != null) throw new Error(registration.failure);
    },
    dispose() {
      if (schedulers.get(context) === registration) schedulers.delete(context);
    },
  };
}

function contextFor(target: Frame | Page): BrowserContext | undefined {
  // Small Page/Frame test doubles can omit lifecycle APIs when no owner exists.
  if ("context" in target) return target.context();
  if ("page" in target) return target.page().context();
  return undefined;
}

/** Cross compositor frames without delivering parked author rAF callbacks. */
export async function waitForCaptureAnimationFrames(
  target: Frame | Page,
  count: 1 | 2 = 2,
  timeoutMs = 2_000,
): Promise<void> {
  if ((count !== 1 && count !== 2) || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("invalid capture frame wait");
  const context = contextFor(target);
  const registration = context == null ? undefined : schedulers.get(context);
  if (registration?.failure != null) throw new Error(registration.failure);
  if (registration == null) {
    await evaluateInFrame(
      target,
      count === 1
        ? () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        : () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    return;
  }

  const expired = Symbol("capture-frame-deadline");
  try {
    const wait = evaluateInFrame(
      target,
      async ({ key, protocol, frames, requireParked }) => {
        const control = Object.getOwnPropertyDescriptor(globalThis, key)?.value as
          | {
              protocol?: string;
              waitForCaptureFrames?: (count: 1 | 2, requireParked: boolean) => Promise<void>;
            }
          | undefined;
        if (control?.protocol !== protocol || typeof control.waitForCaptureFrames !== "function")
          throw new Error("capture frame scheduler ownership unavailable");
        await control.waitForCaptureFrames(frames, requireParked);
      },
      {
        key: registration.key,
        protocol: CAPTURE_FRAME_SCHEDULER_PROTOCOL,
        frames: count,
        requireParked: registration.active,
      },
    );
    if ((await withTimeout(wait, timeoutMs, expired)) === expired)
      throw new Error(`capture frame scheduler exceeded ${timeoutMs}ms`);
  } catch (error) {
    // Some existing paint probes catch best-effort settle failures. The owner
    // must still reject the reference operation instead of publishing it.
    registration.failure = `capture frame scheduler failed: ${String(error)}`;
    throw error;
  }
}
