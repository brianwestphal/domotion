# 78 — `svg-to-image`: still SVG → PNG / JPEG / PDF / WebP / AVIF / TIFF

Status: **shipped** (DM-1353). A fifth published bin (sibling to `domotion`,
`svg-to-video`, `svg-review`, `svg-scrubber`) that converts a single SVG
into one image file. It is the headless, one-shot counterpart to the scrubber's
interactive **Export frame** (doc 56) and the still analogue of `svg-to-video`
(which only emits video).

## Why

Domotion produces SVGs, but an SVG isn't something you can *look at* as pixels
without a renderer. The agent review loop the `llms.txt` playbook prescribes —
"render → look at the rasterized pixels → critique → iterate" — had no published
one-shot rasterizer for a **still**:

- `svg-to-video` outputs video (mp4/webm/mov), not an image.
- `svg-scrubber` can export a frame as PNG, but only through its
  interactive web UI.
- `svg-review` rasterizes via Chromium but is a diff tool that requires an
  `--expected` image.

So an agent (or a human) had to bring their own SVG rasterizer just to see what
Domotion produced. `svg-to-image` closes that gap with a single command.

## Usage

```sh
svg-to-image <input.svg> -o <output> [options]
```

```sh
# The agent review loop: capture to SVG, then look at the pixels.
domotion capture page.html -o out.svg
svg-to-image out.svg -o out.png

svg-to-image card.svg  -o card@2x.png --scale 2      # retina (2×) PNG
svg-to-image demo.svg  -o frame.jpg   --at 4000      # an animation's 4s frame, as JPEG
svg-to-image poster.svg -o poster.pdf                # a vector PDF sized to the SVG
```

Input is always an existing `.svg` file. For URL/HTML → image, run
`domotion capture … -o x.svg` first, then `svg-to-image x.svg` — each verb stays
single-purpose.

## Output format

The format is inferred from the `-o` **extension** (override with `--format`):

| Extension | Format | Notes |
|---|---|---|
| `.png` | PNG | Lossless raster; keeps an alpha channel for transparent SVGs. |
| `.jpg` / `.jpeg` | JPEG | Lossy raster; no alpha → transparent input composites onto the background. `--quality 1–100` (default 92). |
| `.pdf` | PDF | A single page sized to the SVG, rendered by Chromium's `page.pdf()` (vector where the content is vector; resolution-independent). |
| `.webp` | WebP | Raster; keeps alpha. Lossy `--quality` (default 92). |
| `.avif` | AVIF | Raster; keeps alpha. Lossy `--quality` (default 92). |
| `.tiff` / `.tif` | TIFF | Lossless raster (LZW); keeps alpha. |

PNG / JPEG / PDF are produced natively by Chromium (`page.screenshot` /
`page.pdf`). WebP / AVIF / TIFF are **transcoded from the PNG buffer with
[`sharp`](https://sharp.pixelplumbing.com/)** — already a Domotion dependency
(capture image-resize, conic-gradient raster, …), so no extra install — and
`sharp` is **imported lazily**, only when one of those formats is requested, so
the common PNG/JPEG/PDF path doesn't pay its native-load cost. An unrecognized
extension is a usage error that names the supported set.

## Options

- `--at <ms>` — for an **animated** SVG, the timeline position to sample (default
  `0`, the first frame). Uses the same pause-and-seek path as `svg-to-video` and
  the scrubber, so a grabbed frame is pixel-identical to the corresponding video
  frame. Harmless on a static SVG.
- `--width <px>` / `--height <px>` — contain within, preserving aspect ratio.
  Give either or both; omitted → the SVG's intrinsic size (from `viewBox`, else
  the `width`/`height` attributes). An SVG with no derivable size requires both.
- `--scale <n>` — device-pixel-ratio / supersample factor for **raster** output
  (a positive **integer**; default `1`; output px = size × scale). Use `2` for a
  crisp retina raster. Ignored for PDF (vector, resolution-independent).
- `--background <css>` — page background behind the SVG (default `transparent`).
  PNG/WebP/AVIF/TIFF keep the SVG's own alpha; JPEG/PDF can't carry alpha and
  composite onto white when the background is transparent.
- `--quality <1-100>` — quality for JPEG / WebP / AVIF (default 92). Ignored for
  png / pdf / tiff (tiff is lossless LZW).
- `--quiet` — suppress the one-line progress on stderr.

## Fidelity

The default `--scale 1` renders at the SVG's intrinsic pixel size, matching
Domotion's "pixel-faithful to Chromium at 1×" contract (and the 1× rasterization
`svg-review` uses). The render path loads the SVG in headless Chromium via the
same `htmlWrapper` + `seekTo` + `screenshot` machinery as `svg-to-video`, waits
for embedded webfonts (`document.fonts.ready`) before shooting, and — for PDF —
forces `screen` media so a print stylesheet can't alter the paint. `page.pdf()`
requires headless Chromium, which `launchChromium()` always is.

## Code

- CLI: `src/cli/svg-to-image.ts` (arg parsing + help) → `runSvgToImage` in
  `src/cli/svg-to-image-core.ts` (format resolution, sizing, render, write).
- Reuses `htmlWrapper` / `seekTo` / `screenshot` / `parseSvgIntrinsicSize` from
  `src/cli/svg-to-video-core.ts`; WebP/AVIF/TIFF transcode via a lazy
  `import("sharp")`.
- Bin registered in `package.json` (`"svg-to-image": "dist/cli/svg-to-image.js"`).
- Tests: `svg-to-image-core.test.ts` (pure helpers) + `svg-to-image-e2e.test.ts`
  (real Chromium: PNG geometry/alpha, `--scale`, `--width`, JPEG/PDF magic
  bytes, WebP/AVIF/TIFF magic bytes + WebP alpha round-trip, `--at` frame
  distinctness).

## See also

- doc 56 — `svg-scrubber` (interactive frame export + MP4/trim).
- doc 54 — `svg-review` (still-fidelity diff against a Chromium screenshot).
- the `svg-to-video` bin — animated SVG → video.
- `llms.txt` "Work the loop" — the agent review loop this command serves.
