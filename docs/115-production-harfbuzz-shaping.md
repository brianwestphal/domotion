---
id: "requirements/production-harfbuzz-shaping"
title: "Production HarfBuzz shaping"
kind: "contract"
status: "current"
owners: ["text-fonts","product-tooling"]
platforms: ["macos","linux","windows"]
tickets: []
code: []
aliases: ["docs/115-production-harfbuzz-shaping.md","doc-115"]
---

# Production HarfBuzz shaping

Domotion now has one production shaping decision-maker: the vendored HarfBuzz build configured like Chromium. Face selection remains platform-native because Chromium itself selects through CoreText, fontconfig, or DirectWrite/Skia. Once a concrete file/member/axis instance and fallback run are known, both `paths` and `embedded-font` modes wrap that face with `harfbuzzShapedRunOverride`; native/fontkit objects provide outlines and metrics only.

The ordering is intentional:

1. Resolve CSS family, weight, width, slope, named instance, and variation coordinates with the host platform's Chromium-equivalent resolver.
2. Run Blink's shaped-cluster fallback/requeue model, including variation selectors, default ignorables, dotted-circle rules, and UTF-16 source ownership.
3. Merge adjacent assignments into whole shaping runs.
4. Shape every supported run with vendored HarfBuzz using explicit ptem, axes, direction, script/language, features, and the resolved TTC member.
5. Use the resulting glyph IDs, clusters, advances, and offsets for paths, embedded subsets, measurement, decoration geometry, and placement.

`DOMOTION_CLUSTER_FALLBACK=0` remains a diagnostic A/B for fallback assignment, but no longer restores another shaper: the legacy assignment path is also wrapped with HarfBuzz before emission. Proxies are memoized by concrete face, axes, ptem, outline provider, and features so run identity is stable.

## Unsupported and declined cases

The consolidation requires an identifiable sfnt face. These cases remain unsupported at this pre-raster boundary and use the existing visible raster/diagnostic path rather than claiming exact logical parity:

- an `@font-face` collection buffer whose member cannot be identified;
- a damaged or non-sfnt font HarfBuzz cannot open;
- color/bitmap-only glyph output the SVG path pipeline cannot represent;
- CSS text layout features listed by the renderer's unsupported-feature diagnostics (layout-stage, not shaping-stage exclusions).

There is no automatic fallback from a supported face to CoreText/fontkit shaping. `shapesWithHarfbuzz` is the test-visible assertion on every emitted supported run. The exact oracle in `docs/114-exact-shaping-oracle.md` stops before rasterization and applies no numeric tolerance.

Source anchors: Chromium `7d859f27`, `third_party/blink/renderer/platform/fonts/shaping/harfbuzz_shaper.cc`; HarfBuzz `4de187d`, `src/hb-shape.cc` and the OT/AAT shapers. Skia's platform typeface cloning remains the source of concrete variation instances, not glyph sequencing.
