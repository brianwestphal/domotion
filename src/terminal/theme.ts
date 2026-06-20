/**
 * Terminal color themes (DM-1225).
 *
 * `ansi` holds the 16 base colors (0–7 normal, 8–15 bright) a palette cell
 * index < 16 resolves to. Indices 16–255 are the standard xterm 6×6×6 color
 * cube + 24-step grayscale ramp, computed by `xterm256ToHex` (theme-independent
 * — every terminal renders that range identically). `bg`/`fg` are the default
 * surface + text colors for cells that carry no explicit color.
 */

export interface TerminalTheme {
  name: string;
  bg: string;
  fg: string;
  /** 16 ANSI colors: [black, red, green, yellow, blue, magenta, cyan, white,
   *  brightBlack, brightRed, …, brightWhite]. */
  ansi: string[];
}

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
