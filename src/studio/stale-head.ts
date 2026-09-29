/**
 * Optimistic-concurrency check on a Studio project's review head.
 *
 * Every mutating route (annotation, authoring, timeline, save, recording import,
 * generate) carries the head revision the client last saw. If the project has moved
 * on, the change is stale and the HTTP layer must answer 409 so the client refetches.
 *
 * The signal is a machine-readable `code`, not the message text: the HTTP mapping
 * used to test `message.startsWith("stale annotation change:")`, so rewording a
 * message anywhere silently downgraded a conflict to a 400.
 */
export const STALE_HEAD_CODE = "stale-head" as const;

export type StaleHeadKind = "annotation" | "authoring" | "timeline";

export function staleHeadMessage(kind: StaleHeadKind, expected: string, found: string): string {
  return `stale ${kind} change: expected review head ${expected}, found ${found}`;
}

/** True for any Studio error raised by {@link assertHeadRevision}. */
export function isStaleHeadError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === STALE_HEAD_CODE;
}

/**
 * Throw the caller's own error class, tagged `code: "stale-head"`, when `expected` is
 * present and differs from `found`. `expected == null` means "no precondition supplied".
 */
export function assertHeadRevision(
  kind: StaleHeadKind,
  expected: string | null | undefined,
  found: string,
  makeError: (message: string, code: typeof STALE_HEAD_CODE) => Error,
): void {
  if (expected == null || expected === found) return;
  throw makeError(staleHeadMessage(kind, expected, found), STALE_HEAD_CODE);
}
