/** Browser-owned CSS property animation sampled into a timed nested SVG. */
import type { Page } from "@playwright/test";
import type { AnimationFrame } from "../animation/index.js";
import { generateAnimatedSvg } from "../animation/index.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { captureElementTreeSelfContained } from "../capture/index.js";
import { elementTreeToSvgInner } from "../render/index.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";

export interface CssPropertyResampleSpec {
  selector: string;
  fps?: number;
}

/** Capture the final source paint for one millisecond, while retaining exact frame duration. */
export function cssPropertySampleSchedule(durationMs: number, fps: number): Array<{ atMs: number; holdMs: number }> {
  if (!(durationMs > 0) || !(fps > 0 && fps <= 30))
    throw new Error("cssPropertyResample requires positive duration and fps <= 30");
  const interval = 1000 / fps;
  const times = [0];
  for (let at = interval; at < durationMs - 1; at += interval) times.push(at);
  if (durationMs > 1) times.push(durationMs - 1);
  if (times.length > 120) throw new Error("cssPropertyResample exceeds 120 captures; reduce fps or frame duration");
  return times.map((atMs, index) => ({ atMs, holdMs: (times[index + 1] ?? durationMs) - atMs }));
}

interface BrowserAnimationState {
  animation: Animation;
  currentTime: number;
  wasRunning: boolean;
}

export async function buildCssPropertyResampleAnimation(
  page: Page,
  spec: CssPropertyResampleSpec,
  options: { width: number; height: number; durationMs: number; framePrefix: string },
): Promise<{ svgContent: string; periodMs: number; rootBg: string | undefined }> {
  const schedule = cssPropertySampleSchedule(options.durationMs, spec.fps ?? 30);
  const state = await page.evaluateHandle((selector): BrowserAnimationState[] => {
    const root = document.querySelector(selector);
    if (root == null) throw new Error(`cssPropertyResample selector did not match: ${selector}`);
    const animations = root
      .getAnimations({ subtree: true })
      .filter((animation) => animation instanceof CSSAnimation || animation instanceof CSSTransition);
    if (animations.length === 0)
      throw new Error(`cssPropertyResample found no active CSS animations under: ${selector}`);
    const saved = animations.map((animation) => {
      const currentTime = animation.currentTime;
      if (typeof currentTime !== "number") throw new Error("cssPropertyResample requires numeric animation time");
      const wasRunning = animation.playState === "running";
      return { animation, currentTime, wasRunning };
    });
    for (const entry of saved) entry.animation.pause();
    return saved;
  }, spec.selector);
  const frames: AnimationFrame[] = [];
  let rootBg: string | undefined;
  try {
    for (let index = 0; index < schedule.length; index++) {
      const sample = schedule[index];
      await page.evaluate(
        ({ saved, atMs }) => {
          for (const entry of saved) entry.animation.currentTime = entry.currentTime + atMs;
        },
        { saved: state, atMs: sample.atMs },
      );
      const tree = await captureElementTreeSelfContained(page, spec.selector, {
        x: 0,
        y: 0,
        width: options.width,
        height: options.height,
      });
      cullElementsOutsideViewBox(tree, options.width, options.height, undefined, 0, 1);
      if (index === 0) rootBg = tree[0]?.styles?.rootBgComputed;
      frames.push({
        svgContent: elementTreeToSvgInner(
          tree,
          options.width,
          options.height,
          `${options.framePrefix}s${index}-`,
          true,
          2,
          false,
        ),
        duration: sample.holdMs,
        transition: { type: "cut", duration: 0 },
      });
    }
  } finally {
    try {
      await page.evaluate((saved) => {
        for (const entry of saved) {
          entry.animation.currentTime = entry.currentTime;
          if (entry.wasRunning) entry.animation.play();
        }
      }, state);
    } finally {
      await state.dispose();
    }
  }
  const svg = generateAnimatedSvg({
    width: options.width,
    height: options.height,
    frames,
    fontFaceCss: "",
    ...(rootBg != null ? { background: rootBg } : {}),
  });
  const namespaced = namespaceEmbeddedAnimatedSvg(svg, options.framePrefix, { namespaceFonts: false });
  return { svgContent: namespaced.replace(/^<\?xml[^>]*\?>\s*/, ""), periodMs: options.durationMs, rootBg };
}
