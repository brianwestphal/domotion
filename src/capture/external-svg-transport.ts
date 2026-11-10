/** Renderer fetches isolated from author globals, without bypassing its origin/CSP. */
import type { CDPSession, Frame } from "@playwright/test";
import { isSameProcessFrameError } from "./cdp-lifecycle.js";
import { browserCallbackExpression, evaluateInFrame } from "./evaluate-in-frame.js";
import { privateCaptureKey } from "./private-key.js";

// Reuse one private world per frame rather than leak a new realm per capture.
const worlds = new WeakMap<Frame, string>();
export type ExternalSvgResponse = { text: string; hrefs: string[] } | { failure: string };

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("external SVG renderer operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function frameSession(frame: Frame): Promise<CDPSession> {
  try {
    return await frame.page().context().newCDPSession(frame);
  } catch (error) {
    const parent = frame.parentFrame();
    if (parent != null && isSameProcessFrameError(error)) return frameSession(parent);
    throw error;
  }
}

/** A separate world supplies native fetch/AbortController despite page freezes.
 * InspectorPageAgent copies the frame origin; grantUniveralAccess stays false.
 * No isolated CSP is installed, so LocalDOMWindow retains the document CSP.
 * Requests default to generic CORS; SVG use explicitly selects same-origin. */
