---
id: "requirements/affine-text-baseline-protocol"
title: "Blink affine text baseline and fragment-origin protocol"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2544","DM-2546","DM-2547"]
code: [".github/workflows/text-transform-parity.yml","src/capture/text-fragment-geometry.test.ts","src/capture/text-fragment-spans.test.ts","src/capture/text-line-origin.test.ts","src/capture/text-line-origin.ts","src/capture/text-paint-geometry-cdp.ts","src/render/text-affine.test.ts","src/render/text-affine.ts","tests/text-affine-baseline-protocol-oracle.test.ts","tests/text-affine-line-origin-workflow.test.ts","tests/text-affine-render.e2e.test.ts","tests/text-fragment-span-oracle.test.ts","tests/text-fragment-span-workflow.test.ts","tests/text-paint-geometry.e2e.test.ts"]
aliases: ["docs/215-affine-text-baseline-protocol.md","doc-215"]
---

# Blink affine text baseline and fragment-origin protocol

DM-2544 decoded Blink's text-paint origin without using pixels. DM-2547 shipped
that result as the versioned `CapturedTextPaintLineOrigin` record, and DM-2546
now supplies the exact physical `FragmentItem`/DOM UTF-16 ownership needed
before that record is correlated. One `LayoutText` may expose several physical
items because of fallback, bidi, ligatures, wrapping, `::first-letter`, or
vertical layout; capture now splits ordinary segments and shaped geometry on
those source spans instead of collapsing them or selecting a nearby rectangle.

Both records are built in the same transform-neutral frame, validated and
consumed once, and only then mapped through the captured affine paint matrix.
No raster threshold, visual tolerance, or native glyph antialiasing rule
changed. Genuine duplicate/overlapping ownership still fails closed to one
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
- `core/layout/inline/fragment_item.h:448-451` owns each item's half-open
  `StartOffset()`/`EndOffset()`; `fragment_item.cc:1217-1241` derives its full
  local rectangle from the corresponding `ShapeResult` interval.
- `core/layout/layout_text.cc:556-637` walks
  `MoveToNextForSameLayoutObject()`, clamps the DOM range to each item, and
  emits the full local rectangle exactly when the queried range covers the
  complete item.
- `core/dom/range.cc:1686-1742` handles the separate first-letter
  `LayoutTextFragment`; `core/inspector/inspector_highlight.cc:1941-1967`
  routes `DOM.getContentQuads` through the same `LayoutText` quad traversal.
