# Blink affine text baseline and fragment-origin protocol

DM-2544 is an investigation, not an implementation. It independently decodes
the baseline plane that docs 159 and 177 deliberately left as retained
provenance. The result is narrower than a visual comparison:

- the existing one-fragment horizontal affine route applies Blink's neutral
  baseline before the complete matrix and is logically correct;
- a single `LayoutText` can expose several physical `FragmentItem`s while
  Domotion captures one line segment, so the current affine correlator fails
  closed to a Chromium surface; and
- the vertical `baseline` field is not the physical baseline promised by its
  schema. It carries `segment.x + ascent`, which the renderer converts back to
  an ascent before constructing a line-relative SVG origin.

No production behavior, raster threshold, pixel tolerance, or native glyph
antialiasing rule changes in DM-2544.

## Pinned source boundary

The source trace uses Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`. Its `DEPS` file pins Skia
`62efacd37737505732dbe3d8daa62abd679626a1` and HarfBuzz
`511df88b82e697cd2a0f1f0635787aa0b18bddbb`. The Chromium dependency pin, not
the newer standalone HarfBuzz checkout head, is authoritative for this
protocol.

### Fragment ownership and exposed coordinate spaces

`Range::getClientRects()` calls `GetBorderAndTextQuads`, then
`LayoutText::AbsoluteQuadsForRange`, and finally
`Document::AdjustQuadsForScrollAndAbsoluteZoom`
(`core/dom/range.cc:1656-1697,1748-1779`). In the LayoutNG path,
`LayoutText::AbsoluteQuadsForRange` iterates the text's `FragmentItem`s with an
`InlineCursor`, intersects each item's `TextOffsetRange`, and obtains its local
rectangle with `CurrentLocalRect` (`core/layout/layout_text.cc:556-630`). A
whole-text Range therefore returns one axis-aligned rectangle per intersecting
physical text fragment, not necessarily one rectangle per DOM text node.

`DOM.getContentQuads` reaches `InspectorHighlight::GetContentQuads` through
`InspectorDOMAgent` (`core/inspector/inspector_dom_agent.cc:1839`).
`CollectQuads` asks the text `LayoutObject` for `AbsoluteQuads`, maps frame
coordinates into the viewport, and adjusts absolute zoom
(`core/inspector/inspector_highlight.cc:1941-1969,2594-2609`). For
`LayoutText`, `AbsoluteQuads` uses `CollectLineBoxRects`, which iterates the
same physical items (`core/layout/layout_text.cc:484-511`). The neutral Range
rects must consequently equal the axis-aligned bounds of the neutral CDP quads
and have the same count.

`AdjustQuadMaybeExcludingCSSZoom` divides the exposed quad by effective CSS
zoom, or by layout zoom when standardized browser zoom is enabled
(`core/layout/adjust_for_absolute_zoom.h:100-121`). CSS zoom still participates
in local font metrics and layout; it is removed only from this exposed viewport
coordinate projection. The affine prepass correctly leaves zoom active while
neutralizing CSS transforms.

### Baseline selection, paint snap, and writing plane

Blink constructs the local paint origin before the paint-property transform:

```text
physical top = round(paint offset top + parent offset top)
             + (fragment top - parent offset top)
