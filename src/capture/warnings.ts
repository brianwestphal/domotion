/**
 * Module-global buffer of `CaptureWarning`s produced by the most recent
 * `captureElementTree()` call. The buffer is reset (via `_resetLastCaptureWarnings`)
 * at the start of every capture so single-capture callers can inspect the
 * latest run with `getLastCaptureWarnings()` / `logCaptureWarnings()`.
 *
 * Concurrent captures should pass their own array to
 * `captureElementTreeWithWarnings` / `embedRemoteImages` rather than relying
 * on this global, since the global gets overwritten on each call.
 */

import type { CaptureWarning } from "./types.js";

let _lastCaptureWarnings: CaptureWarning[] = [];

export function getLastCaptureWarnings(): CaptureWarning[] {
  return _lastCaptureWarnings;
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
 * @internal — replace the buffer reference. Used by
 * `captureElementTreeWithWarnings` at the end of each capture to point the
 * global at the new run's warnings array.
 */
export function _resetLastCaptureWarnings(w: CaptureWarning[]): void {
  _lastCaptureWarnings = w;
}
