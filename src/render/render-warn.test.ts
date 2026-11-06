import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLastCaptureWarnings, getLastCaptureWarnings } from "../capture/warnings.js";
import { renderWarn, withRenderWarningSink } from "./render-warn.js";
import { elementTreeToSvg, elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement, CaptureWarning } from "../capture/types.js";

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

describe("render warnings follow the render's own sink, not the last capture", () => {
  const clipped = (): CapturedElement =>
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
        clipPath: "xywh(0px 0px 10px 10px)",
        color: "black",
        borderColor: "transparent",
      },
      children: [],
    }) as unknown as CapturedElement;
  const B_WARNING = { selector: "p", feature: "capture-b", detail: "from capture B" };
  const features = (warnings: ReadonlyArray<{ feature: string }>): string[] => warnings.map((w) => w.feature);

  it("capture A → capture B → render A: A's render warnings go to A's sink, B's buffer is unchanged", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const captureA: CaptureWarning[] = [];
    const treeA = [clipped()];
    // Capture B completes after A, so the global "last capture" buffer is B's.
    resetLastCaptureWarnings([B_WARNING]);
    elementTreeToSvg(treeA, 100, 100, { warnings: captureA });
    expect(features(captureA)).toContain("clip-path");
    expect(getLastCaptureWarnings()).toEqual([B_WARNING]);
  });

  it("repeated renders with a sink never grow the global buffer; omitting it keeps the CLI fallback", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLastCaptureWarnings([B_WARNING]);
    const sink: CaptureWarning[] = [];
    elementTreeToSvg([clipped()], 100, 100, { warnings: sink });
    const once = sink.length;
    expect(once).toBeGreaterThan(0);
    elementTreeToSvg([clipped()], 100, 100, { warnings: sink });
    expect(sink.length).toBe(once * 2);
    expect(getLastCaptureWarnings()).toEqual([B_WARNING]);
    // No sink → the global (the CLI's `--warnings` path) receives it.
    elementTreeToSvg([clipped()], 100, 100);
    expect(features(getLastCaptureWarnings())).toEqual(["capture-b", "clip-path"]);
  });

  it("nests (innermost wins), restores on throw, and falls back to the global outside every scope", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLastCaptureWarnings([]);
    const outer: CaptureWarning[] = [];
    const inner: CaptureWarning[] = [];
    withRenderWarningSink(outer, () => {
      renderWarn("outer-1", "o1");
      withRenderWarningSink(inner, () => renderWarn("inner", "i"));
      renderWarn("outer-2", "o2");
      expect(() =>
        withRenderWarningSink(inner, () => {
          throw new Error("render failed");
        }),
      ).toThrow("render failed");
      renderWarn("outer-3", "o3");
    });
    renderWarn("global", "g");
    expect(features(outer)).toEqual(["outer-1", "outer-2", "outer-3"]);
    expect(features(inner)).toEqual(["inner"]);
    expect(features(getLastCaptureWarnings())).toEqual(["global"]);
  });

  it("rejects an async callback and restores the previous sink before its continuation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLastCaptureWarnings([]);
    const sink: CaptureWarning[] = [];
    expect(() =>
      withRenderWarningSink(sink, (async () => {
        renderWarn("before-await", "b");
        await Promise.resolve();
        renderWarn("after-await", "a");
      }) as unknown as () => void),
    ).toThrow(/withRenderWarningSink callback must be synchronous/);
    await Promise.resolve();
    expect(features(sink)).toEqual(["before-await"]);
    expect(features(getLastCaptureWarnings())).toEqual(["after-await"]);
    const typeOnly = (): void => {
      // @ts-expect-error -- a Promise-returning callback cannot keep the sink scoped.
      withRenderWarningSink(sink, async () => 1);
    };
    expect(typeof typeOnly).toBe("function");
  });
});
