---
id: "requirements/border-outline-phase-oracle"
title: "Border and outline device-pixel phase oracle"
kind: "evidence"
status: "current"
owners: ["paint-effects", "platform-release"]
platforms: ["macos", "linux", "windows"]
tickets:
  [
    "DM-2184",
    "DM-GQJ8C4",
    "DM-HGGQMW",
    "DM-RGE1V9",
    "DM-9X9M8A",
    "DM-XDTVBW",
    "DM-NVVDRB",
    "DM-XWP1NV",
    "DM-2323",
    "DM-2355",
    "DM-CMKF35",
    "DM-652J8C",
    "DM-VJASEG",
    "DM-D1BK35",
    "DM-92KTN7",
    "DM-64RACW",
    "DM-96BH76",
    "DM-H20KAP",
  ]
code:
  [
    ".github/workflows/border-phase-oracle.yml",
    "src/render/outline-paint.ts",
    "src/render/stroke-style.ts",
    "src/render/border-paint.ts",
    "src/render/background-inline-paint.ts",
    "src/render/thin-dotted-endpoints.test.ts",
  ]
aliases: ["docs/127-border-outline-phase-oracle.md", "doc-127"]
---

# Border and outline device-pixel phase oracle

DM-2184 adds `npm run borders:phase-oracle`, a focused paint oracle for the
localized residuals in `18-border-styles` and `18-outline`.

The oracle lays out 128 isolated primitives in a compact four-column grid:
border and outline, solid/dashed/
dotted/double, widths 1/2/3/5px, and quarter-CSS-pixel x/y phases. Chromium
first paints the HTML. Domotion then captures the same document, emits SVG,
and Chromium paints that SVG through an `<img>`. This exercises the delivered
image path; parsing emitted coordinates cannot reveal SVG rasterizer phase.

For the middle of each top edge, the tool records every device-pixel alpha
value at the requested device scale factor. It derives coverage-weighted outer/inner edges
and centerlines, reports profile RMSE, and fits three shared models to the HTML
measurements: no snap, CSS outer-edge rounding, and device-center rounding.
The best model is evidence for a shared renderer rule, not permission to
special-case a fixture or primitive.

The producer's broad 0.56 CSS-px / 0.48 alpha-RMSE limits remain diagnostic
compatibility defaults. DM-2355 reviewed the complete native matrix and moved
the source-exact subset to the much narrower, scenario-specific envelopes in
doc 191. Widening one of those ratified ceilings requires new pinned-source and
native-artifact review. Useful options:

```sh
npm run borders:phase-oracle -- --json /tmp/border-phase.json
npm run borders:phase-oracle -- --keep /tmp/border-phase-artifacts
npm run borders:phase-oracle -- --dsf 1,2,4 --zoom 0.8,1,1.25 --report-only --json /tmp/border-phase-matrix.json
npm run borders:phase-ratify -- --report /tmp/border-phase-matrix.json --run-env /tmp/run-env.json --artifact-dir /tmp/border-phase-artifacts
```

`--keep` writes a scenario directory containing the native HTML PNG, emitted
SVG, and img-rendered SVG PNG. These are diagnostics only and are never renderer
fallbacks. Each scenario reports snap-model fits under `geometry` separately
from HTML-versus-SVG alpha differences under `paintResiduals`; a paint-profile
threshold therefore cannot disguise a changed logical snap decision.

`.github/workflows/border-phase-oracle.yml` runs the 3 × 3 DSF/zoom matrix on
macOS, Linux, and Windows and uploads the JSON plus visual evidence. The report
fingerprints OS, architecture, Node, Chromium, the corpus/source pins, and each
artifact. The separate strict adjudicator applies the reviewed envelope to all
128 rows per scenario. The uniform `border.double` branch now rounds one outer
reference rectangle before deriving both stripe boxes; an unsnapped-reference
mutation is rejected across every width and quarter-pixel phase. This logical
fix moved the local double rows to exact zero without widening a paint
threshold.

The first expanded run found and closed a shared effective-zoom boundary
(DM-2323). Blink stores border widths and outline width/offset in zoomed integer
paint units, but CSSOM serializes those values divided by `EffectiveZoom`.
Domotion already captured physical DOMRects, so consuming the CSSOM lengths
unchanged mixed coordinate spaces. Capture now reconstructs the paint lengths
once from the memoized ancestor effective zoom. On the local DSF 1/2 × zoom
0.8/1.25 discriminator this changed 309 threshold failures to 9 and made the
inferred HTML/SVG snap rule agree in all four scenarios. Later outline snap
work closed the logical dotted-outline discrepancy. DM-2355's repeated native
review found the remaining DSF=1 dotted-outline coverage profile byte-stable
across runners. The later uniform-double snap correction left those maxima and
their ceilings unchanged; doc 191 records the exact geometry, ceilings, and
evidence fingerprints.

