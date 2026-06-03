# 56 — `animated-svg-scrubber` (video-style playback for animated SVGs)

A command-line app that launches a local web UI for inspecting animated SVGs
the way a video editor inspects a clip: play / pause, change playback speed,
scrub the timeline by hand, mark an in/out range and loop it, export the current
frame as a PNG, and trim the range to a new self-contained animated SVG.

It complements the non-interactive `svg-to-video` CLI (doc 47): that bakes an
SVG to a finished video file; this is the interactive bench for *deciding* what
you want before (or instead of) baking.

## Usage

```sh
animated-svg-scrubber [file.svg] [--port <n>] [--no-open]
```

- `file.svg` (optional) preloads an SVG into the UI; otherwise drag-drop or use
  the file picker in the browser.
- `--port <n>` binds the local server to a fixed port (default: an OS-assigned
  free port on `127.0.0.1`).
- `--no-open` prints the URL instead of auto-opening the browser.

The process serves a local HTTP UI and stays alive until `Ctrl-C`.

## UI controls

| Control | Behavior |
| --- | --- |
| Play / pause | Space, or the ▶/❚❚ button. |
| Frame step | `←` / `→` step one 30 fps frame; hold **Shift** to step 1 ms. |
| Speed | 0.1×–4× select; affects playback only, not the underlying timeline. |
| Scrub | The timeline slider seeks the playhead and pauses. |
| Range | **[ In** / **Out ]** set the in/out points to the playhead, or type seconds directly. **loop** loops playback over `[in, out]`. **Reset range** restores the full loop. |
| Export frame (PNG) | Renders the frame at the playhead **server-side** (Chromium) and downloads it. |
| Trim → SVG | Exports a new animated SVG re-timed to `[in, out]` (see below). |

## How playback works

The playhead is driven **manually**, not via `Animation.play()`. Each rendered
frame the client does, for every animation inside the loaded SVG,
`anim.pause(); anim.currentTime = playhead`. That is the exact seek the
exporters use, so the on-screen state, an exported frame, and a trimmed SVG all
agree at any given time. It also makes speed, manual scrubbing, and sub-range
looping fall out for free (the client owns the clock).

Timeline length is the SVG's single-loop period, resolved **server-side** by the
same `resolveDurationMs` the video exporter uses (the max finite end time, or
the LCM of infinite-loop periods) so the scrubber's timeline matches the
exporter's. SMIL (`<animate>`) timelines are driven via `svg.setCurrentTime`.

## Frame export (server-side, pixel-faithful)

`Export frame` POSTs the SVG markup + playhead time to `/export-frame`; the
server loads the SVG in Playwright Chromium, pauses + seeks every animation to
that time, and screenshots it (`src/cli/svg-to-video-core.ts::seekTo` /
`screenshot`, shared with `svg-to-video`). This is why a grabbed frame is
identical to the corresponding video frame and to Chromium's own paint —
rather than a canvas rasterization that can diverge on embedded raster /
`foreignObject` content.

## Trim → new animated SVG

`Trim → SVG` produces a **new self-contained animated SVG** that plays only the
selected `[in, out]` window, looping. The transform (`src/scrubber/trim.ts`,
pure + unit-tested) re-times the CSS animation rather than re-recording it:

1. Each `@keyframes` block is windowed to `[f0, f1] = [in/period, out/period]`:
   interior stops in that range are kept and their percentages remapped to
   `[0%, 100%]`, and boundary stops at `0%` / `100%` are synthesised by
   interpolating the keyframe state at `f0` / `f1`.
2. Each animation's duration (`animation-duration`, or the first `<time>` in the
   `animation` shorthand) is rewritten to the window length; delays are zeroed.

Because the keyframe shape is preserved, per-stop easing inside the window is
unchanged and the output stays a tiny vector file.

### Known limitations (tracked as follow-ups)

- **Boundary easing**: the two synthesised boundary stops are interpolated
  **linearly**; a non-linear `animation-timing-function` is therefore
  approximated at exactly the in/out instants (interior stops keep their own
  easing). Full timing-function-aware boundary interpolation is a follow-up.
- **Single period**: the window is taken within one loop period; selecting a
  range that spans multiple periods clamps to the first period.
- **Property coverage**: boundary interpolation handles the properties Domotion
  emits (opacity, `transform` translate/scale/rotate) plus generic numeric / px
  values; any value whose numeric skeleton differs between the bracketing stops
  **snaps** to the earlier stop (visually safe, never throws).

## Scope (this version)

Per the requested design: range export targets a **new animated SVG** (not
video/GIF/PNG-sequence — use `svg-to-video` for those), frame export is the
**current frame** only, and all rendering-fidelity-sensitive export runs
**server-side** through Chromium. Batch frame export, video/GIF range export,
and in-browser (instant) export are deliberately out of scope here and tracked
separately.

## Code map

- `src/cli/scrubber.ts` — the `animated-svg-scrubber` bin (arg parsing, browser
  launch, open, lifecycle).
- `src/scrubber/server.ts` — HTTP server: static shell + client bundle;
  `/timing`, `/trim`, `/export-frame` endpoints; one reused Chromium page.
- `src/scrubber/client.ts` — the page-side UI (bundled to `/client.js` by
  `scripts/build-scrubber-client.mjs`, baked into `client.bundle.generated.ts`).
- `src/scrubber/trim.ts` — the pure keyframe re-timing transform.
- Tests: `src/scrubber/trim.test.ts` (transform), `src/scrubber/server.e2e.test.ts`
  (endpoints end-to-end through Chromium).
