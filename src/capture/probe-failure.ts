import type { CaptureWarning } from "./types.js";

/** The human-readable cause of a thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `CaptureWarning` for a Node-side CDP probe that failed and was replaced by an empty
 * value. Those probes fail closed (the affected element takes a Chromium-owned or legacy
 * route), but downstream code reads the empty value as "nothing to do", so without this the
 * only trace of the failure is an unexplained fidelity difference.
 *
 * `partial` (the default) means a fallback retained the element; `unavailable` means its paint
 * is missing from the output.
 */
export function probeFailureWarning(input: {
  selector: string;
  feature: string;
  /** What was being measured, e.g. "Range FragmentItem probe". */
  probe: string;
  /** The thrown value, or an already-formatted message. */
  cause: unknown;
  /** What the output does instead, e.g. "its text elements take the legacy text path". */
  effect: string;
  status?: "partial" | "unavailable";
}): CaptureWarning {
  return {
    selector: input.selector,
    feature: input.feature,
    detail: `${input.probe} failed (${errorMessage(input.cause)}); ${input.effect}`,
    status: input.status ?? "partial",
  };
}
