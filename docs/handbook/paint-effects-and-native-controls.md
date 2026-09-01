---
id: "handbook/paint-effects-and-native-controls"
title: "Paint, effects, and native controls handbook"
kind: "contract"
status: "current"
owners: ["paint-effects","text-fonts"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2596","DM-2615","DM-2628","DM-2634"]
code: ["src/render/paint.ts","src/capture/input-value-geometry.ts","src/capture/native-control-raster.ts","src/capture/pseudo-style-cdp.test.ts","src/capture/pseudo-style-cdp.ts","src/capture/script/walker/form-controls.ts","src/capture/script/walker/input-value.ts","src/render/form-controls.test.ts","src/render/form-controls.ts","tests/feature-coverage.ts"]
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
5. Structural controls retain vector ownership, but their browser-owned layout
   inputs are captured rather than inferred. A single-line input may consume
   Chromium's closed-UA-shadow value-text FragmentItem top only after strict
   quad and same-frame host-size validation. A `base-select` disclosure icon is
   vector structural paint using the captured resolved `::picker-icon` color;
   it is never substituted for a native menulist arrow.

## Verified implementation map

| Area | Requirements | Code and tests |
| --- | --- | --- |
| Gradients/masks/clips | [Gradient fills](../07-gradient-fills.md), [mask emission](../20-css-mask-emission.md), [generated combinations](../188-generated-svg-effect-combinations.md) | render paint builders and paint geometry oracles |
| Paint order and filters | [Paint order](../132-paint-order-oracle.md), [blend/filter stage](../185-blend-filter-pixel-stage-oracle.md), [backdrop ownership](../195-strict-ordinary-backdrop-ownership.md) | paint-order/filter modules and strict browser oracles |
| Borders and scrollbars | [Border phase](../127-border-outline-phase-oracle.md), [cross-platform envelopes](../191-cross-platform-border-phase-envelopes.md), [scrollbars](../165-native-scrollbar-layout-paint-ownership-audit.md) | border/scrollbar oracles and native workflows |
| Native and structural controls | [Source-frame rasters](../167-native-control-source-frame-rasters.md), [effective appearance](../170-blink-effective-appearance-routing.md), [closed-shadow geometry/decorations](../171-closed-shadow-control-decorations.md), [fallback retirement](../182-native-control-fallback-retirement.md) | native-control capture/routes plus `input-value-geometry.ts`, the input/form-control walkers, `form-controls.ts`, focused unit tests, and cross-platform E2E/visual jobs |

Every new specialized paint route needs a source decision, an activation
record, a hostile movement control, and platform integration evidence.

## Structural form-control failure boundaries

- Input value geometry is retained only for one non-empty closed-shadow text
  candidate and one finite, positive-area, axis-aligned host/text quad pair.
  The live DOM walk consumes its host-relative top only when the recorded and
  current host dimensions agree within 0.05 CSS px. Compound controls,
  ambiguous candidates, rotation/skew, invalid geometry, or a changed scale do
  not acquire this authority; old captures and rejected records keep the
  documented metric-based compatibility path.
- Closed single-selects capture the resolved `::picker-icon` color. The renderer
  emits the structural disclosure path at the logical inline end only when the
  control has no native-decoration raster reservation. Missing icon and host
  colors omit the vector. Native `auto`/`menulist-button` arrows remain narrow
  Chromium-owned raster overlays and can never fall through to this path.
- Both decisions are platform-neutral Blink/CDP procedures and contain no
  macOS, Linux, or Windows font, palette, or glyph table. The capture contract
  applies on all three platforms; DM-2628's exact visual ratification was the
  Linux `06-deep-field-sizing` fixture that exposed the half-pixel estimate.
