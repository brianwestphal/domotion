/** One ordinary page-frame capture: serialize, annotate, cull, and render. */

import type { Page } from "@playwright/test";
import type { IntraFrameAnimation } from "../animation/animator.js";
import { captureElementTreeSelfContained } from "../capture/index.js";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "../render/index.js";
import { annotateAnimatedProperties, cullElementsOutsideViewBox } from "../tree-ops/index.js";

export interface AnimateFrameCaptureRequest {
  page: Page;
  selector: string;
  width: number;
  height: number;
  framePrefix: string;
  animations: IntraFrameAnimation[];
  frameStartMs: number;
  totalDurationMs: number;
}

export interface AnimateFrameCaptureResult {
  tree: CapturedElement[];
  svgContent: string;
  cullCss: string;
  rootBackground: string | undefined;
}

/** Capture an ordinary DOM frame without owning cross-frame orchestration. */
export async function captureAnimateFrame(
  request: AnimateFrameCaptureRequest,
): Promise<AnimateFrameCaptureResult> {
  const tree = await captureElementTreeSelfContained(request.page, request.selector, {
    x: 0,
    y: 0,
    width: request.width,
    height: request.height,
  });
  annotateAnimatedProperties(tree, request.animations);
  const cull = cullElementsOutsideViewBox(
    tree,
    request.width,
    request.height,
    request.animations,
    request.frameStartMs,
    request.totalDurationMs,
  );
  return {
    tree,
    svgContent: elementTreeToSvgInner(tree, request.width, request.height, request.framePrefix, true, 2, false),
    cullCss: cull.css,
    rootBackground: tree[0]?.styles?.rootBgComputed,
  };
}
