import type { CapturedElement, CaptureWarning } from "./types.js";

/**
 * Validate the value `page.evaluate(CAPTURE_SCRIPT)` returned before the Node side reads it.
 * `evaluate` is untyped across the page boundary, so a script that threw a non-serializable
 * value, returned `undefined`, or was replaced by a stale build would otherwise surface as an
 * unrelated `undefined.tree` error far from the cause.
 *
 * `warnings` is optional on the wire (the empty-root early return sends `[]`, older builds omit it).
 */
export function assertCapturedTreeShape(
  result: unknown,
  what = "capture script",
): { tree: CapturedElement[]; warnings?: CaptureWarning[] } {
  if (result == null || typeof result !== "object") {
    throw new Error(`${what} returned ${result === null ? "null" : typeof result}, expected { tree, warnings }`);
  }
  const record = result as { tree?: unknown; warnings?: unknown };
  if (!Array.isArray(record.tree)) {
    throw new Error(`${what} result has no \`tree\` array (got ${record.tree === null ? "null" : typeof record.tree})`);
  }
  if (record.warnings !== undefined && !Array.isArray(record.warnings)) {
    throw new Error(`${what} result \`warnings\` is not an array (got ${typeof record.warnings})`);
  }
  return record as { tree: CapturedElement[]; warnings?: CaptureWarning[] };
}
