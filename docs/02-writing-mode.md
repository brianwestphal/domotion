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

## Edge cases / out of scope

- `text-combine-upright: all` (tate-chū-yoko, horizontal digits embedded in vertical text) — defer to a follow-up. Visible in date strings within vertical paragraphs.
- Per-glyph rotation choice for ambiguous codepoints (Latin parens around CJK, ideographic punctuation in Latin runs) — start with the Unicode `Vertical_Orientation` property and refine if a real-world page misbehaves.
- CSS logical properties (`inline-size`, `padding-block-*`) — captured pixel values from `getComputedStyle` are already physical, so layout sizing comes through. Only typography axes need new logic.

## Follow-ups to file

- Implementation ticket: "SK-???: implement vertical writing-mode + text-orientation in capture+render".
- `text-combine-upright` ticket once we have a test case.

## Acceptance criteria

`20-writing-mode.html` test diff drops below 1.5% avg, with the vertical Japanese paragraph rendering top-to-bottom right-to-left and Latin runs inside it sideways-90°. Existing horizontal tests do not regress.
