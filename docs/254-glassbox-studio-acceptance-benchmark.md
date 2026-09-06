---
id: "requirements/glassbox-studio-acceptance-benchmark"
title: "Glassbox as the end-to-end cinematic Studio acceptance benchmark"
kind: "contract"
status: "current"
owners: ["studio","capture","animation","post-processing","ai"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2697"]
code: ["benchmarks/glassbox/glassbox.project.json","benchmarks/glassbox/run.ts","benchmarks/glassbox/launch.html","benchmarks/glassbox/handoff.html","benchmarks/glassbox/base.svg","src/animation/embed-namespace.ts","src/studio/interactive-compile.ts","tests/glassbox-studio-benchmark.test.ts"]
aliases: ["docs/254-glassbox-studio-acceptance-benchmark.md","doc-254"]
---

# Glassbox as the end-to-end cinematic Studio acceptance benchmark

Status: implemented in DM-2697.

## North-star project

`benchmarks/glassbox/glassbox.project.json` is the durable authoring source for
the Glassbox product demo. Its AI-authored narrative explains one causal loop:
launch a local review, use AI risk triage, inspect the real diff, leave precise
feedback, export structured direction, let the coding agent apply it, and show
the resolved result. The product source is static JSON; only the application-
owned setup, wait, and illustrative fix steps cross the explicit TypeScript
hook boundary in `run.ts`.

The project uses real Glassbox branding and real live UI capture for the main
scene. Opening, terminal, handoff, and closing beats stay small and bespoke so
they support the product rather than replacing it with synthetic fixture UI.
Browser/terminal chrome, title and logo reveals, cursor choreography, and scene
transitions are ordinary Studio treatments or storyboard data. Smaller Studio
fixtures remain the focused test layer; this project is the full integration
benchmark.

## Required AI gates and human handoff

Every benchmark generation runs through `runStudioHealingLoop`. The review
callback first improves the persistent local-first browser framing, causing a
recorded AI content revision and a complete recapture, then accepts only a
candidate containing evidence for all causal beats. The accepted SVG is
rendered through the production H.264 exporter and
`renderAndReviewStudioVideo`; the required report covers pacing, cursor
realism, readability, transitions, narrative clarity, brand presentation, and
overall polish and adds its findings to the shared Studio review queue.

The runner persists the accepted project, per-scene SVGs, interaction evidence,
review video, structured video report, and an acceptance report under the
gitignored `benchmarks/glassbox/generated/` directory. The source JSON and hook
module remain tracked and editable in the separate Studio application. With
publishing enabled, only the accepted baseline SVG and SVGZ replace
`../glassbox/assets/demo.svg` and `demo.svgz`; publication never replaces the
project source.

If either AI boundary finds an ambiguity, the normal Studio clarification state
stops the run. The benchmark adds no iteration, token, cost, or time budget.

## Controlled healing acceptance

`npm run benchmark:glassbox` runs both a baseline and a controlled-change pass.
The second pass changes the real Glassbox risk control's accessible name from
`Sort files by AI risk score` to `Risk review` after page load. The authored
exact role/name no longer matches, so replay must fail. Healing may proceed only
when the failure's live
page inspection contains the unique visible replacement control; its recorded
role/name, rectangle, selector, and computed display/visibility/opacity/cursor/
pointer-event/position styles become revision evidence. Studio then replays the
healed semantic target, recaptures the complete product flow, and requires AI
review again. The acceptance report records the healing and review revisions
and the changed candidate digest.

This follows browser ownership rather than inventing a second interpretation:

- Blink's `external/chromium/third_party/blink/renderer/platform/fonts/font.cc`
  selects the current `FontFallbackList` from the computed `FontDescription`
  and sends the existing shaped result to paint.
- HarfBuzz's `external/harfbuzz/src/hb-shape.cc` defines shaping as converting a
  same-font/direction/script/language Unicode buffer into positioned glyphs.
- Skia's `external/skia/src/core/SkGlyphRunPainter.cpp` consumes finite glyph
  positions through the selected strike and paint path.

Accordingly the benchmark captures the actual DOM, computed CSS, layout boxes,
font decisions, and rendered glyph result through the existing Domotion
pipeline. It does not copy CSS declarations into a parallel renderer or tune
glyph positions against a screenshot.

## Output contract

The accepted SVG must contain embedded font data and no remote `href`, `src`,
`url()`, or import dependency. Nested composition namespaces previously
namespaced subset-font families again, and interactive capture hoists shared
glyph definitions once, so scene text remains readable and every document ID is
unique. The same SVG must export through the production video path. Its Studio
project records artifact hashes and source revision IDs, and its AI video report
records media hash, rubric evidence, and scene/time targets. These assertions
make the demo reusable after Glassbox changes rather than a one-off generated
asset.

## Verification

`tests/glassbox-studio-benchmark.test.ts` validates the durable concept,
narrative beats, real interaction track, explicit hook boundary, treatment set,
export paths, mandatory AI policy, the evidence-constrained accessible-name
repair, and the review edit-to-accept transition.

`npm run benchmark:glassbox` is the live end-to-end acceptance run against the
sibling Glassbox checkout. It builds Glassbox's client, launches its real demo
server in an isolated config directory, captures the complete semantic flow,
forces the AI review revision, renders and reviews video, runs the controlled UI
change through heal/recapture/review, verifies self-containment, writes evidence,
and publishes the accepted baseline. `npm run benchmark:glassbox:quick` performs
both browser passes without video or publication for iteration.
