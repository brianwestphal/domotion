---
id: "requirements/studio-high-level-authoring"
title: "High-level scene and story authoring in Domotion Studio"
kind: "contract"
status: "current"
owners: ["studio","ui","ai"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2688"]
code: ["src/studio/authoring.ts","src/studio/authoring.test.ts","src/studio/client.tsx","src/studio/server.ts","src/studio/server.e2e.test.ts","src/cli/storyboard.ts","src/animation/embed-timeline.ts"]
aliases: ["docs/251-studio-high-level-authoring.md","doc-251"]
---

# High-level scene and story authoring in Domotion Studio

Status: implemented in DM-2688.

## Authoring surface

Studio edits the versioned JSON project through purpose-built controls rather
than requiring raw JSON. Authors can add, duplicate, remove, and reorder scenes;
edit narrative beats and scene membership; choose template, URL, file, SVG, or
cast sources; set capture selectors, duration, source trim, placement, and
transition; write per-scene generation instructions; and apply useful cinematic
presets. The shared annotation editor remains beside these controls.

Composition scenes retain their recursive layer source while exposing the
presentation controls that are safe at scene level. Their source summary is
read-only in this first piece rather than silently flattening a composition into
a storyboard recipe.

## Immutable edits and revisions

`applyStudioAuthoringCommand` clones its input, applies one bounded structural
command, and returns the complete prior snapshot as an undo command. Scene
duplication remaps scene, track, event, and recursive layer identities. Removal
keeps at least one scene and refuses to orphan a scene-grounded annotation.
Beat membership is maintained on both the beat and scene sides.

Browser saves use optimistic concurrency. `commitStudioAuthoringRevision`
rejects review or artifact changes through the generic save route and appends a
human content revision. Generated status is keyed to the latest content
revision, so later review annotations do not stale valid media while an authored
edit does.

## Generation policy

Scene and whole-story generation are provided by a host adapter. Every request
receives the non-optional policy `{ healing: "required", review: "required" }`.
A completed result must explicitly report accepted AI healing and AI review,
preserve the authored narrative/scenes/settings and existing provenance, and
publish a current digest-checked SVG artifact. An ambiguous result returns a
clarification question without modifying the project. There is intentionally no
token, dollar, or other budget management.

Capture adapters are expected to honor each scene's generation instructions and
the existing Studio capture contract: inspect the actual live DOM, computed CSS,
geometry, and browser state proactively before capture. Studio does not replace
those facts with authored guesses.

## Source trim and browser timing

Storyboard scenes accept `trimStart` and `trimEnd` in milliseconds. Trimming
requires an animated source, derives the visible duration when omitted, rejects
an end outside the source period, and prevents a longer visible hold from
running past the trim end. The embedded animation is retimed to the master loop
with a source-local negative delay, preserving browser interpolation at an
arbitrary trim point instead of approximating an intermediate style.

This continues to use Chromium's animation time authority in
`external/chromium/third_party/blink/renderer/core/animation/animation.cc`; SVG
time seeking remains grounded in
`external/chromium/third_party/blink/renderer/core/svg/svg_svg_element.cc`.
No font, glyph, HarfBuzz, or Skia ownership changes in this feature.

## Verification

`src/studio/authoring.test.ts` covers immutable scene operations, recursive ID
remapping, beat membership, destructive guards, exact undo, and content
revisions. Storyboard/timeline tests cover trim validation and source-local
retiming. `src/studio/server.e2e.test.ts` authors and persists a multi-scene,
multi-beat story in Chromium, edits source/timing/fit/transition/treatment and
generation instructions, invokes required-AI scene generation, opens the real
Scrubber preview, and reopens the same persisted project.

Real-user recording import extends this command surface with editable semantic
tracks; see `docs/252-studio-real-interaction-import.md`.
