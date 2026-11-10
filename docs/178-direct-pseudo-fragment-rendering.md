---
id: "requirements/direct-pseudo-fragment-rendering"
title: "178 — Direct source-owned generated-pseudo rendering"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2459", "DM-2468", "DM-2488", "DM-P1ASMP", "DM-AWS6Y4", "DM-XWPSPP", "DM-NAG7AD", "DM-5YF0BB"]
code:
  [
    ".github/workflows/pseudo-fragment-render-parity.yml",
    "src/render/pseudo-fragments.ts",
    "src/render/pseudo-stacking-order.ts",
    "src/render/pseudo-stacking-contexts.ts",
    "src/render/pseudo-stacking-contexts.test.ts",
    "src/capture/pseudo-fragment-cdp.ts",
    "tests/pseudo-ancestor-stacking.e2e.test.ts",
    "tests/pseudo-fragment-render-oracle.e2e.test.ts",
    "tests/pseudo-fragment-render-report.test.ts",
    "tests/pseudo-stacking-native-contract.e2e.test.ts",
    "tools/pseudo-fragment-render-oracle.ts",
    "tools/pseudo-fragment-render-report.ts",
  ]
aliases: ["docs/178-direct-pseudo-fragment-rendering.md", "doc-178"]
---

# 178 — Direct source-owned generated-pseudo rendering

**Ticket:** DM-2468
**Status:** direct record rendering, compatibility-bridge retirement, and the
native macOS/Linux/Windows DPR gate are shipped
**Source pins:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`, and Chromium-pinned
Skia `62efacd37737505732dbe3d8daa62abd679626a1`

## Outcome

`src/render/pseudo-fragments.ts` consumes `CapturedPseudoFragmentSet`
directly. New live captures no longer project a source-owned record back into
`textSegments`, `pseudoImages`, or `pseudoBoxes`, so the old host-first/last
text anchor, flex-center, 0.8-line-height wrap threshold, and synthetic
half-leading branches cannot regain authority. Old serialized trees that only
contain the legacy fields remain readable through their existing renderer
paths; the deleted `pseudo-fragment-compat` projection is not needed for them.

The renderer validates the record before paint. Invalid or collapsed box
quads/baselines fail closed to a diagnostic boundary; a captured
`terminal-raster` record emits its single isolated Chromium surface. Hidden,
collapsed, and zero-opacity records emit no pseudo paint. Exact records retain
the captured pseudo/content-item identity, fragment order, physical plane,
baseline, selected-face typography, logical edge ownership, and paint slot.

## Direct paint ownership

The implementation keeps Blink's decisions separated by owner:

- Each generated text fragment follows the ordinary resolved-face,
  HarfBuzz/fontkit, and path route at its captured physical baseline and
  inline origin. Bidi fragments are projected from the retained visual order;
  horizontal, vertical, and sideways records use the captured writing plane.
- When capture authenticates a bitmap/color representation in an otherwise
  exact text-only record, one isolated Chromium text surface replaces only the
  vector text fragments. The record's boxes, paint slot, filter/opacity wrapper,
  and geometry remain direct and vector-owned; `font-variant-emoji` is retained
  for both classification and ordinary outline-capable text.
- Each anonymous `url()` child stays a separate content item and is emitted
  through the ordinary image embedding cache at its captured replaced-child
  quad. Text/image/text sequences are never concatenated or independently
  anchored.
- Each box fragment maps its retained local border rectangle onto the full
  physical quad. Background, border, padding, radius, and
  `box-decoration-break` slice/clone edge ownership are painted per fragment,
  including multicolumn translations.
- `::before`, `::after`, positioned, negative, and positive records enter
  explicit host paint slots. A negative positioned pseudo whose host does not
  establish a stacking context remains owned by the ancestor context and
  paints below the host box; a host-local stacking context retains Appendix E
  ordering.
- An already-emitted host CTM is inverted around source-owned physical pseudo
  paint, so transforms are applied exactly once rather than baking host
  geometry into every fragment.

For checkboxes and radios, DM-2459 assigns `::checkmark` to the before slot
ahead of `::before`, matching Blink's attachment order. Resolved
`appearance:none`/`base` plus an authoritative pseudo record array (including
an empty array) suppresses the generic checkbox/radio indicator. Native
`appearance:auto` remains a negative control, and only pre-contract trees with
an undefined record field can use the legacy heuristic. Uniform solid rounded
pseudo borders preserve their circular contour rather than becoming four
square-corner side strokes.

The main renderer continues to allocate image/background paint servers and
the existing affine wrappers. The pseudo renderer supplies their authoritative
fragment geometry; it never reads host `textSegments`, host edges, or host
font ascent to reconstruct placement.

DM-2488/doc 193 extends that same record-local order for `backdrop-filter`.
One Chromium prior-device raster paints first inside the already selected
pseudo slot, followed by a separately marked direct box/text/image vector
group. The raster never migrates to the host and does not terminate otherwise
exact pseudo descendants.

## Independent paint gate

`tools/pseudo-fragment-render-oracle.ts` captures one adversarial live Chromium
page, renders the resulting tree to SVG, rasterizes that SVG in a second
Chromium page, and compares the colored pseudo-paint edge sets in device space.
When `--json` is set, the retained report uses a version 1 envelope with a
normalized `pass` or `fail` outcome while preserving the oracle's full domain
report in `data`. The reader accepts legacy version 1 raw reports and rejects
unknown versions. Without `--json`, stdout keeps the original raw report.
The acceptance disk is exactly four device pixels at both DPR 1 and DPR 2; it
is deliberately not multiplied by DPR. Exact record count, terminal record
count/reasons, emitted source-marker count, structural validation errors, both
directed unmatched-edge counts, and maximum edge distance are recorded.

The corpus covers before/after and child-first/child-last hosts; one, two, and
three wrapped lines; all Blink `vertical-align` families; mixed fallback fonts
and sizes; LTR/RTL bidi; vertical and sideways writing; text/URL/text;
asymmetric slice/clone edges; multicolumn; inline-block/flex/grid; absolute and
fixed placement; negative stacking, affine transform, zoom, and DPR 1/2.
`content:none`, `display:none`, `visibility:hidden`, and `opacity:0` are
negative pseudo-paint controls, while ordinary text, first-letter, line-clamp,
and list-marker routes remain outside the generated-pseudo owner.

The DM-2459 extension adds none/base checkbox and radio indicators across
checked, unchecked, indeterminate, disabled, generated text/box/gradient,
affine transform, switch, fractional-origin, zoom, and DPR rows. The focused
browser test independently asserts `::before`/`::after`/`::checkmark`
identities, authoritative empty ownership, synthesis suppression, and the
native-auto raster negative.

The focused unit mutations prove that changing host text coordinates cannot
move source-owned output and that a collapsed baseline or quad cannot silently
reactivate a legacy anchor. `tests/pseudo-fragment-render-oracle.e2e.test.ts`
provides the focused browser leg. Run the full local gate with:

```bash
npm run pseudo:fragment-render-oracle -- \
  --json tests/output/pseudo-fragment-render/report.json \
  --artifact-dir tests/output/pseudo-fragment-render/artifacts
