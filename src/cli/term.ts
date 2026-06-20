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
import { castToAnimatedSvg } from "../terminal/index.js";
import { THEMES } from "../terminal/theme.js";
import { cliFail } from "./common.js";

const HELP = `domotion term — record a terminal session as an animated SVG

Usage:
  domotion term --cast <file.cast> [-o out.svg] [options]

Record a session first with asciinema (https://asciinema.org):
  asciinema rec demo.cast -c "your-command"
  domotion term --cast demo.cast -o demo.svg

Options:
  --cast <file>        asciinema v2 .cast file to convert (required; "-" = stdin).
  -o, --output <path>  Output SVG path (default: stdout, or <cast>.svg for a file).
      --theme <name>   Color theme: ${Object.keys(THEMES).join(" | ")} (default catppuccin).
      --font-size <n>  Monospace font size in px (default 14).
      --cols <n>       Override the recorded column count.
      --rows <n>       Override the recorded row count.
      --settle-ms <n>  Output-pause (ms) that marks a frame boundary (default 90).
      --min-frame-ms <n>  Minimum per-frame hold (default 400).
      --max-frame-ms <n>  Maximum per-frame hold / idle cap (default 4000).
      --tail-ms <n>    Hold (ms) on the final screen (default 1500).
  -h, --help           Show this help.
`;

export async function runTerm(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cast: { type: "string" },
      output: { type: "string", short: "o" },
      theme: { type: "string" },
      "font-size": { type: "string" },
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

  if (values.help || values.cast == null) {
    (values.help ? process.stdout : process.stderr).write(HELP);
    process.exit(values.help ? 0 : 2);
  }

  const castPath = values.cast;
  const castText = castPath === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(castPath), "utf8");

  const num = (v: string | undefined): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) cliFail("domotion term", `invalid numeric value: ${v}`, "usage");
    return n;
  };

  const browser = await launchChromium();
  try {
    const { svg, width, height, frameCount } = await castToAnimatedSvg(castText, browser, {
      theme: values.theme,
      fontSize: num(values["font-size"]),
      cols: num(values.cols),
      rows: num(values.rows),
      settleMs: num(values["settle-ms"]),
      minFrameMs: num(values["min-frame-ms"]),
      maxFrameMs: num(values["max-frame-ms"]),
      tailMs: num(values["tail-ms"]),
      log: (m) => process.stderr.write(m + "\n"),
    });

    const outPath = values.output ?? (castPath !== "-" ? `${castPath.replace(/\.cast$/i, "")}.svg` : null);
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
