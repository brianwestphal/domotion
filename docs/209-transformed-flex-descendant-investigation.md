# Transformed flex descendant investigation

DM-2336 investigated the remaining `0.05` relaxed pixel threshold on
`transform-scale-flex-descendants`. This ticket is investigation-only: it does
not change capture or rendering code and does not weaken or remove a pixel
threshold. Transform/flex geometry is exact through capture and at the
documented 0.1px SVG serialization boundary; the relaxed pass gate is
historical debt left by the pre-DM-587 transform model.

## Ownership model

Blink lays flex items out before applying CSS transforms. In pinned Chromium
`7d859f271c` (2026-06-27), the flex algorithm starts the main-axis offset at the
container border/padding plus content-distribution offset, constructs each
item's logical offset, then advances by the flexed border-box size, distributed
space, and `gap` (`flex_layout_algorithm.cc:1815-1819,1964-1972`). These are
`LayoutUnit` values in the flex container's local layout space.

CSS transforms enter later through the paint property tree. Blink resolves
`transform-origin` against the transform reference box and includes the
reference-box offset (`paint_property_tree_builder.cc:1255-1268`), constructs
the transform matrix without baking the origin into the matrix
(`paint_property_tree_builder.cc:1367-1378`), and installs that transform node
in `UpdateTransform` (`paint_property_tree_builder.cc:1610-1640`). Paint-offset
translation is a distinct parent transform node. Blink rounds that paint
offset, but `CanPropagateSubpixelAccumulation()` discards the residual on an
axis carrying a non-unit scale (`paint_property_tree_builder.cc:697-779`);
paint-offset translation nevertheless remains outside the later CSS transform
node (`paint_property_tree_builder.cc:4042-4072`). Thus child translation is
composed in child-local space and then carried through the ancestor scale; it
is not an unscaled viewport translation. A useful oracle must distinguish
Blink's pre-transform `LayoutUnit`/paint-offset decisions from arbitrary
rounding of already transformed viewport coordinates.

Finally, `getBoundingClientRect()` validates paint-location data, obtains the
element's transformed client quads, and unions their bounding boxes
(`element.cc:3488-3519`). Domotion's axis-aligned path deliberately consumes
those live post-transform viewport rectangles and records the pure
scale/translation as `transform: none`, preventing a second SVG transform
(`src/capture/script/walker/transforms.ts:34-55,240-254`). It separately keeps
`transformCreatesSc` so removing the matrix does not erase stacking-context
semantics (`transforms.ts:270-278`; `src/render/stacking.ts:97-109`). This is the right ownership boundary for
an axis-aligned box-only fixture.

No HarfBuzz source participates because this fixture contains no text or glyph
shaping. Skia ultimately rasterizes its fractional rectangle edges, but no Skia
rule is needed to decide the logical geometry studied here. The logical
discriminator ends at Blink layout, transform-tree composition, DOM geometry,
and Domotion SVG rectangle emission; raw edge pixels remain paint-stage facts.

## Evidence

The checked-in fixture is a 200 by 300 flex column with 10px padding and gap,
scaled by 0.69 around `0 0`; two children have local translations of -5px and
+10px (`tests/features.ts:604-625`). Its emitted child geometry is the direct
composition of layout and paint spaces: 10px padding becomes 6.9px, 40px
height becomes 27.6px, the 50px item pitch becomes 34.5px, and the two local
translations become -3.45px and +6.9px.

Three independent observations reject a current logical gap:

1. The current macOS feature run reports zero scored differing regions and
   0.00% after the harness's antialias filtering. Its raw artifact still has
   252 differing pixels with maximum channel delta 8, so this is logical/scored
   exactness rather than a claim of raw-pixel identity.
2. Checked-in Linux and Windows baseline records both report `diffPct: 0` and
   zero differing regions for this fixture.
3. A live Chromium metamorphic probe crossed four scales (`0.5`, `0.69`, `1`,
   `1.25`), three origins (`0 0`, `50% 50%`, `17px 23px`), and presence or
   absence of a neutral `display: contents` wrapper: 24 cases total. Every
   captured descendant `(x, y, width, height)` equalled its same-frame live
   `getBoundingClientRect()` value exactly (maximum delta 0). Every wrapper
   pair was invariant. At scale 0.69, inverse-normalized item pitch remained
   50px, while the translated rows moved by -5px and +10px in local space,
   proving nested translation is scaled once rather than omitted or doubled.

The mutation contracts for the proposed permanent oracle are logical, not
pixel allowances:

- comparing captured coordinates with unscaled descendant translations must
  fail at every non-unit scale;
- applying the ancestor scale a second time must fail;
- ignoring `transform-origin` must fail for both center and length origins;
- adding a neutral `display: contents` wrapper must not move any descendant;
- a fractional local padding, gap, or translation case must distinguish
  Blink's `LayoutUnit` geometry from a mutation that rounds local positions
  before the ancestor transform; the current integral local inputs do not
  activate that mutation;
- emitted SVG rectangle geometry must be compared with the live/captured facts,
  because capture-versus-live alone does not test renderer consumption.

## Conclusion and next step

There is no earliest current production gap to fix. The earliest historical
gap was the old pre-transform capture/reapply model documented by DM-587; the
live-rectangle path has already removed it. The fixture comment still speaks
as though SVG `<g>` composition owns this pure-scale case, but the present
implementation intentionally bakes the live viewport geometry and suppresses
that group. That stale explanation should be corrected with the threshold.

The 252 raw macOS pixels are not an unexplained Skia-only difference:
`src/render/format.ts` applies the documented one-decimal SVG serialization.
Chromium reports the translated green row at y=57.9500007629 and height
27.6000023; SVG emits y=58 and height=27.6, producing the two 126px horizontal
edge rows. The permanent oracle must assert capture equals live and emitted SVG
equals the documented rounding of capture, rather than demanding sub-tenth
coordinate identity.

The follow-up is now shipped. `tests/transformed-flex-geometry.e2e.test.ts`
crosses 24 scale/origin/wrapper states with fractional padding, gap, size, and
translations. It requires same-frame live rectangles to equal captured facts,
and emitted SVG bounding boxes to equal the documented one-decimal
serialization. Omitted/doubled scale, ignored origin, wrapper movement,
premature local rounding, and renderer-consumption mutations are all active.
The feature's `relaxedDiffPct: 0.05` is removed. A native macOS/Linux/Windows
workflow runs both this exact logical matrix and the scored fixture; raw raster
edges remain evidence rather than a substitute geometry threshold.
