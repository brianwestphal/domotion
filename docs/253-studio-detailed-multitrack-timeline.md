---
id: "requirements/studio-detailed-multitrack-timeline"
title: "Detailed multitrack timeline editing in Domotion Studio"
kind: "contract"
status: "current"
owners: ["studio","ui","scrubber","ai"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2692"]
code: ["src/studio/timeline.ts","src/studio/timeline.test.ts","src/studio/timeline.e2e.test.ts","src/studio/client.tsx","src/studio/server.ts","src/scrubber/embed.ts","src/scrubber/client.tsx"]
aliases: ["docs/253-studio-detailed-multitrack-timeline.md","doc-253"]
---

# Detailed multitrack timeline editing in Domotion Studio

Status: implemented in DM-2692.

## One project clock

`buildStudioTimeline` projects scene holds, semantic actions, cursor events,
overlays, transitions, timed cinematic treatments, review annotations, and
composition-layer animations onto one absolute millisecond clock. Scene starts
use the same `frameAdvanceMs` rule as production SVG composition, including the
default transition and the zero-duration meaning of `cut`; the editor therefore
does not invent a second timing model.

Rows retain the stable scene, track, event, layer, and annotation identities
needed to select the corresponding authored object. Different semantic tracks
may overlap. Events in one semantic track retain their ordered, non-overlapping
contract and a conflicting edit fails atomically.

## Shared edit command

`studioTimelineCommandSchema` defines one strict `set-timing` command containing
exact absolute start/end overrides. Pointer drags, resize handles, accessible
buttons, keyboard shortcuts, undo, redo, and AI callers all converge on
`applyStudioTimelineCommand`; there is no UI-only patch format. The function
clones its input, checks optimistic concurrency, materializes explicit local
timings in the appropriate source field, appends human or AI revision
provenance, and returns the exact inverse command.

Content timings append a content revision and invalidate older generated media.
An annotation-only edit appends a review revision and updates that annotation's
revision pointer without falsely staling rendered content. `POST /api/timeline`
forces browser callers to a human author, validates the result through the full
project schema during atomic save, and returns the inverse command to the UI.

## Editor interaction and preview sync

The separate Studio application displays horizontally scrollable labeled
tracks with zoom and 1–250 ms snapping. Click selects; Command/Ctrl-click toggles
multiple items. Drag moves the complete selection, the right handle resizes it,
Arrow keys move by the snap interval, Shift multiplies the step, and Alt+Arrow
resizes. Named Earlier/Later/Shorter/Longer and Undo/Redo buttons provide the
same operations without pointer precision. Timeline blocks are focusable,
named with their range, expose pressed selection state, and keep a visible focus
ring.

Selecting a block loads the current whole-story artifact at its absolute start,
or a scene artifact at the corresponding scene-local time. The versioned
Scrubber embed protocol accepts a bounded same-origin `seek` command and all
seeking still runs through Scrubber's existing animation path. Web Animations
remain owned by Chromium's
`external/chromium/third_party/blink/renderer/core/animation/animation.cc`, and
SVG/SMIL time remains owned by
`external/chromium/third_party/blink/renderer/core/svg/svg_svg_element.cc`.
No font, glyph, HarfBuzz, Skia, or capture ownership changes in this feature.

## Verification

`src/studio/timeline.test.ts` is the transition matrix for projection, explicit
edits, exact undo/redo, downstream scene-clock changes, snapping, multiselect,
cross-track overlap, same-track rejection, optimistic concurrency, and
human/AI plus content/review revision kinds.

`src/studio/timeline.e2e.test.ts` drives the rendered Studio UI in Chromium. It
selects an action and verifies the embedded Scrubber seeks to it, then performs
keyboard movement, pointer movement, keyboard resizing, undo, and redo and
checks the atomically persisted project after each transition.
