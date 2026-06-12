import { describe, it, expect, vi, afterEach } from "vitest";
import { getLastCaptureWarnings, logCaptureWarnings, _resetLastCaptureWarnings } from "./warnings.js";
import type { CaptureWarning } from "./types.js";

const W: CaptureWarning[] = [
  { selector: ".a", feature: "conic-gradient", detail: "rasterized" },
  { selector: "#b", feature: "vertical-text", detail: "raster fallback" },
];

afterEach(() => {
  _resetLastCaptureWarnings([]);
  vi.restoreAllMocks();
});

describe("capture warnings buffer", () => {
  it("round-trips the buffer reference set by _resetLastCaptureWarnings", () => {
    _resetLastCaptureWarnings(W);
    expect(getLastCaptureWarnings()).toBe(W);
    _resetLastCaptureWarnings([]);
    expect(getLastCaptureWarnings()).toEqual([]);
  });

  it("logCaptureWarnings prints one stderr line per warning with the feature/selector/detail", () => {
    _resetLastCaptureWarnings(W);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logCaptureWarnings();
    expect(err).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[0][0]).toBe("[domotion] conic-gradient on .a — rasterized");
    expect(err.mock.calls[1][0]).toBe("[domotion] vertical-text on #b — raster fallback");
  });

  it("logCaptureWarnings includes the label in the prefix when given", () => {
    _resetLastCaptureWarnings([W[0]]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logCaptureWarnings("capture");
    expect(err.mock.calls[0][0]).toBe("[domotion capture] conic-gradient on .a — rasterized");
  });

  it("logCaptureWarnings is silent when there are no warnings", () => {
    _resetLastCaptureWarnings([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logCaptureWarnings();
    expect(err).not.toHaveBeenCalled();
  });
});
