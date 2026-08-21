# Exact text-transform geometry audit

This investigation replaces one premise, not one constant: a CSS transform is
not a font-size multiplier. Blink shapes and positions a text fragment in its
local, zoom-adjusted layout space, then the paint-property transform maps that
paint into its destination space. A single magnitude derived from matrix
diagonals cannot stand in for that mapping.

No production routing changed in this investigation. The implementation is
split into three dependency-ordered follow-ups: exact affine fragment capture
(DM-2469), matrix-owned text emission with deletion of scalar compensation
(DM-2470), and an independent all-platform Chromium gate (DM-2471).

## Verdict

- Every finite 2D affine text plane is representable as vector SVG, including
  rotation, anisotropic scale, either skew, negative-determinant reflection,
  asymmetric origins, nested transforms, and singular affine matrices.
- CSS `zoom` belongs to font selection, shaping, and layout metrics. It stays
  in the local fragment geometry and must not be multiplied into the CSS
  transform matrix a second time.
- A text plane whose fourth corner cannot be predicted by one affine matrix is
  projective. The existing outer `transformSubtreeRaster` boundary owns that
  complete 3D rendering context; a text-only bitmap would lose compositing,
  clipping, depth order, and sibling interaction.
- If authoritative fragment geometry cannot be correlated, capture must warn
  and select an explicit Chromium-owned surface. It must not silently fall back
  to `sqrt(abs(a*d))`, column norms, a determinant magnitude, or another fitted
  scalar.

## Why the current scalar is not a transform

The current prepass in `src/capture/script/index.ts` reads only the `a` and `d`
entries from each computed matrix, replaces either zero with one, multiplies
those two unsigned values independently through the ancestor chain, and returns
their geometric mean. That result changes captured `fontSize`, ascent, descent,
and every segment metric. The renderer then adds an axis-ratio wrapper for the
subset whose two retained values differ.

That loses information in several independent ways:

1. A rotation matrix has `a=d=cos(theta)`. At 37 degrees the current metric
   multiplier is about `0.798636`, not one. This directly contradicts the source
   comment that the approximation returns one for pure rotation.
2. `scale(0.79863551)` and `rotate(37deg)` have the same retained diagonal and
   therefore the same scalar, but one matrix has zero off-diagonals and the
   other has `b=0.601815`, `c=-0.601815`.
3. Component-wise multiplication of ancestor diagonals is not matrix
   multiplication. Nested rotation, skew, and asymmetric origins cannot be
   reconstructed from the product.
4. Absolute values discard reflection. The current pure `scaleX(-1)` path also
   stores `transform:none` and no anisotropic correction, so the signed paint
   mapping disappears completely.
5. The capture model mixes spaces. Pure translate/scale keeps live,
   post-transform rectangles and drops the transform; rotation/skew temporarily
   neutralizes the owner and stores its matrix. Transform-derived font metrics
   are then applied in both models. A rotated run therefore receives a local
   font-size change and a downstream rotation even though Blink changes only
   the downstream paint transform.
6. Perspective already crosses the outer raster boundary, but the scalar
   prepass still mutates descendant text metrics before that boundary replaces
   them.

The per-axis correction in `src/render/text.ts` cannot recover missing
off-diagonals, sign, origin, reference box, or ancestor composition. Dividing
captured x offsets before applying the correction only cancels one symptom of
the mixed coordinate spaces.

## Pinned source decision

The audit used these checkouts:

