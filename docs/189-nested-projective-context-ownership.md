---
id: "requirements/nested-projective-context-ownership"
title: "189 — Nested projective-context raster ownership"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2356","DM-2359","DM-2492","DM-2493"]
code: []
aliases: ["docs/189-nested-projective-context-ownership.md","doc-189"]
---

# 189 — Nested projective-context raster ownership

**Status:** production selector and strict all-platform release gate shipped by DM-2492/DM-2493

**Ticket:** DM-2356

Domotion already keeps non-affine CSS paint in an atomic Chromium raster and
emits each selected raster once. This investigation asks a narrower question:
which element is the *smallest* raster owner when projective descendants cross
perspective, `preserve-3d`, ordinary/flat intermediaries, or grouping
properties? The answer is not “the outermost ancestor with a 3D symptom.” It is
Blink's used rendering-context root, or the non-affine plane itself when no
rendering context exists.

The audit found a production defect. Before DM-2492, `measureProjectivePaintQuads` marked every
descendant of a 3D-signal element as influenced, and `selectProjectiveRasterOwners`
then climbs through all influenced ancestors. That descendant-union model
over-owns nine of thirteen source-discriminating families. The resulting SVG is
visually close because the larger Chromium crop contains the right pixels, but
unrelated vector siblings were unnecessarily baked into the bitmap. DM-2492
replaced that selector with the source-derived used-context walk below.

## Pinned source verdict

The source revisions are Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and its DEPS-pinned Skia
`62efacd37737505732dbe3d8daa62abd679626a1`.

Blink's state machine is explicit:

1. `ComputedStyle::UsedTransformStyle3D` forces authored `preserve-3d` to
   `flat` when a grouping property is active
   (`computed_style.h:2131-2146,2210-2267`). The grouping predicate includes
   opacity/current opacity animation/`will-change:opacity`, filter and
   `will-change:filter`, reflection, clip-path, isolation, mask, blend,
   backdrop-filter, view-transition participation, positioned CSS `clip`, and
   either non-visible overflow axis.
2. A transform node inherits the current `RenderingContextId`. A used
   `preserve-3d` element outside a context creates an ID
   (`paint_property_tree_builder.cc:1458-1466`). Only a parent whose *used*
   style preserves 3D propagates that ID to children; an ordinary nonanonymous
   object or a flat/grouping object resets it
   (`paint_property_tree_builder.cc:1634-1651`).
3. Perspective creates a projection node in the transform chain, but it does
   not establish a rendering context. Blink's own test requires both the
   perspective node and its transformed child to have no context ID
   (`paint_property_tree_builder_test.cc:3495-3523`).
4. Context propagation follows direct DOM-parent applicability. An ordinary
   intermediary breaks sharing, even when the outer ancestor preserves 3D
   (`paint_property_tree_builder_test.cc:3158-3197`), and a nested preserve
   subtree below a break starts a new context
   (`paint_property_tree_builder_test.cc:3285-3321`). The runtime paint-layer
   path repeats the direct-parent rule (`paint_layer.cc:1166-1174`).
5. A flat leaf inside its parent's 3D scene gets a separate render pass so its
   descendants do not emit sorting-context-zero quads into the shared scene
   (`compositing_reason_finder.cc:179-211`). This is a paint boundary, not a
   reason to promote the raster through unrelated ancestors.
6. `LayoutObject::Preserves3D` additionally checks layout applicability and
   excludes SVG children (`layout_object.h:1569-1595`). Existing inline-SVG
   atomic-clone promotion therefore remains a later ownership step, after the
   correct HTML context root has been selected.

Fixed-position containing-block ownership is separate. It intentionally uses
computed transform-related properties in places where projective paint uses
the *used* rendering context. A grouping property can therefore flatten paint
without erasing the computed `preserve-3d` containing-block signal.

## Exact ownership algorithm

For a frame-coherent, non-affine paint plane:

1. Capture whether each applicable layout object has used `preserve-3d` after
   grouping-property resolution.
