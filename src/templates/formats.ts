/**
 * Format presets (docs/87, DM-1521 design → DM-1534 impl).
 *
 * Creators think in **formats** (reel, square, story), not `width × height`. A
 * single `--format` flag resolves to a platform-ready canvas size plus a
 * sensible **safe-area inset** (px per side) that templates lay their content
 * out within (`canvas − safeInset`). This module owns the `FORMATS` table and
 * `resolveFormat()`; both are exported so the CLI, templates, and the future UI
 * playground (DM-1520) share one source of truth.
 *
 * `resolveFormat` accepts a preset **name** (or alias) OR a raw `WIDTHxHEIGHT`
 * string. Sizes are the 1× authoring canvas — the SVG scales to any display
 * size; `--scale` / the video export set raster resolution independently.
 */

/** Safe-area inset in px, one value per side. */
export interface SafeInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A resolved format: the canvas size + its computed px safe-area inset. */
export interface ResolvedFormat {
  width: number;
  height: number;
  safeInset: SafeInset;
}

/** Fractional (0..1) safe-area inset per side, applied to the axis it sits on
 *  (top/bottom → height, left/right → width). */
interface InsetFraction {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A named format preset. `inset` is fractional; `resolveFormat` turns it into px. */
export interface FormatPreset {
  width: number;
  height: number;
  inset: InsetFraction;
  /** Alternate names that resolve to this preset (e.g. `story` → `reel`). */
  aliases?: readonly string[];
  /** One-line human description (for `--help` / the UI playground dropdown). */
  description: string;
}

/**
 * Default safe-area inset for symmetric formats and raw `WxH` sizes: ~6% all
 * around. Vertical formats override top/bottom to reserve room for platform UI
 * (caption bars, action rails). These are reasonable v1 defaults, tunable — not
 * a platform-exact spec (docs/87).
 */
const DEFAULT_INSET_FRACTION = 0.06;
const EVEN_INSET: InsetFraction = {
  top: DEFAULT_INSET_FRACTION,
  right: DEFAULT_INSET_FRACTION,
  bottom: DEFAULT_INSET_FRACTION,
  left: DEFAULT_INSET_FRACTION,
};

/**
 * The built-in format presets. Sizes are the 1× authoring canvas (docs/87).
 * `reel` reserves 12% top / 18% bottom for the platform's caption bar + action
 * rail; the symmetric feed formats use the even ~6% inset.
 */
export const FORMATS: Record<string, FormatPreset> = {
  reel: {
    width: 1080,
    height: 1920,
    inset: { top: 0.12, right: 0.06, bottom: 0.18, left: 0.06 },
    aliases: ["story"],
    description: "9:16 vertical — Reels / TikTok / Shorts / Stories.",
  },
  square: {
    width: 1080,
    height: 1080,
    inset: EVEN_INSET,
    description: "1:1 square feed post.",
  },
  portrait: {
    width: 1080,
    height: 1350,
    inset: EVEN_INSET,
    description: "4:5 portrait feed post.",
  },
  landscape: {
    width: 1920,
    height: 1080,
    inset: EVEN_INSET,
    description: "16:9 landscape — YouTube / web hero.",
  },
};

/** Lower-cased alias → canonical preset name (built once from `FORMATS`). */
const ALIAS_TO_NAME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [name, preset] of Object.entries(FORMATS)) {
    map[name] = name;
    for (const a of preset.aliases ?? []) map[a] = name;
  }
  return map;
})();

/** Turn a preset's fractional inset into rounded px for its canvas. */
function insetToPx(width: number, height: number, f: InsetFraction): SafeInset {
  return {
    top: Math.round(height * f.top),
    right: Math.round(width * f.right),
    bottom: Math.round(height * f.bottom),
    left: Math.round(width * f.left),
  };
}

/** A raw `WIDTHxHEIGHT` string (case-insensitive `x`), e.g. `1600x900`. */
const RAW_SIZE_RE = /^(\d+)\s*[x×]\s*(\d+)$/i;

/** Sorted, human-readable list of the valid preset names + aliases (for errors/help). */
export function formatNames(): string[] {
  return Object.keys(ALIAS_TO_NAME).sort();
}

/**
 * Resolve a `--format` value to a canvas size + safe-area inset. Accepts a
 * preset name / alias (`reel`, `story`, `square`, …) or a raw `WIDTHxHEIGHT`
 * (`1600x900`). Throws a clear error listing the valid presets on anything else
 * (unknown name, non-positive / malformed size).
 */
export function resolveFormat(fmt: string): ResolvedFormat {
  const key = fmt.trim().toLowerCase();
  if (key === "") {
    throw new Error(`format: empty value — use a preset (${formatNames().join(", ")}) or WIDTHxHEIGHT (e.g. 1600x900).`);
  }

  const name = ALIAS_TO_NAME[key];
  if (name != null) {
    const preset = FORMATS[name];
    return { width: preset.width, height: preset.height, safeInset: insetToPx(preset.width, preset.height, preset.inset) };
  }

  const m = RAW_SIZE_RE.exec(key);
  if (m != null) {
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width <= 0 || height <= 0) {
      throw new Error(`format: "${fmt}" must have positive width and height.`);
    }
    return { width, height, safeInset: insetToPx(width, height, EVEN_INSET) };
  }

  throw new Error(
    `format: unknown format "${fmt}". Use a preset (${formatNames().join(", ")}) or WIDTHxHEIGHT (e.g. 1600x900).`,
  );
}

/**
 * Apply a resolved format's canvas size to a raw params object as **defaults**:
 * fill `width`/`height` only where the caller hasn't already set them, so the
 * precedence stays explicit `--width`/`--height` > format > (template default,
 * which zod applies later for any axis still absent). Mutates `raw` in place.
 * A format can thus size one axis while an explicit flag pins the other.
 */
export function applyFormatSize(raw: Record<string, unknown>, fmt: ResolvedFormat): void {
  raw.width ??= fmt.width;
  raw.height ??= fmt.height;
}

/** A per-side px inset — a template's own default breathing room, in the shape of
 *  a `SafeInset`, for combining with a format's safe-area inset. */
export type EdgeInset = SafeInset;

/**
 * A CSS `padding` shorthand (px, top/right/bottom/left) that keeps a template's
 * content within the safe area (docs/87, DM-1537): each side is the MAX of the
 * template's own default padding and the format's safe-area inset. With no
 * `safeInset` (no format chosen) it returns the defaults unchanged, so default
 * output is byte-identical. The per-side max means a small canvas keeps its
 * normal padding while a tall 9:16 format still reserves the platform-UI margin.
 */
export function safeAreaPadding(defaults: EdgeInset, safeInset?: SafeInset): string {
  const top = safeInset != null ? Math.max(defaults.top, safeInset.top) : defaults.top;
  const right = safeInset != null ? Math.max(defaults.right, safeInset.right) : defaults.right;
  const bottom = safeInset != null ? Math.max(defaults.bottom, safeInset.bottom) : defaults.bottom;
  const left = safeInset != null ? Math.max(defaults.left, safeInset.left) : defaults.left;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}
