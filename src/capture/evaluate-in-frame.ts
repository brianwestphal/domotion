import type { Frame, Page } from "@playwright/test";

/**
 * Evaluate a trusted browser callback with esbuild's keep-names helper scoped
 * to that one expression. Source-run tsx can leave free `__name(...)` calls in
 * serialized callbacks; installing a page global changes the inspected page.
 */
export function evaluateInFrame<Result>(frame: Frame | Page, callback: () => Result | Promise<Result>): Promise<Result>;
export function evaluateInFrame<Argument, Result>(
  frame: Frame | Page,
  callback: (argument: Argument) => Result | Promise<Result>,
  argument: Argument,
): Promise<Result>;
export function evaluateInFrame<Argument, Result>(
  frame: Frame | Page,
  callback: ((argument: Argument) => Result | Promise<Result>) | (() => Result | Promise<Result>),
  argument?: Argument,
): Promise<Result> {
  try {
    const expression =
      arguments.length >= 3
        ? browserCallbackExpression(callback, argument as Argument)
        : browserCallbackExpression(callback);
    return frame.evaluate(expression) as Promise<Result>;
  } catch (error) {
    return Promise.reject(error);
  }
}

/** The same lexical scope for context.addInitScript, which accepts source text. */
export function browserCallbackExpression<Argument, Result>(
  callback: ((argument: Argument) => Result | Promise<Result>) | (() => Result | Promise<Result>),
  ...args: [] | [Argument]
): string {
  const encodedArgument = args.length === 0 ? null : JSON.stringify(args[0]);
  if (args.length !== 0 && encodedArgument == null) {
    throw new Error("frame evaluation argument is not JSON-serializable");
  }
  return `((__name) => { const browserImageNaturalSize = (${browserImageNaturalSize.toString()}); return (${callback.toString()})(${encodedArgument ?? ""}); })(function(target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch {} return target; })`;
}

/** Shared browser-side decoder deadline for generated CSS images. */
export async function browserImageNaturalSize(url: string): Promise<{ width: number; height: number } | null> {
  const image = new Image();
  image.src = url;
  if (!(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) {
    await Promise.race([
      image.decode().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  return image.naturalWidth > 0 && image.naturalHeight > 0
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : null;
}
