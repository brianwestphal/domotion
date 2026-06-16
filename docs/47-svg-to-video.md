# Domotion: animated SVG → video export (`svg-to-video`)

The `svg-to-video` CLI renders an animated SVG to a video file (h264/mp4 by
default), with precise frame-rate control and optional audio / captions. It is a
**standalone program** — its own `bin` (`svg-to-video`), a sibling of
`domotion`, in the same npm package. Origin: DM-873.

> **Status: implemented (DM-873).** The decisions in
> [Decisions](#decisions-resolved) were confirmed by the maintainer; this doc
> describes the shipped behavior. Source: `src/cli/svg-to-video.ts` (bin) +
> `src/cli/svg-to-video-core.ts` (converter + pure helpers).

## Goal

Turn an animated SVG into a video:

```bash
svg-to-video demo.svg -o demo.mp4 --width 1280 --fps 30
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
   derived from `getAnimations()` timings: the max finite `endTime`, and for
   infinite (looping) animations the LCM of their iteration periods — one full
   loop cycle. For a `domotion animate` SVG every animation shares one period, so
   that LCM is just the loop length. Incommensurate infinite periods (LCM over a
   ~10-min cap) or a SMIL-only SVG (no WAAPI timings) require an explicit
   `--duration`. `N = round(duration * fps)`.
5. **Pre-flight disk-space check.** Estimate footprint and compare against free
   space on the output (and temp, if `--keep-frames`) volume via `fs.statfs`.
   Abort with a clear message if short. See [Disk space](#disk-space).
6. **Render frames.** Pause all animations; for `i` in `[0, N)` set
   `currentTime` to the **center** of the frame's interval — `(i + 0.5) * 1000/fps`
   ms (`frameSampleTimeMs`, + `setCurrentTime` for SMIL), flush, screenshot PNG.
   Sampling the interval center rather than its start (`i/fps`) matters for
   flipbook-style SVGs: a start-aligned sample lands exactly on a keyframe
   boundary, where the animator's per-frame visibility keyframes leave the
   outgoing and incoming frame BOTH at `opacity:1` for that sub-frame instant, so
   the screenshot ghosts two frames together — a cross-fade the SVG itself never
   paints (DM-1144). The midpoint lands inside one frame's solid window. **Pipe frames to ffmpeg stdin** (`image2pipe`) by default so
   no intermediate frame files touch disk; `--keep-frames <dir>` switches to
   writing a numbered PNG sequence for debugging. For a transparent background on
   an alpha-capable format (below) the page background is left transparent and
   the screenshot uses `omitBackground: true`, so the PNG frames carry real alpha.
7. **Encode + mux** with ffmpeg: video codec/container/pix_fmt from `--format`/
   `--container` (default `libx264` / `mp4`, `-pix_fmt yuv420p` for
   compatibility; an alpha pix_fmt for a transparent output, below); then mux
   optional audio and captions (below).

## CLI options

| Option | Default | Meaning |
| --- | --- | --- |
| `-o, --output <path>` | required | Output video path. |
| `--width <px>` / `--height <px>` | intrinsic | Contain within; preserve aspect ratio. Either or both. |
| `--fps <n>` | `30` | Target frame rate; drives the sampling interval. |
| `--duration <s>` | one cycle | Override the rendered length (required for SMIL-only or indeterminate general SVGs). |
| `--format <codec>` | `h264` | Output format: video codecs `h264`, `hevc`, `vp9`, `vp8`, `av1`, `prores` (ProRes 4444, `.mov`), or the animated images `gif` / `apng` (no audio track). |
| `--container <ext>` | per format | Container override (default: h264/hevc/av1 → `mp4`, vp9/vp8 → `webm`, prores → `mov`). Ignored for `gif`/`apng` (the format *is* the container). |
| `--scale <n>` | `2` | Supersample render factor; ffmpeg downscales (lanczos) to the target size for crisper output. |
| `--background <css>` | `#ffffff` | Page background behind the SVG. `transparent` / `none` / a zero-alpha color requests a transparent output — see [Transparent backgrounds / alpha](#transparent-backgrounds--alpha). |
| `--color-range <r>` | `tv` | Color range for the yuv420p formats (h264/hevc/av1): `tv` (limited, most compatible) or `pc` (full, more dynamic range). See [Color fidelity](#color-fidelity-dm-1146). |
| `--music <path>` | — | Background music; looped (`-stream_loop -1`) + trimmed (`-shortest`) to the video length. |
| `--audio <path>` | — | Foreground audio; mixed over music via `amix` when both are given. |
| `--audio-offset <s>` | — | Delay the foreground audio by this many seconds (`-itsoffset`). |
| `--captions <path>` | — | Caption file (`.srt`/`.vtt`); soft-muxed (mp4→`mov_text`, webm→`webvtt`) or burned-in via `--burn-captions`. |
| `--burn-captions` | off | Render captions into the picture (`subtitles=` filter) instead of muxing a track. |
| `--keep-frames <dir>` | — | Also write the PNG sequence to disk (debug). |
| `--ffmpeg <path>` | `$FFMPEG_PATH` or `ffmpeg` | ffmpeg binary to shell out to. |
| `--quiet` | off | Suppress per-phase progress on stderr. |

## ffmpeg dependency

ffmpeg is **not** bundled (binary size + codec licensing). It is required at
runtime, resolved from `PATH`. When missing, print install guidance:

- **macOS**: `brew install ffmpeg`
- **Debian/Ubuntu**: `sudo apt install ffmpeg`
- **Fedora**: `sudo dnf install ffmpeg` (RPM Fusion)
- **Windows**: `winget install ffmpeg` / `choco install ffmpeg`, or a
  [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) / BtbN static build on `PATH`.

Codec notes: h264 (`libx264`) + AAC audio is the portable default; `yuv420p` is
needed for QuickTime/Safari/most players; VP9/webm uses `libvpx-vp9` + Opus audio
+ WebVTT subs; HEVC needs `libx265`. The `--ffmpeg <path>` flag (or `FFMPEG_PATH`
env var) points at a specific binary. ffmpeg is resolved up front so the tool
fails with guidance *before* launching a browser. (Per the maintainer decision,
there is no `ffmpeg-static` auto-fallback — system ffmpeg is a hard requirement.)

## Disk space

Even though piping avoids a frame sequence on disk, the user asked for a
pre-flight check, and `--keep-frames` does write frames. Estimate:

- **Pipe mode**: output-file estimate (`≈ bitrate × duration` with headroom) +
  a small constant. Abort if free space on the output volume is below it.
- **`--keep-frames` mode**: `N × (typical PNG bytes at the output resolution)` —
  conservatively from a single probe screenshot's size — on the temp/frames
  volume, plus the output estimate.

`statfsSync(path)` gives free bytes per volume; the estimate is sized from the
real first rendered frame's byte size. The message names the volume, the
estimate, and what's free.

## Audio / caption muxing

- **Background music**: looped (`-stream_loop -1`) and trimmed to the video
  length (`-shortest`).
- **Foreground audio**: when given alongside music, the two are combined with
  `amix=inputs=2:duration=longest`; alone, it is mapped directly. `--audio-offset`
  delays it via `-itsoffset`.
- **Captions**: default soft-mux (`-c:s mov_text` for mp4, `webvtt` for webm);
  `--burn-captions` renders them into the picture via the `subtitles=` filter.
- Audio codec follows the container: AAC for mp4/mov, Opus for webm.

## Animated-image output (GIF / APNG, DM-885)

`--format gif` and `--format apng` emit an animated image instead of a video.
They share the same Playwright frame-stepping pipeline; only the ffmpeg argv
differs (`buildFfmpegArgs` branches on the container):

- **GIF** uses a single-invocation palette flow — `split` the filtered frame
  stream, `palettegen` an optimal 256-color palette from one branch, and
  `paletteuse` (Bayer dither) it on the other. A naive single-pass GIF is
  heavily banded; the palette pass is what makes it look acceptable.
- **APNG** encodes through the `apng` encoder with `-plays 0` (loop) and an
  `rgba` pixel format.
- **No audio / soft captions.** Neither format carries an audio track or
  soft-muxed subtitles, so `--music` / `--audio` / soft `--captions` are
  ignored with a note. `--burn-captions` still works (it's a video filter).
- **`--container` is ignored** — the format is its own container.
- **GIF frame-rate caveat.** GIF delays are stored in centiseconds, so the
  effective rate is `round(100/fps)/100`. fps values that divide 100
  (`50`/`25`/`20`/`10`) are exact; others (e.g. `30`) drift slightly. The CLI
  warns on a non-dividing fps rather than silently snapping it.

mp4/webm remain the primary path; gif/apng are for inline-loop demos and chat
embeds where a video element isn't convenient.

## Color fidelity (DM-1146)

The full-range sRGB frame screenshots are encoded to the format's pixel format. For
the **yuv420p** video formats (h264 / hevc / av1) the conversion is now explicit
and TAGGED — `scale=…:in_range=full:out_range=tv:out_color_matrix=bt709` plus the
matching `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`
stream tags — so players decode with the same assumptions the encode used and the
colors don't drift (untagged streams were the worst case). `--color-range pc` keeps
full range (more dynamic range, slightly less universal playback).

This fixes the *systematic* shift, but yuv420p still **subsamples chroma 4:2:0**, so
saturated colors and anti-aliased colored edges (neon/fire gradients, colored text)
desaturate somewhat regardless of range. For true color fidelity use a **4:4:4 /
RGBA** path — `--format prores` (ProRes 4444 for transparent, HQ otherwise) or
`--format apng` — which carry full chroma. (Measured: an h264 render's saturated
region averaged ~18/255 off the source vs ~5 for ProRes.)

## Transparent backgrounds / alpha (DM-1142)

A transparent `--background` — the CSS keyword `transparent` / `none`, or any
zero-alpha color (`rgba(…, 0)`, `#rrggbb00`) — requests a transparent output.
`isTransparentBackground` detects it; the page is then loaded with a transparent
background and frames are captured with `omitBackground: true`, so the PNG stream
carries real alpha into ffmpeg.

Whether that alpha survives depends on the format. `resolveFormat(format,
container, transparent)` switches alpha-capable formats to an alpha pixel format
(and any alpha-specific codec args) and reports `alpha: true`; the rest report
`alphaCapable: false` and the CLI composites onto opaque white with a note.

| `--format` | Transparent output | How |
| --- | --- | --- |
| `vp9` | ✅ alpha | `-pix_fmt yuva420p` (webm). Verified transparent in Chromium's `<video>`; note ffmpeg's own VP9-alpha *decode* round-trip is lossy, but browsers — the real consumer — render it correctly. |
| `prores` | ✅ alpha | ProRes 4444, `prores_ks -profile:v 4 -pix_fmt yuva444p10le` (`.mov`). The standard alpha video for editing / compositing. Opaque ProRes uses the HQ profile (`3`, `yuv422p10le`). |
| `apng` | ✅ alpha | `rgba` (already the APNG pixel format). |
| `gif` | ✅ 1-bit alpha | `palettegen=reserve_transparent=1` + `paletteuse=…:alpha_threshold=128`. GIF alpha is 1-bit, so semi-transparent edges snap fully on/off. |
| `h264` / `hevc` / `av1` / `vp8` | ⚠️ composited | These can't carry alpha (h264/hevc/av1 have no alpha profile we target; ffmpeg's libvpx VP8 encoder *lists* `yuva420p` but fails to open with it, producing a corrupt file). A transparent request composites onto opaque white with a `note:` and a pointer to `vp9`/`prores`/`apng`/`gif`. |

## Out of scope (v1)

- Arbitrary JS/`requestAnimationFrame`-driven SVG animation (needs clock
  virtualization; best-effort only).
- Per-frame audio sync beyond music/voiceover/captions.

## Verification

- **Unit tests** (`src/cli/svg-to-video-core.test.ts`) cover the pure helpers:
  `fitContain` (aspect-preserving + even dims), `parseSvgIntrinsicSize`,
  `resolveDurationMs` (override / uniform loop / LCM / finite-end / cap), the
  `--format` map (incl. the gif/apng entries + container-override guard), the
  alpha resolution (`isTransparentBackground`, `resolveFormat(…, transparent)`
  switching alpha-capable formats to their alpha pix_fmt / ProRes profile and
  leaving the rest opaque), and `buildFfmpegArgs` for every audio/caption/scale/
  webm combo plus the gif palette filtergraph (incl. the transparent
  `reserve_transparent` / `alpha_threshold` variant), the ProRes 4444 alpha args,
  and the apng encoder branch (audio/soft-caption drop, burn-in kept).
- **Alpha, end-to-end** (validated manually this session, ffmpeg + Chromium): a
  transparent-background SVG rendered to `vp9` is confirmed transparent at a
  corner and opaque at the painted center via a Chromium `<video>` → canvas
  read-back; `prores` (`yuva444p`) and `apng` (`rgba`) carry alpha at the corner;
  `gif` keys out the transparent index; `h264`/`vp8` emit a `note:` and a valid
  opaque file.
- **End-to-end** (`src/cli/svg-to-video-e2e.test.ts`, ffmpeg-gated) renders the
  same animated SVG to mp4, gif, and apng and ffprobes each for codec, geometry,
  and frame count.
- **End-to-end** (validated manually this session): a `domotion animate` SVG
  rendered to mp4 yields exactly `round(duration*fps)` frames with the seeked
  state captured (frames genuinely differ across the timeline — confirmed the
  WAAPI seek beats Playwright's screenshot default, which is why we do **not**
  pass `animations:"disabled"`), correct contain-fit dimensions, and a looping
  music track trimmed to length; vp9/webm output and the ffmpeg-missing guidance
  path both verified.

## Decisions (resolved)

Confirmed by the maintainer (DM-873):

1. **Generality scope** — CSS-`@keyframes` (domotion) **+** SMIL
   (`setCurrentTime`); JS-`rAF` animation out of scope / best-effort. ✅
2. **Infinite/indeterminate duration** — derive one loop cycle from
   `getAnimations()`; require `--duration` for SMIL-only or incommensurate cases. ✅
3. **ffmpeg sourcing** — hard-require system ffmpeg, print install guidance when
   missing; **not** bundled, **no** `ffmpeg-static` auto-fallback. ✅
4. **Frame transport** — pipe to ffmpeg stdin by default; `--keep-frames` for the
   on-disk debug sequence; disk pre-flight always runs. ✅
5. **Program shape** — a **standalone `svg-to-video` bin** (second bin in the
   package), not a `domotion video` subcommand. ✅
