---
id: "requirements/nested-projective-context-ownership"
title: "189 — Nested projective-context raster ownership"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2356", "DM-2359", "DM-2492", "DM-2493", "DM-TF7QX8", "DM-9TGDYG", "DM-6NS46P"]
code:
  [
    "tests/nested-projective-ownership-audit.e2e.test.ts",
    "tests/nested-projective-ownership-audit.test.ts",
    "tools/nested-projective-ownership-audit.ts",
    "tools/parity-program.json",
    "tools/check-projective-owner-release.ts",
    "tools/projective-owner-release-producer.ts",
    "tools/projective-owner-release-gate.ts",
    "tools/projective-owner-artifact-integrity.ts",
    "tests/projective-owner-artifact-integrity.test.ts",
  ]
aliases: ["docs/189-nested-projective-context-ownership.md", "doc-189"]
---

# 189 — Nested projective-context raster ownership

**Status:** production selector and strict all-platform release gate shipped by DM-2492/DM-2493

**Ticket:** DM-2356

Domotion already keeps non-affine CSS paint in an atomic Chromium raster and
emits each selected raster once. This investigation asks a narrower question:
which element is the _smallest_ raster owner when projective descendants cross
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
   (`paint_property_tree_builder.cc:1458-1466`). Only a parent whose _used_
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
the _used_ rendering context. A grouping property can therefore flatten paint
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

| Evidence                                                  |    DPR 1 |    DPR 2 |
| --------------------------------------------------------- | -------: | -------: |
| source-model rows                                         |    13/13 |    13/13 |
| minimal production owners                                 |    13/13 |    13/13 |
| over-owned production rows                                |     0/13 |     0/13 |
| atomic rasters emitted once                               |    13/13 |    13/13 |
| over-owned rows that absorbed the vector sentinel         |        0 |        0 |
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
_before_ that promotion.

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

### Every audited owner must be on canvas

A row can witness "one direct atomic image per owner" only if Chromium paints
that owner inside the capture viewport. The fixture stage is exactly the
capture viewport, so any profile zoom above 1 scales the fourth column and the
last row past its edge. The vertical/RTL profile originally used `zoom:1.25`.
That placed the `ordinary` and `independent` planes entirely outside the
1000 px viewport, so Chromium painted nothing there. The capture correctly
recorded each isolated owner as `empty`, and the release gate reported
`rasterCount = 0` on all three platforms. Seven more owners were only
partly visible, so their rasters were clipped.

- The profile now uses `zoom:0.8` (`NESTED_PROJECTIVE_FRACTIONAL_ZOOM`). That
  is still a non-integer zoom, so fractional layout snapping is still
  exercised, and every case stays on canvas.
- The audit fails closed on this class of fixture error. An expected owner
  whose Chromium content quad leaves the viewport becomes a case-scoped
  blocker (`fixture places the expected owner outside the capture viewport`).
- The producer fails that row and copies the blocker into its `warnings`.
  The adjudicator therefore names the cause instead of a bare raster-count
  miss.

### The vertical/RTL profile is genuinely scrolled

The profile name and the release-gate claim include scroll, but the fixture
page originally never scrolled. `body` was `overflow:hidden` and nothing set a
scroll offset, so the scroll part of the claim was never tested. The profile
now captures a scrolled state:

- The stage sits inside a `#scroller` scroll container with
  `writing-mode:vertical-rl; direction:rtl`. Its scroll origin is the
  bottom-right corner, so the reachable offsets are negative on both axes.
  An inner wrapper at (-263, -197) holds the stage with a 23 × 17 px inset,
  so the unscrolled stage starts at (-240, -180). The wrapper resets the
  writing mode, so
  the stage's own profile CSS (zoom 0.8, vertical-rl/RTL, sub-pixel
  translate) is unchanged.
- An inline script applies `NESTED_PROJECTIVE_SCROLL_OFFSET` = (-263, -197)
  before `load`. The stage then paints at (23, 17), fully on canvas. The
  offset is load-bearing: at offset 0 every owner quad is 263 px left and
  197 px above its scrolled position, and the off-canvas owner guard blocks
  the rows.
- The offsets are integers. Blink rounds a programmatic scroll offset when
  fractional scroll offsets are disabled (`ScrollableArea::ScrollOffsetChanged`
  → `ShouldUseIntegerScrollOffset()`, `core/scroll/scrollable_area.cc:626`,
  `scrollable_area.h:291`, chromium `7d859f27`). A requested -263.5 reads back
  as -263 at DPR 1 and 2. The profile's fractional coverage comes from the
  zoom and the translate.
- The audit records `scrollOffsets` per DPR, before and after capture. It
  blocks the scroll profile when the measured offset differs from the declared
  one, or when capture changes the offset. It also blocks any other profile
  that has a scroll container.
- Measured on macOS: all 200 producer rows pass. With the scroll assignment
  removed, the audit reports `scroll offset not in effect: measured (0, 0)`
  and 17 off-canvas owner blockers per DPR. The source-vs-SVG changed fraction
  is the same as the pre-change unscrolled fixture (0.0547 at DPR 1), so
  capture under the scrolled ancestor keeps the same fidelity.
- `tests/nested-projective-ownership-audit.test.ts` pins the fixture shape and
  the scroll blockers. `tests/nested-projective-ownership-audit.e2e.test.ts`
  asserts the audit's recorded offsets. It also resets the offset to 0 and
  requires every content rect to move by exactly the offset, with owners
  leaving the viewport.

### Aggregate artifact-integrity contract

The adjudicator (`npm run transform:projective-owner-release -- --reports <dir>`,
`tools/check-projective-owner-release.ts`) runs once on Linux over the
downloaded tree `projective-owner-{macOS,Linux,Windows}/`, each holding its own
`report.json` and `artifacts/<fingerprint>/<profile>/*.png`. Every artifact path
is resolved against its own report's directory by
`tools/projective-owner-artifact-integrity.ts`, which then checks PNG decoding,
SHA-256 and dimensions.

- Artifact paths are **portable report-relative paths**. The producer writes
  them with `/`, and the adjudicator accepts both `/` and `\` and resolves them
  segment by segment. A Windows collector once wrote `artifacts\<fingerprint>\…`,
  and POSIX `path.resolve` read the whole string as one filename. That made all
  400 Windows artifacts "unreadable" in the three-platform tree, and the
  resulting 400 integrity blockers buried the real producer blockers.
- Absolute paths (POSIX root, drive letter, UNC) and any `..` segment are
  reported as `artifact escapes report root`.
- `tests/projective-owner-artifact-integrity.test.ts` pins this with a synthetic
  three-collector tree whose Windows report uses backslash paths.
