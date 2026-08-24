# Blink affine text baseline and fragment-origin protocol

DM-2544 decoded Blink's text-paint origin without using pixels. DM-2547 now
ships that result as the versioned `CapturedTextPaintLineOrigin` record used by
ordinary affine text. The record is built in the transform-neutral plane,
validated and consumed once, and only then mapped through the captured affine
paint matrix. No raster threshold, visual tolerance, or native glyph
antialiasing rule changed.

The remaining, separate boundary is DM-2546: one `LayoutText` may expose
several physical `FragmentItem`s while the current normal capture has one
line-grouped `TextSegment`. Ambiguous cardinality still fails closed to a
Chromium surface.

## Pinned source boundary

The protocol is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `core/paint/text_fragment_painter.cc:62-87` constructs the physical fragment
  rectangle by rounding the containing paint offset and retaining the
  fragment-relative delta.
- `core/paint/text_fragment_painter.cc:506-529` selects the scaled primary font,
  takes integer `FontMetrics::Ascent`, and creates the line-relative origin.
- `platform/fonts/simple_font_data.cc:416-428` and
  `platform/fonts/font_metrics.h:109-166` establish that this is `Ascent`, not
  `FixedAscent`.
- `core/paint/line_relative_rect.cc:19-75` owns the writing-mode map.
- `core/paint/paint_property_tree_builder.cc:1370-1456` and
  `core/style/computed_style.cc:1415-1489` apply the later reference-box and
  transform-origin-aware matrix.

The construction order is:

```text
physical top = rounded containing paint offset top + fragment-relative top
line-relative origin = (line left, physical top + integer primary ascent)
physical baseline = writing-mode rotation(line-relative origin)
painted baseline = captured affine paint matrix(physical baseline)
```

Ascent, paint snap, and writing rotation therefore belong before the CSS
affine matrix. Effective CSS zoom remains active while Blink shapes and lays
out the neutral fragment; it is recorded as provenance and is not applied a
second time.

## Versioned record

`src/capture/text-line-origin.ts` produces this record for every correlated
ordinary text fragment:

```ts
interface CapturedTextPaintLineOrigin {
  source: "blink-text-fragment-line-origin-v1";
  space: "pre-css-transform-viewport";
  roundedContainingPaintOffsetTop: number;
  fragmentRelativeTop: number;
  primaryFontIntegerAscent: number;
  lineRelativeTextOrigin: { lineLeft: number; lineOver: number };
  writingModeRotation: [number, number, number, number, number, number];
  physicalBaselinePoint: { x: number; y: number };
  effectiveZoom: number;
  provenance: {
    chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3";
    physicalBox: "core/paint/text_fragment_painter.cc:62-87";
    primaryFontAscent: "core/paint/text_fragment_painter.cc:506-529";
    writingModeRotation: "core/paint/line_relative_rect.cc:19-75";
    transformOrigin: "core/style/computed_style.cc:1415-1489";
    decomposition: "normalized-neutral-fragment-top";
  };
}
```

CDP exposes the completed neutral fragment, not Blink's private
`paint_offset` and `parent_offset` operands. The record consequently stores a
source-equivalent canonical decomposition: `round(neutralTop)` plus the exact
unrounded remainder. Their sum is the observed physical top. The provenance
labels this normalization explicitly instead of claiming private operands were
observed.

`CapturedTextPaintGeometry` and each fragment use
`blink-text-fragment-affine-v2`; the old scalar `baseline` and duplicate
top-level `effectiveZoom` are gone. `src/render/text-affine.ts` validates the
record against its neutral segment, restores the decoded origin/ascent, and
then computes `inverse(emitted CTM) * paintMatrix`. Wrong schema, plane,
rotation, snap, provenance, zoom, or decoded point fails closed before SVG
paint.

## Writing-mode maps

For fragment bounds `(left, top, width, height)`, horizontal-tb is identity.
Vertical-rl, vertical-lr, and sideways-rl use Blink's clockwise map:

```text
[0, 1, -1, 0, left + top + width, top - left]
```

Sideways-lr uses the opposite rotation:

```text
[0, -1, 1, 0, left - top, left + top + height]
```

The matrices and decoded physical points are exact unit-test facts; they are
not inferred from final glyph bounds.

## Logical oracle and destructive controls

Run the headless logical oracle with:

```sh
npm run transform:text-baseline-protocol -- --json /tmp/text-baseline-protocol.json
```

The 2026-08-24 local run passed 7/7 rows with verdict
`source-exact-line-origin`: fractional horizontal, nested zoom, mixed-script
safe boundary, vertical-rl, vertical-lr, sideways-rl, and sideways-lr. All
vector rows independently agree on neutral Range geometry, CDP quads, captured
record fields, the writing map, decoded physical origin, transform-origin-aware
matrix, and emitted origin. The mixed-script row proves the already-ticketed
DM-2546 `3 -> 1` cardinality gap and retains the outer Chromium surface.

Eight destructive controls are mandatory:

| Mutation | Local discriminator |
| --- | ---: |
| post-transform AABB top plus ascent | `1.809447` CSS px |
| apply ascent after affine mapping | `4.454658` CSS px |
| snap after affine mapping | `0.255442` CSS px |
| apply effective zoom twice | `5.956938` CSS px |
| drop transform-origin translation | `62.408470` CSS px |
| collapse mixed physical fragments | `3 -> 1` fragments |
| interpret a vertical origin in the horizontal plane | `22.561028` CSS px |
| drop the fractional fragment-relative top | `0.375000` CSS px |

The oracle never takes a screenshot or reads a pixel. Native macOS, Linux, and
Windows jobs in `.github/workflows/text-transform-parity.yml` run it and retain
the structured report before the existing final-ink integration leg. The
line-origin release job depends on all three matrix rows; there is no headed
browser flag or line-origin tolerance knob.

## Evidence and remaining boundary

- `src/capture/text-line-origin.test.ts` covers fractional decomposition, all
  five writing modes, provenance, wrong-plane, origin-drop, and double-zoom
  rejection.
- `src/capture/text-fragment-geometry.test.ts` proves capture emits the v2
  record for horizontal and vertical fragments.
- `src/render/text-affine.test.ts` proves the record is consumed once before
  the residual affine matrix and malformed records fail closed.
- `tests/text-affine-baseline-protocol-oracle.test.ts` pins the seven-row/eight-
  mutation corpus; `tests/text-affine-line-origin-workflow.test.ts` pins the
  native release wiring.
- `tests/text-affine-render.e2e.test.ts` retains the existing visual integration
  safety leg without changing its tolerance.

DM-2547 closes the scalar/schema-plane gap. DM-2546 alone owns physical
fragment/source-span splitting; no pixel fitting belongs in either protocol.
