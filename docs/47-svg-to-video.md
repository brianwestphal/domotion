# Domotion: animated SVG → video export

Requirements for a CLI that renders an animated SVG to a video file (h264/mp4
by default), with precise frame-rate control and optional audio / captions.
Origin: DM-873.

> **Status: DRAFT — pending maintainer decisions.** The open decisions in
> [Open decisions](#open-decisions) are stated with a recommended default; the
> design below assumes those defaults. Confirm or override before
> implementation begins.

## Goal

Turn an animated SVG into a video:

```bash
domotion video demo.svg -o demo.mp4 --width 1280 --fps 30
```

Primary target: SVGs produced by `domotion animate` (CSS-`@keyframes`-driven).
Secondary, best-effort: animated SVGs more generally. The output must stay
**pixel-faithful to Chromium** — which falls out naturally, because we render
the frames back through the same Chromium that produced the SVG.

## Why this is tractable (and where it isn't)

The hard part of SVG→video is sampling the animation at exact times rather than
racing the wall clock. Domotion's output makes this clean:

- A `domotion animate` SVG is **one CSS `@keyframes` loop** of a known period
  (`animator.ts` emits `animation: … <totalSec>s infinite` and exposes the
  scene duration as the `--scene-dur` CSS custom property). So the natural
  video length is exactly one loop, and it is discoverable.
- CSS animations are reachable through the **Web Animations API**:
  `document.getAnimations({ subtree: true })` returns every running animation.
  We can `pause()` them all and set `animation.currentTime = t` per frame, force
  a style/layout flush, and screenshot. This is **frame-accurate and
  independent of the wall clock** — the core mechanism. (The capture pipeline
  already uses `getAnimations({ subtree: true })`, so the API is known-good in
  this Chromium.)

What is *not* free:

- **SMIL** (`<animate>`/`<animateTransform>`) animations are not controlled by
  WAAPI. They need `svgRoot.pauseAnimations()` + `svgRoot.setCurrentTime(t)`.
  Domotion never emits SMIL, but general SVGs might. Modest extra path.
- **JS-driven (`requestAnimationFrame`) animation** can't be stepped via either
  API. It needs Playwright's `page.clock` virtual-time tick-and-render, which
  is fragile and engine-dependent. Treated as out of scope / best-effort.

## Pipeline

1. **Resolve ffmpeg.** Probe `ffmpeg -version` on `PATH`. If absent, fail fast
   with per-platform install guidance (see [ffmpeg](#ffmpeg-dependency)). Never
   silently produce nothing.
2. **Load the SVG in Chromium** (Playwright, reusing `launchChromium`). Inline
   the SVG into a minimal HTML wrapper at its intrinsic size so the document's
   animations are script-reachable and the viewport is controlled.
3. **Determine intrinsic size** from `viewBox` / `width`/`height`, then compute
   the output size: `--width`/`--height` *contain* the natural aspect ratio
   (fit inside the box, never distort). Render at an integer device scale for
   crisp frames; pad to even dimensions (h264 `yuv420p` requires even W/H).
4. **Determine duration & frame count.** Duration = explicit `--duration`, else
   one full timeline cycle computed from `getAnimations()` end times (for
   domotion SVGs that is the `--scene-dur` loop). `N = round(duration * fps)`.
5. **Pre-flight disk-space check.** Estimate footprint and compare against free
   space on the output (and temp, if `--keep-frames`) volume via `fs.statfs`.
   Abort with a clear message if short. See [Disk space](#disk-space).
6. **Render frames.** Pause all animations; for `i` in `[0, N)` set
   `currentTime = i * 1000/fps` ms (+ `setCurrentTime` for SMIL), flush,
   screenshot PNG. **Pipe frames to ffmpeg stdin** (`image2pipe`) by default so
   no intermediate frame files touch disk; `--keep-frames <dir>` switches to
   writing a numbered PNG sequence for debugging.
7. **Encode + mux** with ffmpeg: video codec/container from `--format`/
   `--container` (default `libx264` / `mp4`, `-pix_fmt yuv420p` for
   compatibility); then mux optional audio and captions (below).

## CLI options

| Option | Default | Meaning |
| --- | --- | --- |
| `-o, --output <path>` | required | Output video path. Extension may imply `--container`. |
| `--width <px>` / `--height <px>` | intrinsic | Contain within; preserve aspect ratio. Either or both. |
| `--fps <n>` | `30` | Target frame rate; drives the sampling interval. |
| `--duration <s>` | one cycle | Override the rendered length (needed for indeterminate/infinite general SVGs). |
| `--format <codec>` | `h264` | Video codec (`h264`/`libx264`, `vp9`, `hevc`, …). |
| `--container <ext>` | `mp4` | Container (`mp4`, `webm`, `mov`, …). Validated against codec. |
| `--music <path>` | — | Background music; looped+trimmed to video length, optional fade-out. |
| `--audio <path>` | — | Foreground audio; mixed over music (`amix`), optional start offset. |
| `--captions <path>` | — | Caption file (`.srt`/`.vtt`); soft-muxed (mp4→`mov_text`) or burned-in via `--burn-captions`. |
| `--scale <n>` | `2` | Device scale factor for capture crispness. |
| `--keep-frames <dir>` | — | Write the PNG sequence to disk instead of piping (debug). |
| `--quiet` | off | Suppress per-phase progress on stderr. |

## ffmpeg dependency

ffmpeg is **not** bundled (binary size + codec licensing). It is required at
runtime, resolved from `PATH`. When missing, print install guidance:

- **macOS**: `brew install ffmpeg`
- **Debian/Ubuntu**: `sudo apt install ffmpeg`
- **Fedora**: `sudo dnf install ffmpeg` (RPM Fusion)
- **Windows**: `winget install ffmpeg` / `choco install ffmpeg`, or a
  [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) / BtbN static build on `PATH`.

Codec notes to surface: h264 (`libx264`) + AAC audio is the portable default;
`yuv420p` is needed for QuickTime/Safari/most players; VP9/webm needs `libvpx`;
HEVC needs `libx265`. The tool detects whether the resolved ffmpeg has the
requested encoder and errors early if not.

## Disk space

Even though piping avoids a frame sequence on disk, the user asked for a
pre-flight check, and `--keep-frames` does write frames. Estimate:

- **Pipe mode**: output-file estimate (`≈ bitrate × duration` with headroom) +
  a small constant. Abort if free space on the output volume is below it.
- **`--keep-frames` mode**: `N × (typical PNG bytes at the output resolution)` —
  conservatively from a single probe screenshot's size — on the temp/frames
  volume, plus the output estimate.

`fs.statfs(path)` gives free bytes per volume. The message names the volume,
the estimate, and what's free.

## Audio / caption muxing (defaults)

- **Background music** longer than the video: trim with `-shortest`; shorter:
  loop (`-stream_loop -1`) then trim; optional `afade` out at the tail.
- **Foreground audio**: `amix` over music (or replace if no music); optional
  `--audio-offset`.
- **Captions**: default soft-mux (`-c:s mov_text` for mp4, native for webm);
  `--burn-captions` renders them into the picture via the `subtitles=` filter.

## Out of scope (v1)

- Arbitrary JS/`requestAnimationFrame`-driven SVG animation (needs clock
  virtualization; best-effort only).
- GIF/APNG output (could be a later `--format gif` via a palette pass).
- Per-frame audio sync beyond music/voiceover/captions.

## Verification

- A fixture SVG from `domotion animate` rendered at a known fps yields exactly
  `round(duration*fps)` frames, and sampled frames match per-time screenshots
  taken by the existing capture path (frame-accuracy assertion).
- ffmpeg-missing path prints guidance and exits non-zero without writing a
  partial file.
- Disk-space pre-flight aborts cleanly when free space is below the estimate.

## Open decisions

These need a maintainer call (see the ticket's FEEDBACK note). Defaults assumed
above:

1. **Generality scope** — v1 = CSS-`@keyframes` (domotion) **+** SMIL
   `setCurrentTime`; JS-`rAF` animation out of scope / best-effort. *(assumed)*
2. **Infinite/indeterminate duration** — when no finite cycle is derivable,
   require `--duration`; for domotion SVGs default to one `--scene-dur` loop.
   *(assumed)*
3. **ffmpeg sourcing** — require system ffmpeg + install guidance; do **not**
   bundle. Optionally honor an `ffmpeg-static` install if present. *(assumed)*
4. **Frame transport** — pipe to ffmpeg by default; `--keep-frames` for the
   on-disk debug sequence. *(assumed)*
5. **Subcommand name** — `domotion video`. Alternatives: `export` / `render` /
   `record`. *(assumed `video`)*
