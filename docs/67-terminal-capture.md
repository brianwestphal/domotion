# Terminal capture → animated SVG (`domotion term`, DM-1225)

`domotion term` turns a recorded terminal session into a self-contained animated
SVG — real text, real color, native SVG (no raster frames). It replaces the
hand-authored terminal demos (`examples/terminal-demo.ts`,
`examples/animate/terminal-onboarding/`) with automatic capture from a real
program.

## Front-end: asciinema `.cast`

The shipped front-end imports an **asciinema v2 `.cast`** — the de-facto
terminal-recording format. Record with the ubiquitous `asciinema` tool, then
convert:

```sh
asciinema rec demo.cast -c "npm test"     # records the command in a real PTY
domotion term --cast demo.cast -o demo.svg
```

Using asciinema for capture means the recording runs in a genuine pseudo-
terminal (so the program detects a TTY and emits color/cursor control) without
Domotion needing a native PTY dependency. A live `node-pty` front-end can later
feed the same backend (see "Architecture").

### Options

| flag | default | meaning |
|------|---------|---------|
| `--cast <file>` | — | asciinema v2 `.cast` to convert (`-` = stdin). Required. |
| `-o, --output <path>` | `<cast>.svg` / stdout | output SVG path |
| `--theme <name>` | `catppuccin` | base theme: `catppuccin` \| `dark` \| `github-light` |
| `--theme-file <path>` | — | JSON overriding `bg` / `fg` / `ansi[16]` on top of `--theme` |
| `--bg <color>` | — | override the terminal background color |
| `--fg <color>` | — | override the default text color |
| `--font-size <n>` | `14` | monospace font size (px) |
| `--font-family <stack>` | `'SF Mono', Menlo, …` | monospace font stack |
| `--cols <n>` / `--rows <n>` | from cast header | override the recorded grid size |
| `--settle-ms <n>` | `90` | output-pause (ms) that marks a frame boundary |
| `--min-frame-ms <n>` | `400` | minimum per-frame hold |
| `--max-frame-ms <n>` | `4000` | maximum per-frame hold (caps idle gaps) |
| `--tail-ms <n>` | `1500` | hold on the final screen |

## Theming

A theme is a background (`bg`), a default text color (`fg`), and the 16 ANSI
colors (`ansi`, indices 0–7 normal + 8–15 bright). Three are built in:
`catppuccin` (default), `dark`, `github-light`. The xterm **256-color cube +
truecolor** that a recording uses are reproduced exactly regardless of theme —
the theme only governs the 16 ANSI colors + bg/fg.

Customize at any layer:

```sh
# pick a built-in, swap just the background / text color
domotion term --cast x.cast --theme dark --bg "#0a0e14" --fg "#b3b1ad"

# full custom palette from a JSON file (any subset; merged onto --theme)
domotion term --cast x.cast --theme-file ./ayu.json --font-family "'JetBrains Mono', monospace"
# ayu.json: { "extends": "dark", "bg": "#0a0e14", "fg": "#b3b1ad", "ansi": [ …16 hex… ] }
```

In an `animate` config, `term.theme` accepts a name OR an inline override object:

```json
{ "cast": "./x.cast",
  "term": { "theme": { "extends": "dark", "bg": "#0a0e14", "fg": "#b3b1ad" },
            "fontFamily": "'JetBrains Mono', monospace", "fontSize": 15 },
  "duration": 11000 }
```

Programmatically, `theme` takes a name, a `TerminalThemeSpec` (partial override),
or a full `TerminalTheme`; `resolveThemeSpec` is the shared resolver:

```ts
await castToAnimatedSvg(castText, browser, {
  theme: { extends: "dark", bg: "#0a0e14", ansi: [/* 16 hex */] },
  fontFamily: "'JetBrains Mono', monospace",
});
```

## Architecture (4 stages)

`src/terminal/` + the `term` subcommand in `src/cli/index.ts`. The backend is
deliberately source-agnostic — swap stage 1 for a `node-pty` byte stream and
stages 2–4 are identical.

1. **Parse** (`cast.ts`) — read the asciinema v2 document: a JSON header
   (`width`/`height`) then `[time, "o", data]` output events. Non-output events
   (input/resize/marker) and a truncated trailing line are tolerated.
2. **Emulate** (`emulator.ts`) — feed the raw bytes through **`@xterm/headless`**
   (a full xterm.js terminal with no DOM) so cursor moves, `\r` overwrites,
   clears, scroll regions, and SGR/256/truecolor all resolve to the real screen
   grid. `TerminalEmulator.snapshot()` reads each cell's glyph + resolved
   fg/bg/bold/italic/dim/underline; palette indices map through the active
   `theme.ts` (16 ANSI + the 256-color cube).
3. **Select + render** (`render.ts`) — `buildFrames` replays the events and
   snapshots the screen at SETTLE POINTS (gaps ≥ `settleMs`, plus the final
   state), so a spinner updating every few ms collapses into the snapshot at the
   next pause instead of producing hundreds of frames. Each frame's `duration`
   is how long that screen stayed up (clamped to `[minFrameMs, maxFrameMs]`);
   identical consecutive screens merge. `gridToHtml` renders a snapshot to a
   monospace terminal HTML document (rows of `<span>` runs coalesced by style).
