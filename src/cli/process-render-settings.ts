/**
 * Process-wide render settings for one CLI execution.
 *
 * `executeCapture` / `executeAnimate` select the text-render mode (and, for
 * capture, nested-SVG flattening) for everything they render. Those settings
 * are process-globals read deep inside asynchronous pipelines — the animate
 * orchestrator, every `elementTreeToSvgInner` call — so the synchronous
 * `withRenderTextMode` / `withFlattenNestedSvg` scopes cannot span them. This
 * helper applies the requested values for the duration of one awaited
 * execution and restores the prior values in `finally`, on success, throw or
 * rejection. Without it, an in-process caller (a test, Studio, a script) that
 * ran a second capture inherited the first execution's mode and flag.
 *
 * It restores what it found at entry, so it is correct for sequential
 * executions. Two executions overlapping in one process still share the one
 * global while both run; the one-shot CLI never overlaps.
 */
import { getRenderTextMode, setRenderTextMode, type RenderTextMode } from "../render/index.js";
import { getFlattenNestedSvg, setFlattenNestedSvg } from "../render/svg-inline.js";

export interface ProcessRenderSettings {
  /** Text-render mode for the execution; omitted keeps the current mode. */
  renderTextMode?: RenderTextMode;
  /** Nested-SVG flattening for the execution; omitted keeps the current flag. */
  flattenNestedSvg?: boolean;
}

export async function withProcessRenderSettings<T>(settings: ProcessRenderSettings, run: () => Promise<T>): Promise<T> {
  const previousMode = getRenderTextMode();
  const previousFlatten = getFlattenNestedSvg();
  try {
    if (settings.renderTextMode != null) setRenderTextMode(settings.renderTextMode);
    if (settings.flattenNestedSvg != null) setFlattenNestedSvg(settings.flattenNestedSvg);
    return await run();
  } finally {
    setRenderTextMode(previousMode);
    setFlattenNestedSvg(previousFlatten);
  }
}
