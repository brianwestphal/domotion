---
title: Export to video / image
description: svg-to-video and svg-to-image — render any animated SVG to a video file or a still image.
---

Domotion ships two standalone CLIs for turning an SVG into other formats.

## svg-to-video — animated SVG → video

Renders an animated SVG (a `domotion animate` output, or any CSS-/SMIL-animated
SVG) to video by stepping the timeline frame by frame in Chromium, then piping
the frames to **ffmpeg** (a required external dependency).

```bash
svg-to-video demo.svg -o demo.mp4 --width 1280
svg-to-video demo.svg -o demo.webm --format vp9 --fps 60 --music bed.mp3
```

Flags: `--width`/`--height` (contain, aspect-preserving), `--fps` (default 30),
`--duration <s>`, `--format` (h264 / hevc / vp9 / vp8 / av1 / gif),
`--scale` (supersample), `--music`. Run `svg-to-video --help`.

## svg-to-image — SVG → still image

The one-shot rasterizer for *looking at* what you produced, embedding a
thumbnail, or handing off a flat asset. The output format follows the `-o`
extension: PNG / WebP / AVIF / TIFF (keep alpha), JPEG (`--quality`), or a
single-page vector PDF.

```bash
svg-to-image card.svg -o card.png                 # PNG at intrinsic size
svg-to-image card.svg -o card@2x.png --scale 2    # crisp retina raster
svg-to-image demo.svg -o frame.png --at 4000      # one frame of an animation, at 4s
svg-to-image poster.svg -o poster.pdf             # vector PDF
```

`--at <ms>` samples an animated SVG's timeline. Run `svg-to-image --help`.

## svg-scrubber — inspect an animated SVG

For debugging an animated SVG's timeline, `svg-scrubber demo.svg` opens a local
video-style bench — play / pause / scrub / mark a range / export a frame or the
range.