4. **Compose** (`index.ts`, `castToAnimatedSvg`) — each HTML frame runs through
   the normal `captureElementTree` + `elementTreeToSvgInner` pipeline, and the
   frames are stitched by `generateAnimatedSvg` with hard `cut` transitions
   (terminals don't crossfade). The canvas is sized from a full `cols×rows`
   reference block so every frame fits.

## What's reused vs new

Stages 3–4's rendering/animation infrastructure already shipped (the capture
pipeline, the animator, the device-chrome `--chrome window` bezel from doc 65
can frame the terminal, and the `animated-svg-scrubber` from doc 56 reviews the
result). The new code is the cast parser, the `@xterm/headless` snapshot wrapper,
the frame-selection heuristic, and the grid→HTML mapper.

## Composing a terminal into a larger animation

A terminal recording is rarely the whole demo — you'll usually want it inside
intro/outro frames, behind window chrome, retimed, etc. There are two seams for
that (DM-1225 follow-up), so you don't have to settle for the flat `domotion
term` output.

### Declarative: a `cast` frame in an `animate` config (no code)

The `domotion animate` JSON config accepts a frame whose content is a terminal
cast — it embeds as a self-contained animated terminal SVG, nested like a
`scroll` block. Size the frame's `duration` to ≈ the cast's recorded play time
(the tool logs it; a too-short duration warns and cuts off):

```json
{
  "width": 656, "height": 346,
  "frames": [
    { "input": "./intro.html", "duration": 1500, "transition": { "type": "crossfade", "duration": 400 } },
    { "cast": "./build.cast",
      "term": { "theme": "dark", "maxFrameMs": 700, "fontSize": 13 },
      "duration": 12000,
      "transition": { "type": "crossfade", "duration": 400 } },
    { "input": "./done.html", "duration": 2500 }
  ]
}
```

The `term` block takes the same options as the CLI flags (theme, font, the
`*-ms` timing knobs, `cols`/`rows`). A `cast` frame is mutually exclusive with
`input`/`continue`, and the cursor / magic-move machinery is skipped for it (the
terminal is an opaque animated block). This is the way to surround the terminal
with other frames, transitions, and overlays without touching the API.

### Programmatic: `castToTermFrames`

For full control — retiming individual frames, wrapping each in window-chrome
HTML, re-transitioning — use the frames-out half of the pipeline (re-exported
from the package root):

```ts
import { castToTermFrames, generateAnimatedSvg, launchChromium } from "domotion-svg";

const browser = await launchChromium();
const { frames, width, height, fontFaceCss } = await castToTermFrames(castText, browser, { theme: "dark", maxFrameMs: 800 });
// frames: AnimationFrame[] (svgContent + duration + `cut` transitions) — mutate freely:
//   • frames[i].duration = …            // retime a beat
//   • frames[i].transition = { type: "push-left", duration: 250 }
//   • frames[i].svgContent = wrapInChrome(frames[i].svgContent)
// Pass `fontFaceCss` so the embedded monospace font appears ONCE, not per frame
// (the frames carry no @font-face of their own — see "Embedded-font dedup").
const svg = generateAnimatedSvg({ width, height, frames, fontFaceCss });
```

`castToAnimatedSvg` is exactly `generateAnimatedSvg(await castToTermFrames(…))`.
When composing terminal frames into a LARGER animation that already owns the
font lifecycle (an `animate` config or your own `clearEmbeddedFonts()` /
`getEmbeddedFontFaceCss()` loop), pass `{ manageFonts: false }` — the frames then
share that builder and defer their font to the host's single top-level block.

### Embedded-font dedup

The default render mode bakes glyphs into one *accumulating* custom TTF, so
rendering each frame with its own `@font-face` would re-embed a growing base64
copy per frame (a 16-frame cast → 50+ `@font-face` blocks). Both
`castToAnimatedSvg` and a correctly-composed `castToTermFrames` emit the font
exactly once — the same trick `composeAnimateFrames` / `composeScrollSvg` use.
A regression guard lives in `src/terminal/font-dedup.e2e.test.ts`.
The lower-level primitives — `parseCast`, `TerminalEmulator`, `buildFrames`,
`gridToHtml`, `THEMES` — are re-exported too, so you can drive the emulator and
render grids to your own HTML (e.g. inside a window-chrome template) directly.

## Known limitations / roadmap

- **Frame cadence is pause-based.** Fast sub-`settleMs` animations (spinners) are
  sampled at pauses, not frame-for-frame — keeps SVGs small but drops the
  in-between spinner states. A future `--fps`/change-threshold mode could capture
  more.
- **Cursor/caret** is not yet drawn (the recorded echo of typed input shows the
  text; the blinking block cursor is omitted).
- **Alt-screen full-screen apps** (vim/htop) work at the buffer level but imply
  many near-identical frames; the tool is tuned for line-oriented CLIs first.
- **Live `node-pty` capture** (`domotion term -- <cmd>`) is the planned second
  front-end onto the same backend.