- Chromium `7d859f271cbda744098ac69f44978d4edfa62be3` (2026-06-27)
- HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab` (2026-07-31)
- Skia `62efacd37737505732dbe3d8daa62abd679626a1`, the revision pinned by
  Chromium's `DEPS`, rather than the newer standalone checkout head

### Transform ownership

`core/paint/paint_property_tree_builder.cc:1370-1379` constructs a
`TransformAndOrigin` from a complete `gfx::Transform` plus a separate origin.
For each physical box fragment, lines 1421-1456 compute the reference box and
record the entire matrix; the code explicitly distinguishes scale-only from a
non-scale transform rather than converting either into a font size. The normal
transform property calls `ComputedStyle::ApplyTransform` at lines 1610-1628.

`core/layout/transform_utils.cc:17-49` selects the physical fragment's content
or border reference box. `core/style/computed_style.cc:1415-1490` resolves the
origin against that box, composes translate, rotate, scale, motion path, and
the ordered transform operations, then translates back. Origin and
`transform-box` therefore belong to the matrix construction, not to text
metrics.

### Text stays local until paint

`core/paint/text_fragment_painter.cc:506-529` selects the fragment's scaled
font, computes its local ascent and physical-box origin, and constructs
`TextPainter` with that local origin. Lines 641-651 expose the current paint
chunk's transform separately. Lines 730-758 then paint the already-shaped
fragment and its decorations.

`platform/fonts/font.cc:91-109` converts the fragment's `ShapeResult` into text
blobs and draws those blobs at the supplied local point. Blink's HarfBuzz bridge
stores the returned physical advances and offsets in `ShapeResult` without any
CSS-transform magnitude (`platform/fonts/shaping/shape_result.cc:1517-1573`).
HarfBuzz itself defines every `hb_glyph_position_t` advance and offset relative
to the current point (`src/hb-buffer.h:175-199`).

The handoff remains matrix-valued in Skia. Chromium's `GraphicsContext` sends a
complete `SkM44` to `PaintCanvas::concat`
(`platform/graphics/graphics_context.cc:322-325,1002-1004`). In pinned Skia,
`src/core/SkCanvas.cpp:1336-1354` pre-concatenates that matrix into the global
CTM, while lines 2442-2462 and 2580-2599 turn a text blob into a glyph-run list
and draw it under that CTM. No scalar text-transform calibration exists at this
boundary.

### Zoom is different

Blink applies zoom while deriving the computed font size:
`core/css/resolver/font_builder.cc:378-423` says the computed size already has
scale/zoom and text autosizing applied, and
`core/css/font_size_functions.cc:216-218` multiplies the specified size by the
zoom factor. `platform/fonts/font_description.cc:271-281` and
`platform/fonts/skia/font_cache_skia.cc:73-94` carry that computed/effective
size into the platform font. Zoom is therefore a local shaping/layout input;
the later CSS transform remains an independent paint operation.

## Fresh discriminator evidence

Run:

```sh
npm run transform:text-geometry-audit -- --json /tmp/text-transform-audit.json
```

The audit is observational. It obtains `DOM.getContentQuads` for the actual
text node before and after a temporary all-owner identity override. The
override leaves CSS zoom active. Three corresponding corners solve the affine
map from neutral fragment space to live paint space; the fourth corner of every
fragment is a held-out discriminator. A non-affine fourth corner classifies the
outer context as projective. Production capture runs on the restored page and
records the scalar fields beside those independent browser facts.

The 2026-08-22 darwin/arm64 run used Playwright 1.59.1 and Chromium
147.0.7727.15. All affine held-out corners agreed within `0.000046` CSS px;
all fifteen affine rows kept `transformSubtreeRaster` inactive. The projective
row missed by `17.4469` CSS px and activated `transformSubtreeRaster`.

| Row | Browser fact | Current captured paint-metric scale |
| --- | --- | ---: |
| identity | affine identity | 1.000000 |
| translation | affine translation; no font change | 1.000000 |
| uniform scale 1.25 | affine scale | 1.250000 |
| uniform `cos(37deg)` | diagonal affine matrix | 0.798634 |
| rotation 37deg | determinant about 1; off-diagonals +/-0.601815 | 0.798638 |
| anisotropic scale 1.6 by 0.7 | complete affine matrix | 1.058300 |
| rotate 31deg plus scale 1.6 by 0.65 | complete affine matrix | 0.874144 |
| two-axis skew | complete affine matrix | 1.000000 |
| `scaleX(-1)` | determinant -1; signed quad winding retained | 1.000000, transform discarded |
| nested asymmetric origins | composed affine matrix | 0.962231 |
| `transform-box: border-box` | affine matrix about the border-box reference origin | 0.926416 |
| `transform-box: content-box` | same linear matrix; translation moves 8.7268 px by 16.1049 px | 0.926416 |
| wrapped skew text | seven independently returned fragment quads | 1.000000 |
| zoom 1.5 | computed font 48 px from logical 32 px | 1.000000 relative to computed size |
| zoom 1.5 plus rotation 37deg | zoom remains local; rotation remains affine | 0.798635 |
| perspective plus `rotateY`/`translateZ` | non-affine fourth corner; outer raster active | 0.862059 before replacement |

The mutation control is especially strong. The uniform-cosine and rotation
rows have scalar values within `0.000004`, yet their recovered matrices are:

```text
scale:  [0.798635, 0,        0,         0.798636,  55.3005,  35.8026]
rotate: [0.798635, 0.601815, -0.601815, 0.798636, 162.3032, -129.4731]
```

Any scalar-only implementation must return the same answer for these two
different paints. The tool also requires multiple wrapped fragment quads,
negative reflection winding, a moved `content-box` versus `border-box`
reference-origin result, and a zoom-only metric ratio of one. Those controls
make a dormant probe or a reintroduced scalar approximation fail visibly.

Fresh HTML run `32366215930` remains the downstream integration baseline: it
records structured anisotropic-scale and transform-origin residuals on all
platforms, plus transform-box/2D differences on Linux. Those pixel residuals
show user-visible impact, but cannot select paint ownership; the source and
matrix/quad discriminators above do that before the fixtures are reused as
integration acceptance.

## Exact capture representation

The required record is a local fragment plus a matrix, never a scaled font:

```ts
interface CapturedTextPaintGeometry {
  // Physical text geometry with all vector-affine CSS transforms neutralized.
  // Effective CSS zoom has already affected these coordinates and font metrics.
  space: "pre-css-transform-viewport";
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  inlineOffset: number;
  xOffsets?: number[];
  yOffsets?: number[];

