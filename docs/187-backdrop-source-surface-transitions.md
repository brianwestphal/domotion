# 187 — Backdrop-filter source-surface transitions

**Status: source investigation and all ownership follow-ups shipped. Ordinary
effect-space parity is now a strict native gate in
[doc 195](195-strict-ordinary-backdrop-ownership.md).**

## Question

Doc 126 established the right coarse boundary: an `<img>`-embedded SVG cannot
sample pixels already painted behind one of its internal groups, so an active
`backdrop-filter` needs Chromium pixels. The remaining question is *which
surface owns those pixels* as the target crosses stacking contexts, Backdrop
Roots, transforms, clips, masks, scrolling, generated content, and overlapping
paint.

The initial investigation added an observational oracle. Docs 192–195 record
the production ownership, generated-pseudo, fixed-order, diagnostic, and final
strict-gate work that followed from its findings.

## Source verdict

The source baseline is Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and the Skia revision pinned by
that checkout, `62efacd37737505732dbe3d8daa62abd679626a1`.

Blink does not model a backdrop as a CSS-filter function applied to the
target's reconstructed box:

- `FragmentPaintPropertyTreeBuilder::NeedsEffectIgnoringClipPathAnd2DScale()`
  gives a nonempty backdrop filter its own effect node.
- `FragmentPaintPropertyTreeBuilder::NeedsEffect()` also materializes effect
  nodes on otherwise auxiliary Backdrop Roots when a backdrop-filter
  descendant exists. A simple `clip-path` and the `will-change: clip-path` /
  `will-change: mask` compositing reasons are explicit cases.
- `PopulateBackdropFilterIfNeeded()` installs filter operations, a contoured
  bounds path, and the mask compositor id on `BackdropFilterInfo`.
- `PaintLayer::UpdateCompositorFilterOperationsForBackdropFilter()` uses the
  physical border/inline-line reference box, removes effective zoom from the
  compositor reference box, and appends the target's ordinary `filter`
  operations to the backdrop chain. Blink documents this as a workaround for
  its distinct backdrop and regular-filter effect nodes/render surfaces, with
  the backdrop node first.
- `object_paint_properties.h` documents the order as Effect, Filter, then Mask:
  the mask paints last with `DstIn` rather than becoming the backdrop input.
- Skia `SkCanvas::internalSaveLayer()` initializes a backdrop layer by drawing
  the `priorDevice` into the new device through `internalDrawDeviceWithFilter`.
  The source is the prior parent device, not the target's final screenshot.

The resulting nearest-ancestor Backdrop Root classifier is:

| Creates a Backdrop Root | Does not create a Backdrop Root |
| --- | --- |
| document root | ordinary positioned/z-index stacking context |
| `opacity < 1` | `isolation:isolate` by itself |
| noninitial `filter` | 2D/3D transform by itself |
| noninitial `backdrop-filter` | overflow clip or scroll container |
| `clip-path` | fixed positioning |
| mask / mask-border | sticky positioning |
| nonnormal `mix-blend-mode` | |
| matching `will-change` values | |

`isolation:isolate` remains an important blend-group boundary, but it is not a
Backdrop Root trigger in Filter Effects 2 and does not take the auxiliary-root
path in this Blink revision. Likewise, transform, scroll, fixed, and sticky
create other property-tree nodes without changing the nearest backdrop input
surface. HarfBuzz has no role in this pixel/effect-tree decision.

## Independent audit

`tools/backdrop-source-surface-audit.ts` generates one deterministic, font-free
page with 17 families:

1. document-root baseline;
2. ordinary nested stacking context;
3. `isolation:isolate`;
4. opacity root;
5. transformed non-root;
6. clip-path root;
7. mask root;
8. scrolled overflow container;
9. fixed target;
10. sticky target;
11. `::before` target;
12. nested backdrop targets;
13. overlapping sibling backdrops;
14. filter root;
15. target-local regular-filter chain;
16. overflow clip; and
17. blend-mode root.

For each DPR the audit:

- reads the live computed target and ancestor chain and applies the
  source-derived Backdrop Root classifier;
- takes an independent pre-capture `DOMSnapshot` for target/later-sibling paint
  order;
- captures the production tree and counts the serialized
  `backdropFilterRaster` owners under each named case;
- renders the complete SVG as an image and compares the target region with the
  original Chromium page;
- verifies that the target raster precedes its vector child and compares the
  raster/later-sibling order with the independent snapshot; and
- renders two destructive controls:
  - **under-capture:** remove the raster data URI, leaving the reconstructed
    target with no usable backdrop input;
  - **over-capture:** replace the isolated surface with the final Chromium
    target crop, deliberately baking semi-transparent descendants/later paint
    that the SVG then paints again.