line-relative origin = (physical left, physical top + integer ascent)
painted origin = writing-mode rotation(line-relative origin), then paint CTM
```

The first expression is transcribed from `PhysicalBoxRect`; it rounds the
containing paint offset while retaining the fragment-relative fractional delta
(`core/paint/text_fragment_painter.cc:62-87`). `TextFragmentPainter` selects
the fragment's scaled primary font, reads integer `FontMetrics::Ascent`, and
adds it to that physical top (`text_fragment_painter.cc:506-529`). Blink's
metric code explicitly uses `Ascent`, not `FixedAscent`, to agree with the
painter (`platform/fonts/simple_font_data.cc:416-428`; `font_metrics.h:109-166`).

The resulting `LineRelativeOffset` changes plane in vertical writing.
`LineRelativeRect::ComputeRelativeToPhysicalTransform` uses the following
matrix for vertical-rl, vertical-lr, and sideways-rl, while sideways-lr uses
the opposite rotation (`core/paint/line_relative_rect.cc:19-75`):

```text
[ 0  1  -1  0  lineLeft + lineOver + blockSize  lineOver - lineLeft ]
```

Finally, Blink records the complete transform matrix and a fragment-specific
reference-box origin (`core/paint/paint_property_tree_builder.cc:1370-1456`).
`ComputedStyle::ApplyTransform` translates to that resolved origin, applies
independent transforms, motion path, and ordered transform operations, then
translates back (`core/style/computed_style.cc:1415-1489`). Transform origin is
therefore part of the later mapping; ascent is not recomputed in transformed
space.

## Independent live/capture/emitted discriminator

Run the logical oracle with:

```sh
npm run transform:text-baseline-protocol -- --json /tmp/text-baseline-protocol.json
```

It temporarily neutralizes every marked transform owner, takes same-frame
whole-Range and per-UTF-16-unit rectangles plus CDP text-node quads, restores
the page, captures it normally, and loads the emitted SVG in a second page.
The report records unrounded coordinates and source spans. It never takes a
screenshot or reads a pixel. The `1/64` CSS-pixel source discriminator is
Blink's `LayoutUnit` quantum; the `1/32` emitted bound covers the renderer's
existing hundredth-pixel SVG serialization. Neither is a visual tolerance.

The 2026-08-23 darwin/arm64 run used Node 22.23.2, Playwright 1.59.1, and
Chromium 147.0.7727.15:

| Row | Neutral Blink facts | Captured/emitted result | Discriminator |
| --- | --- | --- | --- |
| fractional horizontal | one fragment; baseline witness `(301.703125, 103.375)`; ascent `22` | one vector fragment; painted endpoint `(296.517334, 145.557343)` | independently solved matrix maps the neutral baseline within `0.000009` CSS px; emitted endpoint is within `0.008693` CSS px after decimal serialization |
| nested zoom | effective zoom `1.25`; one fragment; neutral baseline `(422.15625, 129.46875)` | one vector fragment; painted endpoint `(442.696808, 204.653290)` | captured matrix equals the independently solved matrix; emitted endpoint is within `0.023048` CSS px |
| mixed Latin/Arabic/CJK | Range and CDP both expose three fragments with UTF-16 offsets `0..5`, `6..12`, and `13..15` | one `TextSegment`, zero correlated affine fragments, one outer Chromium image | proves the fragment-count/source-span correlation gap without consulting raster output |
| vertical-rl | neutral quad `[102.25,80.375,129.25,80.375,129.25,176.375,102.25,176.375]`; ascent `22` | stored scalar `124.25`; emitted first local y `102.38` | decoded line-relative point `(102.25,102.375)` maps to physical baseline `(107.25,80.375)`, while `124.25 = segment.x + ascent`; the field is an ascent carrier, not physical x |

The live-to-neutral-to-restored CDP quad delta is zero in all four rows. The
mixed row's warning is the expected safe boundary: “neutral text segment could
not be correlated with its protocol fragment.”

Seven destructive controls are active and are expressed as logical coordinate
or cardinality changes:

| Mutation | Observed movement |
| --- | ---: |
| post-transform AABB top plus ascent | `55.932349` CSS px |
| apply ascent after the affine map | `4.454658` CSS px |
| snap after the affine map | `0.654913` CSS px |
| apply CSS zoom twice | `5.956938` CSS px |
| drop transform-origin translation | `62.408470` CSS px |
| collapse mixed physical fragments | `3 -> 1` fragments |
| interpret the vertical scalar in the horizontal plane | `17` CSS px |

## Earliest Domotion seams

The first correction belongs before affine matrix fitting.
`src/capture/script/walker/text-segments.ts` groups per-character Range bounds
into visual lines, so one DOM text node with same-line fallback/script items
still becomes one `TextSegment`. `src/capture/text-fragment-geometry.ts` then
matches each CDP physical fragment to one unused segment by rectangle distance
with a 2 CSS-pixel cutoff. Three Blink fragments cannot map one-to-one onto one
segment, so capture correctly fails closed but unnecessarily loses vector text.

The second correction is a schema-plane repair. `src/capture/types.ts` describes
`CapturedTextPaintFragment.baseline` as physical y for horizontal text and
physical x for vertical text. Capture actually falls back to `segment.x +
ascent` for vertical text (`src/capture/text-fragment-geometry.ts:221`), and
`src/render/text-affine.ts:152-157` subtracts `segment.x` to recover the ascent.
That round trip preserves the sampled output but cannot encode Blink's
line-relative origin, paint snap, or writing rotation independently.

## Filed implementation tickets

- **DM-2546 — Capture Blink text FragmentItem UTF-16 spans before affine
  correlation.** Split the normal captured/shaped record at the ordered Range
  fragment spans before one-to-one CDP correlation; retain source spans,
  clusters, gids, advances, offsets, zoom, and fragment origins. Mixed fallback,
  bidi, ligature, wrap, first-letter, and vertical rows plus collapse/reorder/
  wrong-span mutations are mandatory.
- **DM-2547 — Replace affine text scalar baseline with a structured Blink
  line-relative origin.** Carry the rounded containing paint offset,
  fragment-relative top, primary-font integer ascent, line-relative origin,
  writing transform, decoded physical point, zoom, and provenance through
  capture and render. Horizontal, all vertical/sideways modes, fractional
  offsets, zoom, nested origins, and wrong-plane mutations are mandatory.

DM-2546 is the earliest behavior-affecting seam and should land first. DM-2547
then removes the misleading compatibility scalar without using output pixels
as an answer table. Native glyph antialiasing remains owned by the existing
terminal-raster evidence, outside both geometry tickets.
