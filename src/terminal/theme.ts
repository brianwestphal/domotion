/**
 * Terminal color themes (DM-1225).
 *
 * `ansi` holds the 16 base colors (0–7 normal, 8–15 bright) a palette cell
 * index < 16 resolves to. Indices 16–255 are the standard xterm 6×6×6 color
 * cube + 24-step grayscale ramp, computed by `xterm256ToHex` (theme-independent
 * — every terminal renders that range identically). `bg`/`fg` are the default
 * surface + text colors for cells that carry no explicit color.
 */

import { z } from "zod";

export interface TerminalTheme {
  name: string;
  bg: string;
  fg: string;
  /** 16 ANSI colors: [black, red, green, yellow, blue, magenta, cyan, white,
   *  brightBlack, brightRed, …, brightWhite]. */
  ansi: string[];
}

/**
 * A custom-theme spec (DM-1225): override any of `bg` / `fg` / the 16 `ansi`
 * colors on top of a built-in base (`extends`, default `catppuccin`). Every
 * field is optional — `{ bg: "#000" }` keeps the base theme's text + palette
 * and only swaps the background. A full `TerminalTheme` also satisfies this.
 */
export interface TerminalThemeSpec {
  /** Built-in base to inherit unspecified fields from. Default `catppuccin`. */
  extends?: string;
  name?: string;
  bg?: string;
  fg?: string;
  /** Exactly 16 colors when present (0–7 normal, 8–15 bright). */
  ansi?: string[];
}

/**
 * Runtime validator for `TerminalThemeSpec`, so external theme JSON (the
 * `domotion term --theme-file` surface) is shape-checked at the CLI boundary
 * instead of being cast straight through with `as`. Shared with `animate.ts`'s
 * per-frame `cast` theme option so the two `--theme-file` / config code paths
 * can't drift. Keep in sync with the interface above. `.length(16)` enforces the
 * exact ANSI palette size; unknown keys are stripped (non-strict).
 */
export const terminalThemeSpecSchema: z.ZodType<TerminalThemeSpec> = z.object({
  extends: z.string().optional(),
  name: z.string().optional(),
  bg: z.string().optional(),
  fg: z.string().optional(),
  ansi: z.array(z.string()).length(16).optional(),
});

/** Default: a Catppuccin-Mocha-style palette (matches the existing terminal demos). */
const CATPPUCCIN: TerminalTheme = {
  name: "catppuccin",
  bg: "#11111b",
  fg: "#cdd6f4",
  ansi: [
    "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
  ],
};

/** A light theme for docs that want a terminal on a white page. */
const GITHUB_LIGHT: TerminalTheme = {
  name: "github-light",
  bg: "#ffffff",
  fg: "#1f2328",
  ansi: [
    "#24292e", "#d73a49", "#28a745", "#dbab09", "#0366d6", "#5a32a3", "#0598bc", "#6a737d",
    "#959da5", "#cb2431", "#22863a", "#b08800", "#005cc5", "#5a32a3", "#3192aa", "#d1d5da",
  ],
};

/** A classic dark terminal (VS Code-ish dark+). */
const DARK_PLUS: TerminalTheme = {
  name: "dark",
  bg: "#1e1e1e",
  fg: "#d4d4d4",
  ansi: [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
  ],
};

export const THEMES: Record<string, TerminalTheme> = {
  catppuccin: CATPPUCCIN,
  "github-light": GITHUB_LIGHT,
  dark: DARK_PLUS,
};

/**
 * Resolve a theme spec to a concrete `TerminalTheme`. A string is a built-in
 * theme name; an object overrides `bg` / `fg` / `ansi` on top of its `extends`
 * base (default `catppuccin`). A full `TerminalTheme` passes through unchanged.
 * Throws on an unknown theme name or an `ansi` array that isn't 16 colors.
 */
/** Resolve a theme name / spec / undefined to a concrete `TerminalTheme`,
 *  defaulting to `catppuccin`. The shared entry point for both terminal render
 *  paths (full-frame `index.ts` + incremental composer) — DM-1370. */
export function resolveTheme(theme: string | TerminalThemeSpec | undefined): TerminalTheme {
  return resolveThemeSpec(theme ?? "catppuccin");
}

export function resolveThemeSpec(spec: string | TerminalThemeSpec): TerminalTheme {
  const names = Object.keys(THEMES).join(", ");
  if (typeof spec === "string") {
    const t = THEMES[spec];
    if (t == null) throw new Error(`term: unknown theme "${spec}" (have: ${names})`);
    return t;
  }
  const base = THEMES[spec.extends ?? "catppuccin"];
  if (base == null) throw new Error(`term: unknown base theme "${spec.extends}" to extend (have: ${names})`);
  if (spec.ansi != null && spec.ansi.length !== 16) {
    throw new Error(`term: theme.ansi must have exactly 16 colors, got ${spec.ansi.length}`);
  }
  return {
    name: spec.name ?? base.name,
    bg: spec.bg ?? base.bg,
    fg: spec.fg ?? base.fg,
    ansi: spec.ansi ?? base.ansi,
  };
}

/** Resolve an xterm 256-color palette index (16–255) to a hex string. 16–231 is
 *  the 6×6×6 RGB cube; 232–255 is the 24-step grayscale ramp. */
export function xterm256ToHex(index: number): string {
  if (index < 16) return THEMES.catppuccin.ansi[index] ?? "#000000";
  if (index >= 232) {
    const level = 8 + (index - 232) * 10; // 8, 18, …, 238
    return rgbHex(level, level, level);
  }
  const i = index - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const conv = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return rgbHex(conv(r), conv(g), conv(b));
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
