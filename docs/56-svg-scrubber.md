---
id: "requirements/svg-scrubber"
title: "56 — svg-scrubber (video-style playback for animated SVGs)"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: []
tickets: ["DM-1041", "DM-1042", "DM-1045", "DM-77YEZV", "DM-KJNT2X"]
code:
  [
    "scripts/build-scrubber-client.mjs",
    "src/cli/scrubber.ts",
    "src/scrubber/client.tsx",
    "src/scrubber/embed.ts",
    "src/scrubber/server.e2e.test.ts",
    "src/scrubber/server.ts",
    "src/scrubber/trim.test.ts",
    "src/scrubber/trim.ts",
    "tools/probe-scrubber-resize.ts",
    "tests/scrubber-natural-size.e2e.test.ts",
  ]
aliases: ["docs/56-svg-scrubber.md", "doc-56"]
---

# 56 — `svg-scrubber` (video-style playback for animated SVGs)

A command-line app that launches a local web UI for inspecting animated SVGs
the way a video editor inspects a clip: play / pause, change playback speed,
scrub the timeline by hand, mark an in/out range and loop it, export the current
frame as a PNG, and trim the range to a new self-contained animated SVG.

It complements the non-interactive `svg-to-video` CLI (doc 47): that bakes an
SVG to a finished video file; this is the interactive bench for _deciding_ what
you want before (or instead of) baking.

Studio embeds the scrubber through `src/scrubber/embed.ts`; the preview contract
is in [doc 250](250-studio-embedded-scrubber-preview.md).

## Usage

```sh
svg-scrubber [file.svg] [--port <n>] [--no-open]
```

- `file.svg` (optional) preloads an SVG into the UI; otherwise drag-drop or use
  the file picker in the browser. With nothing loaded, the stage shows a
  drop-target empty state whose **Choose SVG file** button (or a click anywhere
  on the drop area) opens the picker.
- `--port <n>` binds the local server to a fixed port (default: an OS-assigned
  free port on `127.0.0.1`).
- `--no-open` prints the URL instead of auto-opening the browser.

The process serves a local HTTP UI and stays alive until `Ctrl-C`.

## UI controls

The footer has two rows: row 1 is transport (play, speed, timeline, time); row 2
spreads three groups across the width (`space-between`) — **range** controls on
the left, **zoom / pan** controls in the middle, the **Export** button on the
right.

