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
7. A Domotion Studio project is the versioned durable authoring source. Stable
   narrative/scene/track/layer/review identities survive regeneration; SVG and
   review video are generated artifacts with revision provenance. Static Studio
   compilation lowers to the existing composite/storyboard pipelines.
8. Domotion Studio is a separate local application. Its file UI is confined to
   one workspace, validates before atomic saves, and presents exact model errors;
   SVG Scrubber remains a focused, independently usable playback/review tool.
9. Studio replay failures and generated candidates are always routed through
   explicit application-owned AI healing and review boundaries. Automatic edits
   append evidence-backed revisions; material ambiguity pauses for clarification,
   and only an AI-accepted candidate proceeds to human review. This phase has no
   user-facing iteration, time, token, or cost budget management.
10. Studio visual review operates on rendered video, not authored intent alone.
    AI findings cover the complete pacing/cursor/readability/transition/narrative/
    brand/polish rubric, separate evidence from inference and recommendations,
    ground comments to project identities/space/time, and enter the same queue as
    human review. Material ambiguity pauses for clarification.
11. Studio cinematic treatments are validated, ordered presets over inspectable
    layer, mask, transform, overlay, timing, transition, template, chrome, and
    compositor primitives. Presets are brand-aware and nest with deterministic
    namespacing; they do not introduce a second renderer or external runtime.
12. Real interaction recording is redacted in-page before persistence and keeps
    raw pointer, keyboard, scroll, navigation, DOM, computed-style, geometry,
    timing, and state evidence. Required AI healing simplifies it into ordinary
    semantic Studio scenes; required AI review accepts or edits the candidate,
    and either stage pauses for clarification when intent is ambiguous.
13. Studio projects expose one detailed absolute timeline over scenes, semantic
    actions, cursor, overlays, transitions, treatments, annotations, and layer
    animations. Pointer, keyboard, accessible controls, undo/redo, and AI use
    the same explicit timing command; selection seeks the existing Scrubber.

## Current handbooks

- [Text and fonts](../handbook/text-and-fonts.md)
- [Layout and fragmentation](../handbook/layout-and-fragmentation.md)
- [Paint, effects, and native controls](../handbook/paint-effects-and-native-controls.md)
- [Images, media, and embedding](../handbook/images-media-and-embedding.md)
- [Animation and interaction](../handbook/animation-and-interaction.md)
- [Platforms, testing, and release](../handbook/platforms-testing-and-release.md)

Studio's cross-domain authoring contract is
[the versioned Studio project model](../239-studio-project-model.md).
Its first application surface is the
[standalone Studio shell](../240-studio-application-shell.md).

Use the generated [manifest](manifest.json) to retrieve records by stable ID or
code path. Use [domain packets](packets/) for a bounded list of current and
partial records. Proposals, investigations, retired designs, and superseded
evidence live behind the generated [archive index](../archive/index.md).

Run `npm run docs:index:check` after documentation changes. Do not add another
hand-maintained global requirements catalog.
