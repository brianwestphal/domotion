---
id: "requirements/transition-schema-and-normalization"
title: "116 — Transition schema and compatibility normalization"
kind: "contract"
status: "current"
owners: ["animation","product-tooling"]
platforms: []
tickets: ["DM-2070","DM-2071","DM-2072","DM-2633"]
code: ["src/animation/transition-schema.test.ts","src/animation/transition-schema.ts","src/cli/animate.ts","src/cli/storyboard.ts","tests/feature-coverage.ts"]
aliases: ["docs/116-transition-schema-and-normalization.md","doc-116"]
---

# 116 — Transition schema and compatibility normalization

DM-2070 ships the foundation proposed in doc 115: one transition contract and one compatibility normalizer shared by every authoring surface.

## Contract

`src/animation/transition-schema.ts` is the source of truth. Its zod schema derives the public `Transition` TypeScript type, validates `animate` and `storyboard` configs, and feeds both generated JSON Schemas. Storyboard adds one capability refinement: it rejects `magic-move` with an actionable error because opaque scenes do not provide the paired element trees that effect requires.

Every existing spelling remains accepted: `crossfade`, the five push/scroll spellings, `cut`, `magic-move`, the four reveal spellings, both zoom spellings, and `shine`. Existing easing, linear-wipe angle, and clock-wipe controls are unchanged. Negative durations are rejected consistently.

## Normalized plan

`normalizeTransition()` translates each legacy name into a renderer plan with bounded channels:

- incoming: opacity plus optional translate, scale, or clip;
- outgoing: opacity plus optional translate;
- optional supported overlay: shine or magic-move.

Aliases normalize to identical channels (`scroll` = `push-up`; `iris` = `wipe-radial`) while retaining `legacyType` for compatibility emission and diagnostics. Renderer entrance/exit classification reads this plan instead of maintaining another name-to-family table. The existing emitters remain intact, preserving legacy SVG bytes.

This plan is intentionally internal and has no new author-facing motion parameters. Built-in parameter objects are DM-2071; bounded custom recipes are DM-2072.

## Compatibility guarantees

- One CSS timeline remains authoritative; normalization does not add SMIL, JavaScript, masks, or filters.
- Existing same-family and mixed-family emit paths are unchanged after classification.
- The schema and normalizer tests enumerate every legacy spelling and verify alias equivalence and the allowed channel set.
- Existing animator golden tests cover byte-stable output and mixed-family boundaries; generated-schema tests keep CLI artifacts synchronized.
