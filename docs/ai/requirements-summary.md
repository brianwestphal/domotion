# Requirements summary for AI agents

Domotion captures real HTML/CSS in Chromium and emits a self-contained SVG that
preserves the browser's visual result, remains crisp when scaled, and has no
external runtime assets. macOS, Linux, and Windows are first-class platforms.

## Core contract

1. Chromium and its pinned/platform dependencies own rendering decisions.
   Domotion captures or source-transcribes those decisions; it does not tune
   output to individual screenshots.
2. Exact logical agreement comes before raster grading. Face, shaping, layout,
   geometry, resource, paint-stage, or activation disagreements cannot be
   excused by a pixel tolerance.
3. SVG-native representation is preferred. Browser-only or unrepresentable
   paint uses a bounded, authenticated raster with explicit ownership and
   negative activation controls.
4. Unsupported, unavailable, or unauthenticated specialized paths fail closed
   with diagnostics. They do not silently guess, normalize evidence, or widen a
   tolerance.
5. Platform comparisons fingerprint the relevant OS, architecture, browser,
   profile/preferences, fonts, helpers, source pins, corpus, and artifacts.
6. Output is deterministic under the same authenticated inputs. Animation,
   compositing, templates, terminal capture, and exports reuse the same capture
   and render contracts.

## Current handbooks

- [Text and fonts](../handbook/text-and-fonts.md)
- [Layout and fragmentation](../handbook/layout-and-fragmentation.md)
- [Paint, effects, and native controls](../handbook/paint-effects-and-native-controls.md)
- [Images, media, and embedding](../handbook/images-media-and-embedding.md)
- [Animation and interaction](../handbook/animation-and-interaction.md)
- [Platforms, testing, and release](../handbook/platforms-testing-and-release.md)

Use the generated [manifest](manifest.json) to retrieve records by stable ID or
code path. Use [domain packets](packets/) for a bounded list of current and
partial records. Proposals, investigations, retired designs, and superseded
evidence live behind the generated [archive index](../archive/index.md).

Run `npm run docs:index:check` after documentation changes. Do not add another
hand-maintained global requirements catalog.
