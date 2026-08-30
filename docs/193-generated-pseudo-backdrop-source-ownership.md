---
id: "requirements/generated-pseudo-backdrop-source-ownership"
title: "Generated-pseudo backdrop source ownership"
kind: "contract"
status: "current"
owners: ["paint-effects"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2357","DM-2487","DM-2488"]
code: ["tools/pseudo-backdrop-source-oracle.ts"]
aliases: ["docs/193-generated-pseudo-backdrop-source-ownership.md","doc-193"]
---

# Generated-pseudo backdrop source ownership

**Status:** source-owned production boundary and native release gate (DM-2488)

## Problem

The generated-pseudo protocol already retained Chromium's real
`::before`, `::after`, and `::checkmark` box/text/image fragments, but its paint
record stopped at `opacity` and regular `filter`. A pseudo with a live computed
`backdrop-filter` therefore captured exact vector geometry while serializing no
filtered source surface. Moving that effect to the host would be observably
wrong: it flattens host paint, changes the generated-child slot, and bakes later
siblings or pseudo descendants into the wrong owner.

## Pinned source contract

The implementation is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and the Skia revision in that
checkout, `62efacd37737505732dbe3d8daa62abd679626a1`.

- `paint_property_tree_builder.cc` builds `BackdropFilterInfo` on the current
  box-model object's effect node via `PopulateBackdropFilterIfNeeded`.
- `paint_layer.cc::BackdropFilterReferenceBox` uses an inline's physical lines
  bounding box or a box's physical border box; `BackdropFilterBounds` applies
  the source-owned contoured border geometry.
- `SkCanvas.cpp` states the decisive image direction: for a backdrop filter,
  the source is the parent device and the destination is the new layer.
- Blink's real generated pseudo has its own backend/layout node. Its
  DOMSnapshot paint order—not host source order or a renderer heuristic—is the
  isolation boundary.

## Capture ownership

`preparePseudoFragmentGeometry` now retains the computed pseudo
`backdropFilter` and, for each visible exact record, materializes one
`backdropFilterRaster`:

1. the pseudo backend node selects its independent DOMSnapshot paint row;
2. prior overlapping paint remains visible while later unrelated owners are
   hidden and restored through CDP;
3. the target pseudo's reproducible background, border, text and generated
   image paint is temporarily neutralized without changing box geometry;
4. generated images are replaced only for that frame by transparent SVGs with
   the same intrinsic size, so mixed text/image layout does not reflow;
5. ancestor opacity and regular filter are replaced by identity effects that
   preserve the Backdrop Root transition and prevent final-SVG double
   application;
6. the cropped Chromium prior-device pixels are attached to the pseudo record,
   never to `CapturedElement.backdropFilterRaster` on its host.

`none`, hidden/collapsed, opacity-zero, and empty/no-box pseudos remain
authoritative zero-owner states. Isolation failure is explicit through the
`generated-pseudo-backdrop-filter` unavailable warning; it never silently
promotes a host crop.

## Render ownership

The direct pseudo renderer emits the Chromium raster first inside the record's
already captured `negative`, `before`, `after`, `positioned`, or `positive`
slot. A separately marked vector group then paints the retained pseudo box,
text, and generated images. The complete record remains inside the ordinary
host transform/clip/opacity/filter wrappers, with the existing emitted-CTM
compensation preventing viewport-space raster coordinates from being
transformed twice.

This is one pseudo-local raster boundary plus direct vectors. It is not a
terminal host raster and does not change the host's child plan.

## Independent gate

`tools/pseudo-backdrop-source-oracle.ts` runs 15 cases at DPR 1 and 2:

- active, `none`, hidden and empty activation;
- in-flow before/after and `appearance:base` checkmark identity;
- positioned, negative and positive slots;
- ancestor Backdrop Root and effective zoom;
- nested and overlapping pseudo owners;
- text, box and generated-image vector descendants.

For every active row, the gate requires exactly one pseudo-owned raster, no
host-wide raster, the captured slot, raster-before-vector order, a bounded
Chromium/final-SVG mean channel delta, and two destructive controls. Removing
the raster must change the result; replacing it with the final composited crop
must also change the result, so neither under-capture nor over-capture can pass
as a plausible screenshot. The local macOS run produced 30/30 passing rows,
24/24 active owners, 24/24 under-capture discriminators, 24/24 over-capture
discriminators, and no warnings across DPR 1/2. The workflow repeats the same
gate and uploads source/rendered/mutation PNGs, SVGs and JSON on macOS, Linux
and Windows.

## Remaining boundary

DM-2488 closes generated-pseudo ownership only. The broader DM-2357/DM-2487
work still owns a general non-pseudo representation for arbitrary ancestor
effect-space surfaces. The focused gate must not be used to declare those
separate viewport-final-crop transitions exact.