2. Walk in DOM order. Inherit a context root only from a direct parent whose
   used style preserves 3D. If such an element has no inherited context, it is
   the new context root. Otherwise reset the context passed to children.
3. A non-affine plane owns itself when it has no context ID; inside a context,
   the context root owns the scene.
4. Promote that owner through an opaque inline-SVG clone only when the clone
   would otherwise suppress it.
5. Remove only true ancestor/descendant duplicate owners. Never merge sibling
   projective planes merely because one outer ancestor has perspective or a 3D
   property token.

Unknown used-style facts must select an explicit conservative Chromium surface
and warn. In particular, `ElementIsViewTransitionParticipant()` is an internal
same-frame fact not exposed by ordinary CSSOM. The deterministic audit does not
start a view transition and records that control as proven false; production
must capture the active fact or fail closed rather than silently assuming it.

## Observational audit

`npm run transform:nested-projective-owner-audit` builds twenty-five font-free
cases and compares three independent views of each row:

- source-derived used-context ownership from live computed facts and CDP
  content quads;
- production `transformSubtreeRaster` owner IDs and PNG payloads; and
- complete generated-SVG structure, including a uniquely colored vector
  sentinel outside the minimal owner and the count/placement of every atomic
  `<image>`.

The families cover shared/nested contexts, perspective, ordinary/flat breaks,
every Blink grouping axis (including animation and will-change variants), both
overflow axes, independent planes, affine and affine-matrix3d negatives, and
inline-SVG/foreignObject promotion.
Every non-affine decision is backed by the held-out fourth-corner residual from
Chromium's quad rather than a parsed transform string.

Local macOS evidence on the pinned Chromium is:

| Evidence | DPR 1 | DPR 2 |
| --- | ---: | ---: |
| source-model rows | 13/13 | 13/13 |
| minimal production owners | 13/13 | 13/13 |
| over-owned production rows | 0/13 | 0/13 |
| atomic rasters emitted once | 13/13 | 13/13 |
| over-owned rows that absorbed the vector sentinel | 0 | 0 |
| source/generated changed-pixel fraction (diagnostic only) | 0.16053% | 0.07388% |

All thirteen source-discriminating families now select the same minimal owner
as the independent model. Perspective-only and ordinary breaks own the plane;
flat/grouping breaks allow the preserving descendant to start a fresh context;
and every uniquely colored sentinel remains vector-owned.

Six structural mutations are mandatory and all are detected: owner one level
too high, owner one level too low, dropped owner, duplicate raster, baked vector
sibling, and double transform application. Investigation success requires
complete source evidence and mutation sensitivity; it does not disguise the
production failures as an audit failure.

## Existing-gate correction

DM-2492 corrected DM-2359's independent expectations: perspective owns its
non-affine plane, while the animated overflow grouping row identifies the
measured intermediary and expects that fresh root after the break. The focused
gate is 64/64 at DPR 1/2 with 5/5 mutations.

Likewise, the inline-SVG affine freeze and opaque-clone promotion in doc 162
remain source-owned. What is partial is the HTML nested-context owner chosen
*before* that promotion.

## Follow-up boundary

DM-2492 changes production capture and selection by:

- replacing descendant-union ownership with frame-coherent used rendering-context
  facts while retaining inline-SVG promotion and one-owner emission;
- correcting the animated oracle's expected owner and labeling the grouping
  intermediary independently; and
- leaving promotion of this corpus to a strict native macOS/Linux/Windows
  DPR-1/2 release gate, preserving the vector sentinel and all six mutations.

- **DM-2492** implements frame-coherent Blink used rendering-context owner
  selection and corrects the animated expectation (complete in this source tree).
- **DM-2493** promotes this corpus to a strict native macOS/Linux/Windows
  DPR-1/2 release gate. Four environment profiles cross horizontal/LTR,
  vertical/RTL fractional zoom and scroll, iframe/SVG/effects, and paused
  document-timeline evidence. Schema-v2 reports carry lossless PNG SHA-256,
  crop/frame geometry, restoration and warning integrity, complete Cartesian
  keys, and nine mandatory mutations; the aggregate rejects any missing arm.
