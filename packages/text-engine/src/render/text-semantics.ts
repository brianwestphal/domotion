import { esc } from "./format.js";

let visualSemanticsSuppressionDepth = 0;

/** Suppress duplicate run-level labels while a Domotion-owned readable text
 * layer supplies the authored semantics for the same glyph geometry. */
export function withTextEngineVisualSemanticsSuppressed<T>(render: () => T): T {
  visualSemanticsSuppressionDepth++;
  try {
    return render();
  } finally {
    visualSemanticsSuppressionDepth--;
  }
}

/** Accessibility attributes for visual-only text-engine glyph geometry. */
export function visualTextSemantics(text: string, includeTitle = true): { attrs: string; title: string } {
  if (visualSemanticsSuppressionDepth > 0) return { attrs: ` aria-hidden="true"`, title: "" };
  return {
    attrs: ` role="img" aria-label="${esc(text)}"`,
    title: includeTitle ? `<title>${esc(text)}</title>` : "",
  };
}

/** Hide decorative/native text paint while authored text owns semantics. */
export function visualTextOnlyHiddenAttr(): string {
  return visualSemanticsSuppressionDepth > 0 ? ` aria-hidden="true"` : "";
}
