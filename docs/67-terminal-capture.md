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
| `--mode <m>` | `incremental` | `incremental` (render each line once, reveal on its timeline) \| `full` (a complete screen frame per settle-point) |
| `--cursor <s>` | `block` | caret shape: `block` \| `bar` \| `underline` \| `none` (incremental mode) |
| `--cursor-color <c>` | theme fg | caret color |
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
   (`width`/`height`) then `[time, "o", data]` output events plus
   `[time, "r", "<cols>x<rows>"]` resize events (DM-1246, see "Mid-session
   resize" below). Input (`"i"`) / marker (`"m"`) events and a truncated trailing
   line are tolerated.
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
4. **Compose** — two modes (`--mode`, default `incremental`):
   - **`incremental`** (`incremental.ts`, the default) — a terminal is a POOL of
     lines that scroll, so this renders each LINE ONCE rather than each screen.
     `trackLines` threads every logical line through the frames by identity:
     `detectScroll` finds the per-transition scroll shift, lines that survive get
     a `(time, row)` waypoint when they move, and a line that's cleared /
     overwritten / scrolled off ends. Each tracked line is emitted once (an
     absolutely-positioned element tagged `data-domotion-anim` → `class="anim-<id>"`)
     and driven by up to two animations on that element: an OPACITY track
     (`step-end` — hard cut on at birth, off when it leaves) and a TRANSFORM track
     (`linear` — `translateY` glides between waypoint rows over a short window, so
     a scroll slides every line up together). One captured tree, far smaller, and
     a true line-level animation (a 16-frame cast: 142 KB / "Cloning into" ×22 →
     45 KB / ×1).
   - **`full`** (`castToTermFrames` + `generateAnimatedSvg`) — each settle-point
     renders as a complete screen frame, stitched with hard `cut` transitions.
     Re-emits unchanged lines per frame, but is robust to anything the emulator
     does. Use it for sessions that don't fit the line-pool model well.

   Both size the canvas from a full `cols×rows` reference block, so the two modes
   lay out identically.

   **Cursor** (incremental mode, `--cursor`, default `block`): the emulator
   captures `buffer.active.cursorX/Y` plus DECTCEM visibility (`?25h`/`?25l`,
   tracked off the byte stream) at each settle-point. `buildCursor` emits a
   blinking caret rect whose position GLIDES (linear) between those cells — so as
   a typed line grows the caret slides along it, reading as typed — with a
   standard ~1.06 s blink. Visibility is gated to INPUT lines so the caret only
   shows where a user types, never trailing program output: `detectInputFrames`
   infers the shell prompt as the common prefix of every cursor-row line that
   gets typed onto (extended at the next settle-point), and a frame counts as
   input only when the cursor's line starts with that prompt (or is itself
   growing). Opacities compose through nesting (input-visibility × blink on a
   transform-positioned group). Hand-drawn as a `<rect>` in the SVG (not captured).

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

## Mid-session resize (DM-1246)

A recording that changes terminal size mid-session emits asciinema `"r"` events
(`[time, "r", "<cols>x<rows>"]`). The full-frame path honors them:
`buildFrames` applies each resize to the emulator (`TerminalEmulator.resize`,
which reflows the xterm buffer) when the replay clock reaches its timestamp, so
every snapshot at/after it reflects the new geometry — including a closing frame
when a resize lands after the last output. The canvas is sized to the **largest**
grid across the initial size + all resizes, so a grid that grows still fits;
a smaller post-resize grid renders top-left with the theme background filling the
rest (matching how a terminal anchors content). Passing `--cols`/`--rows` (or
`opts.cols`/`opts.rows`) pins the grid to that fixed size and **ignores** resizes.

The **`incremental`** compose mode honors resizes too (DM-1249): it passes the
resizes to `buildFrames`, sizes the canvas to the largest grid, and `trackLines`
treats each grid-height change as a **hard boundary** — the line pool resets
(every active line ends, a fresh pool starts) since content reflows across a
resize, so there's no meaningful line continuity through it. Within each
constant-size segment the usual line-identity threading / scroll-glide applies.

## Known limitations / roadmap

- **Frame cadence is pause-based.** Fast sub-`settleMs` animations (spinners) are
  sampled at pauses, not frame-for-frame — keeps SVGs small but drops the
  in-between spinner states. A future `--fps`/change-threshold mode could capture
  more.
- **Incremental line tracking is content-based.** `detectScroll` + identity
  matching handle append / overwrite / line-oriented scroll well; an alt-screen
  full-screen redraw (vim/htop) that rewrites many rows at once produces more
  tracked lines (each row-state once) — still correct, just less of a win.
  `--mode full` is the robust fallback for those.
- **Nested cast in an `animate` config** loops on the document timeline (like a
  `scroll` frame), so it isn't re-synced to when its outer frame appears — put the
  cast frame first or size the scene so the loop lines up.
- **Live `node-pty` capture** (`domotion term -- <cmd>`) is the second front-end
  onto this same backend — shipped in DM-1226, see doc
  [68](./68-live-terminal-capture.md). It runs a command live in a pty and feeds
  the captured `[time,"o",data]` stream straight into `buildFrames` /
  `castToAnimatedSvg`; only stage 1 (the source) differs.
