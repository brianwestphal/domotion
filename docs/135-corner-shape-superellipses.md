---
id: "requirements/corner-shape-superellipses"
title: "CSS corner-shape superellipses"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: []
tickets: ["DM-2314","DM-2315","DM-2316","DM-2317"]
code: ["tests/fixtures/html-test/corner-shape-superellipses.html"]
aliases: ["docs/135-corner-shape-superellipses.md","doc-135"]
---

# CSS corner-shape superellipses

Status: shipped by DM-2315.

## Requirement

Domotion captures Chromium's computed physical `corner-*-shape` longhands and
reconstructs every non-round corner as vector SVG. The supported computed
values are `notch`, `scoop`, `bevel`, `round`, `squircle`, `square`, and
`superellipse(<number>)`. Different physical corners may use different shapes,
radii, and horizontal/vertical radii. A missing field in an older capture is
`round`, preserving snapshot compatibility.

This is a geometry feature, not a list of visually tuned keyword paths. The
renderer stores Blink's corner curvature (the superellipse exponent), and all
background, clipping, border, and shadow consumers use the shared contour
path. Zero-sized radii use round effective curvature, as Blink does.

## Chromium transcription

The implementation is pinned to Chromium `7d859f271c`:

- `external/chromium/third_party/blink/renderer/core/style/superellipse.h`:
  computed parameter to exponent is `2^clamp(parameter, -16, 16)`; the named
  shapes are merely parameter aliases.
- `third_party/blink/renderer/platform/geometry/path_builder.cc`:
  `ApproximateSuperellipseHalfCornerAsBezierCurve` supplies one fitted pair of
  cubic segments for all non-degenerate convex curvatures. Concave contours
  invert the corner and curvature before using that same construction.
- `external/chromium/third_party/blink/renderer/core/paint/contoured_border_geometry.cc`:
  `EffectiveCurvature` and the opposite-corner hull intersection constraint.
- `third_party/blink/renderer/platform/geometry/contoured_rect.cc`:
  `Corner::AlignedToOrigin` keeps inset contours aligned to the original
  border contour instead of inventing a second unrelated curve.

The SVG path retains Blink's exact degeneracies: bevel is one chord, square is
two edge segments, notch is the inverse square through the inner corner, and
round stays an elliptical arc. Other values use the source's seven fitted
constants and two cubic segments per corner.

## Capture and rendering contract

Capture stores `cornerTopLeftShape`, `cornerTopRightShape`,
`cornerBottomRightShape`, and `cornerBottomLeftShape`. These are physical
properties on purpose: layout has already resolved writing-mode-dependent
logical declarations when `getComputedStyle` is read.

`parseCornerRadii` performs the ordinary CSS adjacent-edge radius constraint,
then applies Blink's additional opposite-hull constraint when any contour is
concave. `insetCornerRadii` retains the origin contour and accumulated physical
insets, allowing path emission to apply `AlignedToOrigin` for border and clip
geometry. Round-only captures retain the prior `<rect rx>` and SVG arc path.

## Verification

- Unit tests pin named/custom parameter mapping, cubic activation, degenerate
  paths, asymmetric physical corners, zero-radius effective curvature, and the
  concave opposite-hull constraint.
- `tests/fixtures/html-test/corner-shape-superellipses.html` is copied into the
  external corpus in CI and composes backgrounds, thick borders, shadows,
  asymmetric radii, custom parameters, and overlapping concave corners.
- The focused visual comparison is diagnostic rather than a source of
  constants. Remaining antialiasing and SVG-stroke differences are classified
  separately from contour decision failures.

## Mixed border sides

DM-2316 extends the contour to non-uniform side painting. Hyperellipses
(`curvature >= 2` at all four corners) take Blink's general
`BoxBorderPainter::ClipBorderSidePolygon` path: each physical side is normalized
to top-side coordinates, its two inner points move from the unadjusted inner
rect corners to the intersections between the corner miters and inner bevel
hulls, and the resulting quad clips the shared annular contour. Rotation back
to physical coordinates is geometry-only; there are no per-side constants.

Concave/mixed-curvature corners continue through the close-edge miter/opposite
bound introduced for ordinary curvature by DM-2314. The composed fixture
crosses unequal widths and four colors through both a squircle and a scoop;
both ordinary-sized mixed cases are visually correct. A deliberately narrow,
overlapping scoop case exposed an earlier prerequisite rather than a side-quad
error: Blink intersects four aligned inset-corner paths with the target rect,
whereas one joined SVG path crosses its lobes.

DM-2317 transcribes that operation without flattening curves. Each of Blink's
TR, BR, BL, and TL corner constraint paths becomes an SVG `<clipPath>`; nesting
the four clips produces intersection semantics, and a luminance mask subtracts
that exact inner shape from the outer contour. This also preserves Blink's
ordinary close-edge tangent/miter partition without new side rules. The full
composed fixture, including the narrow overlap activation case, is now clean at
**0 regions / 0.00%**.
