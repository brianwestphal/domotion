import type { AnimationFrame } from "../animation/index.js";
import type { CapturedElement } from "../capture/types.js";
import type { AnimateFrameCfg } from "./animate-orchestrator.js";

export type LiveFrameNavigation = { kind: "continue" } | { kind: "load"; input: string };

export type CapturedFrameStage =
  { kind: "cast" } | { kind: "template" } | { kind: "live"; navigation: LiveFrameNavigation };

export interface LiveCapturedFrameResult {
  frame: AnimationFrame;
  frameTree: CapturedElement[] | null;
  rootBg: string | undefined;
}

export type CapturedFrameResult =
  | { kind: "embedded"; source: "cast" | "template"; frame: AnimationFrame }
  | ({ kind: "live" } & LiveCapturedFrameResult);

export interface CapturedFrameStageHandlers {
  cast: () => Promise<AnimationFrame>;
  template: () => AnimationFrame;
  live: (navigation: LiveFrameNavigation) => Promise<LiveCapturedFrameResult>;
}

/**
 * Decide which content-producing stage owns a configured frame. A non-first
 * live frame without an input continues the existing browser page; frame zero
 * always requires an input unless an embedded cast/template owns it.
 */
export function resolveCapturedFrameStage(frame: AnimateFrameCfg, index: number): CapturedFrameStage {
  if (frame.cast != null) return { kind: "cast" };
  if (frame.template != null) return { kind: "template" };
  if (index > 0 && (frame.continue === true || frame.input == null)) {
    return { kind: "live", navigation: { kind: "continue" } };
  }
  if (frame.input == null) {
    throw new Error(`animate: frames[${index}] has no input and is not a continue frame`);
  }
  return { kind: "live", navigation: { kind: "load", input: frame.input } };
}

/** Dispatch one frame without taking ownership of the shared browser session. */
export async function buildCapturedFrame(
  frame: AnimateFrameCfg,
  index: number,
  handlers: CapturedFrameStageHandlers,
): Promise<CapturedFrameResult> {
  const stage = resolveCapturedFrameStage(frame, index);
  if (stage.kind === "cast") {
    return { kind: "embedded", source: "cast", frame: await handlers.cast() };
  }
  if (stage.kind === "template") {
    return { kind: "embedded", source: "template", frame: handlers.template() };
  }
  return { kind: "live", ...(await handlers.live(stage.navigation)) };
}
