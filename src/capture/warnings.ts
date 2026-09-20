/**
 * Module-global buffer of `CaptureWarning`s produced by the most recent
 * completed `captureElementTree()` call. Single-capture callers can inspect a
 * frozen snapshot with `getLastCaptureWarnings()` / `logCaptureWarnings()`.
 *
 * Concurrent captures should pass their own array to
 * `captureElementTreeWithWarnings` / `embedRemoteImages` rather than relying
 * on this global, since the global gets overwritten on each call.
 */

import type { CaptureWarning } from "./types.js";

let _lastCaptureWarnings: CaptureWarning[] = [];

export function getLastCaptureWarnings(): ReadonlyArray<Readonly<CaptureWarning>> {
  return Object.freeze(_lastCaptureWarnings.map((warning) => Object.freeze({ ...warning })));
}

/**
 * Print the last capture's warnings to stderr in a compact format. Useful in
 * CLI / test scripts that want a one-line-per-warning summary.
 */
export function logCaptureWarnings(label: string = ""): void {
  if (_lastCaptureWarnings.length === 0) return;
  const prefix = label !== "" ? `[domotion ${label}] ` : "[domotion] ";
  for (const w of _lastCaptureWarnings) {
    console.error(`${prefix}${w.feature} on ${w.selector} — ${w.detail}`);
  }
}

/**
 * @internal — replace the global buffer with a detached copy of one completed
 * capture. Neither the returned capture result nor a prior public snapshot can
 * mutate later global inspection state.
 */
export function _resetLastCaptureWarnings(w: CaptureWarning[]): void {
  _lastCaptureWarnings = w.map((warning) => ({ ...warning }));
}

/** @internal — mutable sink for capture internals; never export from the package root. */
export function _captureWarningSink(explicit?: CaptureWarning[]): CaptureWarning[] {
  return explicit ?? _lastCaptureWarnings;
}
