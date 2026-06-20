/**
 * Frame selection + grid→HTML rendering (DM-1225).
 *
 * `buildFrames` replays the cast's output events through the emulator and
 * snapshots the screen at SETTLE POINTS — moments where the gap to the next
 * event is ≥ `settleMs` (output paused), plus the final state. Rapid bursts
 * (a spinner updating every few ms) collapse into the snapshot at the next
 * pause, so a 30 s session yields a handful of meaningful frames instead of
 * hundreds. Each frame's `durationMs` is how long that screen stayed up (the
 * pause length), clamped to `[minFrameMs, maxFrameMs]`. Identical consecutive
 * screens merge (their durations add) so a quiet terminal isn't re-emitted.
 *
 * `gridToHtml` turns one snapshot into terminal HTML: a monospace `<pre>`-style
 * block whose rows are runs of `<span>`s coalesced by style. That HTML feeds the
 * normal capture→SVG pipeline.
 */

import type { CastOutputEvent } from "./cast.js";
import { TerminalEmulator, gridSignature, type TermGrid, type TermCell } from "./emulator.js";
import type { TerminalTheme } from "./theme.js";

export interface FrameBuildOptions {
  /** Output must pause this long (ms) to mark a settle point. Default 90. */
  settleMs?: number;
  /** Minimum per-frame hold (ms). Default 400. */
  minFrameMs?: number;
  /** Maximum per-frame hold (ms) — caps long idle gaps. Default 4000. */
  maxFrameMs?: number;
  /** Tail hold (ms) added after the last event so the final screen lingers. Default 1500. */
  tailMs?: number;
}

export interface TermFrame {
  grid: TermGrid;
  durationMs: number;
}

export async function buildFrames(
  emu: TerminalEmulator,
  events: CastOutputEvent[],
  opts: FrameBuildOptions = {},
): Promise<TermFrame[]> {
  const settleMs = opts.settleMs ?? 90;
  const minFrameMs = opts.minFrameMs ?? 400;
  const maxFrameMs = opts.maxFrameMs ?? 4000;
  const tailMs = opts.tailMs ?? 1500;
  const settleSec = settleMs / 1000;

  const frames: TermFrame[] = [];
  let lastSig: string | null = null;
  const n = events.length;
  for (let i = 0; i < n; i++) {
    await emu.write(events[i].data);
    const isLast = i === n - 1;
    const gapSec = isLast ? tailMs / 1000 : events[i + 1].time - events[i].time;
    if (gapSec < settleSec && !isLast) continue; // not a settle point yet
    const grid = emu.snapshot();
    const sig = gridSignature(grid);
    const holdMs = Math.min(maxFrameMs, Math.max(minFrameMs, Math.round(gapSec * 1000)));
    if (sig === lastSig && frames.length > 0) {
      // Same screen persisted across the pause — extend the prior frame.
      frames[frames.length - 1].durationMs = Math.min(maxFrameMs, frames[frames.length - 1].durationMs + holdMs);
    } else {
      frames.push({ grid, durationMs: holdMs });
      lastSig = sig;
    }
  }
  // Drop a leading all-blank frame (terminal hadn't printed anything yet).
  while (frames.length > 1 && gridSignature(frames[0].grid) === "") frames.shift();
  return frames;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cellStyle(cell: TermCell, theme: TerminalTheme): string {
  const parts: string[] = [];
  if (cell.fg != null) parts.push(`color:${cell.fg}`);
  if (cell.bg != null) parts.push(`background:${cell.bg}`);
  if (cell.bold) parts.push("font-weight:700");
  if (cell.italic) parts.push("font-style:italic");
  if (cell.dim) parts.push("opacity:.6");
  if (cell.underline) parts.push("text-decoration:underline");
  void theme;
  return parts.join(";");
}

/** Two cells share a `<span>` run when every visible style attribute matches. */
function sameStyle(a: TermCell, b: TermCell): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold
    && a.italic === b.italic && a.dim === b.dim && a.underline === b.underline;
}

export interface HtmlRenderOptions {
  theme: TerminalTheme;
  /** Font size in px. Default 14. */
  fontSize?: number;
  /** Cell line-height multiplier. Default 1.4. */
  lineHeight?: number;
  /** Padding around the grid in px. Default 16. */
  padding?: number;
  /** Monospace font stack. */
  fontFamily?: string;
}

/** Render one snapshot grid to a self-contained terminal HTML document. */
export function gridToHtml(grid: TermGrid, opts: HtmlRenderOptions): string {
  const { theme } = opts;
  const fontSize = opts.fontSize ?? 14;
  const lineHeight = opts.lineHeight ?? 1.4;
  const padding = opts.padding ?? 16;
  const fontFamily = opts.fontFamily ?? "'SF Mono', 'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace";

  const rows = grid.map((row) => {
    // Trim trailing blank (default-styled space) cells so empty tails don't emit spans.
    let end = row.length;
    while (end > 0) {
      const c = row[end - 1];
      if (c.char !== " " || c.fg != null || c.bg != null) break;
      end--;
    }
    if (end === 0) return `<div class="r">&nbsp;</div>`;
    const spans: string[] = [];
    let runStart = 0;
    for (let x = 1; x <= end; x++) {
      if (x === end || !sameStyle(row[x], row[runStart])) {
        const text = row.slice(runStart, x).map((c) => c.char).join("");
        const style = cellStyle(row[runStart], theme);
        spans.push(style === "" ? escapeHtml(text) : `<span style="${style}">${escapeHtml(text)}</span>`);
        runStart = x;
      }
    }
    return `<div class="r">${spans.join("")}</div>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:${theme.bg}}
  .term{display:inline-block;padding:${padding}px;background:${theme.bg};color:${theme.fg};
    font-family:${fontFamily};font-size:${fontSize}px;line-height:${lineHeight};
    font-variant-ligatures:none;-webkit-font-smoothing:antialiased}
  .r{white-space:pre;min-height:${(fontSize * lineHeight).toFixed(2)}px}
</style></head><body><div class="term">${rows.join("")}</div></body></html>`;
}
