# 208 — Iframe-local SVG fragment reference ownership

## Outcome

DM-2338 closes the first-wins collision that occurred when an outer document,
a recursed iframe, or a shadow root reused the same local `<mask>` or
`<clipPath>` id. Capture and rendering now identify a CSS `url(#id)` resource
by `(TreeScope, id)`, not by the author id alone. The same contract also carries
the referenced mask's coordinate systems, region, computed channel, and the
HTML consumer's effective zoom so the generated SVG can materialize Blink's
reference geometry without a raster or a fitted offset.

DM-2520 applies that identity independently to every local URL in a computed
`mask-image` layer list. It retains layer order, cyclic mode/composite
selection, resolved resource regions, and bottom-up Porter-Duff composition;
duplicate ids in different frames cannot cross-wire any layer.

The `iframe-inner-clip-mask` feature no longer has a `relaxedDiffPct` escape.
The strict feature comparison is 0.00%, and the dedicated capture-to-SVG gate
passes every discriminator at DPR 1 and 2.

## Pinned source ownership

Source revisions:

- Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`.
- Chromium-pinned Skia `62efacd37737505732dbe3d8daa62abd679626a1`.

Blink resolves a local mask or clip through the consumer element's
`OriginatingTreeScope()` and that scope's `SVGTreeScopedResources`, not through
one document-global or capture-global id map:

- `core/css/resolver/element_style_resources.cc:281-294` — clip resource.
- `core/css/resolver/element_style_resources.cc:374-390` — mask resource.
- `core/css/resolver/style_resolver_state.cc:311-319` — tree-scoped reference
  state.

That makes scope part of the resource's identity before geometry or paint.
HarfBuzz has no role in this decision. Skia receives the already-resolved clip
or mask paint; its luminance filter supplies the channel calculation, not the
resource lookup.

## Captured identity and namespace

The capture script reuses the deterministic `getRootNode()` scope allocator
already used for inline-SVG references. Each `MaskFragmentDef` and
`ClipPathFragmentDef` carries that scope. A mask consumer carries ordered
`(layerIndex,scope,id)` references; a single clip consumer carries its scope.
The capture maps, renderer lookups, and renderer output caches all use
`(scope,id)`. A miss in a shadow root does not fall through to
`ownerDocument.getElementById`.

Every materialized output definition receives its own descendant-id namespace.
For example, two scoped masks that both contain `id="tone"` receive different
rewritten ids and `url(#tone)` references. This prevents a second collision
after the correct scoped resources have already been selected.

Old serialized trees that lack a scope still use their historical raw-id
lookup, and old mask records that lack unit/region facts retain the historical
element-sized user-space placement.

## Exact geometry contract

For an HTML consumer, Blink uses the border box as the SVG resource reference
box. Capture records the physical border rectangle already produced by layout
and records EffectiveZoom separately for SVG user-space coordinates.

| Resource fact | Generated root-space mapping |
| --- | --- |
| `clipPathUnits="objectBoundingBox"` | `translate(borderX,borderY) scale(borderW,borderH)` |
| `clipPathUnits="userSpaceOnUse"` | `translate(borderX,borderY) scale(effectiveZoom)` |
| `maskUnits="objectBoundingBox"` | region tokens resolve against the border box |
| `maskUnits="userSpaceOnUse"` | source-viewport-resolved region, translated to the border origin and scaled by effective zoom |
| `maskContentUnits="objectBoundingBox"` | `translate(borderX,borderY) scale(borderW,borderH)` |
| `maskContentUnits="userSpaceOnUse"` | `translate(borderX,borderY) scale(effectiveZoom)` |

The user-space mask region is resolved in the defining SVG document while it
is live. This matters for percentages: the generated root SVG must not
reinterpret them against a different viewport. The SVG defaults are preserved:
`maskUnits=objectBoundingBox`, `maskContentUnits=userSpaceOnUse`, and region
`-10% -10% 120% 120%`.

The relevant Blink seams are:

- `core/paint/clip_path_clipper.cc:364-400,459-472,532-549` and
  `core/layout/svg/layout_svg_resource_clipper.cc:230-247` for the HTML border
  reference, object-box map, user-space origin, and zoom.
- `core/paint/box_painter_base.cc:1409-1431`,
  `core/paint/svg_mask_painter.cc:34-47`, and
  `core/layout/svg/layout_svg_resource_masker.cc:87-107` for the mask region
  and content maps.
- `core/style/fill_layer.cc:209-354` and
  `core/paint/svg_mask_painter.cc:95-135,229-307` for cyclic longhand fill,
  bottom-up layers, per-layer channel/composite selection, and the SVG
  resource clip that precedes the Porter-Duff layer.
- `core/layout/svg/layout_svg_resource_container.cc:46-63,96-139` for SVG
  length and percentage resolution.

The SVG-mask source is a special CSS mask layer: Blink does not apply the
ordinary `mask-origin`, `mask-clip`, `mask-size`, `mask-position`, or
`mask-repeat` image geometry to it. The discriminator assigns hostile values
to those longhands and requires the same output.

Composition is still scoped by the SVG resource region. Blink calls
`Clip(ResourceBoundingBox)` before `BeginLayer(composite_op)`, so a non-bottom
fragment layer replaces the accumulated destination only inside its resolved
region; destination alpha outside survives. Domotion materializes that region
per layer and reproduces the clipped bottom-up recurrence for `add`,
`intersect`, `subtract`, and `exclude`, including mixed three-layer operator
lists. This is logical paint ownership, not a pixel-tolerance adjustment.

## Alpha and luminance ownership

Capture records the referenced `<mask>`'s computed `mask-type`, including
stylesheet-owned `alpha` or `luminance`. A consumer layer with explicit
`mask-mode: alpha` or `luminance` overrides that value; `match-source` retains
it. The generated definition bakes the effective value inline so it does not
depend on the defining iframe's stylesheet after serialization.

Blink selects this channel in `box_painter_base.cc:1306-1313` and
`svg_mask_painter.cc:273-307`. Skia's luminance filter uses prior alpha times
the gamma-encoded RGB weights (`SkLumaColorFilter.h:16-31` and
`sksl_rt_shader.sksl:3-7`). Tests therefore use binary opaque/transparent
probes, not a percentage pixel envelope.

## Discriminator

`tests/iframe-inner-defs.e2e.test.ts` covers DPR 1 and 2 and requires:

- outer-document and iframe definitions with identical author ids but opposite
  halves, with two scoped capture records and distinct output resources;
- distinct descendant ids/references after rewriting;
- non-square object-box and user-space masks/clips at nonzero iframe offsets;
- asymmetric consumer border/padding and user-space effective zoom;
- source-viewport mask regions, object-box mask content, luminance,
  stylesheet alpha, and explicit consumer alpha override;
- hostile mask image-geometry longhands that must not affect an SVG fragment;
- exact source/render binary probes and no capture warning.

`src/mask.test.ts` independently locks each root-space transform and region
materialization. `tests/features.ts#iframe-inner-clip-mask` is the repository
visual row and now passes with the default strict comparison at 0.00%.

`tests/multi-layer-fragment-mask.e2e.test.ts` adds raw RGBA equality at DPR 1
and 2 for duplicate outer/iframe ids, object/user units, effective zoom,
per-layer alpha/match-source channels, hostile image geometry, and two-/three-
layer operator sequences. Destructive scope, mode, operator, and zoom
mutations prove each captured fact is active.

## Deliberate boundaries

Definitions referenced transitively from outside the copied mask/clip subtree
and author stylesheet paint on copied descendants are also not made
self-contained here. Those remain the explicit boundaries in docs 21 and 39;
they require source-scoped dependency collection rather than another id or
pixel tolerance adjustment.
