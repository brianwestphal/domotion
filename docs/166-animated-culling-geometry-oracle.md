---
id: "requirements/animated-culling-geometry-oracle"
title: "Animated culling geometry oracle"
kind: "evidence"
status: "current"
owners: ["layout","animation","platform-release"]
platforms: ["macos","linux","windows"]
tickets: []
code: [".github/workflows/animated-culling-geometry.yml"]
aliases: ["docs/166-animated-culling-geometry-oracle.md","doc-166"]
---

# Animated culling geometry oracle

`npm run culling:animated-geometry-oracle` is the independent live-Chromium
gate for animated viewBox culling. It grades an optimization, so its governing
invariant is one-sided: **production may retain paint conservatively, but it
must never hide an instant at which Chromium paints inside the final SVG
viewBox**.

## Two final-SVG legs

Every generated row starts from one `CapturedElement` tree and one set of
`IntraFrameAnimation` tracks. The oracle renders it twice through the normal
renderer and animator:

1. the reference SVG has no culling annotation or culling CSS; and
2. the compared SVG first runs `cullElementsOutsideViewBox`, then carries the
   production `display:none` decision or emitted `cull-*` visibility window.

The browser pauses every Web Animation and seeks both documents to the same
global scene time. On the reference leg it records the generated animation
group's object bbox, current transform, four transformed corners, screen rect,
and an alpha-trimmed screenshot ink rectangle. On the compared leg it records
the effective visibility through the complete ancestor chain. A row fails if
the declared Chromium paint state changes, if the production decision changes
class, or—most importantly—if a cull window hides any reference instant with
paint.

The alpha leg intentionally supplements `getBoundingClientRect()`: DOM bounds
do not include every shadow/filter expansion and do not narrow to clip or mask
paint. Screenshots are transparent and contain only the generated target, so
their alpha hull is an independent Chromium-painted ink observation.

## Generated matrix

The corpus contains enter, leave, and negative/non-activation rows for every
family below:

- SVG `fill-box`, `stroke-box`, and `view-box`, including asymmetric descendant
  geometry, outline stroke geometry, percentage/keyword/pixel origins, and
  signed scale;
- frozen author rotation and skew, including a box whose untransformed carrier
  is off-view but whose emitted affine wrapper enters;
- compatible function lists, incompatible/decomposition-only lists, and the
  non-commuting negative-scale-plus-translate discriminator;
- an entry interval centered at 50.5% that is narrower than the retired 2%
  sampling grid, plus independent narrow enter/leave controls;
- nested ancestor/child animation wrappers with shared timing, canceling
  motion, and independently delayed/duration tracks on the global clock;
- finite repeat, alternate direction, post-active fill, and cubic-bezier
  overshoot outside the nominal progress range;
- motion path as an explicit unsupported/retain channel. The browser moves the
  group via `offset-path`/`offset-distance` while computed `transform` remains
  `none`, proving why transform-only reconstruction is insufficient;
- planar `matrix3d`, affine-to-projective interpolation, near-`w=0`, and
  behind-plane retention;
- outset shadow and unknown pixel-moving filter visual overflow; and
- clip and mask enter/leave plus an all-transparent-mask non-activation row.

One-shot crossings often produce no narrow production class: the conservative
swept bound for the continuous interval intersects, so retaining the full
interval is correct. Repeat and independently timed partitions do emit windows;
the oracle checks their actual WAAPI visibility at paint and no-paint instants.
This distinction prevents an optimization-rate expectation from being mistaken
for the soundness contract.

## Mutation controls

The same browser run must make one declared discriminator for every family
move. Four controls directly replace a historical algorithmic choice:

- substitute `view-box` for the asymmetric generated `fill-box`;
- remove the animated ancestor from the independent-timing cancellation row;
- replace function-first interpolation with the retired component-lerped
  endpoint matrix;
- inspect only 0%, 2%, …, 98% on the 50.5% narrow crossing.

The remaining controls force a retained paint instant hidden for frozen static
geometry, mismatched transform lists, repeat/easing overshoot, motion path,
projective transforms, visual overflow, and clip/mask. Those controls prove
that conservative or `unknown` results are active fail-closed decisions rather
than unexercised branches. Corpus validation fails if any family loses its
control, and the runtime gate fails if any control stops moving Chromium ink.

## Fingerprints and platform gate

The command writes
`tests/output/animated-culling-geometry-<platform>.json` by default; `--json`
chooses another path. The report persists Chromium version and user agent,
OS/release, architecture, Node version, viewport, every DPR/zoom scenario, all
row observations, and mutation results. Defaults are DPR 1/2 crossed with CSS
zoom 1/1.25; `--dpr` and `--zoom` accept comma-separated positive values for a
narrow diagnostic run.

`.github/workflows/animated-culling-geometry.yml` runs the full matrix on
macOS, Linux, and Windows and uploads each fingerprinted report. This is a
decision/activation gate, not a replacement for the feature screenshot suite:
the latter still catches integration paint changes after the culler has proven
that it did not remove valid timeline paint.

The source model and unsupported boundary are audited in
[the animated viewBox culling audit](155-animated-viewbox-culling-audit.md), and
the broader proof ordering is defined by
[the Chromium parity verification program](129-chromium-parity-verification-program.md).
