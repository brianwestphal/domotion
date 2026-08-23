/**
 * Blink-derived Backdrop Root and screenshot effect-space ownership.
 *
 * A backdrop-filter target samples its nearest ancestor Backdrop Root.  The
 * Chromium screenshot used by Domotion must nevertheless be taken before the
 * ancestor effects which the SVG renderer will re-apply.  `will-change`
 * preserves the same Blink root while the visual property is neutralized for
 * that one screenshot frame.
 */

export type BackdropRootReason =
  | "document-root"
  | "opacity"
  | "filter"
  | "backdrop-filter"
  | "clip-path"
  | "mask"
  | "mix-blend-mode"
  | "will-change";

export type BackdropEffectNeutralization =
  | "opacity"
  | "filter"
  | "clip-path"
  | "mask"
  | "mix-blend-mode"
  | "rotate-skew";

export interface BackdropEffectStyleFacts {
  isDocumentRoot: boolean;
  opacity: string;
  filter: string;
  backdropFilter: string;
  clipPath: string;
  maskImage: string;
  maskBorderSource: string;
  mixBlendMode: string;
  willChange: string;
  transform: string;
  translate: string;
  rotate: string;
  scale: string;
}

const active = (value: string | undefined, initial: string): boolean =>
  value != null && value !== "" && value !== initial;

export function backdropWillChangeTokens(value: string): Set<string> {
  if (value === "" || value === "auto") return new Set();
  return new Set(value.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean));
}

/** Pinned Blink `NeedsEffect()` / auxiliary Backdrop Root triggers. */
export function backdropRootReasons(style: BackdropEffectStyleFacts): BackdropRootReason[] {
  const reasons: BackdropRootReason[] = [];
  if (style.isDocumentRoot) reasons.push("document-root");
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity < 1) reasons.push("opacity");
  if (active(style.filter, "none")) reasons.push("filter");
  if (active(style.backdropFilter, "none")) reasons.push("backdrop-filter");
  if (active(style.clipPath, "none")) reasons.push("clip-path");
  if (active(style.maskImage, "none") || active(style.maskBorderSource, "none")) reasons.push("mask");
  if (active(style.mixBlendMode, "normal")) reasons.push("mix-blend-mode");
  const willChange = backdropWillChangeTokens(style.willChange);
  if ([
    "opacity",
    "filter",
    "backdrop-filter",
    "clip-path",
    "mask",
    "mask-image",
    "mask-border",
    "mix-blend-mode",
  ].some((property) => willChange.has(property))) reasons.push("will-change");
  return reasons;
}

/**
 * Visual ancestor properties already represented by SVG wrappers.  An
 * ancestor backdrop-filter is intentionally absent: it is the prior-device
 * source seen by a nested backdrop target, rather than an effect to erase.
 */
export function backdropEffectNeutralizations(
  style: BackdropEffectStyleFacts,
): BackdropEffectNeutralization[] {
  const result: BackdropEffectNeutralization[] = [];
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity < 1) result.push("opacity");
  if (active(style.filter, "none")) result.push("filter");
  if (active(style.clipPath, "none")) result.push("clip-path");
  if (active(style.maskImage, "none") || active(style.maskBorderSource, "none")) result.push("mask");
  if (transformRotatesOrSkews(style)) result.push("rotate-skew");
  return result;
}

/** Mirrors the capture walk's rotation/skew freeze discriminator. */
export function transformRotatesOrSkews(style: BackdropEffectStyleFacts): boolean {
  const matrix2d = /^matrix\(\s*([-.\deE+]+)\s*,\s*([-.\deE+]+)\s*,\s*([-.\deE+]+)\s*,\s*([-.\deE+]+)/.exec(style.transform);
  if (matrix2d != null) {
    if (Math.abs(Number.parseFloat(matrix2d[2])) > 1e-6
      || Math.abs(Number.parseFloat(matrix2d[3])) > 1e-6) return true;
  }
  const matrix3d = /^matrix3d\(([^)]+)\)/.exec(style.transform);
  if (matrix3d != null) {
    const values = matrix3d[1].split(",").map((value) => Number.parseFloat(value));
    if (Math.abs(values[1] ?? 0) > 1e-6 || Math.abs(values[4] ?? 0) > 1e-6) return true;
  }
  return active(style.rotate, "none");
}

export function willChangePropertyForNeutralization(
  property: BackdropEffectNeutralization,
): string | null {
  switch (property) {
    case "opacity": return "opacity";
    case "filter": return "filter";
    case "clip-path": return "clip-path";
    case "mask": return "mask";
    case "mix-blend-mode": return "mix-blend-mode";
    case "rotate-skew": return "transform";
  }
}
