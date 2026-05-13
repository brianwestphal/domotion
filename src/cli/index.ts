#!/usr/bin/env node
/**
 * Domotion CLI — DOM-to-animated-SVG renderer.
 *
 * Two commands:
 *   domotion capture  <input> [options]   single-frame capture
 *   domotion animate  <config.json>       multi-frame animated capture
 *
 * `<input>` for `capture` may be:
 *   - a URL (`https://...`, `http://...`)
 *   - a local HTML file path
 *   - `-` to read HTML from stdin
 *
 * Run `domotion --help` for the full option list.
 */

import { runCapture } from "./capture.js";
import { runAnimate } from "./animate.js";

const VERSION = "0.1.0";

const HELP = `domotion ${VERSION} — DOM-to-animated-SVG renderer

Usage:
  domotion capture <input> [options]
  domotion animate <config.json>
  domotion --help | --version

Commands:
  capture   Capture a single frame from a URL or HTML file as SVG.
  animate   Capture multiple frames described by a JSON config and stitch
            them into one animated SVG with CSS keyframe transitions.

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
      --color-scheme <s>   Set prefers-color-scheme: "light" | "dark" | "no-preference".

animate config (JSON):
  {
    "width":  800,
    "height": 400,
    "output": "demo.svg",
    "optimize": true,
    "frames": [
      {
        "input":      "./frames/start.html",        // or a URL
        "duration":   1500,                         // ms held on screen
        "transition": { "type": "crossfade", "duration": 300 },
        "selector":   "body",                       // optional
        "wait":       200,                          // optional ms
        "waitFor":    ".ready",                     // optional CSS selector
        "scrollTo":   [0, 0],                       // optional [x, y] — scroll to here BEFORE capture
        "scroll":     {                             // optional — scroll-demo block (DM-612)
          "pattern":  "down:bottom/8s",             //   pattern grammar (see docs)
          "speed":    1500,                         //   optional default px/s
          "selector": ".panel",                     //   optional inner-element to scroll
          "prescroll": true                         //   optional, default true
        },
        "actions": [                                // optional, run before capture
          { "type": "click",     "selector": ".btn" },
          { "type": "fill",      "selector": "input", "value": "hi" },
          { "type": "press",     "key": "Enter" },
          { "type": "scroll",    "y": 200 },
          { "type": "hover",     "selector": ".tooltip" },
          { "type": "wait",      "ms": 300 }
        ],
        "overlays": [                               // see Overlay types
          { "kind": "tap",    "x": 100, "y": 50 },
          { "kind": "typing", "text": "Hello", "x": 20, "y": 40 }
        ],
        "animations": [                             // intra-frame motion
          {
            "selector": ".bar",                     // CSS selector in source HTML
            "property": "transform",                // or width/height/opacity/translateX/translateY
            "from": "scaleX(0)",
            "to":   "scaleX(1)",
            "duration": 2000,
            "easing": "ease-out",                   // optional, default "linear"
            "delay": 150                            // optional ms after frame start
          }
        ]
      }
    ]
  }

  Transition types: "crossfade" | "push-left" | "scroll" | "cut".
                  ("cut" = instant; duration is ignored.)
  Paths in "input" are resolved relative to the config file's directory.

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
