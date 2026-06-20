/**
 * Headless VT emulator (DM-1225).
 *
 * Wraps `@xterm/headless` — a full xterm.js terminal with no DOM — so a raw
 * byte stream (with cursor moves, `\r` overwrites, clears, scroll regions, and
 * SGR/256/truecolor color) is reduced to the same 2D grid of styled cells the
 * terminal would actually display. We snapshot that grid into frames.
 *
 * `@xterm/headless`'s cell API reports color as a default flag, a 0–255 palette
 * index, or a packed 24-bit RGB int; `resolveColor` maps all three to a hex
 * string against the active `TerminalTheme` (so palette colors are themeable
 * and the 6×6×6 / grayscale 256-color cube is reproduced).
 */

import pkg from "@xterm/headless";
import type { Terminal as XTerm } from "@xterm/headless";
import type { TerminalTheme } from "./theme.js";
import { THEMES, xterm256ToHex } from "./theme.js";

// `@xterm/headless` ships as CommonJS; under esModuleInterop the default import
// is the `module.exports` object whose `Terminal` is the constructor. Type it
// through the real exported class so the rest of the file stays fully typed.
type XTermCtor = new (opts: { cols: number; rows: number; allowProposedApi?: boolean; scrollback?: number }) => XTerm;
const Terminal = (pkg as unknown as { Terminal: XTermCtor }).Terminal;

/** One rendered terminal cell: its glyph plus resolved style. */
export interface TermCell {
  char: string;
  /** Resolved foreground hex (e.g. "#a6e3a1"); null = theme default fg. */
  fg: string | null;
  /** Resolved background hex; null = theme default bg. */
  bg: string | null;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
}

export type TermGrid = TermCell[][];

/** The cursor's cell + visibility at a snapshot. */
export interface TermCursor {
  x: number;
  y: number;
  /** False while the program has hidden the cursor (DECTCEM `?25l`). */
  visible: boolean;
}

export class TerminalEmulator {
  private term: XTerm;
  readonly cols: number;
  readonly rows: number;
  private theme: TerminalTheme;
  // `@xterm/headless` has no public cursor-visibility getter, so track DECTCEM
  // (`\x1b[?25h` show / `\x1b[?25l` hide) off the byte stream ourselves.
  private cursorVisible = true;

  constructor(cols: number, rows: number, theme: TerminalTheme = THEMES.catppuccin) {
    this.cols = cols;
    this.rows = rows;
    this.theme = theme;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  /** Feed raw output bytes; resolves once xterm has parsed them. */
  write(data: string): Promise<void> {
    // Track the LAST cursor show/hide toggle in this chunk (DECTCEM).
    const m = data.match(/\x1b\[\?25([hl])(?![\s\S]*\x1b\[\?25[hl])/);
    if (m != null) this.cursorVisible = m[1] === "h";
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /** The cursor's current cell + visibility. */
  cursor(): TermCursor {
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY, visible: this.cursorVisible };
  }

  /**
   * Map an xterm cell color to a hex string. `isRgb` → packed 0xRRGGBB int;
   * `isPalette` → 0–255 index resolved through the theme's 16-color ANSI set
   * (0–15) or the 256-cube (16–255); otherwise the default (returns null so the
   * renderer can omit the attribute and inherit the theme fg/bg).
   */
  private resolveColor(value: number, isRgb: boolean, isPalette: boolean): string | null {
    if (isRgb) {
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
    }
    if (isPalette) {
      if (value < 16) return this.theme.ansi[value];
      return xterm256ToHex(value);
    }
    return null;
  }

  /** Snapshot the visible buffer into a styled grid. */
  snapshot(): TermGrid {
    const buf = this.term.buffer.active;
    const grid: TermGrid = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(y);
      const row: TermCell[] = [];
      for (let x = 0; x < this.cols; x++) {
        const cell = line?.getCell(x);
        if (cell == null) {
          row.push({ char: " ", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false });
          continue;
        }
        const chars = cell.getChars();
        row.push({
          char: chars === "" ? " " : chars,
          fg: this.resolveColor(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette()),
          bg: this.resolveColor(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette()),
          bold: cell.isBold() !== 0,
          italic: cell.isItalic() !== 0,
          dim: cell.isDim() !== 0,
          underline: cell.isUnderline() !== 0,
        });
      }
      grid.push(row);
    }
    return grid;
  }

  dispose(): void {
    this.term.dispose();
  }
}

/** Serialize a grid to a comparable string (trailing blanks trimmed per row) so
 *  the frame builder can skip snapshots identical to the previous one. */
export function gridSignature(grid: TermGrid): string {
  const cellSig = (c: TermCell): string => {
    if (c.char === " " && c.fg == null && c.bg == null && !c.bold && !c.italic && !c.dim && !c.underline) return " ";
    return c.char + "|" + (c.fg ?? "") + "|" + (c.bg ?? "")
      + (c.bold ? "b" : "") + (c.italic ? "i" : "") + (c.dim ? "d" : "") + (c.underline ? "u" : "");
  };
  return grid
    .map((row) => row.map(cellSig).join("").replace(/ +$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
