#!/usr/bin/env node
/**
 * `animated-svg-scrubber` CLI (DM-1040).
 *
 * Launches a local web UI that gives an animated SVG video-style transport:
 * play / pause, playback speed, manual scrubbing, range select + loop, plus
 * pixel-faithful (Playwright-rendered) current-frame PNG export and a "trim to
 * a new clipped animated SVG" export. Drop an SVG in the browser, or pass one
 * on the command line to preload it.
 *
 * Usage:
 *   animated-svg-scrubber [file.svg] [--port <n>] [--no-open]
 *
 * Spins up an HTTP server on 127.0.0.1, opens the default browser, and stays
 * alive until Ctrl-C. See docs/56-animated-svg-scrubber.md.
 */

import { parseArgs } from "node:util";
import { resolve, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { startScrubberServer } from "../scrubber/server.js";
import { cliFail, openInBrowser } from "./common.js";

const HELP = `animated-svg-scrubber — video-style playback / scrubbing for animated SVGs

Usage:
  animated-svg-scrubber [file.svg] [options]

Arguments:
  file.svg               Optional animated SVG to preload into the UI.

Options:
      --port <n>         Port to bind the local UI server on (default: an
                         OS-assigned free port).
      --no-open          Print the URL but don't auto-open the browser.
      --help, -h         Show this help.

In the browser you can play / pause (space), step frames (←/→, shift = 1ms),
set the playback speed, scrub the timeline, mark an in/out range and loop it,
export the current frame as a PNG (rendered server-side via Chromium so it
matches the SVG's paint exactly), and trim the range to a new animated SVG.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { process.stdout.write(HELP); return; }

  let initialSvg: string | undefined;
  let initialName: string | undefined;
  const file = positionals[0];
  if (file != null) {
    const p = resolve(file);
    if (!existsSync(p)) cliFail("animated-svg-scrubber", `file not found: ${p}`, "usage");
    initialSvg = readFileSync(p, "utf-8");
    initialName = basename(p);
  }

  const server = await startScrubberServer({
    port: values.port != null ? Number(values.port) : undefined,
    initialSvg,
    initialName,
    launchBrowser: () => chromium.launch(),
    log: (m) => process.stderr.write(`${m}\n`),
  });

  process.stdout.write(`\n  animated-svg-scrubber running at ${server.url}\n  Press Ctrl-C to stop.\n\n`);
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
  cliFail("animated-svg-scrubber", err instanceof Error ? err.message : String(err), "runtime");
});
