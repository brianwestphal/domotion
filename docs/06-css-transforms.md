---
id: "requirements/css-transforms"
title: "Domotion: CSS 2D transforms"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2473", "DM-2475", "DM-WTSX24", "DM-S2EA2P", "DM-PYF5QN", "DM-9VS6RT", "SK-1091", "SK-1127"]
code:
  [
    "src/capture/script/index.ts",
    "src/capture/script/walker/transforms.ts",
    "src/capture/script/walker/border-paint-snap.ts",
    "src/capture/raster-viewport-space.ts",
    "src/capture/frozen-transform-neutralizer.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/stacking.ts",
    "src/render/transforms.ts",
  ]
aliases: ["docs/06-css-transforms.md", "doc-06"]
---

# Domotion: CSS 2D transforms

> **2026 source audit:** text inside transformed HTML is not exactly represented
> by the current cumulative scalar/geometric-mean correction. Blink keeps
> zoom-adjusted shaped text in local fragment space and applies the complete
> signed transform in the paint property tree. Rotation, skew, reflection,
> nested origins, and anisotropic scale therefore require captured fragment
> geometry plus an affine matrix; non-affine planes retain the existing outer
> Chromium raster boundary. See
> [the exact text-transform geometry audit](159-exact-text-transform-geometry-audit.md).

Requirements for applying CSS `transform` to rendered SVG element groups in Domotion. Origin: SK-1127 (follow-up from SK-1091). Today our pipeline reads `cs.transform` into `el.styles.filter` (via the existing CSS filter pass-through) but only `transform: translate(…)` round-trips correctly because translation is absorbed by the captured `getBoundingClientRect` position. `rotate`, `scale`, `skew`, and `matrix` render as axis-aligned bounding boxes — the box is in the right viewport position but its internal contents are upright instead of rotated/scaled/skewed.

## Why now

`21-transform-2d.html` shows a grid of rotated and scaled boxes, each with text and a colored border. Our capture has each box at the correct on-page position but renders the internals (border, text, background) un-transformed, so a 30°-rotated red-bordered card with the word "rotate" renders as an upright red-bordered card with un-rotated text. The diff (~2.79%) is dominated by these orientation mismatches.

## Goals

- Capture `cs.transform` and `cs.transformOrigin` per element.
- For non-`none` transforms, wrap the element's rendered `<g>` in an SVG transform that matches Chrome's painted result.
- Compose CSS transforms into SVG transform syntax verbatim where possible (rotate, scale, translate, skew, matrix all share names with SVG).
- Honor `transform-origin` by translating to the origin, applying the transform, and translating back.
- Nested transforms compose naturally because each captured element's `getBoundingClientRect` already reflects the parent's transform — so each element only needs to apply its OWN transform, not its ancestors'.

## Capture changes

`CapturedElement.styles` adds:

- `transform: string` — the CSS `transform` value (e.g. `rotate(30deg)`, `scale(1.5)`, `matrix(1, 0.5, 0, 1, 0, 0)`).
- `transformOrigin: string` — the resolved origin (Chrome returns `Npx Mpx` or `Npx Mpx Npx`).

Both come from `getComputedStyle`. Note: Chrome returns the **computed** transform which preserves percentages on translate (e.g. `translate(50%, 0)` stays as `translate(50%, 0)`); the `getComputedStyle` resolved value is in pixels for translate-percent IF the element has a fixed size at capture time, but for safety the renderer should resolve the percent against the element's box if it sees one.

Important subtlety: `getBoundingClientRect()` returns the **transformed** box (the bounding rect of the rotated/scaled element on the screen). If we apply our own transform on top of that, the result is double-transformed. The simpler path is to capture the **untransformed** box and apply the transform ourselves:

- Use `el.getBoxQuads()` or `el.style.transform = "none"; rect = el.getBoundingClientRect(); el.style.transform = original` to read the pre-transform rect. The latter is hacky; the former is the right primitive but Chromium-specific.

