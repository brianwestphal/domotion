import type { Frame, JSHandle, Page } from "@playwright/test";
import { browserCallbackExpression } from "./evaluate-in-frame.js";
import { privateCaptureKey } from "./private-key.js";

type BrowserTarget = Frame | Page;

/**
 * Own one private property on each inspected frame tagged by a prepass. The
 * initializer runs in Chromium, so its result can contain live DOM objects
 * (which Playwright could not serialize back to Node).
 */
export interface PageRegistry<Value> {
  readonly key: string;
  tag(target: BrowserTarget, initializer: () => Value | Promise<Value>): Promise<void>;
  tag<Argument>(
    target: BrowserTarget,
    initializer: (argument: Argument) => Value | Promise<Value>,
    argument: Argument,
  ): Promise<void>;
  /** Caller owns the returned handle and must dispose it. */
  read(target: BrowserTarget): Promise<JSHandle<Value | undefined>>;
  dispose(): Promise<void>;
}

export function createPageRegistry<Value>(page: Page, name: string): PageRegistry<Value> {
  const key = privateCaptureKey(name);
  const tagged = new Set<BrowserTarget>();
  let disposed = false;

  async function tag<Argument>(
    target: BrowserTarget,
    initializer: ((argument: Argument) => Value | Promise<Value>) | (() => Value | Promise<Value>),
    argument?: Argument,
  ): Promise<void> {
    if (disposed) throw new Error(`Cannot tag disposed page registry ${name}`);
    if (target !== page && !page.frames().includes(target as Frame)) {
      throw new Error(`Cannot tag a frame outside page registry ${name}`);
    }
    const expression =
      arguments.length >= 3
        ? browserCallbackExpression(initializer, argument as Argument)
        : browserCallbackExpression(initializer);
    // Track before evaluating: a navigation can interrupt the reply after the
    // browser has already stored a value, and dispose must still try to clear it.
    tagged.add(target);
    const value = await target.evaluateHandle(expression);
    try {
      await target.evaluate(
        ({ property, result }) => {
          (globalThis as unknown as Record<string, unknown>)[property] = result;
        },
        { property: key, result: value },
      );
    } finally {
      await value.dispose();
    }
  }

  return {
    key,
    tag,
    read(target) {
      return target.evaluateHandle((property) => (globalThis as unknown as Record<string, Value>)[property], key);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all(
        [...tagged].map((target) =>
          target
            .evaluate((property) => {
              delete (globalThis as unknown as Record<string, unknown>)[property];
            }, key)
            .catch(() => undefined),
        ),
      );
      tagged.clear();
    },
  };
}
