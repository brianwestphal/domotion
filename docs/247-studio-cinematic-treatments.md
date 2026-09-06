---
id: "requirements/studio-cinematic-treatments"
title: "Domotion Studio cinematic treatment library"
kind: "contract"
status: "current"
owners: ["studio","animation","templates"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2691"]
code: ["src/studio/treatment-schema.ts","src/studio/treatments.ts","src/studio/treatments.test.ts","src/studio/treatments.e2e.test.ts","src/studio/treatments.visual.e2e.test.ts","src/studio/compile.ts","src/studio/project-schema.ts","tests/fixtures/studio/treatments-showcase.project.json","tests/fixtures/studio/treatment-source.svg"]
aliases: ["docs/247-studio-cinematic-treatments.md","doc-247"]
---

# Domotion Studio cinematic treatment library

Status: **Shipped.** Studio project scenes and in-process callers can apply an
ordered, opinionated treatment stack without hand-authoring animation CSS or
forking the capture/render pipeline.

## Presets and primitives

The v1 library includes device frames, browser chrome, terminal chrome,
zoom-and-pan, spotlighting, callouts, title cards, logo reveals, and every
standard storyboard transition. `studioTreatmentSchema` is the shared runtime
and generated-JSON-schema authority for both project files and the public API.

`resolveStudioTreatmentPlan` expands those presets into inspectable lower-level
layer, mask, transform, overlay, timing, and transition primitives. This gives
AI and UI authors a high-level vocabulary while leaving a precise programmatic
plan for later direct manipulation. Ordered application makes treatments
nestable; a browser-framed scene can be zoomed, spotlighted, annotated, and
branded in one stack.

## Existing render ownership

Studio compilation first renders a treated scene through the ordinary
storyboard path, including its capture/template/cast/SVG source and existing
overlays. The treatment layer then:

- delegates phone/browser/window furniture to `wrapInDeviceChrome`;
- emits cross-engine SVG/CSS transform, opacity, path, and gradient primitives;
- delegates scene transitions back to the existing storyboard transition
  schema and animator; and
- sends the resulting self-contained SVG back through ordinary storyboard
  composition.

Before every nesting step, `namespaceEmbeddedAnimatedSvg` rewrites document-wide
IDs, references, classes, keyframes, duration variables, and embedded-font
families. Mixed and repeated treatments therefore do not collide with the
source, siblings, or outer story. Local logo assets are embedded as data URLs;
remote logo URLs fail closed rather than weakening self-containment.

This follows Blink's SVG resource model, where fragment references resolve in a
document-wide tree scope (`external/chromium/third_party/blink/renderer/core/svg/svg_resource.cc`),
and its CSS animation ownership (`external/chromium/third_party/blink/renderer/core/animation/css/css_animations.cc`).
Studio reuses the browser-facing representations already exercised by Domotion
instead of recreating layout, paint, font, or animation timing decisions.

## Brand and Studio source

A project may carry the existing brand schema. Explicit treatment parameters
win; otherwise callout/title/logo treatments use the brand palette, background,
and logo. Scene `treatments` remain JSON data in the durable project source.
Regeneration applies the same ordered stack to new scene output, including
interactive scenes lowered by the Studio capture compiler.

## Verification

Schema and unit cases cover every preset, primitive expansion, defaults,
invalid timing/geometry, brand mapping, local-asset embedding, remote-asset
rejection, and mixed nesting without ID/keyframe/reference collisions. A
committed eight-scene Studio fixture compiles every treatment through the real
storyboard integration. Chromium visual evidence renders every example twice at
a fixed animation time and requires byte-identical screenshots, guarding the
deterministic rendered presentation in addition to structural SVG assertions.
