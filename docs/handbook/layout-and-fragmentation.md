---
id: "handbook/layout-and-fragmentation"
title: "Layout and fragmentation handbook"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2596", "DM-5YF0BB", "DM-F42BPG", "DM-D8Y3WJ"]
code:
  [
    "src/capture/script/walker/transforms.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/transforms.ts",
    "src/capture/script/walker/document-prepass.ts",
    "src/render/containment.ts",
    "src/render/stacking.ts",
    "tests/containment-stacking.e2e.test.ts",
    "src/scroll/",
    "tests/feature-coverage.ts",
  ]
aliases: ["docs/handbook/layout-and-fragmentation.md"]
---

# Layout and fragmentation handbook

## Contract

1. Chromium owns source geometry. Capture retains physical fragments, boxes,
   clips, scroll state, transforms, zoom, and frame boundaries; SVG emission
   preserves those facts without independently relaying out the page.
2. Affine transforms remain vector when their captured geometry is sufficient.
   Projective/3D or otherwise unrepresentable ownership activates a bounded
   raster fallback and must have a negative activation control.
3. Fragmented inline, multicolumn, table, pseudo-element, and iframe content
   keeps source fragment order and physical placement. No fragment may be
   synthesized from a union box when Chromium exposes distinct fragments.
4. Scroll capture composes authenticated chunks, sticky ownership, and nested
   scrolling without duplicating fixed/sticky paint, flattening static
   foreground stacking, or leaking outside the output viewBox.

## Verified implementation map

| Area                   | Requirements                                                                                                                                                                                        | Code and tests                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Transforms and culling | [CSS transforms](../06-css-transforms.md), [geometry oracle](../131-transform-geometry-oracle.md), [culling](../33-element-out-of-viewbox-hiding.md)                                                | `src/capture/script/walker/transforms.ts`, `src/render/transforms.ts`, transform oracle tests |
| Scroll composition     | [Chunk diff](../34-scroll-mode-per-chunk-diff.md), [sticky](../35-scroll-sticky-hoisting.md), [grammar](../37-scroll-pattern-grammar.md), [inner live capture](../147-inner-live-scroll-capture.md) | `src/scroll/`, scroll executor/composer tests                                                 |
| Frames and resources   | [Iframe recursion](../81-iframe-recursion.md), [cross-origin scroll](../217-cross-origin-frame-scroll-ownership.md), [transitive resources](../222-transitive-svg-fragment-resource-ownership.md)   | capture frame/resource modules and E2E tests                                                  |
| Fragmentation          | [Generated pseudo fragments](../176-source-owned-pseudo-fragment-capture.md), [collapsed tables](../225-fragmented-collapsed-table-ownership.md)                                                    | screen-fragment capture/render modules and exact collapsed-table tests                        |

Partial timeline ownership stays explicitly partial in
[scroll/view/rAF sampling](../221-scroll-view-raf-timeline-ownership.md).

## Native containment eligibility

`contain:layout` is a stacking-context boundary only when Blink's layout object
is eligible. The installed Chromium 147 revision
`6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050` makes eligibility false on
`LayoutObject`, true on `LayoutBox`, and false on `LayoutTableRow` and
`LayoutTableSection`; `LayoutInline` inherits false. The same eligibility hook
gates paint containment and containment's fixed-position ownership.

DM-5YF0BB retains `styles.paintOrLayoutContainmentEligible` from a neutral native
probe. A hidden built-in host carries the source's computed display and
`contain:layout`; its fixed child's `offsetParent` identifies actual ownership.
The probe verifies its computed display/contain values, caches by document and
built-in display class, and removes itself immediately. It does not clone or
modify source/custom elements. Capture's text-geometry discovery and final walk
each own their cache; three matching ordinary hosts need one probe per walk.

The renderer shares this fact across stacking, overflow-only context traversal,
fixed ownership, implicit isolation, paint clips and clip-margin activation.
Layout containment creates no paint clip. Native controls cover ordinary
block/atomic/flex/grid/table/table-cell boxes and exclude inline, ruby, contents,
table-row and row-group objects, with absolute/fixed descendants and
paint/strict/content aliases. A separate source-custom-element control checks
constructor/connection counts, unchanged source markup and zero source
mutations/callbacks during the probe. Safe built-in buttons are measured too.

Absent facts retain the old per-consumer compatibility behavior: paint/strict/
content stacking and clipping, and containment fixed ownership; layout-only
stacking requires native authority. Source-specific replaced/control/SVG and
other unknown layout states remain unprobed, rather than inferred from a tag
name. DM-F42BPG owns that explicit native-authority and legacy-input gap.
DM-D8Y3WJ separately tracks an unchanged-source native-control capture path that
adds an empty `style` attribute and invokes source style callbacks; that defect
is not attributed to the neutral eligibility probe.
