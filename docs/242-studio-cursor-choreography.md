---
id: "requirements/studio-cursor-choreography"
title: "Domotion Studio cursor choreography"
kind: "contract"
status: "current"
owners: ["studio","animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2686"]
code: ["src/studio/cursor-choreography.ts","src/studio/cursor-choreography.test.ts","src/studio/cursor-choreography.e2e.test.ts","src/studio/interactions.ts","src/animation/cursor-overlay.ts"]
aliases: ["docs/242-studio-cursor-choreography.md","doc-242"]
---

# Domotion Studio cursor choreography

Status: **Shipped.** Studio semantic actions can drive deterministic,
human-readable cursor motion without introducing another cursor renderer or
changing explicit cursor timelines in animate/storyboard configs.

## Evidence before planning

`inspectStudioCursorTargets(page, plan)` resolves every visual action using the
same accessibility-first target contract as execution. It proactively reads the
actual live DOM border box, viewport dimensions, drag destination, and computed
CSS `cursor`. Missing, ambiguous, or non-rendered targets fail at their authored
path with guided recovery. Wait and script-hook events do not invent pointer
movement. A position-only scroll uses the viewport as its pointer context.

The captured boxes are evidence for this capture run, not durable project data.
Scrolling or responsive layout can change them, so callers inspect after the
page is ready and again for a later scene whose live layout differs.

The planner carries Chromium's computed cursor keyword rather than inferring a
second cursor type. Blink's `external/chromium/third_party/blink/renderer/platform/cursors.cc`
maps those CSS identities to platform cursor types, while
`external/chromium/third_party/blink/common/input/web_mouse_event.cc` confirms
that browser mouse moves are position-bearing events that may be coalesced. The
Studio curve is presentation choreography; it does not claim to reproduce raw
hardware samples.

## Deterministic natural planning

`planStudioCursorChoreography(evidence, options)` returns the existing
`CursorOverlay` event shape plus an event-ID timing map. Its seeded xorshift
stream derives from explicit `seed` or stable event IDs, making the same input
byte-for-byte reproducible while allowing controlled variations.

For each interaction the planner:

- chooses a point within the target's central usable area rather than always
  obscuring the exact center;
- clamps every point and curve control to a configurable viewport inset;
- derives approach duration from travel distance and target area;
- curves a quadratic path perpendicular to the direct route;
- samples eased progress into the linear-keyframe renderer, creating faster
  initial travel and visible deceleration near the target;
- adds a deterministic 70–170 ms dwell before the interaction;
- emits correctly button-styled/repeated pulses for click events and a focus
  pulse for type, holds naturally for hover/scroll,
  and continues a drag to its semantic target or explicit point with a
  `grabbing` cursor; and
- serializes actions that are authored too densely to show legibly, recording
  each `presentedAtMs` so interactive capture can use the presentation timing.

The default lead-in is 500 ms. `start` lets a caller pass the prior scene's last
point so the next scene approaches from a sensible location rather than an
arbitrary corner. The returned final interaction point provides the value to
chain. Later capture stages own scene/global time placement; this module only
plans one inspected semantic sequence.

## Exact overrides

`overrides[eventId]` may pin the aim/destination point, approach/drag duration,
dwell, curve control, and sample count. Overrides are still viewport-clamped and
must use finite values accepted by TypeScript callers. They are for deliberate
art direction; seeded defaults remain the normal path.

## Existing renderer and compatibility

The output is a normal `CursorOverlay`. Multiple short `move` segments
approximate the curve and easing while `resolveCursorScript` and
`cursorOverlayMarkup` continue to own CSS keyframes, cursor glyph switching,
click pulses, clipping, and loop behavior. Existing explicit animate and
storyboard cursor event lists never call the Studio planner and retain their
established byte behavior.

Unit tests pin determinism, seed variation, viewport bounds, exact endpoints,
nonlinear curvature, deceleration, dense-action timing, drag completion,
overrides, and empty plans. The Chromium/render E2E lays out click, hover, type,
scroll, and drag targets with real CSS, asserts the inspected geometry/cursors,
then sends the choreography through the shipped SVG cursor resolver/renderer.
