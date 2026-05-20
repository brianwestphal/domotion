# Domotion: vertical `<input type=range>`

Requirements for vertical-axis range sliders in Domotion. Origin: DM-276 (follow-up from DM-273). Section 5 of `external/html-test/06-forms-style-range.html` declares a vertical slider via `writing-mode: vertical-lr; direction: rtl`; before this work the renderer always laid the track + thumb on the horizontal axis, so the captured 30×150 element painted as a misshapen horizontal slider stuffed into a tall narrow box.

## Why now

CSS Writing Modes Level 4 makes `writing-mode` the modern way to author vertical sliders (the legacy `-webkit-appearance: slider-vertical` is deprecated in Chromium 126+). The `06-forms-style-range` fixture exercises the modern syntax; matching Chrome's painted output is required for the html-test suite.

## Scope

In: `<input type=range>` with `writing-mode: vertical-rl` or `vertical-lr`. Direction (`ltr` / `rtl`) selects which end of the track holds the low value.

Out for now (separate tickets when fixtures arrive):

- `writing-mode: sideways-rl` / `sideways-lr` on range inputs — Chrome renders these the same as `vertical-*` for form controls, but our pipeline hasn't been verified against fixtures.
- Vertical `<progress>` / `<meter>` — the renderer in `renderProgress` / `renderMeter` still assumes horizontal.
- Legacy `-webkit-appearance: slider-vertical` — deprecated; if a fixture surfaces it, treat as equivalent to `writing-mode: vertical-lr`.

## Geometry

The captured element rect is the slider's viewport box (e.g. `30 × 150` for the test fixture). The renderer chooses an axis based on `s.writingMode`:

- `horizontal-tb` (or unset): track runs along the x-axis, length = `el.width − thumbW`, thickness = `trackHeight` (4 px UA default). Thumb moves along x; ratio 0 → left, ratio 1 → right.
- `vertical-rl` / `vertical-lr`: track runs along the y-axis, length = `el.height − thumbH`, thickness = `trackHeight`. Thumb moves along y. The track is centered horizontally inside `el`.

`direction: rtl` flips the value-to-position mapping on the active axis:

- Horizontal `rtl` (out of scope here, matches Chrome's behavior for LTR-default slider): low at right.
- Vertical `rtl`: low at bottom (matches the `06-forms-style-range` fixture comment `direction: rtl; /* low at bottom */`). Vertical `ltr`: low at top.

The UA accent fill spans from the value-end of the track to the thumb. For vertical-rtl this is from the bottom up to the thumb; for vertical-ltr this is from the top down to the thumb.

## Capture

No new fields. `CapturedElement.styles.writingMode` and `direction` are already captured (SK-1123 / pre-existing).

## Render

`renderRange` in `src/form-controls.ts` branches early on `isVertical = s.writingMode != null && s.writingMode !== 'horizontal-tb'`. Both branches share the same fill / border / styled-thumb logic — only the geometry math differs. Specifically:

- Horizontal: `trackRect.w = el.width − thumbW`, `fillRect.w = thumbCx − trackLeft`.
- Vertical: `trackRect.h = el.height − thumbH`, `fillRect.h` runs from `thumbCy` to `trackBottom` (rtl) or from `trackTop` to `thumbCy` (ltr).

Author-styled track (`::-webkit-slider-runnable-track { width: ..., height: ... }`) is interpreted along the **inline axis** of the writing mode. In a vertical mode, a CSS `height: 8px` declaration on the track describes the track's *thickness* (not its length), matching how Chrome interprets it. The current implementation uses `rangeTrackHeight` as the thickness regardless of writing mode, which is correct.

## Animation

No special handling for animated values: if a frame mid-animation lands on a different `inputValue`, the captured ratio changes per frame and the thumb position recomputes from that ratio.

## Edge cases / out of scope

- `writing-mode: vertical-rl` is treated identically to `vertical-lr` in the current implementation. Chrome also paints them the same for `<input type=range>` (the inline-block effect doesn't matter when the control's content is just a track + thumb), but verify against a fixture before relying on this.
- Custom `::-webkit-slider-thumb { transform: rotate(...) }` is not interpreted — author-styled thumbs paint as their static rect/circle in viewport coordinates.
- The `r-vert` fixture also sets `accent-color: #7c3aed`. The renderer reads `accent-color` via `resolveAccent(el)` and applies it to both the UA fill and the native (unstyled) thumb fill, so vertical native sliders honor `accent-color` the same way horizontal ones do (DM-273).
