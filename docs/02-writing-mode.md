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

`renderTextAsPath` and friends in `src/render/text-to-path.ts` emit glyphs in a horizontal, line-relative coordinate space. For vertical writing-mode the renderer follows Blink's `TextFragmentPainter` / `LineRelativeRect` handoff:

- `Range.getBoundingClientRect()` supplies the physical character box. As Blink's `CreateFromLineBox` does, the renderer reuses that box's physical top-left as the line-relative origin and swaps physical height/width into inline/block size.
- `vertical-rl`, `vertical-lr`, and `sideways-rl` use Blink's clockwise affine matrix; `sideways-lr` uses its counter-clockwise matrix. The translation terms preserve the physical box's top-left after rotation.
- Mixed-orientation upright glyphs use the lower-level equivalent of Blink's nested `CanvasRotationInVertical`: they remain physically upright, while Latin and other rotated glyphs inherit the outer line-relative transform.
- Horizontal modes: unchanged.

The existing per-char raster path (SK-1090) needs to copy the rotation transform into each `<image>` overlay so emoji rendered in a vertical column rotate to match Chrome.

### Baseline placement invariant

`renderTextAsPath` (and the embedded-font `renderTextAsEmbedded` it delegates to) interpret their `y` argument as the **line-box top** and add the font ascent to derive the painted baseline (`baselineY = y + ascent`). The vertical renderer therefore must NOT also pre-add an ascent, or every glyph picks up a second ascent (~0.85em at body sizes):

- **Upright glyphs**: pass the intended baseline (`charY + 0.85em`) as `y` together with `ascentOverride = 0`, so the baseline is used verbatim.
- **Rotated glyphs**: pass the captured physical box's top-left as the line-relative text origin and `fontBoundingBoxAscent` as the ascent override, exactly matching Blink's `text_origin { physical_box.left, physical_box.top + font_metrics.Ascent() }`. Apply `LineRelativeRect::ComputeRelativeToPhysicalTransform` afterward. A baseline error becomes horizontal drift after the 90° rotation, so the ascent is part of the coordinate contract rather than a fitted center offset.

`src/render/vertical-text.test.ts` locks both argument shapes and both upstream affine matrices in (font-independent, so it holds on Linux CI). The focused `20-writing-mode` visual fixture is pixel-clean on macOS after this handoff; `20-deep-text-emphasis` retains only emphasis-mark metric residuals tracked separately.

## tate-chu-yoko (`text-combine-upright`)

`text-combine-upright: all` (and `digits`) combines a short run — typically the digits of a date — into ONE upright, horizontally-laid glyph group occupying a single ~1em column cell, rather than letting each char take its own column position. Chrome paints "31" as two upright digits side by side, squeezed into the cell.

Captured as a dedicated combined segment rather than column-split:

- **Capture** (`src/capture/script/walker/text-segments.ts`): a vertical element whose computed `text-combine-upright` is `all` — or `digits` when the run is entirely ASCII digits (the common authored case: a span wrapping just the digits) — emits ONE `verticalCombineUpright` segment carrying the whole combined text plus `verticalCombineXOffsets[]` (each glyph's captured x relative to the cell's leftmost glyph). Without this the column grouping (group chars by `x` ±1 px) splits "31" into two single-char columns and rotates each, scattering the digits.
- **Render** (`src/render/vertical-text.ts`): the combined segment is emitted as a single `renderTextAsPath` call anchored at the captured cell left with each glyph at its captured `verticalCombineXOffsets[i]`, on the same upright baseline (`cell-top + 0.85em`, `ascentOverride = 0`) as the per-char upright path. Anchoring at Chrome's painted per-char positions reproduces the side-by-side layout — and any sub-1em condensing Chrome applied — without re-deriving the combine geometry. Verified pixel-clean against Chrome on the `20-deep-writing-mode-mixed` date line (the digit cells show zero diff; the residual fixture diff is CJK-ideograph sub-pixel font differences, unrelated).
- **Known limit**: a `text-combine-upright: digits` run that mixes digits with non-digit chars falls through to normal column flow (no fixture exercises it). Heavy condensing (4+ digits squeezed well below 1em) anchors each glyph at the compressed x but does not horizontally scale the glyph *shapes*, so wide glyphs could touch; the date-style 1–2 digit runs that are the overwhelming real-world case render exactly.

## Vertical-form punctuation (`vert`)

In a vertical writing mode Chrome enables the OpenType `vert` feature for every upright glyph in the run. The only glyphs `vert` actually changes are CJK punctuation — the comma `、`, ideographic full stop `。`, and the bracket / quote pairs (`「」『』（）【】〔〕〝〟` and their fullwidth-forms counterparts). Their ink moves from the *horizontal* cell corner to the *vertical* one: e.g. Hiragino's `。` glyph goes from ink bbox `[55,-65,355,235]` (bottom-left) to `[645,525,945,825]` em-units (top-right). Ideographs and kana have no `vert` substitution, so they shape identically with or without the feature.

