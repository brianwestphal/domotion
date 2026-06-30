# 56 — `svg-scrubber` (video-style playback for animated SVGs)

A command-line app that launches a local web UI for inspecting animated SVGs
the way a video editor inspects a clip: play / pause, change playback speed,
scrub the timeline by hand, mark an in/out range and loop it, export the current
frame as a PNG, and trim the range to a new self-contained animated SVG.

It complements the non-interactive `svg-to-video` CLI (doc 47): that bakes an
SVG to a finished video file; this is the interactive bench for *deciding* what
you want before (or instead of) baking.

## Usage

```sh
svg-scrubber [file.svg] [--port <n>] [--no-open]
```

- `file.svg` (optional) preloads an SVG into the UI; otherwise drag-drop or use
  the file picker in the browser.
- `--port <n>` binds the local server to a fixed port (default: an OS-assigned
  free port on `127.0.0.1`).
- `--no-open` prints the URL instead of auto-opening the browser.

The process serves a local HTTP UI and stays alive until `Ctrl-C`.

## UI controls

The footer has two rows: row 1 is transport (play, speed, timeline, time); row 2
spreads three groups across the width (`space-between`) — **range** controls on
the left, **zoom / pan** controls in the middle, the **Export** button on the
right.

| Control | Behavior |
| --- | --- |
| Play / pause | Space, or the play/pause button (a Lucide play/pause icon). The scrubber thumb advances while playing. |
| Frame step | `←` / `→` step one 30 fps frame; hold **Shift** to step 1 ms. |
| Speed | 0.1x–4x select; affects playback only, not the underlying timeline. |
| Scrub | The timeline slider seeks the playhead and pauses. A shaded band + **in**/**out** ticks mark the selected range; the ticks are **draggable** along the track to set the in/out points. |
| Range | **In** / **Out** set the in/out points to the playhead (or type seconds, or drag the ticks). **loop** loops playback over `[in, out]`. **Reset** restores the full loop. |
| Zoom / pan | Plain mouse-wheel pans the stage; **Ctrl/⌘ + wheel** (or trackpad pinch) zooms about the cursor; the **+** / **-** buttons step zoom; **Center** resets the pan. The zoom dropdown picks a fixed level (10/25/50/75/100/150/200/400 %) or **Fit** (contain) / **Fill** (cover); a preset re-centers. Loading an SVG starts at Fit. |
| Crop | A **crop** toggle (lucide crop icon) overlays a draggable crop rectangle with 8 resize handles on the stage; the chosen region is baked into every export. Disabling resets the crop. See **doc 57**. |
| Export | A single **Export** button opens a popup with **Frame (PNG)**, **Trim (SVG)**, and **Range (MP4)** (each described below). Each honors the crop rect when crop mode is on (doc 57). Export errors surface as a browser alert; there is no persistent status line. |

The UI is built with **kerfjs** (signals + `mount` + `delegate`); the loaded SVG
sits in a `data-morph-skip` host so the reactive re-render never touches it,
while its animations, the zoom/pan transform, and the scrubber thumb position
are driven imperatively (kerf preserves a touched input's value, so the thumb is
set on the element directly). No emoji are used — labels are plain text and the
play/pause control is a Lucide SVG icon.

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

## Range → MP4 video (DM-1042)

`Range → MP4` renders the selected `[in, out]` window to an **H.264 MP4 at a
fixed 30 fps**, server-side. It POSTs the SVG markup + window to
`/export-range-video`; the server samples frame `i` at `in + i/30s`
(`seekTo` + `screenshot`), pipes the PNG stream to ffmpeg (`buildFfmpegArgs`,
the same encoder `svg-to-video` uses), and streams the resulting MP4 back for
download. Unlike `Trim → SVG`, this raster export **isolates exactly the window**
(frame count = `round((out − in)/1000 × 30)`), so it's the way to get a clip of
just the selected range today.

**ffmpeg is required** (a hard runtime dependency, not bundled — same as
`svg-to-video`); if it's missing the export returns an error with install
guidance rather than failing silently. Point the app at a specific binary with
the `FFMPEG_PATH` env var. Output dimensions are the SVG's intrinsic size,
rounded to even values (H.264 `yuv420p` needs even width/height).

## Trim → new animated SVG

`Trim → SVG` produces a **new self-contained animated SVG that loops exactly the
selected `[in, out]` window** — for both CSS and SMIL. `src/scrubber/trim.ts`
(pure + unit-tested) classifies each animation and uses one of two strategies:

1. **Period-spanning animations** (a looping animation whose duration ≈ the loop
   period — the master cursor / content cycle) are **window-sliced**: their
   `@keyframes` (CSS) or `values`/`keyTimes` (SMIL) are sliced to
   `[f0, f1] = [in/period, out/period]` (interior stops remapped to `[0%, 100%]`,
   boundary stops synthesised at the window edges), and their duration set to the
   window length. So the output loops the window. Boundary interpolation is
   linear for continuous channels (opacity, transform, multi-component SMIL
   values) and **snaps** discrete ones (`step-end` `visibility`, SMIL
   `calcMode="discrete"`).
2. **Scheduled animations** (a short `<animate begin="1.85s" dur="0.5s">` ripple,
   or any non-period CSS animation):
   - CSS: re-based by a negative time shift — `animation-delay: -t0` +
     `animation-fill-mode: both` (DM-1045) — so it fires at the right offset.
   - SMIL: re-timed to RE-FIRE every loop. A ripple landing inside the window
     gets a self-referencing syncbase `begin="Δs; id.begin+winS"` /
     `end="winS; id.end+winS"` (a 2-entry loop, no long list) + `fill="remove"`,
     so each instance fires at its window offset and is clipped at the boundary;
     one that fires only after the window becomes `begin="indefinite"`.

Re-basing alone (DM-1045) already reproduced the window CONTENT; the slicing
(DM-1041) is what makes it LOOP the window. Verified with an A/B harness against
`cart-htmx.svg`: trimmed @ k matches original @ in+k (within-window 0% diff) AND
trimmed @ (win+k) matches original @ in+k (the loop is pixel-clean by the 2nd
iteration).

### Known limitations (fall back to plain re-basing, no slice)

- A CSS rule mixing period-spanning + scheduled animations in **one** shorthand.
- SMIL `calcMode="paced"` / `"spline"` (extra timing data not sliced).
- Ranges spanning **multiple** periods (the window is taken within one period).

## Scope (this version)

Per the requested design, exports are: **current frame → PNG**, **range → MP4**
(H.264, 30 fps), and **range → windowed-loop animated SVG** — all rendered
**server-side** through Chromium. Animated-GIF / WebM range export, batch
frame-sequence (ZIP) export, and an in-browser (instant, canvas) export path
were deliberately not built (the user selected MP4 only); they're tracked as a
follow-up and reuse the same `svg-to-video` / per-frame machinery.

## Code map

- `src/cli/scrubber.ts` — the `svg-scrubber` bin (arg parsing, browser
  launch, open, lifecycle).
- `src/scrubber/server.ts` — HTTP server: static shell + client bundle;
  `/timing`, `/trim`, `/export-frame`, `/export-range-video` endpoints; one
  reused Chromium page (Chromium work is serialized — one export at a time).
- `src/scrubber/client.tsx` — the kerfjs page-side UI (bundled to `/client.js` by
  `scripts/build-scrubber-client.mjs`, baked into `client.bundle.generated.ts`).
- `src/scrubber/trim.ts` — the pure window-slice + re-base transform.
- Tests: `src/scrubber/trim.test.ts` (transform), `src/scrubber/server.e2e.test.ts`
  (endpoints end-to-end through Chromium).

## Review mode (`--review`)

`svg-scrubber --review` adds an issue-reporting panel (title + note + a
drag-to-draw region, capturing the current frame time + selected range) that
writes importable `.ticket` JSON files to the launch directory — the
animated-SVG analogue of `svg-review`. See
[82-svg-scrubber-review-mode.md](82-svg-scrubber-review-mode.md). Endpoint:
`POST /ticket` (review-mode only); the `.ticket` schema + the pure,
unit-tested `buildTicketFile` builder live in `src/scrubber/server.ts`.
