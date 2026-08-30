---
id: "handbook/paint-effects-and-native-controls"
title: "Paint, effects, and native controls handbook"
kind: "contract"
status: "current"
owners: ["paint-effects"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2596"]
code: ["src/render/paint.ts","src/capture/native-control-raster.ts","tests/feature-coverage.ts"]
aliases: ["docs/handbook/paint-effects-and-native-controls.md"]
---

# Paint, effects, and native controls handbook

## Contract

1. Paint follows Chromium's background, border, content, decoration, outline,
   stacking, blend, filter, mask, and backdrop order. Geometry is derived from
   captured boxes and source-cited decision procedures, not screenshot tuning.
2. SVG-native gradients, masks, clips, filters, borders, and shadows remain
   vector when semantics are representable. URL resources preserve reference
   identity, units, geometry boxes, and transitive dependencies.
3. Effects needing an isolated source surface or browser-only paint operation
   use an authenticated, bounded raster owned by the corresponding element or
   effect. Transparent or unavailable evidence fails closed.
4. Native controls use Chromium-owned source pixels only when the activation,
   state, geometry, and compositor frame are authenticated. Hand-sampled
   platform palettes and approximate chrome are not fallback behavior.

## Verified implementation map

| Area | Requirements | Code and tests |
| --- | --- | --- |
| Gradients/masks/clips | [Gradient fills](../07-gradient-fills.md), [mask emission](../20-css-mask-emission.md), [generated combinations](../188-generated-svg-effect-combinations.md) | render paint builders and paint geometry oracles |
| Paint order and filters | [Paint order](../132-paint-order-oracle.md), [blend/filter stage](../185-blend-filter-pixel-stage-oracle.md), [backdrop ownership](../195-strict-ordinary-backdrop-ownership.md) | paint-order/filter modules and strict browser oracles |
| Borders and scrollbars | [Border phase](../127-border-outline-phase-oracle.md), [cross-platform envelopes](../191-cross-platform-border-phase-envelopes.md), [scrollbars](../165-native-scrollbar-layout-paint-ownership-audit.md) | border/scrollbar oracles and native workflows |
| Native controls | [Source-frame rasters](../167-native-control-source-frame-rasters.md), [effective appearance](../170-blink-effective-appearance-routing.md), [fallback retirement](../182-native-control-fallback-retirement.md) | `src/capture/native-control-raster.ts`, control render routes, E2E activation tests |

Every new specialized paint route needs a source decision, an activation
record, a hostile movement control, and platform integration evidence.
