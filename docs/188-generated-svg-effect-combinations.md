---
id: "requirements/generated-svg-effect-combinations"
title: "188 — Generated SVG gradient, mask, and clip combinations"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2358","DM-2538"]
code: [".github/workflows/svg-effect-combinations.yml","src/capture/script/walker/inline-svg.ts","tools/svg-effect-combination-corpus.ts"]
aliases: ["docs/188-generated-svg-effect-combinations.md","doc-188"]
---

# 188 — Generated SVG gradient, mask, and clip combinations

DM-2358 replaced the small hand-picked SVG effect cross-product with a
deterministic, source-linked pairwise corpus. DM-2538 extends it with
source-selected triples and projective SVG ownership. The gate keeps the ownership
boundary explicit: Domotion makes Chromium's computed SVG paint choices
self-contained, while the output browser continues to own gradient, clip,
mask, marker, viewport, and stroke geometry.

## Source-owned classes

The matrix is pinned to Chromium revision
`7d859f271cbda744098ac69f44978d4edfa62be3`.

| Decision | Pinned Blink owner |
| --- | --- |
| `gradientUnits` object bounding box versus user space | `layout/svg/layout_svg_resource_gradient.cc:100-141` |
| SVG `sRGB` versus `linearRGB` interpolation | `layout/svg/layout_svg_resource_gradient.cc:129-138` |
| fill, stroke, and local viewport effect boxes | `layout/svg/svg_resources.cc:53-102` |
| `clipPathUnits` mapping | `layout/svg/layout_svg_resource_clipper.cc:229-248` |
| `maskUnits` and `maskContentUnits` | `layout/svg/layout_svg_resource_masker.cc:73-110` |
| CSS mask positioning, clipping, tiling, and composition | `paint/svg_mask_painter.cc:115-190` |
| filter data cache and effect reference box | `layout/svg/svg_resources.cc:357-421` |
| joint clip/mask paint-property invalidation | `layout/svg/layout_svg_model_object.cc:145-177` |
| marker placement and viewport transform | `layout/svg/layout_svg_resource_marker.cc:120-168` |
| non-scaling stroke host transform | `layout/svg/layout_svg_shape.cc:468-508` |
| transform/reference-box dependency | `layout/svg/transform_helper.cc:64-176` |

Those classes are not reconstructed from screenshot bounds. XML units and
viewports remain in the cloned SVG, affine transforms use the already captured
Blink-used transform, and the output Chromium instance executes native SVG
resource layout and paint.

## Generated corpus

`tools/svg-effect-combination-corpus.ts` generates 37 cases that cover all 1,088
pairs among 19 axes, including URL filters and identity/affine/projective
transform classes. It additionally covers all 83 values of six deliberately
selected three-axis dependencies:

- mask units × clip units × reference box;
- filter route × clip route × mask units;
- gradient units × interpolation × filter route;
- markers × vector effect × transform;
- transform × reference box × clip route; and
- viewport × transform × filter route.

The remaining axes include:

- rectangle, circle, and path owners;
- linear and radial gradients;
- gradient, clip-path, mask-region, and mask-content
  `objectBoundingBox`/`userSpaceOnUse` units;
- native SVG `sRGB`/`linearRGB` gradient interpolation;
- URL clips plus circle/inset basic clips;
- fill/stroke/view reference boxes;
- root and nested SVG viewports;
- no markers versus start/mid/end markers;
- ordinary and non-scaling strokes;
- identity, affine, and projective transforms;
- independent fill/stroke/view mask origin and clip boxes;
- `auto`, percentage, and `cover` mask sizes;
- no-repeat, repeat-x, and space tiling; and
- add, subtract, intersect, and exclude composition.

The generator starts from the first uncovered value pair, then greedily fills
each remaining axis with the value that closes the most uncovered pairs. The
unit gate reruns the generator, requires byte-stable case ordering, proves all
953 pairs, and rejects any accidental `url(...) <geometry-box>` clip because
Blink parses a reference clip as an exclusive grammar branch.

The higher-order set comes from the cited Blink paint-property and resource
dependencies. It is deliberately not the full three-way Cartesian product,
and this gate makes no claim of exhaustive CSS coverage.

## Production transition and discriminators

The generated matrix exposed one real capture seam. External stylesheets could
select `marker-start`/`marker-mid`/`marker-end`,
`vector-effect:non-scaling-stroke`, or
`color-interpolation:linearRGB`, but those computed values were absent from the
self-contained `svgContent`. XML-authored values survived, which made the old
curated fixtures miss the transition.

`src/capture/script/walker/inline-svg.ts` now writes those resolved computed
properties as inline declarations. Inline style is intentional: it remains the
winner when external CSS overrode an authored presentation attribute. URL
references are still namespaced by the existing SVG inliner. No marker,
non-scaling-stroke, or interpolation geometry moved into Domotion.

Before any screenshot is scored, four destructive logical controls remove a
filter definition, forge a clip reference, remove a gradient reference, and demote a
projective owner. Exact resource IDs/references, owner class, and transform
class must reject all four. Three later paint controls remove the preserved
decisions from the final
SVG. On the local DPR-1 run they changed 5,425 marker pixels, 1,836
non-scaling-stroke pixels, and 11,326 interpolation pixels. At DPR 2 they
changed 20,951, 5,742, and 45,548 pixels. A future accidental no-op therefore
cannot pass only because the ordinary source and output happen to look alike.

## Gate contract and evidence

Run:

```sh
npm run paint:svg-effect-combinations -- --dpr 1,2 \
  --json tests/output/svg-effect-combinations/local/report.json
```

The oracle requires all of the following:

- one self-contained native SVG owner for every generated case;
- no raster owner for identity/affine cases and exactly one Chromium-owned
  projective raster for each projective case;
- exact gradient/clip/mask/marker/filter resource graph, reference identity,
  transform class, and all four destructive logical mutations before pixels;
- no relevant capture warning and no emitted `<image>` escape;
- exact serialized unit classes, reference owners, native paint properties,
  and nested viewport structure;
- live acceptance of a bare URL clip and rejection of both URL-plus-box
  orderings;
- source-versus-final-SVG ink bounds within two device pixels, mean channel
  error at most 2, and at most 4% pixels beyond a 16-code channel difference;
  and
- all three destructive transitions moving at least 40 DPR-scaled pixels.

The DM-2538 focused local macOS headless run passed all 37 DPR-1 rows after the
logical gate. The existing fixed pixel limits were not changed or fitted; they
remain downstream integration evidence, while the resource/owner/transform
record is the parity proof. The JSON
records Chromium, Playwright, Node, OS/release/architecture, viewport, DPRs,
thresholds, source paths, cases, pair coverage, grammar controls, row metrics,
and mutation deltas.

`.github/workflows/svg-effect-combinations.yml` runs the same DPR-1/2 producer
on native macOS, Linux, and Windows runners and uploads each fingerprinted JSON
report even on failure. The local result establishes the implementation; the
workflow is the durable cross-platform evidence collector.

## Boundary

This matrix does not authorize geometry approximations or a looser visual
tolerance. A new SVG effect class must first be tied to its Blink owner, added
as a corpus dimension, and given a destructive discriminator if capture or
render production gains a new transition. The six enumerated dependency triples
and current projective root boundary are covered; other higher-order
combinations and future effect classes remain explicit partial boundaries.
