import { describe, expect, it, vi } from "vitest";
import type { AnimationFrame } from "../animation/index.js";
import type { AnimateFrameCfg } from "./animate-orchestrator.js";
import {
  buildCapturedFrame,
  resolveCapturedFrameStage,
  type CapturedFrameStageHandlers,
} from "./animate-captured-frame-stage.js";

const frame = (value: Partial<AnimateFrameCfg>): AnimateFrameCfg => value as AnimateFrameCfg;
const animationFrame = (duration = 100): AnimationFrame => ({ svgContent: "<g/>", duration });

describe("captured animation frame stage", () => {
  it("classifies embedded, loaded, and continued sources without session state", () => {
    expect(resolveCapturedFrameStage(frame({ cast: "demo.cast" }), 0)).toEqual({ kind: "cast" });
    expect(resolveCapturedFrameStage(frame({ template: "hero" }), 0)).toEqual({ kind: "template" });
    expect(resolveCapturedFrameStage(frame({ input: "page.html" }), 0)).toEqual({
      kind: "live",
      navigation: { kind: "load", input: "page.html" },
    });
    expect(resolveCapturedFrameStage(frame({ continue: true }), 1)).toEqual({
      kind: "live",
      navigation: { kind: "continue" },
    });
    expect(resolveCapturedFrameStage(frame({}), 1)).toEqual({
      kind: "live",
      navigation: { kind: "continue" },
    });
  });

  it("keeps frame zero from implicitly continuing a stale browser page", () => {
    expect(() => resolveCapturedFrameStage(frame({ continue: true }), 0)).toThrow(
      "frames[0] has no input and is not a continue frame",
    );
  });

  it("dispatches only the selected stage handler", async () => {
    const handlers: CapturedFrameStageHandlers = {
      cast: vi.fn(async () => animationFrame(1)),
      template: vi.fn(() => animationFrame(2)),
      live: vi.fn(async () => ({ frame: animationFrame(3), frameTree: null, rootBg: "transparent" })),
    };

    await expect(buildCapturedFrame(frame({ input: "page.html" }), 0, handlers)).resolves.toMatchObject({
      kind: "live",
      rootBg: "transparent",
    });
    expect(handlers.live).toHaveBeenCalledWith({ kind: "load", input: "page.html" });
    expect(handlers.cast).not.toHaveBeenCalled();
    expect(handlers.template).not.toHaveBeenCalled();
  });

  it("keeps alternating embedded and live stages independent", async () => {
    const handlers: CapturedFrameStageHandlers = {
      cast: vi.fn(async () => animationFrame(1)),
      template: vi.fn(() => animationFrame(2)),
      live: vi.fn(async () => ({ frame: animationFrame(3), frameTree: [], rootBg: undefined })),
    };

    await expect(buildCapturedFrame(frame({ cast: "a.cast" }), 0, handlers)).resolves.toMatchObject({
      kind: "embedded",
      source: "cast",
      frame: { duration: 1 },
    });
    await expect(buildCapturedFrame(frame({ template: "hero" }), 1, handlers)).resolves.toMatchObject({
      kind: "embedded",
      source: "template",
      frame: { duration: 2 },
    });
    await expect(buildCapturedFrame(frame({}), 2, handlers)).resolves.toMatchObject({
      kind: "live",
      frame: { duration: 3 },
    });
    expect(handlers.cast).toHaveBeenCalledOnce();
    expect(handlers.template).toHaveBeenCalledOnce();
    expect(handlers.live).toHaveBeenCalledWith({ kind: "continue" });
  });
});
