import { _captureWarningSink } from "../capture/warnings.js";

/**
 * Report a render-side degradation: the renderer is about to paint something other than what
 * Chrome painted (a mask dropped, a clip skipped, a gradient approximated, text replaced by a
 * boundary marker).
 *
 * One tag (`[domotion]`) on stderr for a human running the CLI, AND a `CaptureWarning` pushed to
 * the capture warnings sink so programmatic callers (`getLastCaptureWarnings()`, the composite
 * result's warnings) see it. Before this each site chose its own prefix and only some warned at
 * all; the silent ones returned null / "" and looked like "nothing to paint".
 */
export function renderWarn(feature: string, detail: string, selector = ""): void {
  console.warn(`[domotion] ${detail}`);
  _captureWarningSink().push({ selector, feature, detail });
}