- Chromium pins HarfBuzz `511df88b82e697cd2a0f1f0635787aa0b18bddbb`;
  HarfBuzz clusters remain original-text indices. The renderer evidence pins
  vendored HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`
  and Skia `62efacd37737505732dbe3d8daa62abd679626a1`.

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

## Exact FragmentItem source record

`src/capture/text-paint-geometry-cdp.ts` probes the authored Text node while
the same-frame transform neutralizer is active. For each full
`Range.getClientRects()` rectangle, the first prefix exposing that rectangle
gives its exact end offset and the last suffix exposing it gives its exact
start offset. Duplicate rectangles are tracked by occurrence rank. Isolating
the recovered interval must reproduce exactly one identical full rectangle;
there is no nearest-rectangle or pixel-distance branch.

The ordered Range records are joined to ordered `DOM.getContentQuads` records
by exact width, height, all four edges, and one shared frame translation. The
only legitimate unmatched Range record is the separately styled first-letter
item, which CDP omits from the original `LayoutText` node. Multiple possible
ordered joins, crossing spans, duplicate ownership, or a transformed-length
source chunk crossing an item boundary are genuine ambiguity and fail closed.

```ts
interface CapturedTextFragmentSourceSpan {
  source: "blink-range-fragment-utf16-v1";
  sourceTextNodeIndex: number;
  physicalFragmentIndex: number;
  domUtf16Span: [start: number, end: number];
  neutralRangeRect: { x: number; y: number; width: number; height: number };
  cdpQuadIndex?: number; // absent only for ::first-letter
  role: "ordinary" | "first-letter";
}
```

Capture-script `TextSegment.sourceMapping` keeps authored and rendered UTF-16
coordinates distinct, including length-changing `text-transform`. The split
happens before `buildCapturedTextPaintGeometry` solves the affine matrix.
Per-code-unit origins, advances and vertical arrays are sliced with the text;
raster-glyph and dotted-circle indices are rebased; an atomic raster or glyph
cluster crossing the boundary is rejected. Each ordinary
`CapturedTextPaintFragment` references exactly one source fragment and retains
its source span, shaped origins/advances, inline offset, and structured line
origin. `src/render/text-affine.ts` validates the complete source record and
consume-once ownership before paint.

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

The 2026-08-24 local line-origin run passed 7/7 rows with verdict
`source-exact-line-origin`: fractional horizontal, nested zoom, mixed-script
physical fragments, vertical-rl, vertical-lr, sideways-rl, and sideways-lr.
All rows independently agree on neutral Range geometry, CDP quads, captured
record fields, the writing map, decoded physical origin, transform-origin-aware
matrix, and emitted origin. The formerly collapsed mixed-script row now retains
all `3/3/3` Range/CDP/captured fragments as vectors.

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

Run the exact source-span/shaping oracle with:

```sh
npm run transform:text-fragment-spans -- --json /tmp/text-fragment-spans.json
```

The local headless run passed 2/2 rows with verdict
`exact-fragment-span-agreement`. Its horizontal case combines one LayoutText,
Latin/Arabic/CJK fallback, Hebrew bidi, a pinned `fi` ligature, wrapping,
styled first letter, nested zoom, and nested transforms; Range/CDP/source/paint
cardinality is `7/6/7/6`. Its vertical-rl case retains `4/4/4/4`. The report
records exact DOM spans, clusters, gids, advances, offsets, source face keys,
per-code-unit shaped origins/advances, and physical fragment origins. It
independently rejects collapsed fragment sets, reordered quads, and a wrong
source span.

Neither oracle takes a screenshot or reads a pixel. Native macOS, Linux, and
Windows jobs in `.github/workflows/text-transform-parity.yml` run both and
retain the structured reports before the existing final-ink integration leg.
The release job depends on all three matrix rows; there is no headed browser
flag or FragmentItem/line-origin tolerance knob.

## Evidence

- `src/capture/text-line-origin.test.ts` covers fractional decomposition, all
  five writing modes, provenance, wrong-plane, origin-drop, and double-zoom
  rejection.
- `src/capture/text-fragment-geometry.test.ts` proves capture emits the v2
  record for horizontal and vertical fragments; `src/capture/text-fragment-spans.test.ts`
  proves exact joins, UTF-16 splits, transformed-length maps, first-letter
  deduplication, and collapse/reorder/wrong-span rejection.
- `src/render/text-affine.test.ts` proves the record is consumed once before
  the residual affine matrix and malformed records fail closed.
- `tests/text-affine-baseline-protocol-oracle.test.ts` pins the seven-row/eight-
  mutation corpus; `tests/text-affine-line-origin-workflow.test.ts` pins the
  native release wiring.
- `tests/text-fragment-span-oracle.test.ts` pins the source and shaping corpus;
  `tests/text-fragment-span-workflow.test.ts` pins the required native logical
  artifact.
- `tests/text-paint-geometry.e2e.test.ts` exercises the comprehensive
  horizontal and vertical multi-item captures with explicit headless Chromium.
- `tests/text-affine-render.e2e.test.ts` retains the existing visual integration
  safety leg without changing its tolerance.

DM-2547 closes the scalar/schema-plane gap and DM-2546 closes ordinary
physical-fragment/source-span splitting. Generated pseudo records remain their
separate direct-consumer path; no pixel fitting belongs in either protocol.
