# Cloned inline-SVG 3D transform audit

**Status:** projective raster promotion shipped; SVG-child affine freezing and
the all-platform two-leg gate remain follow-ups

**Ticket:** DM-2371

**Implementation follow-ups:** DM-2473, DM-2474, DM-2475

An inline DOM `<svg>` is an atomic clone in Domotion's renderer: capture bakes
selected computed properties into `svgContent`, and `paintInlineSvg` emits that
markup instead of walking its serialized descendants. That ownership rule is
sound only if every transform inside the clone is frozen into valid 2D SVG, or
the complete non-representable paint is promoted to one raster owner that the
renderer actually visits.

The projective ownership half now satisfies that boundary. A
true SVG-graphics-child 3D transform is not projective in Blink's SVG layout
model: Blink deliberately resolves its complete CSS transform, reference box,
and three-dimensional origin, then flattens the result to an affine
`LocalToSVGParentTransform`. Domotion instead copies the computed
`matrix3d()` into an SVG `transform` attribute. Chromium rejects that attribute
on re-embed, so the element becomes identity. Non-affine root and
`<foreignObject>` paint, however, now crosses one reachable outer Chromium
surface instead of entering that invalid vector fallback.

## Verdict

The source-derived boundary is:

1. **SVG graphics children freeze to an exact used affine matrix.** This covers
   CSS `matrix3d()`, `rotateX/Y`, `translateZ`, and `perspective()` functions on
   `<g>`, `<rect>`, `<path>`, and other SVG children. Blink has already flattened
   these transforms before paint. Capture must serialize Blink's used
   parent-relative affine transform as `matrix(a b c d e f)`; it must not copy
   the 4x4 computed string or independently reconstruct the reference box.
2. **CSS layout boxes may remain projective.** The outer `<svg>` root is a box,
   as are HTML boxes above it and HTML descendants inside `<foreignObject>`.
   If their final paint plane has a non-affine fourth corner, or participates in
   depth/backface composition that cannot be represented by one affine SVG
   matrix, Chromium owns one raster surface.
3. **An opaque clone moves the ownership boundary outward.** A raster attached
   to a descendant of a captured inline SVG is dead data because
   `paintInlineSvg` never renders that descendant. Any non-affine
   `<foreignObject>`/HTML surface must be promoted to the inline SVG root or an
   already-owning outer 3D context.
4. **Computed property presence is not paint activation.** `perspective` and
   `transform-style` on an SVG child do not put that child on Blink's general
   3D box path. SVG-child transforms terminate the rendering context and
   flatten. A perspective-bearing SVG root whose only descendants have already
   lost z can also remain affine. Capture should classify the resulting paint,
   not raster merely because a computed token is non-default.
5. **Unknown means an explicit Chromium surface.** Missing/non-invertible
   local CTMs, a failed source/clone correlation, animation drift, or an
   ambiguous owner must warn and cross the declared outer boundary. It must
   never fall back to the 2D submatrix in `cssTransformToSvg`.

## Remaining information loss

`src/capture/script/walker/inline-svg.ts` reads `getComputedStyle().transform`,
parses only the first two components of `transform-origin`, approximates
`stroke-box` as `getBBox() - strokeWidth / 2`, composes two translations, and
writes the result to the clone's `transform` attribute. This creates four
independent failures:

- an actual 3D matrix remains `matrix3d()` and is invalid in the emitted SVG
  transform attribute;
- the z component of `transform-origin` is discarded even though Blink
  composes it around the 4x4 transform;
- `stroke-box` does not account for Blink's used-value rule that
  `vector-effect: non-scaling-stroke` maps it to `fill-box`, nor for the exact
  stroke bounding box; and
- a retained inline style or CSS-overridden static `transform` attribute can
  reapply a transform after the baked matrix unless the resolved owner is
  normalized once.

The former HTML marker prepass has been removed. `src/capture/index.ts` now
correlates live DOM objects without attributes, asks Chromium CDP for content
quads and box-model border quads, and passes those facts into the capture
bundle. `src/capture/projective-owner.ts` classifies the held-out fourth corner,
selects the outer 3D context, promotes any owner beneath an atomic inline-SVG
clone to the outermost suppressing SVG root, and removes nested duplicate
owners. Property-only perspective with affine resulting paint stays vector.

`rasterizeProjectiveSurfaces` isolates the selected live owner without forcing
authored hidden descendants visible, excludes the propagated document canvas,
screenshots the complete viewport, trims by real alpha, and preserves the PNG's
DPR. The renderer emits that surface in
the inline/replaced-content phase exactly once; `svgContent`, reconstructed
descendants, and nested replaced snapshots are thereby suppressed together.
Missing CDP geometry is treated as an explicit unknown and promotes a measured
paint-bearing plane rather than selecting six matrix entries.

