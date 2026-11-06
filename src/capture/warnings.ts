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
export function resetLastCaptureWarnings(w: CaptureWarning[]): void {
  for (const observer of retirementObservers) observer(_lastCaptureWarnings);
  _lastCaptureWarnings = w.map((warning) => ({ ...warning }));
}

const retirementObservers = new Set<(retired: CaptureWarning[]) => void>();

/**
 * A run-scoped view of every warning that reaches the "last capture" global
 * across many captures. Each capture replaces the global buffer, so a
 * multi-frame run (`domotion animate --debug`) that reads it only at the end
 * sees just the last frame's capture warnings. A collector drains the buffer
 * when `drain()` is called AND just before any capture retires it, tagging each
 * warning with the frame label current at the time. Warnings already present
 * when the collector starts are not collected.
 */
export interface CaptureWarningCollector {
  /** Label subsequent warnings (a frame index, or null for run-level ones). */
  setFrame(frame: number | null): void;
  /** Collect what has reached the global buffer since the last drain. */
  drain(): void;
  /** Drain, stop observing, and return everything collected. Idempotent: later calls collect nothing more. */
  stop(): Array<CaptureWarning & { frame: number | null }>;
}

/** @internal — start a `CaptureWarningCollector` over the capture-warnings global. */
export function startCaptureWarningCollector(): CaptureWarningCollector {
  const collected: Array<CaptureWarning & { frame: number | null }> = [];
  let frame: number | null = null;
  let buffer: CaptureWarning[] | null = _lastCaptureWarnings;
  let consumed = _lastCaptureWarnings.length;
  let stopped = false;
  const collect = (current: CaptureWarning[]): void => {
    if (stopped) return;
    if (current !== buffer) {
      buffer = current;
      consumed = 0;
    }
    for (; consumed < current.length; consumed++) collected.push({ frame, ...current[consumed] });
  };
  const observer = (retired: CaptureWarning[]): void => {
    collect(retired);
    buffer = null;
  };
  retirementObservers.add(observer);
  return {
    setFrame(next) {
      frame = next;
    },
    drain() {
      collect(_lastCaptureWarnings);
    },
    stop() {
      collect(_lastCaptureWarnings);
      stopped = true;
      retirementObservers.delete(observer);
      return collected;
    },
  };
}

/** @internal — mutable sink for capture internals; never export from the package root. */
export function captureWarningSink(explicit?: CaptureWarning[]): CaptureWarning[] {
  return explicit ?? _lastCaptureWarnings;
}
