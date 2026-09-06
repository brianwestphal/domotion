---
id: "requirements/studio-project-model"
title: "Domotion Studio project model"
kind: "contract"
status: "current"
owners: ["studio","animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2682"]
code: ["schemas/domotion-studio-project.schema.json","scripts/generate-studio-project-schema.ts","src/studio/","src/cli/composite.ts","src/cli/storyboard.ts","tests/fixtures/studio/static-storyboard.project.json"]
aliases: ["docs/239-studio-project-model.md","doc-239"]
---

# Domotion Studio project model

Status: **Shipped foundation.** Domotion Studio has a durable, portable JSON
authoring model. It is intentionally distinct from the smaller
`domotion storyboard` render recipe: the project preserves authored intent and
history, while storyboard, SVG, images, and review video are compilation inputs
or generated artifacts rather than substitutes for the project file.

## File identity and compatibility

Every project declares both a format and a numeric version:

```json
{
  "$schema": "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/domotion-studio-project.schema.json",
  "format": "domotion-studio-project",
  "version": 1,
  "id": "project-product-tour"
}
```

- `format` distinguishes a Studio project from storyboard, animate, composite,
  captured-tree, and generated-artifact JSON.
- `version` is required. This release accepts only version 1 and reports an
  unsupported version at `$.version`; it never guesses or silently rewrites a
  future format.
- Studio-owned objects are strict. Misspelled or unknown properties are errors,
  with JSON paths for every issue Zod can evaluate in that pass.
- Stable IDs are required for projects, scenes, narrative beats, tracks, events,
  layers, hook definitions, review revisions, annotations, and artifacts. IDs
  stay attached when ordered arrays are rearranged. Referenceable IDs are unique
  within their category, and every cross-reference is checked at load time.

## Authored project graph

Version 1 contains:

- `canvas`: output dimensions, background, and accessible SVG title/description;
- `narrative`: title, summary, objective, audience, tone, and ordered beats that
  reference scenes by ID;
- `scenes`: the authored order, stable identity, narrative links, render source,
  semantic interaction tracks, and optional script-hook references;
- `playback`: the existing explicit storyboard cursor recipe, when used;
- `scriptHooks`: named module/export references with an optional content digest;
- `review`: an appendable revision graph plus human/AI/system annotations;
- `artifacts`: provenance for generated SVG, review video, images, and capture
  evidence; and
- `exportTargets`: desired SVG/video destinations, which are destinations only
  and never become the project source.

Metadata extension points accept JSON values only. Functions, live browser
objects, binary buffers, and inline executable source are not project data.

### Semantic interaction tracks

A `semantic-interactions` track owns stable event IDs and scene-relative timing.
Version 1 models `click`, `hover`, `type`, `scrollTo`, `drag`, `waitForState`, and
`scriptHook`. Targets prefer role/name/label/text/test ID/DOM ID descriptors;
`selector` is the explicit CSS fallback. Action-specific validation requires the
relevant target, text, position, destination, state, or hook reference.

These events remain intent-level authoring facts. The static compiler rejects a
non-empty semantic track with its exact path instead of ignoring it or lowering
it to brittle coordinates. Interactive action execution and evidence-driven
capture use a separate compiler built on the existing Playwright action path.

### Layers and nested compositions

A composition scene contains a recursive layer tree:

- a `source` leaf embeds the shipped `CompositeLayerConfig` recipe verbatim; or
- a `composition` node contains another canvas/layer tree plus placement in its
  parent.

This is one recursive authoring structure, not a second SVG compositor. Static
compilation evaluates inner groups with `composeCompositeConfig`, writes only
temporary intermediate SVGs, feeds the resulting scene to
`composeStoryboardConfig`, and removes the temporary directory afterward.
Existing template, cast, SVG, font-sharing, namespacing, timing, placement, and
transition behavior therefore remains owned by the established compositors.

### Review and artifact provenance

Review revisions form a parent-linked history with one `headRevisionId`.
Annotations may remain text-only or target a scene, track event, layer, DOM
identity, instant/time range, and one or more rectangles. They record author,
lifecycle (`open`, `resolved`, or `superseded`), creation/resolution revisions,
and evidence artifact IDs.

An artifact records its path, kind, generation time, generator name/version,
source revision, affected scenes, upstream artifact IDs, and optional SHA-256.
The project never embeds a generated SVG or video as its own durable state.
Regeneration creates or replaces an artifact and its provenance; authored scene,
track, layer, and annotation IDs remain unchanged.

### Script-hook boundary

Hooks are references (`module` plus optional named `export` and SHA-256), never
inline JavaScript. Scene phase bindings and `scriptHook` events must reference a
declared hook ID. The static compiler never imports or executes them and fails
with an actionable path when one is active. A caller that enables hooks owns its
permission boundary and must lower the result before static storyboard assembly.

## Runtime API

`validateStudioProject(raw)` returns a typed version-1 project or throws
`StudioProjectValidationError`. The error exposes structured `issues[]` with
`path`, `message`, and `code`; its message lists the same paths for CLI/log use.
Malformed JSON is reported at `$`, and an unsupported version has the dedicated
`unsupported_version` code.

`parseStudioProjectJson`, `serializeStudioProject`, `loadStudioProject`, and
`saveStudioProject` are the JSON/file helpers. Serialization validates first,
uses two-space JSON plus a trailing newline, and has byte-stable
save/load/save behavior.

`importStoryboardConfig` validates today's storyboard config, assigns
deterministic project/scene/beat/revision IDs, preserves every render recipe and
cursor setting, and carries the old output destination into `exportTargets`.
`studioProjectToStoryboardConfig` provides the inverse projection for projects
whose scenes are all direct storyboard recipes.

`compileStudioProject` accepts a caller-owned Playwright `Browser`, a project,
and optional `{ projectDir, log }`; `compileStudioProjectFile` derives
`projectDir` from the project path. Static direct scenes and recursive
compositions compile to one SVG through the shipped storyboard compositor.

## Published JSON Schema and tests

`schemas/domotion-studio-project.schema.json` is generated from
`studioProjectSchema`, the runtime source of truth:

```sh
npm run build:studio-project-schema
npm run build:studio-project-schema -- --check
```

The unit suite covers complete projects, strict/malformed data, unknown versions,
cross-references, stable file round trips, schema synchronization, and storyboard
import/projection. The E2E fixture at
`tests/fixtures/studio/static-storyboard.project.json` loads from disk and
compiles a direct scene plus a nested composition through the real compositor
stack.

No new font, glyph, layout, or paint decision is introduced here. Project
compilation delegates to the same capture/render paths whose Chromium,
HarfBuzz, Skia, and platform-native provenance is documented by the domain
handbooks.
