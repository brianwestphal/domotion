#!/usr/bin/env node
/**
 * `svg-scrubber` CLI (DM-1040).
 *
 * Launches a local web UI that gives an animated SVG video-style transport:
 * play / pause, playback speed, manual scrubbing, range select + loop, plus
 * pixel-faithful (Playwright-rendered) current-frame PNG export and a "trim to
 * a new clipped animated SVG" export. Drop an SVG in the browser, or pass one
 * on the command line to preload it.
 *
 * Usage:
 *   svg-scrubber [file.svg] [--port <n>] [--no-open]
 *
 * Spins up an HTTP server on 127.0.0.1, opens the default browser, and stays
 * alive until Ctrl-C. See docs/56-svg-scrubber.md.
 */

import { parseArgs } from "node:util";
import { resolve, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { launchChromium } from "../capture/index.js";
import { startScrubberServer } from "../scrubber/server.js";
import { cliFail, openInBrowser, parsePort } from "./common.js";

const HELP = `svg-scrubber — video-style playback / scrubbing for animated SVGs

Usage:
  svg-scrubber [file.svg] [options]

Arguments:
  file.svg               Optional animated SVG to preload into the UI.

Options:
      --port <n>         Port to bind the local UI server on (default: an
                         OS-assigned free port).
      --review           Review mode: adds issue-reporting controls (title,
                         note, a draggable region, captured frame time + range)
                         that write importable .ticket files to the current
                         directory (their paths are logged as they're created).
      --no-open          Print the URL but don't auto-open the browser.
      --help, -h         Show this help.

In the browser you can play / pause (space), step frames (←/→, shift = 1ms),
set the playback speed, scrub the timeline, mark an in/out range and loop it,
export the current frame as a PNG (rendered server-side via Chromium so it
matches the SVG's paint exactly), and trim the range to a new animated SVG.

With --review, a panel lets you file issues about the SVG: type a title + note,
optionally drag a rectangle over the problem area, and Save — each issue is
written as a .ticket JSON file (frame time, range, and region included) in the
current directory, ready to import into a tracker like Hot Sheet.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      review: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { process.stdout.write(HELP); return; }

  let initialSvg: string | undefined;
  let initialName: string | undefined;
  let initialPath: string | undefined;
  const file = positionals[0];
  if (file != null) {
    const p = resolve(file);
    if (!existsSync(p)) cliFail("svg-scrubber", `file not found: ${p}`, "usage");
    initialSvg = readFileSync(p, "utf-8");
    initialName = basename(p);
    initialPath = p;
  }

  const review = values.review === true;
  const server = await startScrubberServer({
    port: parsePort(values.port),
    initialSvg,
    initialName,
    initialPath,
    review,
    ticketDir: process.cwd(),
    launchBrowser: () => launchChromium(),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  if (review) process.stderr.write(`Review mode: .ticket files will be written to ${process.cwd()}\n`);

  process.stdout.write(`\n  svg-scrubber running at ${server.url}\n  Press Ctrl-C to stop.\n\n`);
  if (!values["no-open"]) await openInBrowser(server.url);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return; closing = true;
    process.stderr.write("\nshutting down…\n");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch((err) => {
  cliFail("svg-scrubber", err instanceof Error ? err.message : String(err), "runtime");
});
