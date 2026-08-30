---
id: "requirements/source-owned-summary-disclosure-markers"
title: "Source-owned summary disclosure markers"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2457"]
code: [".github/workflows/summary-disclosure-marker-parity.yml","src/capture/summary-marker-cdp.ts","src/render/element-tree-to-svg.ts","src/render/form-controls.ts","src/render/list-marker-geometry.ts"]
aliases: ["docs/180-source-owned-summary-disclosure-markers.md","doc-180"]
---

# Source-owned summary disclosure markers

DM-2457 removes the separate `<details>` triangle approximation. A default
`<summary>` now enters the same Blink-derived list-marker route as other symbol
markers, but only after capture has correlated Chromium's real `::marker`
pseudo and recorded its first-line paint fragment.

## Pinned source boundary

The repository's Chromium checkout is pinned at
`7d859f271cbda744098ac69f44978d4edfa62be3`. The implemented boundary follows:

- `third_party/blink/renderer/core/layout/list/list_marker.cc`:
  `DisclosureSymbolSize` is specified marker font size × effective zoom ×
  `0.66`; `RelativeSymbolMarkerRect` positions the square from the primary-font
  ascent and converts it through `ToLineWritingMode`.
- `third_party/blink/renderer/core/paint/text_fragment_painter.cc`:
  closed markers point toward physical inline-end, open markers toward physical
  block-end, using Blink's exact left/right/up/down three-point tables.
  Disclosure paths consume the fractional `LayoutUnit` rectangle directly;
  the snapped rectangle is used by disc/circle/square paint.
- `third_party/blink/renderer/core/html/resources/html.css`: the first summary
  child is a list item with `disclosure-closed`, switching to
  `disclosure-open` for open details.

`DOM.getContentQuads` proves the pseudo identity and its axis-aligned box.
`DOMSnapshot` supplies the anonymous marker text-fragment origin actually passed
to `PaintSymbol`. This distinction is observable for an outside marker whose
principal line box is taller than the marker: the aggregate pseudo quad begins
six CSS pixels above the paint fragment in the focused row.

## Capture and paint contract

`src/capture/summary-marker-cdp.ts` attaches `summaryMarkerGeometry` only for an
unsuppressed, untransformed Chromium marker with one pseudo node, one content
quad, and one authoritative paint-fragment row. The record contains the source
fragment rectangle, primary-font ascent, specified font size, cumulative zoom,
color, list type/position, writing mode, and direction. Missing or ambiguous
protocol facts warn and omit disclosure paint; there is no details-box fallback.

`src/render/element-tree-to-svg.ts` admits a summary to the generic marker route
only when that record exists. `src/render/list-marker-geometry.ts` transcribes
the relative square and physical orientation. A higher-level authoritative
surface still wins: the existing affine-text boundary promotes the
`sideways-lr` row to `transformSubtreeRaster`, which already contains the
Chromium marker and therefore must not receive a duplicate vector polygon.

`src/render/form-controls.ts` now renders only details content visibility; the
old `max(8, markerFontSize * 0.7)`, child-centering, and ad hoc triangle branch
is deleted. `list-style:none`, transparent markers, and author replacements
remain authoritative no-marker states. `display:flex` has no native marker
pseudo in pinned Chromium; the known custom-pseudo flex-position residual is a
separate generated-content concern.

## Evidence gate

`npm run paint:summary-marker-oracle` captures and compares live Chromium with
the generated SVG at DPR 1 and 2. Its rows cover open/closed, nested and
exclusive details, marker font/color, inside/outside, LTR/RTL, horizontal,
vertical-rl, vertical-lr, sideways-rl/lr, mixed line heights, fractional
origins, zoom, and suppression/replacement controls. Physical ink edges may
differ by at most one device pixel; the small-triangle area check permits eight
device pixels or 8%, whichever is larger, to account for a single quantized
antialias boundary row.

`.github/workflows/summary-disclosure-marker-parity.yml` runs the source/unit
checks and this browser oracle independently on macOS, Linux, and Windows.
`08-details-summary` and `08-deep-details-accordion` remain composed negative
controls for the retired approximation.
