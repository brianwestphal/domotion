#!/usr/bin/env node
/**
 * Domotion CLI — DOM-to-animated-SVG renderer.
 *
 * Commands:
 *   domotion capture  <input> [options]   single-frame capture
 *   domotion animate  <config.json>       multi-frame animated capture
 *   domotion term     --cast <file>       terminal session → animated SVG (DM-1225)
 *
 * `<input>` for `capture` may be:
 *   - a URL (`https://...`, `http://...`)
 *   - a local HTML file path
 *   - a `.har` file (HTTP-Archive) — replayed offline (DM-889)
 *   - `-` to read HTML from stdin
 *
 * Run `domotion --help` for the full option list.
 */

import { createRequire } from "node:module";
import { runCapture } from "./capture.js";
import { runAnimate } from "./animate.js";
import { runTerm } from "./term.js";

// Read the version from package.json at runtime rather than hardcoding it, so
// `domotion --version` always matches the installed package (the literal had
// drifted to 0.1.0 while the package was at 0.5.0). Resolved relative to this
// file: dist/cli/index.js → ../../package.json is the package root, and the
// same path holds for src/cli/index.ts under tsx in local dev.
const require = createRequire(import.meta.url);
const VERSION = (require("../../package.json") as { version: string }).version;

const HELP = `domotion ${VERSION} — DOM-to-animated-SVG renderer

Usage:
  domotion capture <input> [options]
  domotion animate <config.json>
  domotion term --cast <file.cast> [options]
  domotion --help | --version

Commands:
  capture   Capture a single frame from a URL, HTML file, or .har archive as SVG.
  animate   Capture multiple frames described by a JSON config and stitch
            them into one animated SVG with CSS keyframe transitions.
  term      Convert a recorded terminal session (asciinema v2 .cast) into an
            animated SVG. Record with: asciinema rec demo.cast -c "<command>".
            Run 'domotion term --help' for options (theme, font size, timing).

capture options:
  -o, --output <path>      Output SVG path (default: stdout, or <input>.svg
                           when input is a file).
      --width <n>          Viewport width in CSS pixels (default 800).
      --height <n>         Viewport height in CSS pixels (default 600).
      --selector <css>     Element selector to capture (default "body").
      --clip <x,y,w,h>     Capture only this region (default: full viewport).
      --scroll-to <x,y>    Scroll the page to this offset before capturing
                           (use --scroll for an animated scroll demo).
      --wait <ms>          Sleep this long after the page settles (default 200).
      --wait-for <css>     Wait for this selector to appear before capturing.
      --no-fonts-ready     Skip the document.fonts.ready wait (default: wait).
      --optimize           Run output through SVGO.
      --no-optimize        Skip SVGO. Only meaningful when -o ends in
                           .svgz (where --optimize is implied by default).
      --scroll <pattern>   Generate an animated scroll demo. Captures the
                           page at multiple scroll positions per the
                           pattern grammar (see docs) and composes one
                           animated SVG. Examples:
                             --scroll "down:bottom/8s"
                             --scroll "720px,2s until bottom"
                             --scroll "(720px,2s until bottom - 1000px), (200px,3s until bottom)"
      --scroll-speed <n>   Default scroll speed in px/s (used by pattern
                           tokens that don't specify their own /<duration>).
                           Default: 1500.
      --scroll-selector <s> CSS selector for an inner scrollable element
                           to scroll (default: window).
      --no-prescroll       Skip the pre-scroll-to-bottom-then-top step
                           that wakes lazy-loaded content. Default: on.
      --quiet              Suppress per-phase progress messages on stderr.
                           Default: progress messages are on.
      --warnings           Log capture warnings to stderr after capture.
      --mobile             Emulate a mobile device (iOS UA, isMobile=true).
      --chrome <device>    Wrap the capture in a device bezel: "phone", "browser", "window".
      --chrome-label <s>   Text for the chrome bar (browser URL / window title).
      --chrome-theme <s>   browser/window bezel theme: "dark" (default) | "light".
      --color-scheme <s>   Set prefers-color-scheme: "light" | "dark" | "no-preference".
      --debug              Write a reproduction bundle next to the output
                           (.debug/ folder with capture.har, expected.png
                           Chromium screenshot, actual.svg copy, and the
                           captured-tree JSON). Pair with svg-review to
                           file render-fidelity bug reports.
      --debug-dir <path>   Override the .debug/ folder location.

  HAR replay (when <input> ends in .har): the archive is replayed offline —
  every request is served from the HAR, so the capture is deterministic and
  needs no network. The main-document URL is inferred from the HAR; override
  it with --url. Output defaults to <input>.svg.
      --url <url>          Main-document URL to navigate to within the HAR.
                           Default: inferred (recorded page URL, else the first
                           text/html entry). Only valid with a .har input.
      --har-fallback       Let requests missing from the HAR hit the live
                           network instead of aborting. Default: abort (strict
                           offline). Only valid with a .har input.

animate config (JSON):
  {
    "width":  800,
    "height": 400,
    "output": "demo.svg",                           // optional
    "optimize": true,                               // optional
    "mobile": false,                                // optional — emulate a mobile device
    "colorScheme": "light",                         // optional — light | dark | no-preference
    "vars": { "base": "http://localhost:4188" },    // optional — \${name} interpolation in any string field
    "cursor": "auto",                               // optional — on-screen pointer (see Cursor below)
    "frames": [
      {
        "input":      "./frames/start.html",        // URL or path; OPTIONAL after frame 0 (see Continuous session)
        "continue":   false,                        // optional — keep the previous frame's live page (no reload)
        "duration":   1500,                         // ms held on screen
        "transition": { "type": "crossfade", "duration": 300 },
        "selector":   "body",                       // optional
        "wait":       200,                          // optional ms settle
        "waitFor":    ".ready",                     // optional — wait for selector visible
        "waitForText":  { "selector": ".count", "equals": "1" },  // optional (or "contains")
        "waitForGone":  ".spinner",                 // optional — wait until removed / hidden
        "waitForCount": { "selector": ".row", "atLeast": 3 },     // optional (equals | atLeast | atMost)
        "scrollTo":   [0, 0],                       // optional — scroll BEFORE capture
        "scroll":     { "pattern": "down:bottom/8s", "speed": 1500, "selector": ".panel", "prescroll": true },
        "actions":    [ /* run in order, before capture — see Actions */ ],
        "overlays":   [ /* see Overlays */ ],
        "animations": [                             // intra-frame motion
          { "selector": ".bar", "property": "width", "from": "0%", "to": "100%",
            "duration": 2000, "easing": "ease-out", "delay": 150,
            "repeat": "infinite", "alternate": true }             // optional — loop (blink / pulse / breathe)
        ]
      }
    ]
  }

  Transitions: "crossfade" | "push-left" | "scroll" | "cut" ("cut" = instant).
  Continuous session: frame 0 must load an "input"; a later frame that omits
    "input" (or sets "continue": true) captures the live page after its own
    actions instead of reloading — for multi-step interaction demos.

  Actions (each runs in order before capture; all but scroll/press/wait/evaluate take a "selector"):
    Interaction:  click | fill {value} | press {key} | hover | scroll {x,y} | wait {ms}
                  scrollIntoView {block?,inline?} | dispatch {event,bubbles?} | focus | blur | selectText | clear
    DOM mutation: setText {value} | setHtml {value} | remove | setAttribute {name,value} | removeAttribute {name}
                  addClass|removeClass|toggleClass {class} | setStyle {props} | insert {position,html}
                  setValue {value} | check {checked} | selectOption {value} | replaceText {pattern,replacement,flags?}
    Escape hatch: evaluate {script}   // runs via page.evaluate — last resort, small snippets only

  Overlays:
    { "kind": "typing", "text", "x", "y", "caret": true, "maxWidth": "anchor", ... }
    { "kind": "tap",    "x", "y" }
    { "kind": "svg",    "src": "./x.svg", "x", "y", "width", "height", "enter": {...} }
    { "kind": "blink",  "x", "y", "width", "height", "periodMs", "color", "radius" }   // a blinking dot/bar
    Any overlay may set "anchor": { "selector", "at", "dx", "dy" } to position by an
    element's bounding box instead of x/y (at = top-left | top | ... | center | ... | bottom-right).

  Cursor (on-screen pointer):
    "auto"  — a move + click-pulse follows each click / hover / fill action.
    { "style": { "scale": 1.5 }, "events": [
        { "frame": 2, "at": 1600, "type": "moveClick", "selector": ".cta" },
        { "frame": 6, "at": 0,    "type": "hide" } ] }

  All string fields resolve \${vars}. "input" / overlay "src" paths are relative
  to the config file's directory.

Examples:
  # Capture the front page of example.com at 1280×720.
  domotion capture https://example.com --width 1280 --height 720 -o demo.svg

  # Capture a local HTML file, optimized, only the .hero region.
  domotion capture ./hero.html --selector ".hero" --optimize -o hero.svg

  # Capture HTML piped on stdin.
  cat my.html | domotion capture - -o out.svg

  # Capture as gzip-compressed .svgz (auto-detected from -o extension;
  # implies --optimize unless --no-optimize is also passed).
  domotion capture ./hero.html -o hero.svgz

  # Build a 3-frame animated demo from a config.
  domotion animate ./demo.json
`;

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  try {
    if (cmd === "capture") {
      await runCapture(rest, HELP);
    } else if (cmd === "animate") {
      await runAnimate(rest, HELP);
    } else if (cmd === "term") {
      await runTerm(rest);
    } else {
      process.stderr.write(`domotion: unknown command "${cmd}"\n\n`);
      process.stderr.write(HELP);
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`domotion: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