The two shades of a `groove`, `ridge`, `inset` or `outset` border come from
`CalculateInsetOutsetColor` (`box_border_painter.cc:616`, chromium `6b5a1b80`).
The dark edge is `Color::Dark()` (`color.cc:1165`): every channel is scaled by
`(v - 0.33) / v`, where `v` is the largest sRGB channel, and truncated by
`QuantizeTo8Bit`; white is hardcoded to 171. The light edge is the color
itself unless its contrast ratio with that dark shade is below 1.75, in which
case it is `Color::Light()` (black becomes 84,84,84). `bevelShades` in
`src/render/border-paint.ts` transcribes this; it previously used two thirds
per channel (DM-NVVDRB; `tests/border-bevel-shades.e2e.test.ts`).

The sides of a square 3D border paint in `BoxBorderPainter`'s order for one
opacity group: `kSidePriority` sorts top, bottom, right, left. Top and bottom
come first and take no miter, because their adjacent sides will still overdraw
the corners (`WillOverdraw`), so they fill full-width bands. Right and left
then paint with anti-aliased miters over those bands, which leaves each corner
join opaque with the two colors mixed. `DrawRidgeOrGrooveBoxSide` splits each
side at the integer midpoint `(y1 + y2 + 1) / 2`, so for odd widths the half
nearer the band's top or left edge is `ceil(w / 2)`. `bevelSidePolygons` and
`BEVEL_PAINT_ORDER` follow that model. Two separately anti-aliased trapezoids
per corner used to leave a translucent seam (DM-XWP1NV).

A negative outline offset is clamped per axis before any of this geometry:
`AdjustedOutlineOffset` (`outline_painter.cc:79-82`, chromium `6b5a1b80`)
limits the vertical outset to `max(offset, -height / 2)` and the horizontal one
to `max(offset, -width / 2)` of the pixel-snapped rect, with C++ integer
division, and both `PaintSingleRectOutline` and the right-angle path receive
those outsets. An offset past the box center therefore collapses the outline
to a small rectangle instead of inverting it. `adjustedOutlineOffset` in
`src/render/outline-paint.ts` transcribes it for the square and rounded paths,
and the cull mirror in `src/render/culling-geometry.ts` uses the same values
(DM-GQJ8C4; feature fixture `outline-negative-offset-clamp`).

An outline paints whenever its color is not fully transparent:
`BorderEdge::HasVisibleColorAndStyle` (`core/style/border_edge.cc:33`, chromium
`6b5a1b80`) tests only `!IsFullyTransparent()`. Even `rgba(255,0,0,.004)`
quantizes to 8-bit alpha 1 in Chromium's paint. `paintOutline` and the cull
mirror therefore gate on alpha above zero, not on the renderer's 0.01
visibility floor (DM-HGGQMW; `tests/outline-paint-visibility.e2e.test.ts`
compares native and SVG coverage on a transparent background, with a zero-alpha
control).

A normal outline also paints around a zero-area box. `PaintOutlineRects`
(`outline_painter.cc:924`) keeps an empty pixel-snapped rect unless the outline
is a focus ring, so a `0 × 20` box with `outline: 2px solid` paints 96 pixels.
The capture gate that drops empty childless boxes therefore keeps one whose
non-`auto` outline has width and a nonzero alpha (DM-RGE1V9, same test file,
with focus-ring and no-outline controls).

A solid rounded single-rect outline fills between two contours of the
pixel-snapped border box (`ContouredBorderGeometry::PixelSnappedContouredBorderWithOutsets`,
chromium `6b5a1b80`): the outer one outset by offset plus width, the inner one
by offset. Both start from the border radii resolved against the unsnapped box
and constrained, then grow each nonzero radius component by its side's outset
(`FloatRoundedRect::Radii::Outset`, `float_rounded_rect.cc:115`); a zero
component stays square. `paintOutline` emits that even-odd contour pair for every rounded solid
outline. Per-corner and elliptical radii therefore no longer collapse to the
top-left corner's scalar radius (DM-9X9M8A), and a circular radius at a
fractional origin or size paints at the snapped position instead of the
fractional DOM rect (DM-XDTVBW). Curved edges keep a few levels of
anti-aliasing difference from Skia. Double, dashed and dotted rounded outlines still use the scalar radius.

