---
id: "requirements/studio-interactive-segments"
title: "Domotion Studio interactive segment compilation"
kind: "contract"
status: "current"
owners: ["studio","capture","animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2685"]
code: ["src/studio/interactive-compile.ts","src/studio/interactive-compile.test.ts","src/studio/interactive-compile.e2e.test.ts","src/studio/compile.ts","src/studio/interactions.ts","src/studio/interaction-observer.ts","src/studio/cursor-choreography.ts","tests/fixtures/studio/interactive-story.project.json","tests/fixtures/studio/interactive-page.html","tests/fixtures/studio/interactive-followup.svg"]
aliases: ["docs/244-studio-interactive-segments.md","doc-244"]
---

# Domotion Studio interactive segment compilation

Status: **Shipped.** A Studio scene with semantic actions can compile into
one reusable, self-contained animated SVG segment, which is then nested in the
ordinary Studio storyboard beside static captures, compositions, and existing
pre-rendered SVG scenes.

## One live page, captured states

`compileStudioInteractiveProject(browser, project, options)` validates the
authored project and opens one isolated capture context per active scene. The
scene's URL or file is loaded once. Its semantic steps execute in the same page,
in compiled order, so accessibility locators, application state, DOM identity,
webfonts, scrolling, and later controls revealed by earlier actions remain live.

Immediately before each visual action, Studio inspects the actual target border
box and computed cursor. It then wraps the action in proactive DOM/CSS
observation, waits for the bounded evidence window, and captures the resulting
page through the normal self-contained capture/render pipeline. A scene begins
with its rest capture and ends with one captured state per semantic step.

Scene and semantic script hooks are never imported or executed implicitly.
Callers may provide `runHook` and `runSceneHook` handlers as the explicit
TypeScript trust boundary. Scene phases run against that same live page.

## Synthesis and timing

The observed evidence chooses the smallest faithful state transition:

- no rendered/document response is an instantaneous cut;
- paint/state response is a crossfade; and
- DOM additions/removals, geometry changes, and scrolling use the existing
  element-tree magic-move bridge, with its crossfade fallback when no stable
  bridge exists.

The seeded cursor planner supplies curved movement, dwell, drag travel, computed
cursor identity, and click pulses. Its `presentedAtMs` schedule owns the visible
action time. Captured-state transitions begin at that action time and are
bounded by the following action, so a dense sequence cannot let one synthesized
transition overrun the next interaction. The final state holds for a tail and
the scene is extended when necessary rather than cutting off cursor motion.

Blink queues MutationObserver delivery through the event-loop microtask path
and sorts active observers before delivery
(`external/chromium/third_party/blink/renderer/core/dom/mutation_observer.cc`),
while scroll/scrollend are per-frame events
(`external/chromium/third_party/blink/renderer/core/dom/document.cc`). Studio
therefore treats observer sequence and lifecycle phase as authoritative,
settles through animation frames, and captures Chromium's resulting geometry;
it does not reconstruct layout or font/glyph decisions itself.

## Replaceable artifacts and ordinary composition

Each active scene emits two stable-ID files beneath caller-owned `artifactDir`:

- `<scene>-<hash>.segment.svg`, the self-contained animation; and
- `<scene>-<hash>.evidence.json`, the ordered observations and cursor plan.

Both receive SHA-256 and source-revision provenance. The SVG artifact derives
from the evidence artifact. Recapture replaces these stable files and upserts
their stable artifact records while retaining every authored scene, track,
narrative beat, annotation, unrelated artifact, and revision. Files are built in
a staging directory; project/artifact validation and whole-story composition
must succeed before the staged results replace prior files.

The interactive compiler gives the existing Studio compositor a generated
`svg` recipe override only for an active scene. That compositor and the shipped
storyboard engine continue to own recursive compositions, per-scene placement,
resource/font/ID namespacing, nested-timeline rebasing, overlays, transitions,
and final SVG assembly. Inactive pre-rendered SVG scenes stay on this unchanged
path. An active scene must use a live URL/file capture because semantic targets
cannot be resolved inside an opaque SVG.

## Verification

The committed fixture combines a five-action live page (reveal, type, layout
change, an explicit TypeScript hook, and scroll) with a pre-rendered follow-up
scene. Real Chromium E2E proves all four scene hook phases plus
state/evidence/cursor synthesis, storyboard embedding, stable repeat output,
artifact upsert without authored-data loss, failed-recapture preservation,
context cleanup, and staging cleanup. Browser-free coverage proves unchanged
pre-rendered-scene compilation and both success/failure staging cleanup.
