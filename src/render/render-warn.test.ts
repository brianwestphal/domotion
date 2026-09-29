import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLastCaptureWarnings, getLastCaptureWarnings } from "../capture/warnings.js";
import { renderWarn } from "./render-warn.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

afterEach(() => {
  resetLastCaptureWarnings([]);
  vi.restoreAllMocks();
});

describe("renderWarn", () => {
  it("prints one tagged line and records a capture warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLastCaptureWarnings([]);
    renderWarn("mask-image", "mask dropped", "div");
    expect(warn).toHaveBeenCalledWith("[domotion] mask dropped");
    expect(getLastCaptureWarnings()).toEqual([{ selector: "div", feature: "mask-image", detail: "mask dropped" }]);
  });
});

describe("silent render degradations now warn", () => {
  const el = (clipPath: string): CapturedElement =>
    ({
      tag: "div",
      tagName: "div",
      text: "",
      x: 0,
      y: 0,
      width: 40,
      height: 30,
      styles: {
        backgroundColor: "rgb(200, 0, 0)",
        backgroundImage: "none",
        clipPath,
        color: "black",
        borderColor: "transparent",
      },
      children: [],
    }) as unknown as CapturedElement;

  it("reports an unsupported clip-path shape instead of silently painting unclipped", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLastCaptureWarnings([]);
    elementTreeToSvgInner([el("xywh(0px 0px 10px 10px)")], 100, 100);
    const warnings = getLastCaptureWarnings();
    expect(warnings.map((w) => w.feature)).toContain("clip-path");
    expect(warnings.find((w) => w.feature === "clip-path")?.detail).toMatch(/painted unclipped/);
  });

  it("stays quiet for a clip-path the renderer supports", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLastCaptureWarnings([]);
    elementTreeToSvgInner([el("circle(50% at 50% 50%)")], 100, 100);
    expect(getLastCaptureWarnings().filter((w) => w.feature === "clip-path")).toEqual([]);
  });
});