A pixel is changed when any channel differs by more than four codes. The 1%
changed-pixel classification is a diagnostic boundary, not a release tolerance;
mutations must move at least 0.2% of pixels and one channel by at least 12 codes.
`--json` writes the complete report and `--artifact-dir` writes source,
candidate, under-capture, over-capture, and SVG artifacts per DPR.

## Initial DPR 1/2 result

Both native runs returned `investigation-complete` with no evidence blockers:

| Evidence | DPR 1 | DPR 2 |
| --- | ---: | ---: |
| Source-root classifications | 17/17 | 17/17 |
| Serialized raster ownership | 16/17 | 16/17 |
| Under-capture mutations killed | 16/16 | 16/16 |
| Over-capture mutations killed | 16/16 | 16/16 |
| Raster before target vector | 16/16 | 16/16 |
| Raster/later sibling matches source | 15/16 | 15/16 |

The missing owner is the generated-pseudo row; it has an active computed
backdrop filter but serializes no source surface. DM-2489/doc 192 subsequently
closed the fixed sibling-order miss: `DOMSnapshot` and generated SVG now both
place the target raster and retained vectors before the later positioned
sibling at DPR 1/2.

The target-region changed-pixel fractions make the effect-space problem
visible. Small edge differences remain diagnostic rather than being declared
pixel-exact:

| Family | DPR 1 | DPR 2 | Interpretation |
| --- | ---: | ---: | --- |
| plain / stacking / isolation | 0.49% | 0.25% | Same document-root surface; stacking/isolation do not change it. |
| opacity root | 98.02% | 97.57% | Final crop is processed again by the ancestor opacity group. |
| transformed non-root | 64.29% | 63.77% | Viewport-final pixels and emitted transform space disagree. |
| clip-path root | 0.49% | 0.25% | Binary interior is stable; edge ownership still needs the root contract. |
| mask root | 10.42% | 4.13% | Reapplying the ancestor mask changes coverage. |
| scroll / sticky | 1.20% / 1.02% | 0.24% / 0.18% | They remain document-root transitions. |
| fixed | 0.45% | 0.22% | DM-2489 preserves the independently measured sibling order. |
| generated pseudo | 91.55% | 91.85% | No serialized backdrop owner. |
| nested / overlapping backdrops | 0.56% / 0.45% | 0.32% / 0.34% | Both targets serialize independent surfaces and preserve ordinary order. |
| filter root | 88.18% | 87.89% | The already-final crop is filtered again by the ancestor root. |
| target-local filter chain | 3.30% | 2.91% | Splitting the baked box from vector descendants loses one group surface. |
| overflow clip | 0.51% | 0.27% | Overflow does not create a Backdrop Root. |
| blend root | 98.86% | 98.78% | The already-composited crop participates in the ancestor blend again. |

## Why the current representation is insufficient

The DOM walker records only the target's viewport `getBoundingClientRect()` and
a token. The node pass hides selected descendants/later paint and asks
`page.screenshot()` for that rectangle. That screenshot is already a final
viewport composite: ancestor opacity, filters, masks, blends, and transforms
have happened.

The renderer emits the bitmap before the target's own vector descendants, but
it is still inside every recursively opened ancestor wrapper. Those wrappers
therefore process final pixels a second time. Keeping the raster outside the
target's own ordinary-filter wrapper also splits Blink's one filtered group
between a baked box and separately filtered vector descendants. The problem is
ownership/coordinate space, not blur arithmetic and not a larger raster-diff
tolerance.

The audit also records a stale diagnostic: successful Chromium raster rows
still warn that backdrop-filter is only doc 19's solid frosted-glass
approximation. Runtime warning ownership must move to the post-pass that knows
whether raster materialization succeeded.

## Follow-up completion

- **Ordinary-element ownership (docs 194 and 195):** source-owned nearest-root
  and effect-space facts, atomic opacity/blend/mask roots, target-filter
  grouping, and the rotate/skew terminal surface landed. The final schema-v2
  DPR-1/2 audit is strict and records zero logical-interior residual pixels.
- **DM-2488:** give live generated pseudos their own backdrop source boundary at
  the captured pseudo paint slot; do not flatten the host. **Landed in doc
  193:** the focused 15-case DPR-1/2 gate reports 30/30 passing rows, 24/24
  active pseudo owners and both destructive mutations for every owner.
- **DM-2489 (landed; doc 192):** Chromium sibling order is preserved for
  fixed/hoisted backdrop rasters without weakening the oracle tolerance.
- **DM-2490:** retire the pre-raster frosted-glass warning on successful
  materialization and emit structured partial/unavailable diagnostics only
  from the authoritative post-pass.

Doc 126's target snapshot remains the explicit fallback when authoritative
source materialization is unavailable. Successful ordinary, fixed, and
generated-pseudo ownership paths are now independently strict-gated; retained
partial/unavailable output remains diagnostic rather than silently promoted.