The renderer's last fallback remains unsafe for a vector SVG-child route. If no
`transformSubtreeRaster` is present, `src/render/transforms.ts` projects a
computed `matrix3d()` by selecting only m11, m12, m21, m22, m41, and m42. That
is neither Blink's SVG-child affine flattening nor perspective division; it is
an unexplained submatrix approximation.

## Pinned source decision

The audit used Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and Skia
`62efacd37737505732dbe3d8daa62abd679626a1`, the revision named by that
Chromium checkout's `DEPS` rather than the newer standalone Skia worktree head.

### SVG children are source-flattened affine

`core/layout/svg/transform_helper.cc:83-121` obtains the used SVG reference box
from `ObjectBoundingBox()`, `StrokeBoundingBox()`, or the local viewport and
applies effective zoom. `core/style/computed_style.cc:1372-1412` owns the used
box aliases: SVG `content-box` becomes `fill-box`, `border-box` becomes
`stroke-box`, and a non-scaling stroke changes `stroke-box` to `fill-box`.

`ComputedStyle::ApplyTransform` at `computed_style.cc:1429-1490` resolves x/y
against that exact box and includes the z origin while composing independent
translate/rotate/scale, motion, and the ordered transform list. The critical
handoff is `TransformHelper::ComputeTransform` at
`transform_helper.cc:123-149`: after building a complete `gfx::Transform`, it
explicitly returns `AffineTransform::FromTransform(transform)` with the comment
“Flatten any 3D transform.”

Paint consumes that already-used result. In
`core/paint/paint_property_tree_builder.cc`, lines 1161-1203 assert that the
computed helper result equals
`LocalToSVGParentTransform()` and otherwise returns that local affine transform
directly. `UpdateTransformForSVGChild` at lines 1205-1252 says the SVG-specific
node is “without 3D”, then sets inherited flattening true and clears the
rendering-context id for descendants.

These decisions make the capture representation unambiguous: for an SVG child,
the browser-owned fact is the used parent-relative affine CTM, not the computed
CSS syntax and not a hand-derived transform box.

### Roots and HTML boxes keep the 4x4 paint path

The general paint path rejects `IsSVGChild()` in `NeedsTransform`
(`paint_property_tree_builder.cc:1330-1349`) but accepts transformed layout
boxes and stores their complete `gfx::Transform` plus origin in
`TransformAndOriginState` (lines 1370-1447). An inline SVG root is on this box
path rather than the SVG-child path. `UpdatePerspective` at lines 3141-3181 is
also explicitly gated on `object.IsBox()`; it creates a perspective node around
the resolved box origin and prevents that node from flattening itself.

Grouping properties use the **used** transform style.
`computed_style.h:2131-2146,2210-2267` maps `preserve-3d` to flat for opacity,
filters, clip/mask, isolation/blending, backdrop filtering, and non-visible
overflow. The SVG-child update still terminates the rendering context
regardless of the computed `transform-style` token.

### Perspective cannot be reduced to the six obvious 4x4 entries

Pinned Skia's `SkM44` classifies any non-canonical bottom row as perspective
and its `asM33()` conversion preserves the 2D homogeneous row while dropping
the z row/column. `SkMatrix::mapPointPerspective` computes x, y, and homogeneous
z, then divides x and y by that z. A projective fourth corner therefore cannot
be reproduced by selecting six affine entries. It must remain in Chromium's
composited surface unless every affected primitive is source-projected and
validated independently, which is outside the cloned-inline-SVG contract.

## Fresh discriminator evidence

Run:

```sh
npm run transform:inline-svg-3d-audit -- --json /tmp/inline-svg-3d-audit.json
```

The 2026-08-22 run used Playwright 1.59.1, Headless Chromium 147.0.7727.15,
macOS arm64, DPR 1, and a 420 by 260 viewport. For vector rows the tool reads
the live target CTM, expresses it in the immediate SVG parent's coordinate
space, performs the real Domotion capture, re-embeds captured `svgContent` in a
clean document, and compares the resulting local CTM. For projective rows it
records CDP content quads, their held-out fourth-corner affine residual, every
serialized raster owner, and whether that owner is reachable before
`paintInlineSvg` suppresses descendants.

The tool exits zero when the complete set of expected source controls,
remaining SVG-child freeze gaps, and shipped projective-owner routes is
observed. It is not yet the all-platform production parity gate; DM-2475 turns
it into the required logical-plus-raster gate after the affine-freeze work
lands.