| Control      | Behavior                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play / pause | Space, or the play/pause button (a Lucide play/pause icon). Previous frame, play/pause and next frame form one grouped transport control. The scrubber thumb advances while playing.                                                                                                                                                            |
| Frame step   | `←` / `→` step one 30 fps frame; hold **Shift** to step 1 ms.                                                                                                                                                                                                                                                                                   |
| Speed        | 0.1x–4x select; affects playback only, not the underlying timeline.                                                                                                                                                                                                                                                                             |
| Scrub        | The timeline slider seeks the playhead and pauses. A shaded band + **in**/**out** ticks mark the selected range; the ticks are **draggable** along the track to set the in/out points.                                                                                                                                                          |
| Range        | **In** / **Out** set the in/out points to the playhead (or type seconds, or drag the ticks). **loop** loops playback over `[in, out]`. **Reset** restores the full loop.                                                                                                                                                                        |
| Zoom / pan   | Plain mouse-wheel pans the stage; **Ctrl/⌘ + wheel** (or trackpad pinch) zooms about the cursor; the **Zoom in** / **Zoom out** buttons step zoom; **Center** resets the pan. The zoom dropdown picks a fixed level (10/25/50/75/100/150/200/400 %) or **Fit** (contain) / **Fill** (cover); a preset re-centers. Loading an SVG starts at Fit. |
| Crop         | A **crop** toggle (lucide crop icon) overlays a draggable crop rectangle with 8 resize handles on the stage; the chosen region is baked into every export. Disabling resets the crop. See **doc 57**.                                                                                                                                           |
| Export       | A single **Export** button opens a popup with **Frame (PNG)**, **Trim (SVG)**, and **Range (MP4)** (each described below). Each honors the crop rect when crop mode is on (doc 57). Export failures appear in a nonblocking error banner; embedded previews also send an error event to Studio.                                                 |

The UI is built with **kerfjs** (signals + `mount` + `delegate`); the loaded SVG
sits in a `data-morph-skip` host so the reactive re-render never touches it,
while its animations, the zoom/pan transform, and the scrubber thumb position
are driven imperatively (kerf preserves a touched input's value, so the thumb is
set on the element directly). No emoji are used — labels are plain text and
icon-only buttons carry an `aria-label`.

The chrome comes from `@kerfjs/ui` ([doc 273](273-ui-conventions.md)). The
transport is a `ToolbarControlGroup`, icons are lucide icons rendered through
`LucideIcon`, the drop target is an `EmptyState`, and operation errors and
review save results are `StateBanner`s. The speed, zoom, crop-aspect and
category pickers stay native `<select>` elements. The kerf-ui CSS is folded into
`/client.js` at build time, so the page needs no network access.

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
   boundary stops synthesized at the window edges), and their duration set to the
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
  It binds to `127.0.0.1` and inherits the shared cross-site guard in
  `src/utils/local-server.ts`: a foreign `Host` (DNS rebinding) answers 403 for
  every method, and a POST must come from the scrubber's own origin (or carry
  no `Origin`, as curl and scripts do) and declare
  `content-type: application/json`, else 403 / 415. A web page the user has
  open therefore cannot feed SVG to the server's Chromium or write review
  tickets. See doc 240, "Cross-site request guard", for the full rule.
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

## Paused resize attribution

The native resize probe keeps the original SVG bytes and records snapshots
before and after each screenshot, with animation membership, play state/time,
SMIL time, font state, stage/host/SVG geometry, graphic screen matrices, source
hashes and loaded-node identity. Its controls include an equal-wait no-resize
arm, a nonanimated SVG, and an explicit diagnostic override that prevents the
loaded SVG from flex-shrinking. The override affects only an owned probe page;
it is not a production fix.

```sh
npm run build:text-engine
node --import tsx tools/probe-scrubber-resize.ts --output tests/output/scrubber-resize
# Bounded original/control replay:
node --import tsx tools/probe-scrubber-resize.ts --arms animated-resize,animated-natural-size
```

The default five-arm matrix has 20 screenshots. It uses the committed
`examples/animate/overlay-window/overlay-window.svg`; `--svg` selects another
source. The half-timeline seek is 2.50s for that five-second example; the static
control has a one-second fallback period and is sampled at 0.50s. Wide starts
in Fit, displayed as 220% at 1440×900, then transitions through 900×900 and
390×844 back to 1440×900. The probe never disables screenshot animations or
changes their current times while measuring.

On native macOS Chromium 147.0.7727.15, the original source returned with all
16 animations paused at 2500ms and unchanged DOM, timing, font-face, root-box
and animation-target geometry facts, while the SVG stage differed by 3613 pixels. Equal-wait no-resize was
pixel-identical. A static SVG also differed by 1213 stage pixels, excluding
animation pose drift as the common explanation. Finer text measurements do
change despite unchanged screen matrices: one label's native bounding height
moves from 37px to about 36.167px, with its top moving about 1.067px. The
natural-size control retains those text bounds as well as identical stage
pixels. Root-box agreement alone therefore misses the native text metric
change.

The source-owned layout defect is the SVG's default flex shrink inside the
stage-sized flex host: at 390px, the declared 640px SVG width becomes 390px
before the host applies Fit scale 0.609375. Its resulting viewport is only
237.65625×219.375 instead of 390×219.375. Default viewBox `meet` can retain
graphic aspect through additional letterboxing; the viewport measurements do
not prove stretched glyphs. A single-factor `flex-shrink:0` diagnostic restores
the natural layout size and eliminates all returned-wide stage differences
for both animated and static sources. Removing `will-change` alone does not.
The loader makes only the loaded root SVG a nonshrinking flex item alongside
its assigned natural width/height, including a source root with an inline shrink
value. Fit and
Fill apply only the host transform; manual zoom retains its selected scale,
pan remains in stage pixels, and crop keeps its existing integer-client-size
coordinate contract. Root-only setup leaves authored nested SVG flex
layouts unchanged. Native landscape/square/portrait geometry, nested-flex,
pan/crop and paused-source roundtrip cases protect this boundary in
`tests/scrubber-natural-size.e2e.test.ts`.
Small footer-only differences remain separately unclassified; stage identity
must not be reported as whole-page pixel identity.

The exact native Chromium source at
[`6b5a1b80`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/layout/svg/layout_svg_text.cc#218)
updates SVG text metrics on viewport/scale changes.
[`LayoutSVGInlineText::ComputeNewScaledFontForStyle`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/layout/svg/layout_svg_inline_text.cc#182)
constructs a scale-dependent font, using the
[transform-to-layer scale calculation](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/layout/svg/svg_layout_support.cc#367).
That explains why unchanged authored font/geometry values do not establish
identical internal raster state. The probe does not expose Blink's private
scaled-font/cache values, so it does not attribute the residue to a particular
upstream cache or compositor defect. No animation seeking change is supported
by these controls.