export async function openExternalSvgTransport(
  frame: Frame,
  timeoutMs: number,
): Promise<{
  fetch(href: string, mode?: "cors" | "same-origin"): Promise<ExternalSvgResponse>;
  dispose(): Promise<void>;
}> {
  const token = privateCaptureKey("ExternalSvgFrame");
  const worldName = worlds.get(frame) ?? privateCaptureKey("ExternalSvgTransport");
  worlds.set(frame, worldName);
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let session: CDPSession | undefined;
  let contextId: number | undefined;
  const active = new Map<string, { done: Promise<void>; confirmed: boolean }>();
  const abort = async (key: string): Promise<void> => {
    const request = active.get(key);
    if (request == null) return;
    if (session == null || contextId == null) throw new Error("external SVG cancellation context unavailable");
    await within(
      session.send("Runtime.evaluate", {
        contextId,
        expression: `globalThis[${JSON.stringify(key)}]?.abort()`,
        returnByValue: true,
        silent: true,
      }),
      100,
    );
    await within(request.done, 100);
    if (!request.confirmed) throw new Error("external SVG owned request cancellation was not confirmed");
  };
  const detach = async (owned: CDPSession | undefined = session): Promise<void> => {
    try {
      if (owned != null) await within(owned.detach(), 100);
    } catch (error) {
      if (!frame.isDetached() && !frame.page().isClosed())
        throw new Error("external SVG session detach unconfirmed", { cause: error });
    }
  };
  const setup = async (): Promise<void> => {
    await evaluateInFrame(
      frame,
      (key) => Object.defineProperty(globalThis, key, { value: key, configurable: true }),
      token,
    );
    if (disposed) {
      await removeToken();
      return;
    }
    const candidate = await frameSession(frame);
    if (disposed) {
      await detach(candidate).catch(() => undefined);
      return;
    }
    session = candidate;
    const defaults: Array<{ contextId: number; frameId: string }> = [];
    session.on("Runtime.executionContextCreated", ({ context }) => {
      const frameId: unknown = context.auxData?.["frameId"];
      const isDefault: unknown = context.auxData?.["isDefault"];
      if (isDefault === true && typeof frameId === "string") defaults.push({ contextId: context.id, frameId });
    });
    await session.send("Runtime.enable");
    const matches = await Promise.all(
      defaults.map(async (candidate) => {
        const result = await session!
          .send("Runtime.evaluate", {
            contextId: candidate.contextId,
            expression: `globalThis[${JSON.stringify(token)}] === ${JSON.stringify(token)}`,
            returnByValue: true,
            silent: true,
          })
          .catch(() => null);
        return result?.result.value === true ? candidate : null;
      }),
    );
    const matched = matches.filter((context) => context != null);
    if (matched.length !== 1) throw new Error("external SVG source frame identity unavailable");
    if (disposed) return;
    const source = matched[0];
    const isolated = await session.send("Page.createIsolatedWorld", {
      frameId: source.frameId,
      worldName,
      grantUniveralAccess: false,
    });
    if (disposed) return;
    // Frame IDs survive navigation. The world can have been created in a new
    // document while its original default execution context was destroyed.
    const original = await session
      .send("Runtime.evaluate", {
        contextId: source.contextId,
        expression: `globalThis[${JSON.stringify(token)}] === ${JSON.stringify(token)}`,
        returnByValue: true,
        silent: true,
      })
      .catch(() => null);
    if (original?.result.value !== true)
      throw new Error("external SVG source document identity unavailable after isolated world setup");
    contextId = isolated.executionContextId;
  };
  const removeToken = async (): Promise<void> => {
    try {
      const removed = await within(
        evaluateInFrame(
          frame,
          (key) => {
            const scope = globalThis as typeof globalThis & Record<string, unknown>;
            if (scope[key] === key) delete scope[key];
            return scope[key] !== key;
          },
          token,
        ),
        100,
      );
      if (!removed) throw new Error("external SVG source token removal unconfirmed");
    } catch (error) {
      if (!frame.isDetached() && !frame.page().isClosed()) throw error;
    }
  };
  try {
    await within(setup(), timeoutMs);
    await removeToken();
  } catch (error) {
    disposed = true;
    const results = await Promise.allSettled([removeToken(), detach()]);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    if (failures.length > 0) throw new AggregateError([error, ...failures], "external SVG setup and cleanup failed");
    throw error;
  }
  return {
    async fetch(href, mode = "cors") {
      if (disposed || session == null || contextId == null) throw new Error("external SVG transport is disposed");
      const key = privateCaptureKey("ExternalSvgRequest");
      const request = session.send("Runtime.evaluate", {
        contextId,
        expression: browserCallbackExpression(
          async ({
            href,
            key,
            mode,
          }: {
            href: string;
            key: string;
            mode: "cors" | "same-origin";
          }): Promise<ExternalSvgResponse> => {
            const controller = new AbortController();
            const scope = globalThis as typeof globalThis & Record<string, AbortController | undefined>;
            scope[key] = controller;
            try {
              const response = await fetch(href, { credentials: "same-origin", mode, signal: controller.signal });
              if (!response.ok) return { failure: `HTTP ${response.status}` };
              const text = await response.text();
              const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
              if (parsed.getElementsByTagName("parsererror").length > 0)
                return { failure: "the document is not well-formed SVG" };
              return {
                text,
                hrefs: Array.from(parsed.querySelectorAll("use")).map(
                  (use) => use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "",
                ),
              };
            } catch (error) {
              return { failure: String(error) };
            } finally {
              delete scope[key];
            }
          },
          { href, key, mode },
        ),
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      });
      const state = { done: Promise.resolve(), confirmed: false };
      active.set(key, state);
      state.done = request.then(
        (response) => {
          // A successful protocol reply from this guarded native callback proves
          // its finally removed the controller. A lost session alone does not.
          if (response.exceptionDetails == null && response.result.value != null) {
            state.confirmed = true;
            active.delete(key);
          }
        },
        () => undefined,
      );
      try {
        const response = await within(request, timeoutMs);
        if (response.exceptionDetails != null || response.result.value == null)
          return { failure: "the renderer could not read the external SVG document" };
        return response.result.value as ExternalSvgResponse;
      } catch (error) {
        await abort(key);
        return {
          failure:
            error instanceof Error && error.message === "external SVG renderer operation timed out"
              ? "the fetch timed out"
              : String(error),
        };
      }
    },
    dispose() {
      return (disposal ??= (async () => {
        disposed = true;
        const results = await Promise.allSettled([...active.keys()].map(abort));
        const detached = await Promise.allSettled([detach()]);
        const failures = [...results, ...detached].flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, `${failures.length} external SVG cleanup operations unconfirmed`);
      })());
    },
  };
}
