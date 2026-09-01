---
id: "handbook/layout-and-fragmentation"
title: "Layout and fragmentation handbook"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2596"]
code: ["src/capture/script/walker/transforms.ts","src/render/element-tree-to-svg.ts","src/render/transforms.ts","src/scroll/","tests/feature-coverage.ts"]
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
   scrolling without duplicating fixed/sticky paint or leaking outside the
   output viewBox.

## Verified implementation map

| Area | Requirements | Code and tests |
| --- | --- | --- |
| Transforms and culling | [CSS transforms](../06-css-transforms.md), [geometry oracle](../131-transform-geometry-oracle.md), [culling](../33-element-out-of-viewbox-hiding.md) | `src/capture/script/walker/transforms.ts`, `src/render/transforms.ts`, transform oracle tests |
| Scroll composition | [Chunk diff](../34-scroll-mode-per-chunk-diff.md), [sticky](../35-scroll-sticky-hoisting.md), [grammar](../37-scroll-pattern-grammar.md) | `src/scroll/`, scroll executor/composer tests |
| Frames and resources | [Iframe recursion](../81-iframe-recursion.md), [cross-origin scroll](../217-cross-origin-frame-scroll-ownership.md), [transitive resources](../222-transitive-svg-fragment-resource-ownership.md) | capture frame/resource modules and E2E tests |
| Fragmentation | [Generated pseudo fragments](../176-source-owned-pseudo-fragment-capture.md), [collapsed tables](../225-fragmented-collapsed-table-ownership.md), [paged tables](../230-paged-table-private-fragment-transport.md) | fragment capture/render modules and table geometry tests |

Partial timeline ownership stays explicitly partial in
[scroll/view/rAF sampling](../221-scroll-view-raf-timeline-ownership.md).
