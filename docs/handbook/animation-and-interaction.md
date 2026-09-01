---
id: "handbook/animation-and-interaction"
title: "Animation and interaction handbook"
kind: "contract"
status: "current"
owners: ["animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2596","DM-2636","DM-2641"]
code: ["src/animation/","src/cli/animate-artifact.ts","src/cli/animate-capture-session.ts","src/cli/animate-command.ts","src/cli/animate-debug.ts","src/cli/animate-frame-capture.ts","src/cli/animate-orchestrator.ts","src/cli/animate.ts","src/cli/composite.ts","src/cli/debug-bundle.ts","tests/animate-debug.e2e.test.ts","tests/animate-examples.tsx"]
aliases: ["docs/handbook/animation-and-interaction.md"]
---

# Animation and interaction handbook

## Contract

1. An animation is a deterministic sequence of captured SVG frames with
   explicit hold durations, transitions, overlays, loop policy, and reduced-
   motion behavior. Validation rejects unknown or unsafe config rather than
   accepting raw CSS or script.
2. Continuous-session frames may carry browser state across declared actions;
   each capture still observes explicit readiness. Simulated cursor, tap,
   typing, reveal, and interaction-state overlays resolve against captured
   geometry and timing.
3. Built-in and custom transitions compose only schema-owned channels. Frame
   visibility, transition windows, overlay windows, and keyframe padding must
   remain exact at boundaries and when durations compress.
4. Storyboards and nested composites retain child timing/resource identity.
   Templates and format/brand inputs compile into the same public animation
   model rather than a separate rendering path.

## Verified implementation map

| Area | Requirements | Code and tests |
| --- | --- | --- |
| Frame model | [Animation model](../08-animation-model.md), [declarative config](../43-declarative-animate-config.md) | `src/animation/frame-timeline.ts`, `src/animation/svg-generator.ts`, animation tests |
| Declarative capture | [Programmatic pipeline](../60-programmatic-animate-pipeline.md), [frame hooks](../62-frames-out-animate-pipeline.md) | `src/cli/animate-orchestrator.ts`, capture-session/frame-capture modules, compose tests |
| CLI and artifacts | [Format targeting](../90-format-on-capture.md), [debug reproduction bundles](../237-animate-debug-reproduction-bundles.md) | `src/cli/animate-command.ts`, `src/cli/animate-artifact.ts`, `src/cli/animate-debug.ts`, CLI/E2E tests |
| Transitions | [Parameterized built-ins](../117-parameterized-built-in-transitions.md), [custom recipes](../118-custom-transition-recipes.md) | transition schema/builders and example suite |
| Overlays/actions | [Cursor](../13-cursor-overlay.md), [overlay SSOT](../59-overlay-schema-ssot.md), [action primitives](../63-cursor-action-primitives.md) | overlay/action modules and schema tests |
| Composition | [Nested composition](../77-nested-animated-compositing.md), [storyboards](../89-storyboard-sequencing.md) | composite/storyboard modules and demos |

[Transition schema normalization](../116-transition-schema-and-normalization.md)
remains proposed and is not silently promoted by this handbook.