- **Render** (`src/render/vertical-text.ts`): the per-char upright path passes `["vert"]` to `renderTextAsPath` only for the punctuation in `VERTICAL_FORM_PUNCTUATION`, so fontkit substitutes the vertical-form glyph. For those glyphs it also anchors the **full em box** to the column (`xLeft = colX + (colW − fontSize) / 2`) instead of ink-centering by the captured horizontal natural width — a corner-set glyph ink-centered by its narrow horizontal width would drift toward the column's middle and low, which is exactly the pre-fix symptom (the `。` painted bottom-center instead of top-right). Ideographs keep the natural-width ink-centering. Verified against Chrome on `20-deep-text-emphasis` (vertical frame): the `。` cells move from a two-circle diff to a clean match.

## Text-emphasis geometry

Emphasis marks follow Blink's font and paint pipeline rather than fitted `em`
offsets. The mark is shaped through the text font's fallback list; that selected
face is scaled to `round(font-size × 0.5)`, matching
`SimpleFontData::EmphasisMarkFontData`. Its ascent/descent drive
`TextPainter::SetEmphasisMark` exactly: over uses
`floor(-ascent - markDescent)`, under uses
`ceil(descent + markAscent)`. Marks are centered per Unicode grapheme, not per
UTF-16 unit, following `ShapeResult::ForEachGraphemeClusters`.

Horizontal marks paint on the resolved over/under side. Vertical marks are
placed in the same line-relative space as the text and pass through the same
clockwise/counter-clockwise writing-mode matrix; explicit left/right therefore
resolve to the corresponding logical side for each rotation. The focused
macOS checks score `02-text-emphasis` at 2 trivial regions / 0.01% and
`20-deep-text-emphasis` at 10 regions / 0.04%; the placement algorithm and
selected-face metrics are platform-independent while each supported platform
retains its native font resolver.

## Edge cases / out of scope

- Per-glyph rotation choice for ambiguous codepoints (Latin parens around CJK, ideographic punctuation in Latin runs) — start with the Unicode `Vertical_Orientation` property and refine if a real-world page misbehaves.
- CSS logical properties (`inline-size`, `padding-block-*`) — captured pixel values from `getComputedStyle` are already physical, so layout sizing comes through. Only typography axes need new logic.

## Follow-ups to file

- Implementation ticket: "SK-???: implement vertical writing-mode + text-orientation in capture+render".

## Acceptance criteria

`20-writing-mode.html` is pixel-clean on the primary macOS capture platform, with the vertical Japanese paragraph rendering top-to-bottom right-to-left and Latin runs inside it sideways-90°. Linux and Windows must preserve the same logical placement and remain within their documented native-raster floors. Existing horizontal tests do not regress.

## Horizontal `text-spacing-trim` — CJK fullwidth-punctuation ink shift (DM-1184)

The vertical `vert` story above has a horizontal sibling. CJK fullwidth
punctuation (`（「」）。、` …) carries built-in half-width side-bearing — its ink
occupies only one half of the em box: OPENING punctuation (`（「`) sits in the
RIGHT half, CLOSING (`」）。、`) in the LEFT. CSS `text-spacing-trim` (and Chrome's
default `normal` between adjacent punctuation) collapses the empty side, so
trimmed punctuation packs ~0.5em apart instead of the full ~1em advance.

Chrome's already-trimmed pen positions ARE captured (each glyph anchors at its
captured xOffset), but the rendered glyph OUTLINE is the full-width one. Drawing
an opening bracket's right-half ink at the trimmed (leftward) pen pushes it
~0.5em too far right — it lands on the next glyph (the visible "`「` overlaps
`」`" bug in `20-deep-hanging-punctuation`).

The fix borrows the font's `halt` (alternate half widths) GPOS xOffset, which
repositions the ink to fit the half-width box (−0.5em for opening punctuation,
0 for closing). `cjkTrimShiftFontUnits` (`src/render/text-to-path.ts`) applies it
ONLY when the captured advance is actually ~half the em (so untrimmed `（ ）` are
untouched), with an ink-geometry fallback (opening = ink centroid in the right
half) for fonts that can't report `halt`. Applied in the embedded-font path
(CoreText cluster + fontkit branches) and the paths-mode per-char branch. The
captured pen is the glyph ORIGIN; the halt xOffset is an intra-glyph ink nudge —
applying it is not a double-shift. Still open: line-leading and `」「` adjacent-
bracket contextual cases that trim on a different side.
