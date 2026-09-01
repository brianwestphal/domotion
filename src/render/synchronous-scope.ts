/**
 * Process-global renderer state cannot remain scoped across an `await`: the
 * synchronous `finally` must restore it before another render can observe the
 * temporary value. Keep both halves of that contract together (DM-2637): the
 * type rejects async callbacks for ordinary TypeScript callers, while the
 * runtime check rejects native Promises and custom thenables from JavaScript or
 * callers that bypass the type system.
 */
type SynchronousResultConstraint<T> = [T] extends [never]
  ? unknown
  : [Extract<T, PromiseLike<unknown>>] extends [never]
    ? unknown
    : never;

export type SynchronousCallback<F extends () => unknown> =
  F & SynchronousResultConstraint<ReturnType<F>>;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

/** Invoke a callback and reject any value whose callable `then` would let work
 * escape the surrounding synchronous state scope. The owning guard's
 * `try/finally` performs restoration for callback throws and for this error. */
export function invokeSynchronousCallback<F extends () => unknown>(
  scopeName: string,
  callback: F,
): ReturnType<F> {
  const result = callback();
  if (isPromiseLike(result)) {
    throw new TypeError(
      `${scopeName} callback must be synchronous; Promise-like results are not supported`,
    );
  }
  return result as ReturnType<F>;
}
