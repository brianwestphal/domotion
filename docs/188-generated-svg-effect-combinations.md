# 188 — Generated SVG gradient, mask, and clip combinations

DM-2358 replaces the small hand-picked SVG effect cross-product with a
deterministic, source-linked pairwise corpus. The gate keeps the ownership
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
| marker placement and viewport transform | `layout/svg/layout_svg_resource_marker.cc:120-168` |
| non-scaling stroke host transform | `layout/svg/layout_svg_shape.cc:468-508` |

Those classes are not reconstructed from screenshot bounds. XML units and
viewports remain in the cloned SVG, affine transforms use the already captured
Blink-used transform, and the output Chromium instance executes native SVG
resource layout and paint.

## Generated corpus

`tools/svg-effect-combination-corpus.ts` generates 24 cases that cover all 953
pairs among these 18 axes:

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
- identity and affine transforms;
- independent fill/stroke/view mask origin and clip boxes;
- `auto`, percentage, and `cover` mask sizes;
- no-repeat, repeat-x, and space tiling; and
- add, subtract, intersect, and exclude composition.

The generator starts from the first uncovered value pair, then greedily fills
each remaining axis with the value that closes the most uncovered pairs. The
unit gate reruns the generator, requires byte-stable case ordering, proves all
953 pairs, and rejects any accidental `url(...) <geometry-box>` clip because
Blink parses a reference clip as an exclusive grammar branch.

Pairwise coverage is deliberate. It is much stronger than one row per feature
without turning CI into the full Cartesian product. Higher-order interactions
and any future effect class remain an explicit partial boundary.

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

Three destructive controls remove the newly preserved decisions from the final
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
- no element or transform-subtree raster replacing a case;
- no relevant capture warning and no emitted `<image>` escape;
- exact serialized unit classes, reference owners, native paint properties,
  and nested viewport structure;
- live acceptance of a bare URL clip and rejection of both URL-plus-box
  orderings;
- source-versus-final-SVG ink bounds within two device pixels, mean channel
  error at most 2, and at most 4% pixels beyond a 16-code channel difference;
  and
- all three destructive transitions moving at least 40 DPR-scaled pixels.

The focused local macOS run passed 48/48 DPR-1/2 rows. Every row had zero mean
channel error, zero changed pixels, and zero ink-bound delta; the stated bounds
remain fixed failure limits rather than values tuned to the result. The JSON
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
render production gains a new transition. Projective SVG ownership and
higher-order combinations beyond the enumerated pairwise surface remain
explicit future work.