| Control | Live Chromium fact | Current captured/re-embedded fact |
| --- | --- | --- |
| Static SVG `transform="matrix(...)"` | Affine | Exact, delta below 1e-15 |
| CSS matrix, fill/stroke/view boxes, asymmetric origin | Three distinct affine translations | Each round-trips within 0.000058 local units |
| `stroke-box` + non-scaling stroke | Used box equals fill-box | Clone uses the authored stroke-box approximation; delta 3.6611 |
| Planar `matrix3d` (no z/perspective terms) | Computed down to `matrix()` | Vector, delta 0.000058 |
| `rotateY(47deg)`, fill/stroke/view boxes | Source-flattened affine; fourth-corner residual 0 | Literal `matrix3d()` attribute is rejected; identity; deltas 18.3678 / 17.1848 / 12.6883 |
| `rotateY` with z origin 31 px | Z origin moves the used affine translation | Z is discarded and attribute is rejected; delta 4.3042 |
| `perspective(260px) rotateY(43deg) translateZ(22px)` on rect | Source-flattened affine; residual 0 | Literal `matrix3d()` rejected; identity; delta 19.5627 |
| Perspective on SVG `<g>` vs flat control | Identical source affine CTMs; perspective is inert | No raster owner; both clones still lose matrix3d |
| SVG-child preserve-3d vs opacity grouping | Identical source affine CTMs | Both clones lose matrix3d; delta 7.9529 |
| Perspective on root with only flattened SVG graphics | Final target quad remains affine, residual 0 | No raster owner; vector clone remains active |
| Projective transform on inline-SVG root | Non-affine target quad, residual 30.9282 px | One effective raster on the inline-SVG root |
| HTML ancestor perspective + transformed root SVG | Non-affine target quad, residual 36.4226 px | One effective outer raster (positive control) |
| HTML perspective context inside `<foreignObject>` | Non-affine target quad, residual 21.9539 px | One effective raster promoted to `/div/svg` before `paintInlineSvg` |

Activation controls also prove that the static transform path is live, all
three reference boxes move, non-scaling stroke selects fill-box, the z origin
moves Blink's answer, SVG perspective/preserve-3d are source-flat, a normal
HTML projective owner emits exactly once, and root-SVG plus nested
`<foreignObject>` paint each has one reachable owner. No fixture-fit constant
or screenshot tolerance selects these decisions.

## Exact capture design

### Vector freeze

For every SVG graphics descendant that will survive in `svgContent`:

1. Freeze the page's animation time and record the source SVG viewport/parent
   chain before mutating the clone.
2. Read the used local affine transform from Chromium after style, reference
   box, origin (including z), zoom, motion, and SVG transform semantics have
   resolved. A parent-relative matrix may be derived from correlated CTMs only
   when the parent mapping is finite and invertible; nested viewport and
   singular cases need an explicit authoritative protocol or fail closed.
3. Validate the matrix against independent source points/geometry rather than
   assuming that a computed `matrix3d()` is affine in the output space.
4. Write exactly one `transform="matrix(a b c d e f)"` to the clone and remove
   retained CSS `transform`, independent transform properties,
   `transform-origin`, and `transform-box` declarations that could apply it a
   second time. A CSS rule overriding a static transform attribute must freeze
   the used winner, not preserve the losing attribute.
5. Repeat the same operation for inlined `<use>` targets at the captured frame.
   If source/clone node correlation, matrix validity, or timeline stability is
   unavailable, select the outer raster owner and warn.

This retains vector scalability because Blink's SVG-child result is already
affine. It also deletes the need to reproduce `StrokeBoundingBox`,
non-scaling-stroke aliases, z-origin composition, or effective-zoom math in
JavaScript.

### Raster promotion — implemented

Classify root SVG and HTML layout boxes from authoritative live quads/paint
facts rather than `offsetWidth` plus appended HTML markers. When a final plane
is non-affine, backface/depth composition is active, or an inner HTML context
cannot be frozen into native SVG:

1. choose the outermost context required for correct 3D paint order;
2. if that owner is under a captured inline SVG, promote it to the inline SVG
   root unless an already-owning ancestor will suppress the root;
3. capture bounds from transformed descendant visual paint, intersect only at
   the established viewport/clip boundary, and retain zoom/DPR source pixels;
4. emit one `<image>` before `paintInlineSvg` can visit the clone; and
5. suppress both `svgContent` and all nested reconstructed/raster descendants.

An affine fourth corner is a required negative control. Property strings alone
must not force this route, and a raster stored below `svgContent` must fail the
ownership gate even if its PNG bytes exist.