A square dashed or dotted single-rect outline paints through
`BoxBorderPainter`'s outline constructor, which uses the pixel-snapped outer
rect with outsets of offset plus width. Each side therefore runs exactly from
outer corner to outer corner, half the snapped width out from the stroke
centerline. Its dash fit uses that full length. Thick dotted sides then inset
their round caps by half the width, as border sides do. An earlier
`floor((w + 1) / 2)` joint overshot odd widths by 0.5px at each end, so a 1px
outline side was 1px too long and fitted one dash too many. Rounded dashed and dotted borders and outlines follow
`DrawCurvedDashedDottedBoxSide` (`box_border_painter.cc:1827-1860`). Blink does
stroke one closed centerline per side and clips it to that side's wedge, but the
centerline is the snapped border contour inset by
`PhysicalBoxStrut::FromInts(width * 0.5)` (`CenterOutsets`, `:2477-2483`). That
truncates, so a 1px border strokes its outer edge, and the radii shrink by the
same integer. The dash gap is fitted to
`static_cast<int>(centerline_path.length())`. Domotion reproduces that length
with a port of Skia's `SkContourMeasure` conic subdivision (0.5px tolerance,
Skia `62efacd3`, which Chromium's DEPS pins): `skiaRoundedRectContourLength` in
`src/render/borders.ts`. The analytic perimeter can truncate to a different
integer (793.12 against Skia's 792.82) and fits one dash too many. Dashes and
thin dots are stroked at 2.2 × the max adjacent width under the border-ring
mask; round dots keep the side width. The path starts at the top-left corner's
end, clockwise, which is SkRRect start index 0 (`path_builder.cc:228-233`).
Rounded dashed and dotted inline-box fragments go through the same procedure
(`src/render/background-inline-paint.ts`). The inline painter hands
`BoxBorderPainter` the fragment rect with `SidesToInclude()`
(`inline_box_fragment_painter.cc:459-461`), and
`PixelSnappedContouredBorderWithOutsets` zeroes the excluded sides' outsets
(`contoured_border_geometry.cc:219-250`). A sliced first or last fragment
therefore still strokes one closed centerline: inset `floor(width / 2)` on its
included sides and on the fragment edge at the excluded side, with its dashes
fitted to that whole contour's truncated Skia length. The excluded side has no
width, so nothing paints there. Middle fragments have no corners and keep the
straight-side path.

Outline emission and its shared dashed/dotted side geometry live in
`src/render/outline-paint.ts` and `src/render/stroke-style.ts`. The latter
implements Blink's `DashLengthRatio`, `DashGapRatio`, and
`DashEffectFromStrokeStyle` from pinned
`third_party/blink/renderer/platform/graphics/styled_stroke_data.cc` for open
side paths and closed contours. Thin dotted strokes use square dash intervals;
thick dots use round caps and a 0.01-pixel endpoint epsilon. A short path with
no room for two dashes emits no dash attribute. Box borders, outlines, inline
fragments, pseudo boxes, and column rules share the same calculations.

`src/render/border-paint.ts` shares one bevel shade and trapezoid plan across
uniform and mixed groove/ridge/inset/outset borders. The shade is the base
color or two thirds of each color channel. `paintBorder` resolves collapsed
table mode once and passes it to its side painters. Each mixed border side
carries its centerline, miter polygon, and double-stroke normals together.
Blink's curved border raster clip widens its temporary stroke to 2.2 times the
largest adjacent width; the SVG path retains the logical side width because
its vector clip and mask already antialias the ring. This deviation is named
`BLINK_CURVED_BORDER_CLIP_OVERDRAW` in the renderer.

The element-tree renderer remains the paint-order
orchestrator and calls this state-independent owner at the existing outline
phase; the public endpoint-plan export remains available through the legacy
element-tree module.

Collapsed table borders have a separate exact logical gate. The capture-side
model mirrors Chromium's `TableBorders`: one logical edge grid, source merges
in cell/row/section/column/column-group/table order, span-interior
`kDoNotFill`, and exact-tie retention. It then mirrors
`TablePainter::ComputeEdgeJoints`, converts through horizontal or vertical table
writing direction (including RTL inline flow), and applies
`ToPixelSnappedRect` semantics before recording table-owned physical edge
rectangles. The grid's columns follow Blink's `LayoutTableRow::AddChild`
(`layout_table_row.cc:99-112`, chromium `7d859f27`). A row child whose box
is not a table cell, such as a `<td>` an author made `display: flex`, sits inside
an anonymous cell. Consecutive non-cell children share that cell, and it
occupies one borderless column. Dropping that child instead would shift every
later cell in the row toward the inline start. The non-cell box keeps its own
ordinary border. Double edges paint through `DrawDoubleBoxSide` with no adjacent
widths, so each stripe is the integer `(thickness + 1) / 3` of the snapped edge
(`box_border_painter.cc:678`): 1px, a 2px gap, and 1px for a 4px edge. Thick dotted edges
size their dot intervals from the full snapped edge, then move both endpoints
in by half the width and stroke from that inset start with dash phase 0
(`box_border_painter.cc:515-538`). Uniform straight dotted sides take the same
`DrawLineWithStyle` path, so they also start at the inset endpoint with phase 0
and get no SVG `stroke-dashoffset`. Dash intervals are emitted to 0.001px, not
the renderer's usual 0.1px, because they repeat along the whole side. Rounding
them would accumulate drift and erase the thick-dotted interval
`{0, gap + width - kEpsilon}` (`styled_stroke_data.cc:118-128`). That epsilon
keeps the last dot just inside the line end. Thin dotted collapsed edges (3px or less) use the
`EnforceDotsAtEndpoints` plan (`box_border_painter.cc:521-527`) over the full
snapped edge, which is the same helper the uniform-border painter uses.
Unit tests grade each decision stage, the browser test checks the
captured table contract, and `border-collapse-edge-graph` is the visual
integration discriminator. Table fragmentation remains tracked separately;
collapsed-table rows can be added to this scale/platform report once that
fragment model exists.
