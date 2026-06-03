# Domotion: CSS writing-mode support

Requirements for vertical writing-mode rendering in Domotion. Origin: SK-1123 (follow-up from SK-1104). Today the pipeline always emits glyphs left-to-right horizontal regardless of `writing-mode`, so any page that uses `vertical-rl`, `vertical-lr`, or `sideways-*` lays out wrong.

## Why now

Asian-language layouts (Japanese vertical novels, Chinese signage), Western magazine-style sidebars, and the CSS `writing-mode` test in `external/html-test/20-writing-mode.html` all need this. The failing test's diff dominates because text is fundamentally mis-oriented, not just slightly off.

## Goals

- `writing-mode: horizontal-tb` (the default) — unchanged.
- `writing-mode: vertical-rl` — text runs top-to-bottom, lines stack right-to-left.
- `writing-mode: vertical-lr` — text runs top-to-bottom, lines stack left-to-right.
- `writing-mode: sideways-rl` / `sideways-lr` — text rotated 90° clockwise / counter-clockwise without character upright reorientation.
- `text-orientation: mixed` (default) — vertical scripts upright, horizontal scripts (Latin) rotated 90° clockwise into the column.
- `text-orientation: upright` — all glyphs upright in vertical mode (Asian-typography preference).
- `text-orientation: sideways` — all glyphs rotated 90°.

## Capture changes

`CapturedElement.styles` adds:

- `writingMode: string` (computed value: `horizontal-tb` | `vertical-rl` | `vertical-lr` | `sideways-rl` | `sideways-lr`).
- `textOrientation: string` (computed value: `mixed` | `upright` | `sideways`).

The per-char `Range.getBoundingClientRect()` loop in CAPTURE_SCRIPT already reports the painted positions Chrome chose, including those produced by vertical writing-mode. Each char's `cr` already encodes its viewport position correctly. What changes is the **interpretation** of those rects when we group them into "lines" — vertical mode groups by `cr.left` rather than `cr.top`, and `xOffsets` becomes `yOffsets` semantically.

To minimize disruption: keep the existing `xOffsets` field name but record the **inline-axis** position (top in vertical, left in horizontal). Add a `block-axis` analogue if needed later. The renderer reads both writingMode and the offsets and lays the text out accordingly.

## Render changes

`renderTextAsPath` and friends in `src/text-to-path.ts` currently emit `<g transform="translate(x, baselineY)" fill=... >` with glyphs flowing along the +x axis at scale (sc, -sc). For vertical writing-mode the wrapper becomes:

- `vertical-rl` / `vertical-lr` with `text-orientation: mixed` (Asian-script default): `<g transform="translate(x, y) rotate(0)">` for upright glyphs, `<g transform="translate(x, y) rotate(90)">` for Latin runs within the column. Choose per-character based on Unicode block (CJK / kana / Hangul → upright; Latin / digits / punctuation → rotated). Per-char rotation introduces a per-glyph-group emission, which is fine because we already track per-char xOffsets.
- `sideways-*`: a single `rotate(90)` (rl) or `rotate(-90)` (lr) around the text origin, no per-character branching.
- Horizontal modes: unchanged.

The existing per-char raster path (SK-1090) needs to copy the rotation transform into each `<image>` overlay so emoji rendered in a vertical column rotate to match Chrome.

### Baseline placement invariant

`renderTextAsPath` (and the embedded-font `renderTextAsEmbedded` it delegates to) interpret their `y` argument as the **line-box top** and add the font ascent to derive the painted baseline (`baselineY = y + ascent`). The vertical renderer therefore must NOT also pre-add an ascent, or every glyph picks up a second ascent (~0.85em at body sizes):

- **Upright glyphs**: pass the intended baseline (`charY + 0.85em`) as `y` together with `ascentOverride = 0`, so the baseline is used verbatim.
- **Rotated glyphs**: pass `y = 0` with `ascentOverride = fontSize`, pinning the pre-rotation baseline to exactly `fontSize` — the value the compose-and-rotate-around-center math assumes. A stray ascent here becomes a horizontal drift after the 90° rotation rather than a vertical one.

`src/render/vertical-text.test.ts` locks both argument shapes in (font-independent, so it holds on Linux CI).

## tate-chu-yoko (`text-combine-upright`)

`text-combine-upright: all` (and `digits`) combines a short run — typically the digits of a date — into ONE upright, horizontally-laid glyph group occupying a single ~1em column cell, rather than letting each char take its own column position. Chrome paints "31" as two upright digits side by side, squeezed into the cell.

Captured as a dedicated combined segment rather than column-split:

- **Capture** (`src/capture/script/walker/text-segments.ts`): a vertical element whose computed `text-combine-upright` is `all` — or `digits` when the run is entirely ASCII digits (the common authored case: a span wrapping just the digits) — emits ONE `verticalCombineUpright` segment carrying the whole combined text plus `verticalCombineXOffsets[]` (each glyph's captured x relative to the cell's leftmost glyph). Without this the column grouping (group chars by `x` ±1 px) splits "31" into two single-char columns and rotates each, scattering the digits.
- **Render** (`src/render/vertical-text.ts`): the combined segment is emitted as a single `renderTextAsPath` call anchored at the captured cell left with each glyph at its captured `verticalCombineXOffsets[i]`, on the same upright baseline (`cell-top + 0.85em`, `ascentOverride = 0`) as the per-char upright path. Anchoring at Chrome's painted per-char positions reproduces the side-by-side layout — and any sub-1em condensing Chrome applied — without re-deriving the combine geometry. Verified pixel-clean against Chrome on the `20-deep-writing-mode-mixed` date line (the digit cells show zero diff; the residual fixture diff is CJK-ideograph sub-pixel font differences, unrelated).
- **Known limit**: a `text-combine-upright: digits` run that mixes digits with non-digit chars falls through to normal column flow (no fixture exercises it). Heavy condensing (4+ digits squeezed well below 1em) anchors each glyph at the compressed x but does not horizontally scale the glyph *shapes*, so wide glyphs could touch; the date-style 1–2 digit runs that are the overwhelming real-world case render exactly.

## Edge cases / out of scope

- Per-glyph rotation choice for ambiguous codepoints (Latin parens around CJK, ideographic punctuation in Latin runs) — start with the Unicode `Vertical_Orientation` property and refine if a real-world page misbehaves.
- CSS logical properties (`inline-size`, `padding-block-*`) — captured pixel values from `getComputedStyle` are already physical, so layout sizing comes through. Only typography axes need new logic.

## Follow-ups to file

- Implementation ticket: "SK-???: implement vertical writing-mode + text-orientation in capture+render".

## Acceptance criteria

`20-writing-mode.html` test diff drops below 1.5% avg, with the vertical Japanese paragraph rendering top-to-bottom right-to-left and Latin runs inside it sideways-90°. Existing horizontal tests do not regress.
