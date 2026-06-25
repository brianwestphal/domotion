# 57 — `svg-scrubber` crop (DM-1104)

Status: **shipped**. Adds an optional crop rectangle to the scrubber (doc 56) so
you can trim the framing of an animated SVG and export just that region — works
with all three exports (Frame PNG, Range MP4, Trim SVG).

## Why

The scrubber loads an animated SVG at its full intrinsic frame. Real captures
often have padding, a sidebar, or a hero element you want to isolate before
handing the clip off. Rather than re-capture at a different clip rect, let the
user draw a crop directly on the stage and bake it into whatever they export.

## UI

A crop-mode toggle button (lucide **crop** icon) sits in the toolbar next to the
zoom controls.

- **Enabling** crop mode shows an overlay on the stage: a rectangle with a
  movable body, **8 resize handles** (4 corners + 4 edges), a dimmed exterior
  (everything outside the crop is darkened), and a live `W × H` dimensions
  readout. The rect seeds to the **whole frame** — drag the handles inward to
  crop. A corner handle resizes two edges; an edge handle resizes one; the body
  moves the rect. Resizing is clamped to the frame with an 8-unit minimum.
- **Disabling** crop mode hides the overlay **and resets the crop boundaries**,
  so the next enable starts fresh from the full frame.
- Loading a new SVG resets crop mode off and clears the rect.
- **Aspect-ratio lock** (DM-1107): a select next to the crop toggle (enabled only
  while crop mode is on) constrains resizing to a fixed ratio — **Free** (default,
  unconstrained), **1:1**, **16:9**, **4:3**, or **Original** (the loaded SVG's
  intrinsic `viewBox` w:h). Picking a ratio immediately snaps the current box to
  it (centered, shrunk to fit). While locked, dragging a handle keeps the ratio:
  the dragged edge is authoritative (width for corners and the left/right edges,
  height for top/bottom), the perpendicular dimension is derived, and the box is
  anchored at the corner/edge opposite the dragged handle (a top/bottom or
  left/right edge grows symmetrically about the box center on its free axis),
  then ratio-preservingly clamped to the frame. The lock resets to **Free** when
  crop mode is disabled or a new SVG loads. No server changes — the constrained
  rect is still applied verbatim to all three exports.

The crop rect is tracked in the SVG's **user-space (viewBox) units**, so it is
independent of zoom/pan — the overlay is re-laid-out from `stage-center + pan −
half-size` on every zoom / pan / resize, but the stored rect never changes when
you just zoom in to place a handle precisely.

The overlay lives in a `data-morph-skip` host (like the SVG host) so the
imperatively-built box + handles survive kerf re-renders.

## Export semantics

The crop rect is sent with each export request (omitted when crop mode is off or
the rect still covers the whole frame — a no-op). The server (`src/scrubber/
server.ts`) clamps it to the frame (`clampCrop`) and applies it per export:

| Export | Endpoint | How crop is applied |
|---|---|---|
| **Frame (PNG)** | `POST /export-frame` | Playwright `screenshot({ clip })` — the SVG renders at its natural size, so the crop's user-units map 1:1 to viewport px. |
| **Range (MP4)** | `POST /export-range-video` | Each frame screenshot is `clip`ped to the rect. The clip dims are rounded **down to even** values (H.264 yuv420p requires even W/H) and the encoder frame size becomes the cropped size. |
| **Trim (SVG)** | `POST /trim` | **Vector crop** — `cropSvgViewBox` rewrites the trimmed SVG's root `viewBox` + `width`/`height` to the rect and forces `overflow:hidden`. The content is untouched; only the viewport window moves, so the downloaded SVG stays scalable and self-contained. |

A degenerate or off-canvas crop (zero overlap with the frame) is ignored and the
export proceeds full-frame. A non-positive crop size (`w`/`h` ≤ 0) is rejected at
the request boundary (zod → HTTP 400).

`crop` is validated as `{ x ≥ 0, y ≥ 0, w ∈ (0, 10000], h ∈ (0, 10000] }`
(optional) on all three bodies.

## Code

- `src/scrubber/crop.ts` — `clampCrop()` + `cropSvgViewBox()` plus the DM-1107
  aspect-lock math `constrainResizeToAspect()` (drag-time constraint) and
  `fitRectToAspect()` (snap-on-select); all pure and unit-tested in
  `crop.test.ts`.
- `src/scrubber/server.ts` — the `crop` field on `FRAME_BODY` / `RANGE_VIDEO_BODY`
  / `TRIM_BODY`, and its application in each handler + `renderRangeVideo`.
- `src/scrubber/client.tsx` — `cropMode` / `cropRect` / `cropAspect` signals, the
  crop toggle + aspect-ratio select, the imperative overlay (box + 8 handles +
  dimensions), pointer drag math (`applyCropDrag`, which delegates the ratio
  constraint to `constrainResizeToAspect`), and `activeCrop()` plumbed into the
  three exporters.
- Tests: `server.e2e.test.ts` covers the PNG crop dims, the off-canvas + 400
  cases, the SVG viewBox rewrite, the even-dim MP4 crop, and the toggle showing
  the overlay.

## Not yet supported (follow-up)

- Numeric entry of an exact crop rect (the box is mouse-driven only).
