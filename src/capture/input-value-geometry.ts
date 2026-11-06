/** Chromium-pierced geometry for the closed-UA-shadow input value text. */

export interface CapturedInputValueTextGeometry {
  source: "chromium-ua-shadow-text-quad-v1";
  hostWidth: number;
  hostHeight: number;
  textTopOffset: number;
  textHeight: number;
}

/**
 * Why a closed-shadow value-text record could not authorize the used text top.
 * The walker keeps its line-height estimate for these hosts and reports the
 * reason as an `input-value-geometry` capture warning, so the approximation is
 * visible rather than silent. (`host-box-changed` is detected later, by the
 * walker, when the live host box no longer matches an accepted record.)
 */
export type InputValueTextGeometryRejectionReason =
  "multiple-text-labels" | "text-quad-unavailable" | "host-quad-unavailable" | "non-axis-aligned-quad";

export interface RejectedInputValueTextGeometry {
  source: "chromium-ua-shadow-text-quad-v1";
  rejected: InputValueTextGeometryRejectionReason;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const QUAD_EPSILON = 0.05;

function axisAlignedRect(quads: readonly (readonly number[])[]): Rect | null {
  if (quads.length !== 1) return null;
  const q = quads[0];
  if (q.length !== 8 || !q.every(Number.isFinite)) return null;
  if (
    Math.abs(q[1] - q[3]) > QUAD_EPSILON ||
    Math.abs(q[2] - q[4]) > QUAD_EPSILON ||
    Math.abs(q[5] - q[7]) > QUAD_EPSILON ||
    Math.abs(q[6] - q[0]) > QUAD_EPSILON
  )
    return null;
  const width = q[2] - q[0];
  const height = q[5] - q[1];
  if (!(width > 0) || !(height > 0)) return null;
  return { x: q[0], y: q[1], width, height };
}

/**
 * Convert one host border quad and one UA-shadow text FragmentItem quad into a
 * translation-invariant value-text offset. Scale/rotation are rejected later
 * by comparing the live host dimensions with this recorded border box.
 */
export function capturedInputValueTextGeometry(
  hostQuads: readonly (readonly number[])[],
  textQuads: readonly (readonly number[])[],
): CapturedInputValueTextGeometry | null {
  const host = axisAlignedRect(hostQuads);
  const text = axisAlignedRect(textQuads);
  if (host == null || text == null) return null;
  const textTopOffset = text.y - host.y;
  if (!Number.isFinite(textTopOffset)) return null;
  return {
    source: "chromium-ua-shadow-text-quad-v1",
    hostWidth: host.width,
    hostHeight: host.height,
    textTopOffset,
    textHeight: text.height,
  };
}

/**
 * Classify every pierced text candidate of one input host. Exactly one measured
 * candidate plus a measured host quad yields either the authority or a
 * non-axis-aligned rejection; anything else is rejected with its named reason.
 * A `null` candidate is a text node whose content quads Chromium refused, and a
 * `null` host quad list means the host's own quads were refused.
 */
export function classifyInputValueTextGeometry(
  hostQuads: readonly (readonly number[])[] | null,
  textCandidates: readonly (readonly (readonly number[])[] | null)[],
): CapturedInputValueTextGeometry | RejectedInputValueTextGeometry {
  const reject = (rejected: InputValueTextGeometryRejectionReason): RejectedInputValueTextGeometry => ({
    source: "chromium-ua-shadow-text-quad-v1",
    rejected,
  });
  // A refused text node (for example the hidden placeholder of a filled
  // input) paints nothing, so only measured candidates count as labels.
  const measured = textCandidates.filter((quads): quads is readonly (readonly number[])[] => quads != null);
  if (measured.length === 0) return reject("text-quad-unavailable");
  // File/temporal controls can expose multiple independent labels. The
  // input-value walker does not own those surfaces, so never guess which text
  // row is the editing value.
  if (measured.length !== 1) return reject("multiple-text-labels");
  const text = measured[0];
  if (hostQuads == null) return reject("host-quad-unavailable");
  return capturedInputValueTextGeometry(hostQuads, text) ?? reject("non-axis-aligned-quad");
}
