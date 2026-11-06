import { describe, it, expect, vi, afterEach } from "vitest";
import {
  captureWarningSink,
  getLastCaptureWarnings,
  logCaptureWarnings,
  resetLastCaptureWarnings,
  startCaptureWarningCollector,
} from "./warnings.js";
import type { CaptureWarning } from "./types.js";

const W: CaptureWarning[] = [
  { selector: ".a", feature: "conic-gradient", detail: "rasterized" },
  { selector: "#b", feature: "vertical-text", detail: "raster fallback" },
];

afterEach(() => {
  resetLastCaptureWarnings([]);
  vi.restoreAllMocks();
});

describe("capture warnings buffer", () => {
  it("returns a deeply frozen snapshot detached from the reset source", () => {
    resetLastCaptureWarnings(W);
    const snapshot = getLastCaptureWarnings();
    expect(snapshot).toEqual(W);
    expect(snapshot).not.toBe(W);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);

    W[0].detail = "source mutation";
    W.push({ selector: "#c", feature: "source", detail: "late" });
    expect(getLastCaptureWarnings()).toEqual([
      { selector: ".a", feature: "conic-gradient", detail: "rasterized" },
      { selector: "#b", feature: "vertical-text", detail: "raster fallback" },
    ]);
    W.splice(2, 1);
    W[0].detail = "rasterized";
  });

  it("keeps repeated reads and old snapshots stable under external mutation attempts", () => {
    resetLastCaptureWarnings(W);
    const first = getLastCaptureWarnings();
    const second = getLastCaptureWarnings();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(() => (first as CaptureWarning[]).push(W[0])).toThrow(TypeError);
    expect(() => {
      (first[0] as CaptureWarning).detail = "mutated";
    }).toThrow(TypeError);
    expect(getLastCaptureWarnings()).toEqual(second);
  });

  it("handles reset and explicit/global sink transitions without cross-mutation", () => {
    resetLastCaptureWarnings([]);
    const empty = getLastCaptureWarnings();
    const explicit: CaptureWarning[] = [];
    captureWarningSink(explicit).push(W[0]);
    expect(explicit).toEqual([W[0]]);
    expect(getLastCaptureWarnings()).toEqual([]);

    captureWarningSink().push(W[1]);
    expect(getLastCaptureWarnings()).toEqual([W[1]]);
    expect(empty).toEqual([]);
    expect(explicit).toEqual([W[0]]);

    resetLastCaptureWarnings([W[0]]);
    expect(getLastCaptureWarnings()).toEqual([W[0]]);
  });

  it("logCaptureWarnings prints one stderr line per warning with the feature/selector/detail", () => {
    resetLastCaptureWarnings(W);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logCaptureWarnings();
    expect(err).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[0][0]).toBe("[domotion] conic-gradient on .a — rasterized");
    expect(err.mock.calls[1][0]).toBe("[domotion] vertical-text on #b — raster fallback");
  });

  it("logCaptureWarnings includes the label in the prefix when given", () => {
    resetLastCaptureWarnings([W[0]]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logCaptureWarnings("capture");
    expect(err.mock.calls[0][0]).toBe("[domotion capture] conic-gradient on .a — rasterized");
  });

  it("logCaptureWarnings is silent when there are no warnings", () => {
    resetLastCaptureWarnings([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logCaptureWarnings();
    expect(err).not.toHaveBeenCalled();
  });
});

describe("capture warning collector (multi-frame debug bundles)", () => {
  const w = (feature: string): CaptureWarning => ({ selector: "", feature, detail: feature });

  it("ignores warnings present before it starts, then keeps every capture's warnings across buffer resets", () => {
    resetLastCaptureWarnings([w("stale")]);
    const collector = startCaptureWarningCollector();
    collector.setFrame(0);
    resetLastCaptureWarnings([w("capture-0")]); // frame 0's capture
    captureWarningSink().push(w("render-0")); // its render, on the global
    collector.drain();
    collector.setFrame(1);
    captureWarningSink().push(w("late-0-attributed-to-1")); // after the label moved
    resetLastCaptureWarnings([w("capture-1")]); // retires the buffer: drained, not lost
    collector.drain();
    collector.drain(); // repeated drain adds nothing
    collector.setFrame(null);
    captureWarningSink().push(w("run-level"));
    expect(collector.stop().map(({ frame, feature }) => [frame, feature])).toEqual([
      [0, "capture-0"],
      [0, "render-0"],
      [1, "late-0-attributed-to-1"],
      [1, "capture-1"],
      [null, "run-level"],
    ]);
  });

  it("stops observing: a later reset neither throws nor reaches the stopped collector", () => {
    const collector = startCaptureWarningCollector();
    resetLastCaptureWarnings([w("a")]);
    const first = collector.stop();
    expect(first.map((x) => x.feature)).toEqual(["a"]);
    resetLastCaptureWarnings([w("b")]);
    expect(first.map((x) => x.feature)).toEqual(["a"]);
    expect(collector.stop().map((x) => x.feature)).toEqual(["a"]); // idempotent
  });

  it("runs independent collectors side by side over an empty-then-refilled buffer", () => {
    resetLastCaptureWarnings([]);
    const outer = startCaptureWarningCollector();
    resetLastCaptureWarnings([]);
    const inner = startCaptureWarningCollector();
    resetLastCaptureWarnings([w("x")]);
    expect(inner.stop().map((x) => x.feature)).toEqual(["x"]);
    captureWarningSink().push(w("y"));
    expect(outer.stop().map((x) => x.feature)).toEqual(["x", "y"]);
  });
});