Recommendation: keep using the transformed rect for layout (it's what Chrome painted, so paint-order and z-stacking work) and apply the transform around (rect.center) so the rendered group rotates/scales around its visual center. This is approximate for non-uniform transforms but works for the common rotate/scale cases.

## Render changes

In `src/render/element-tree-to-svg.ts` `renderElement`, around the existing `<g>` group wrapper that hosts opacity / filter / blend-mode:

1. Parse `el.styles.transform`. If `none`, skip.
2. Resolve `transform-origin` to absolute viewport coords (origin's `(ox, oy)` = `el.x + parsed-x`, `el.y + parsed-y`).
3. Wrap the element's group in `<g transform="translate(ox, oy) <css-transform> translate(-ox, -oy)">`. CSS `rotate(30deg)` → SVG `rotate(30)`. CSS `scale(2)` → SVG `scale(2)`. CSS `translate(10px, 5px)` → SVG `translate(10, 5)`. CSS `matrix(a,b,c,d,e,f)` → SVG `matrix(a b c d e f)` (space-separated). CSS `skew(Xdeg, Ydeg)` → SVG `skewX(X) skewY(Y)`.
4. Multiple comma-separated transform functions in CSS apply left-to-right; SVG's `transform` attribute also applies left-to-right when functions are space-separated. Keep the order verbatim.

## Edge cases

- Static 3D transforms (`rotate3d`, `translate3d`, `perspective`, `matrix3d`) are measured as final border-plane corners while Blink's live transform tree is intact. An affine `matrix3d()` remains a nested vector matrix. A true projective fourth corner, preserve-3d depth composition, and backface/flattening paint instead activate a Chromium subtree snapshot: SVG transform attributes cannot perform perspective division or reproduce a 3D rendering context. Blink's _used_ preserve-3d rendering-context root is the smallest owner; `perspective` alone does not create a rendering context, and an ordinary, explicit-flat, or grouping-property intermediary breaks propagation. The current descendant-union owner selector still climbs past those breaks and is a known partial boundary documented by [the nested projective-context audit](189-nested-projective-context-ownership.md). Atomic one-image emission is already enforced.
- **Audited inline-SVG exception:** a captured DOM inline `<svg>` is emitted as opaque cloned markup, so its descendants use a dedicated source-owned boundary. Blink-flattened SVG graphics-child transforms are captured from correlated used CTMs, stripped of nested-viewport intrinsic geometry, serialized once as valid `matrix(a b c d e f)`, and verified in an isolated clone. Unavailable/singular correlation fails closed to the same outer Chromium surface used by a projective root or HTML 3D inside `<foreignObject>`; no raster owner remains below the clone that suppresses it. [Doc 162](162-inline-svg-3d-transform-audit.md) records the shipped DM-2473/2474 boundary and DM-2475's hard macOS/Linux/Windows logical-plus-final-SVG pixel gate at DPR 1/2. [Doc 186](186-animated-3d-frame-state-parity.md) ships the matching exact animation-frame protocol and native DPR-1/2 gate.
- **Animated 3D frames:** direct tree capture accepts `animationTimeMs`. It pauses CSS/WAAPI and SMIL timelines before every prepass, records the exact same-frame CDP content/border quad, composed transform/origin/perspective/style, fourth-corner residual, and selected raster owner, and rejects a drifting/refused/non-document timeline. Non-affine frames remain atomic Chromium images; no apparent 2D submatrix is emitted.
- Computed `perspective` and `perspective-origin` are captured independently. `perspective-origin` is the resolved border-box point (for example `15% 70%` on a 200×120 border box becomes `30px 84px`), but it changes neither stacking nor containing-block ownership when perspective computes to `none`.
- `transform-style: preserve-3d` remains a fixed-position containing-block signal even when a grouping property such as `overflow:hidden` forces its **used** transform style to flat. Fixed-containing-block ownership follows the computed value, exactly as Blink's containing-block predicate does; projective paint ownership separately follows the used rendering-context boundary above.

This model is source-owned at Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`:

- `ComputedStyle::HasTransformRelatedProperty` (`computed_style.h`) includes transform, preserve-3d, perspective, and transform-related `will-change`; `CalculateIsStackingContextWithoutContainment` (`computed_style.cc`) makes that result a real stacking context.
- `LayoutInline::LayerTypeRequired` (`layout_inline.cc`) explains the non-box split: a static inline has no paint layer for perspective alone; relative positioning supplies one, so the computed-style stacking context becomes observable, while both forms still fail the fixed-container and perspective-node `IsBox()` gates.
- `LayoutObject::ComputeIsFixedContainer` (`layout_object.cc`) accepts a box with that transform-related predicate and separately checks computed `transform-style: preserve-3d`, preserving containment through grouping-property flattening.
- `FragmentPaintPropertyTreeBuilder::UpdatePerspective` (`paint_property_tree_builder.cc`) gates on a box with `HasPerspective()`, applies `UsedPerspective()` around the resolved border-box origin, and explicitly prevents the perspective node itself from flattening. Its fixed-position context switches at `CanContainFixedPositionObjects()`, so a fixed descendant stays under the owning ancestor's nested clips; `perspective:none` does not switch it.
- Chromium-pinned Skia revision `62efacd37737505732dbe3d8daa62abd679626a1` performs the projective point mapping in `SkMatrix::mapPointPerspective` by dividing mapped x/y by the perspective z term. That non-affine division is why the projective surface is Chromium-owned rather than reconstructed from a 2D SVG matrix.

Domotion mirrors those separate decisions rather than inspecting matrix symptoms: `src/capture/script/index.ts` carries the computed perspective/origin values and asks Blink for transform-related `IsBox()` applicability with a candidate-only neutral host carrying the same computed `display`, active perspective, and a fixed child; this avoids mutating the source element or letting independent filter/contain ownership answer the question. Replaced/control and SVG owners retain the compatible fallback. `src/render/stacking.ts` combines the fact with `LayoutInline` layer rules for stacking and uses it directly for fixed-CB classification; `transformSubtreeRaster` owns non-representable paint. Thus static inline perspective is inert, while a positioned non-replaced inline can isolate z-index even though its fixed descendant continues to the viewport. `will-change: perspective` creates stacking/fixed ownership on a box without manufacturing an active perspective node or raster; `will-change: perspective-origin` and `scroll-position` are negative controls.

- Pre-transformed bounding rect: the `getBoundingClientRect` returns the screen-space AABB of the rotated element, which is bigger than the unrotated rect. If we wrap our render in a transform around the captured center, the visual size will look right because we're rotating contents BACK from upright. But text inside the rotated box will be re-rendered along the rotated baseline, which is what we want.
- Nested transforms: each element's captured rect already includes ancestor transforms, but if we apply our own transform we'd double-transform. Solution: apply the element's transform RELATIVE to its OWN center, not the ancestor's coordinate space. This is the same as Chrome's behavior.

## Implementation note (shipped)

The per-named-function mapping above (`rotate(30deg)` → `rotate(30)`, `scale(2)` → `scale(2)`, …) turned out to be unnecessary: `getComputedStyle().transform` returns a resolved `matrix()` or `matrix3d()`. Ordinary 2D transforms still flow through `src/render/transforms.ts`. A matrix3d participating in a static 3D context instead uses the measured-plane path above, because taking only its 2D submatrix discards ancestor perspective and depth.

## Capture model: freeze-and-wrap for static planar transforms (shipped)

Blink paints a box's decorations in the box's local transform space and applies
the transform afterwards: for example `BoxPainterBase` fills a non-rounded
background color at `ToPixelSnappedRect` of the local paint rect
(`third_party/blink/renderer/core/paint/box_painter_base.cc:1058`, Chromium
`7d859f27`). A box laid out at x = 20.5 under `translate(-0.5px)` therefore
snaps to 21 and paints at 20.5 with anti-aliased edges, and `scale(1.5)` scales
its border and outline widths. A post-transform `getBoundingClientRect` cannot
express either, so the capture walk freezes every static planar transform:

- **Frozen** (`transformFreezes` in `src/capture/script/walker/transforms.ts`):
  rotation and skew always; translate, scale, `matrix()` and an affine
  `matrix3d()` (identity z row/column, no translateZ) unless a running CSS
  animation or transition owns a transform property, or a declared transition
  with positive combined duration covers one. The walk holds `translate(0)`,
  which keeps the containing block, measures the untransformed box, and records
  the composed transform; the renderer re-applies it as a `<g transform>`.
- **How the identity is held** (`neutralizeTransformForFreeze`): an inline
  write would lose to a running CSS animation (animation origin) and to any
  transition (the transition origin outranks even `!important`;
  `CascadeOrigin`, `core/css/resolver/cascade_origin.h:15-35`, Chromium
  `7d859f27`), and, because it changes the base computed style, it would start
  a declared transition and fire transition events on the page
  (`CSSAnimations::CalculateTransitionUpdate`,
  `core/animation/css/css_animations.cc:2954-3039`). The walk instead holds the
  identity with a paused Web Animation, which replaces every CSS animation and
  earlier script animation on the transform properties without touching the
  base style, and detaches a running transition's effect from the element for
  the window, then reattaches it with its timing unchanged. Only a property an
  author `!important` declaration keeps from the override is written inline as
  `!important`. So a rotation or skew that is mid-animation or mid-transition
  freezes at its untransformed box and is applied once, and the capture fires
  no transition or animation events. The Node-side neutralizer and the text
  paint-geometry and collapsed-border CDP passes use the same helper (the last
  two also flatten `perspective` and `transform-style`).
- **Live** (`styles.transform: none`): animated/transitioned planar transforms,
  whose live rect is exact for the sampled frame, and projective planes owned by
  `transformSubtreeRaster`.
- The `translate` longhand keeps percentages in its computed value; they resolve
  against the border box (`transformReferenceBox`, `resolveTranslateComponent`),
  including `calc()` of a length and a percentage, for elements and for
  `::before`/`::after`.
- Computed `transform`, `translate` and `transform-origin` serialize in
  unzoomed CSS px: Blink stores them zoomed and divides by the effective zoom
  when serializing (`ComputedStyleUtils::ValueForTransform` applies
  `AffineTransform::Zoom(1 / zoom)`, `computed_style_utils.cc:3131`, which
  scales only the translation, `affine_transform.cc:277-281`; the origin and
  `translate` use `ZoomAdjustedPixelValue`, `longhands_custom.cc:10563/10771`,
  Chromium `7d859f27`). Captured geometry is zoomed layout px, so a frozen
  owner records its matrix translation and origin multiplied by its effective
  zoom (`zoomTransformTranslation`, `zoomTransformOrigin`).

Consumers that read captured geometry use the emitted CTM: hit-testing
(`paint-order.ts`) and the overlay resolver map points and boxes through it.

**Chromium raster producers.** A Node-side pass that screenshots the live page
after the walk sees the transformed paint. Each producer uses one of two routes:

- **Viewport crop** (`src/capture/raster-viewport-space.ts`): the captured local
  box is mapped through the same static CTM the renderer emits (own transform
  included) to the viewport rectangle Chromium painted; the raster is marked
  `viewportSpace` and the renderer places it through the inverse of the CTM open
  at its emission point. Native-control surfaces and decorations (whose live
  part fingerprints are compared against the mapped rectangles), backdrop-filter
  target crops without a neutralized rotated ancestor, and backdrop-root
  composites use this route, so Chromium's transformed paint is kept at full
  resolution. Culling treats such a raster as unknown geometry.
- **Neutralized sampling** (`src/capture/frozen-transform-neutralizer.ts`):
  `withFrozenTransformsNeutralized` sets exactly the frozen set (the walker's
  own predicate, shipped into the page as source) to `translate(0)` while a
  pass runs, so CDP box models and screenshots come back in local space.
  Replaced-element snapshots, the broken-image UA fallback facts and the
  closed-shadow input value-text quads use it, so a statically rotated or
  scaled input's value top is authorized by the same plane the walk measured.
  A projective `transformSubtreeRaster` neutralizes only the owner's frozen
  ancestors (`ancestorsOf`), because its own subtree's transforms belong in the
  bitmap; the surface is then emitted inside those ancestors' wrappers as is.

Known gaps: a backdrop-filter target or root composite under a neutralized
rotated ancestor that also sits inside a frozen translate/scale keeps the older
local route.

### Rounded paint-offset translation (DM-S2EA2P)

A transformed box gets a PaintOffsetTranslation of its **rounded** paint offset
(`ToRoundedVector2d`, `core/paint/paint_property_tree_builder.cc:748`, Chromium
`7d859f27`), and its transform origin is resolved from the box's local rect
(`ComputeReferenceBox` → `fragment.LocalRect()`,
`core/layout/transform_utils.cc:38-40`). The fractional remainder survives as
"subpixel accumulation" only on an axis the transform leaves alone
(`CanPropagateSubpixelAccumulation`, `:652-686`: identity or translation keeps
both axes, a scale keeps the axes whose factor is 1, anything else and a
`will-change` transform keep neither; paint isolation resets it, `:744-749`).
On an axis that drops it, the box and its whole subtree paint `d = round(P) − P`
further along before the transform, and the transform pivots there too. That
is `T(d)` composed in front of the matrix, so the walk folds `d` into the frozen
matrix's translation (`registerFrozenPaintBase` in
`src/capture/script/walker/border-paint-snap.ts`) and records it as
`styles.transformPaintShift`. Every CTM consumer then agrees with paint.
DOM geometry (`getBoundingClientRect`, Range and protocol quads) does not include
`d`: the text-affine residual is taken against the CTM without it
(`buildEmittedTextCtmMap(…, true)`), and the transformed-flex e2e expects the
emitted boxes at the live rect plus `d`. `P` must be authenticated by the same
rules as the border paint snap (doc 277); otherwise nothing is folded.

Box decorations then snap in that local space: the border paint snap record
(`borderPaintSnap`, now captured for boxes with a shadow, border or outline)
measures each box relative to the nearest frozen transform that drops the
accumulation, and the border, outline, focus-ring and shadow painters read their
snapped edges from it (`snappedBorderEdges`). Transform translations and origins
are written with six decimals so the 1/64 grid survives; two decimals moved a
fractional wrapper by up to 0.005px, enough to move a glyph across a subpixel
bin.

Native full-RGBA controls (`tests/frozen-transform-paint-offset.e2e.test.ts`):
fractional scaled and rotated backgrounds, shadow, border, outline, rounded and
double borders, `will-change` and `contain: paint` scales, and a child border
under a fractional scaled parent are byte-exact on macOS. On the 27 html-test
fixtures that use translate or scale, 7 improve (21-transform-2d 1.03% → 0.13%,
21-deep-transform-origin 1.58% → 0.91%, 32-real-world-pricing-table 12.58% →
9.48%), 18 are unchanged, and 22-deep-filter-paint-bounds moves 1.147% →
1.227%: its rotated, drop-shadowed box gains geometric accuracy but its text
inside the filter differs more (follow-up DM-6AX9BY). 13-deep-anchor-positioning moves by 0.00007 with an identical error total. Backgrounds
now snap in the same local space too (DM-6A9J20, doc 277), which removed the
remaining residual on axes that keep the accumulation and brought
22-deep-filter-paint-bounds to 0.978%.

### Paint isolation (DM-9VS6RT)

`NeedsIsolationNodes` (`paint_property_tree_builder.cc:570-589`, Chromium
`7d859f27`) isolates a layered box when paint containment applies, or style
AND layout containment both apply. Paint and layout containment apply only to
a LayoutObject that is `IsEligibleForPaintOrLayoutContainment`; style
containment has no such gate (`core/layout/layout_object.h:621-670`). An
isolating box's paint offset is rounded into its PaintOffsetTranslation and the
offset beneath it restarts at zero with no subpixel accumulation (`:744-749`).
Its whole subtree therefore paints displaced by `round(P) − P`. That
displacement composes through nested isolation.

`localPaintOffset` now authenticates through an isolating box when the
document prepass's native eligibility fact (`paintOrLayoutContainmentEligible`,
from the neutral-host probe) says the box is eligible. It measures a descendant
from the isolating box's border-box origin and returns the composed
displacement as `shift`. An ineligible box does not isolate. A box whose
eligibility is unknown (source-specific replaced, control and SVG layout
objects, shadow-tree ancestors outside the prepass, `content-visibility`) still
fails closed. `contain: layout` alone does not isolate.

`borderPaintSnap` edge deltas include the shift and record it as `shift`, so
the inset (`snappedInsetBox`) and inline-fragment consumers separate it from
each edge's own rounding. Raster `<img>` / `<input type=image>` boxes carry a
separate `imagePaintBasis` (local origin fraction plus shift), described in the
[images handbook](handbook/images-media-and-embedding.md#raster-image-paint-rectangles).
Text and other unsnapped content inside an isolated subtree still paint at
their captured positions.

## Follow-ups to file

- Implementation ticket: "SK-???: apply CSS 2D transforms to SVG rendered groups".
- ~~"Untransformed box capture for accuracy"~~ — shipped as the freeze-and-wrap capture model above.
- ~~"3D transform downgrade"~~ — shipped differently: static 3D transforms are measured as border-plane corners, and projective / preserve-3d / backface paint takes an atomic Chromium subtree snapshot rather than a lossy 2D projection (see the 3D bullets under Edge cases above, [doc 162](162-inline-svg-3d-transform-audit.md), and [doc 186](186-animated-3d-frame-state-parity.md)).

## Acceptance criteria

`21-transform-2d.html` test diff drops below 1.5% avg. Rotated and scaled boxes render with their internals oriented to match Chrome. Untransformed elements elsewhere on the page don't regress.
