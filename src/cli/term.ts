/**
 * `domotion term` (DM-1225) — turn a recorded terminal session into an
 * animated SVG.
 *
 * Front-end: asciinema v2 `.cast` import (record with `asciinema rec out.cast`,
 * the de-facto terminal recorder). The session replays through a headless VT
 * emulator (`@xterm/headless`) into settle-point frames, each rendered as
 * terminal HTML and run through the normal capture→SVG pipeline, then stitched
 * into one animated SVG with hard cuts.
 *
 * Usage:
 *   domotion term --cast <file.cast> [-o out.svg] [options]
 *   asciinema rec demo.cast -c "npm test"   # then:
 *   domotion term --cast demo.cast -o demo.svg
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { launchChromium } from "../capture/index.js";
import { castToAnimatedSvg, type TermToSvgOptions } from "../terminal/index.js";
import { recordPtySession } from "../terminal/pty.js";
import { THEMES, type TerminalThemeSpec } from "../terminal/theme.js";
import { cliFail } from "./common.js";

const HELP = `domotion term — record a terminal session as an animated SVG

Usage:
  domotion term --cast <file.cast> [-o out.svg] [options]   # from a recording
  domotion term [options] -- <cmd ...>                      # run a command live

Two front-ends, same renderer:
  # 1. Convert an existing asciinema v2 recording:
  asciinema rec demo.cast -c "your-command"
  domotion term --cast demo.cast -o demo.svg

  # 2. Run a command live in a pseudo-terminal and capture it (needs the
  #    optional 'node-pty' dependency; everything after '--' is the command):
  domotion term -o build.svg -- npm test
  domotion term --theme dark -- git clone https://example.com/repo.git

Options:
  --cast <file>        asciinema v2 .cast file to convert ("-" = stdin). Use this
                       OR a live command after '--', not both.
  -o, --output <path>  Output SVG path (default: stdout, or <cast>.svg for a file).
      --mode <m>       incremental (default — render each line once, reveal on
                       its timeline; best for append/overwrite output) | full
                       (a complete screen frame per settle-point; for scrolling).
      --cursor <s>     Caret shape: block (default) | bar | underline | none.
                       A blinking caret follows the recorded cursor.
      --cursor-color <c>  Caret color (default: the theme's foreground).
      --theme <name>   Base color theme: ${Object.keys(THEMES).join(" | ")} (default catppuccin).
      --theme-file <p> JSON theme overriding bg / fg / ansi[16] on top of --theme
                       (e.g. { "bg": "#0a0e14", "fg": "#b3b1ad", "ansi": [16 hex] }).
      --bg <color>     Override the terminal background color.
      --fg <color>     Override the default text color.
      --font-size <n>  Monospace font size in px (default 14).
      --font-family <stack>  Monospace font stack (default 'SF Mono', Menlo, …).
      --cols <n>       Override the recorded column count.
      --rows <n>       Override the recorded row count.
      --settle-ms <n>  Output-pause (ms) that marks a frame boundary (default 90).
      --min-frame-ms <n>  Minimum per-frame hold (default 400).
      --max-frame-ms <n>  Maximum per-frame hold / idle cap (default 4000).
      --tail-ms <n>    Hold (ms) on the final screen (default 1500).
  -h, --help           Show this help.
`;

export async function runTerm(argv: string[]): Promise<void> {
  // `domotion term -- <cmd …>` runs a live command in a pty; everything after
  // the first `--` is the command, everything before is our own options.
  const sepIdx = argv.indexOf("--");
  const optionArgs = sepIdx >= 0 ? argv.slice(0, sepIdx) : argv;
  const command = sepIdx >= 0 ? argv.slice(sepIdx + 1) : [];

  const { values } = parseArgs({
    args: optionArgs,
    options: {
      cast: { type: "string" },
      output: { type: "string", short: "o" },
      mode: { type: "string" },
      cursor: { type: "string" },
      "cursor-color": { type: "string" },
      theme: { type: "string" },
      "theme-file": { type: "string" },
      bg: { type: "string" },
      fg: { type: "string" },
      "font-size": { type: "string" },
      "font-family": { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      "settle-ms": { type: "string" },
      "min-frame-ms": { type: "string" },
      "max-frame-ms": { type: "string" },
      "tail-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const live = command.length > 0;
  if (values.help || (!live && values.cast == null)) {
    (values.help ? process.stdout : process.stderr).write(HELP);
    process.exit(values.help ? 0 : 2);
  }
  if (live && values.cast != null) {
    cliFail("domotion term", "give EITHER --cast <file> OR a live command after `--`, not both", "usage");
  }

  const num = (v: string | undefined): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) cliFail("domotion term", `invalid numeric value: ${v}`, "usage");
    return n;
  };

  // Source the asciinema cast text from EITHER a recorded file or a live pty run.
  // The live path runs the command, echoes it to the terminal, and records the
  // same `[time,"o",data]` events into a cast string for the shared backend.
  const castPath = values.cast;
  let castText: string;
  if (live) {
    const r = await recordPtySession(command, {
      cols: num(values.cols),
      rows: num(values.rows),
      log: (m) => process.stderr.write(m + "\n"),
    });
    castText = r.cast;
  } else {
    castText = castPath === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(castPath as string), "utf8");
  }

  // Theme: a bare `--theme <name>` stays a string (built-in). Any of --theme-file
  // / --bg / --fg makes it a spec object that overrides the named base.
  const themeFile = values["theme-file"];
  let theme: TermToSvgOptions["theme"];
  if (themeFile != null || values.bg != null || values.fg != null) {
    let spec: TerminalThemeSpec = {};
    if (themeFile != null) {
      try {
        spec = JSON.parse(readFileSync(resolve(themeFile), "utf8")) as TerminalThemeSpec;
      } catch (e) {
        cliFail("domotion term", `--theme-file is not valid JSON: ${(e as Error).message}`, "usage");
      }
    }
    if (values.theme != null) spec.extends = values.theme; // --theme is the base
    if (values.bg != null) spec.bg = values.bg;
    if (values.fg != null) spec.fg = values.fg;
    theme = spec;
  } else {
    theme = values.theme;
  }

  const browser = await launchChromium();
  try {
    const mode = values.mode;
    if (mode != null && mode !== "incremental" && mode !== "full") {
      cliFail("domotion term", `--mode must be "incremental" or "full", got "${mode}"`, "usage");
    }
    const cursor = values.cursor;
    if (cursor != null && !["block", "bar", "underline", "none"].includes(cursor)) {
      cliFail("domotion term", `--cursor must be block | bar | underline | none, got "${cursor}"`, "usage");
    }
    const { svg, width, height, frameCount } = await castToAnimatedSvg(castText, browser, {
      theme,
      mode: mode as "incremental" | "full" | undefined,
      cursor: cursor as "block" | "bar" | "underline" | "none" | undefined,
      cursorColor: values["cursor-color"],
      fontSize: num(values["font-size"]),
      fontFamily: values["font-family"],
      cols: num(values.cols),
      rows: num(values.rows),
      settleMs: num(values["settle-ms"]),
      minFrameMs: num(values["min-frame-ms"]),
      maxFrameMs: num(values["max-frame-ms"]),
      tailMs: num(values["tail-ms"]),
      log: (m) => process.stderr.write(m + "\n"),
    });

    // Default output: <cast>.svg for a file input; `term.svg` for the live path
    // (stdout already carried the live session). stdin-cast (`-`) → stdout.
    const outPath = values.output
      ?? (live ? "term.svg" : (castPath !== "-" ? `${(castPath as string).replace(/\.cast$/i, "")}.svg` : null));
    if (outPath == null) {
      process.stdout.write(svg);
    } else {
      writeFileSync(resolve(outPath), svg);
      process.stderr.write(`Wrote ${resolve(outPath)} — ${frameCount} frames, ${width}×${height}px, ${(svg.length / 1024).toFixed(1)} KB\n`);
    }
  } finally {
    await browser.close();
  }
}