Focused production coverage lives in
`tests/inline-svg-projective-ownership.e2e.test.ts`. Its route matrix covers a
direct root projective transform, an owning HTML ancestor, ordinary and nested
`<foreignObject>` promotion, inert SVG root/child perspective, opacity plus
overflow used flattening, and 2D/planar-matrix3d negatives. Its independent
DPR-2 Chromium-versus-generated-SVG ink leg combines zoom, scroll, an outer
ancestor's rotation/opacity/filter, border/overflow clips, transformed
off-bounds paint, and a vector sibling; all four classified color bounds must
agree within four device pixels, the sibling must be absent from the owner PNG,
and the raster payload must occur once.

## Required implementation and gate controls

- static transform attribute, external CSS 2D matrix, and planar matrix3d
  negatives;
- rotateX/Y/3d, translateZ, and perspective-function SVG-child positives whose
  used affine matrix is retained exactly;
- fill/stroke/view boxes; content/border aliases; non-scaling stroke; exact
  stroke geometry; percentage, keyword, x/y/z, and asymmetric origins;
- nested groups, nested viewports, `<use>` expansion, CSS override of a static
  transform attribute, independent transform properties, motion, t=0
  animation, effective zoom, and singular/unavailable fail-closed controls;
- SVG-child perspective and preserve-3d inert negatives; opacity, filter,
  clip/mask, blend/isolation, and overflow used-flattening controls;
- projective root SVG, projective HTML ancestor, and projective HTML inside
  `<foreignObject>`, with backface, depth order, transformed out-of-bounds ink,
  vector siblings, clip/effect composition, scroll, zoom, and DPR 1/2;
- a mutation that emits literal `matrix3d()` into an SVG transform attribute;
  one that selects the six apparent 2D entries; one that keeps stroke-box under
  non-scaling stroke; one that measures an SVG root with HTML offset markers;
  and one that leaves a raster owner below `svgContent`; and
- an independent Chromium-versus-generated-SVG ink/alpha leg on macOS, Linux,
  and Windows. Logical matrix/ownership failures must be rejected before any
  platform raster envelope is considered.

## Follow-up ownership

- **DM-2473 — Freeze Blink-used affine transforms in cloned inline SVG
  graphics.** Owns the exact local matrix, clone normalization, fail-closed
  vector boundary, and focused capture tests.
- **DM-2474 — Promote projective inline SVG paint to one effective outer raster
  owner — shipped.** CDP paint quads now own SVG-capable classification,
  root/ancestor promotion, `<foreignObject>` atomicity, used flattening,
  alpha-trimmed bounds, and one-owner emission.
- **DM-2475 — Gate inline SVG 3D freeze and raster ownership against Chromium.**
  Depends on DM-2473 and DM-2474; promotes this probe to exact logical plus
  independent raster gates on all supported platforms.
- **DM-2359** already owns animated 3D frame-state coverage. The new static
  gate should reuse its frame protocol when available rather than duplicate it.

## Source map

All Chromium paths below are relative to
`external/chromium/third_party/blink/renderer`; Skia paths are read at the
revision pinned by Chromium `DEPS`.

- `core/style/computed_style.cc:1331-1362` — when transform-origin matters.
- `core/style/computed_style.cc:1372-1412` — used SVG/layout transform-box
  mappings and non-scaling-stroke rule.
- `core/style/computed_style.cc:1429-1490` — x/y/z origin and transform
  operation composition.
- `core/style/computed_style.h:2131-2146,2210-2267` — used preserve-3d and
  grouping-property flattening.
- `core/layout/svg/transform_helper.cc:32-121` — dependency checks plus exact
  fill/stroke/view reference boxes and zoom.
- `core/layout/svg/transform_helper.cc:123-178` — complete transform followed
  by explicit SVG-child affine flattening.
- `core/paint/paint_property_tree_builder.cc:1161-1252` — SVG-child local
  transform node and rendering-context termination.
- `core/paint/paint_property_tree_builder.cc:1330-1490` — general 4x4 layout-box
  transform path used by the outer SVG root/HTML boxes.
- `core/paint/paint_property_tree_builder.cc:3141-3181` — box-only perspective
  node and origin.
- `core/paint/paint_property_tree_update_tests.cc:1355-1390` — SVG root
  perspective node parenting the child SVG transform.
- `external/skia/include/core/SkM44.h:360-420` — perspective classification and
  4x4-to-3x3 homogeneous conversion at the pinned revision.
- `external/skia/src/core/SkMatrix.cpp:883-891` — perspective point division at
  the pinned revision.
