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
| `--theme <name>` | `catppuccin` | `catppuccin` \| `dark` \| `github-light` |
| `--font-size <n>` | `14` | monospace font size (px) |
| `--cols <n>` / `--rows <n>` | from cast header | override the recorded grid size |
| `--settle-ms <n>` | `90` | output-pause (ms) that marks a frame boundary |
| `--min-frame-ms <n>` | `400` | minimum per-frame hold |
| `--max-frame-ms <n>` | `4000` | maximum per-frame hold (caps idle gaps) |
| `--tail-ms <n>` | `1500` | hold on the final screen |

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