  // Complete signed affine mapping into the owning SVG paint space.
  // The implementation may store an equivalent parent-relative matrix, but
  // it must be derived before serialization rather than refitted by the renderer.
  paintMatrix: [number, number, number, number, number, number];
}
```

Capture must establish one consistent neutral space for a subtree. Mixing live
rectangles for scale with neutral rectangles for rotation recreates the current
bug. A safe implementation sequence is:

1. Pause/snapshot CSS and Web Animations so live and neutral observations refer
   to one timeline instant.
2. Record live box/text quads and classify the outer transform context.
3. Route non-affine contexts to the existing outer raster boundary.
4. For vector-affine owners, apply identity matrices to all transform owners at
   once while preserving non-`none` transform semantics that create stacking
   and fixed-position containing blocks. Leave zoom untouched.
5. Capture text, line fragments, baselines, glyph origins, clips, decorations,
   pseudo paint, and boxes in that single neutral space.
6. Correlate neutral and live physical fragments, recover the complete signed
   matrix, validate every held-out corner, and restore the page.
7. Fail closed to a declared Chromium surface if correlation is ambiguous—for
   example a frame/navigation mutation, animation drift, missing protocol
   node, or mismatched fragment count.

The renderer must apply the matrix once to the complete text paint bundle. That
includes outline paths, embedded/raw text fallback, color/bitmap glyph
overlays, stroke, shadow, decorations, emphasis marks, generated ellipses and
pseudos, and their clips. Applying it only to glyph outlines would create a new
split paint space.

## Required implementation controls

- Identity and translation must leave local font metrics unchanged.
- Uniform scale is a compatibility control: output may remain pixel-clean, but
  capture must still express it as geometry rather than a font-size mutation.
- Equal-diagonal rotation versus uniform scale is the mandatory mutation row.
- Positive and negative anisotropic axes, both skews, and `scaleX`/`scaleY`
  reflection must preserve matrix sign and off-diagonals.
- Nested owners need asymmetric origins and non-default `transform-box`; a
  content-box/border-box pair must move while keeping the same linear matrix.
- Wrapped inline text must prove fragment correlation, not just element bounds.
- Horizontal, vertical, RTL, mixed face/size, decorations, shadows, raster glyph
  overlays, same-origin frames, CSS zoom, and DPR 1/2 must all use the same
  representation.
- Perspective is a positive outer-raster control. Affine `matrix3d` is its
  negative control and stays vector.
- The existing HTML visual-run residuals are integration acceptance only. The
  exact matrix/fragment gate must fail before pixel scoring when geometry is
  wrong.

## Follow-up order

1. **DM-2469 — capture exact affine text-fragment geometry and transform
   matrices.** Own the neutral/live protocol, schema, fragment correlation,
   warnings, and projective boundary.
2. **DM-2470 — render transformed text from captured affine geometry and remove
   scalar compensation.** Consume the record across every text paint branch,
   delete `_scaleMag`/`cumScale*`/anisotropic correction, and prevent double
   transforms.
3. **DM-2471 — gate transformed-text matrices and ink against Chromium on all
   platforms.** Promote this diagnostic into exact stage plus independent
   raster legs, reuse the existing HTML residual fixtures, and collect
   macOS/Linux/Windows evidence.