```

`.github/workflows/pseudo-fragment-render-parity.yml` runs the unit, capture,
and DPR-1/2 paint legs natively on macOS, Linux, and Windows for pull requests
and `main`. Every runner always uploads its report, source PNGs, rendered PNGs,
and generated SVGs. Platforms do not share a font or screenshot baseline.

## Evidence boundary

### Positioned pseudo/child interleaving gap (DM-AWS6Y4)

The Stripe mobile card's expand SVG is captured and emitted with opaque purple
paths, but an absolute auto-z `::after` background paints later and covers it.
The pre-repair `paintElementOverlayPhase` emitted every child inline/positive bucket
before its positioned pseudo slot. Native controls with the same child at
`position:relative; z-index:1` distinguish source ownership from this emission
order:

| After pseudo z-index | Native icon | Pre-repair output icon |
| -------------------- | ----------- | ---------------------- |
| No pseudo, or -1     | Visible     | Visible                |
| auto, or 0           | Visible     | Covered                |
| 1, or 2              | Covered     | Covered                |

The twelve-case reduction gives the same answers with containment `none` and
`layout style`; containment is not the cause of this omission. The source SVG,
captured opacity/fill and emitted paths remain valid in all cases. The native
source/capture contract is retained in
`tests/pseudo-stacking-native-contract.e2e.test.ts`.

The installed Chromium 147 revision
`6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050` corroborates the native result:
`PaintLayerStackingNode::RebuildZOrderLists` stable-sorts by effective z-index,
`CollectLayers` stops at nested stacking contexts, and `PaintLayerPainter`
preserves background/negative/foreground/normal-positive phases. Repair
DM-XWPSPP merges host-local positioned/positive pseudos with the existing stacked
child buckets by numeric z-index and stable generated-child order. In-flow
`::after` follows in-flow content before positioned children. Elements without
source pseudo overlays retain their original child-emission fast path. Native
coverage also crosses before/after ties, intermediate positive levels, the
in-flow seam, and overflow clipping. Moving
all pseudos before all children would break the tied/higher-z controls. The
independent loaded-image, CSS resource and bitmap-sampling tickets keep their
own scope; no production change is part of the AWS investigation commit.

That local repair did not establish ancestor-context pseudo ownership.
DM-NAG7AD retained an unchanged-source native witness where a pseudo on a
non-stacking host remained local while its real child hoisted; the nonnegative
positioned boundary is now handled as described below. DM-5YF0BB separately
captures native eligibility for the `contain:layout` stacking-context predicate,
verified against Chromium 147 `LayoutObject::IsStackingContext`; see the
[layout handbook](handbook/layout-and-fragmentation.md#native-containment-eligibility)
for the measured scope and explicit unknown-owner gap. The real Stripe icon
owner already establishes a context through z-index 3. Existing negative-host
ownership and the separate preserve-3d path retain their prior behavior.

## Ancestor context admission (DM-NAG7AD)

Nonnegative positioned source records now join the nearest real two-dimensional
stacking context's paint list. A separate immutable plan retains their original
host, source record, generated-child tree order and non-context ancestry; it does
not fabricate captured elements or mutate the captured tree. Ordinary real
children and generated entries stable-sort by effective z-index and source tree
order. `::checkmark`/`::before` precede real children; `::after` follows them.

At runtime Chromium 147 revision
`6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`,
`PaintLayerStackingNode::CollectLayers` traverses non-context layers and stops at
real contexts before the stable effective-z sort. Its `OrderLessThan` uses
computed order for in-flow flex/grid items and effective zero for direct out-of-flow
items. Capture therefore retains optional `paint.order` from the live computed
pseudo style. In-flow generated grid items use that fact; older records without
it retain legacy local paint with a diagnostic. CSS flex direction changes layout
rather than reversing this generated-layer tie order.
The native comparator only inspects layout parent/grandparent ancestry. A deep
layer under a nonzero ordered flex/grid item can therefore differ from ideal
order-modified DOM traversal. Without native layer ancestry, preserve that whole
context's legacy paint with an explicit diagnostic (DM-T935AC). A full-pixel
direct/deep wrapper adversary protects this conservative boundary.

Overflow-only wrappers remain pass-through owners. Escaping generated layers
retain applicable ancestor clips and independent cull/animation wrappers;
absolute/fixed descendants can escape an overflow owner when their containing
block is outside it. True opacity/transform/containment contexts stay atomic.
Source-owned native/effect raster and inline-SVG surfaces keep their generated
paint. The no-generated-child path retains its previous element order.

Full-RGBA native controls cover original before/after z ties, unchanged negative
pseudos, nested non-context hosts, cross-branch ties, negative context ancestors,
opacity/transform/layout barriers, applicable and escaped clips, grid order,
single translucent emission, and generated-owner display/cull/animation state.
The original 80×80 `contain:none` z1/z2 witness changes from 16 leaked solid-purple
pixels to zero, matching the unchanged native source.

The negative pseudo path and existing projective/legacy 3D path remain unchanged.
A prototype negative hoist lost a body background because the implicit canvas
phase is not separately represented; unchanged main passes that negative case.
DM-93GNY0 investigates the source boundary rather than claiming a pre-existing
product bug. Non-positioned generated stacking eligibility remains a separate
source-authority investigation (DM-T935AC); raw static z-index does not justify
promotion. DM-9PEZBK separately owns unchanged-main real-descendant ancestry
failures: nested clips and captured owner display/cull state each differ at 48
pixels on unchanged main. Generated ordering repairs four nested-clip pixels;
the remaining 44 clip pixels and 48 display/cull pixels still need the real-child
ancestry repair. Their full-pixel controls remain intact with that repair; NAG's generated
ancestry controls isolate generated paint without hiding those real-child failures.

Docs [157](157-pseudo-generated-fragment-geometry-audit.md),
[175](175-pseudo-fragment-protocol-oracle.md), and
[176](176-source-owned-pseudo-fragment-capture.md) remain the authority for
the source decision, structural decoder, and production capture. This document
owns direct paint consumption and the independent final-device-space gate.
Ordinary legacy serialized pseudo fields are compatibility input only; new
capture is source-record-only. A future Chromium protocol or pseudo-layout
change must fail either structural validation or the native pixel gate before
any new compatibility behavior is admitted.
