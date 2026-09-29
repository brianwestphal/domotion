import { describe, it, expect, vi, afterEach } from "vitest";
import {
  captureWarningSink,
  getLastCaptureWarnings,
  logCaptureWarnings,
  resetLastCaptureWarnings,
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
