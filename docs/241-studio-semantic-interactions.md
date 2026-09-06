---
id: "requirements/studio-semantic-interactions"
title: "Domotion Studio semantic interaction compilation"
kind: "contract"
status: "current"
owners: ["studio","animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2683"]
code: ["src/studio/interactions.ts","src/studio/interactions.test.ts","src/studio/interactions.e2e.test.ts","src/studio/project-schema.ts"]
aliases: ["docs/241-studio-semantic-interactions.md","doc-241"]
---

# Domotion Studio semantic interaction compilation

Status: **Shipped.** Studio can validate, compile, and execute intent-level
interaction tracks against a live Playwright page. The JSON project remains the
durable source; resolved locators, element handles, and pointer coordinates are
runtime evidence and are never written back into it.

## Timeline contract

Each track is scene-relative, ordered by `atMs`, and owns stable event IDs.
Declared `durationMs` values may touch but may not overlap the next event in the
same track. `compileStudioSemanticTracks` rejects duplicate track or event IDs,
then stable-merges tracks by time, authored track order, and authored event order.
The returned plan exposes the exact JSON path for every step and includes the
maximum authored end time.

Execution waits only for the remaining time until each event, so time already
spent resolving or performing earlier actions is not added to later timestamps.
This makes event timing scene-relative rather than a chain of cumulative delays.

## Target resolution

Targets resolve in this priority order:

1. accessible role plus optional exact accessible name;
2. exact label;
3. exact text;
4. test ID;
5. DOM ID; and
6. explicit CSS `selector` fallback.

When a target declares more than one strategy, the first applicable semantic
strategy wins. A standalone `name` is invalid at execution because accessible
names need a role; use `label` or `text` instead. Every target must resolve to
exactly one live element. Zero matches, ambiguity, invalid selectors, hidden drag
sources, schema failures, and Playwright failures become `StudioInteractionError`
with the authored path and event ID.

For actions already represented by `AnimateAction`, execution reuses
`runActions`. A unique element is temporarily stamped with
`data-domotion-studio-target`, passed through that selector-based runner, and
cleaned in a `finally` block. DOM/CSS observation must treat this short-lived
attribute as Studio instrumentation, not application state. Action-specific
Playwright APIs preserve authored options that the older action shape cannot
carry, including click button/count, timed typing, semantic waits, smooth target
scrolling, and drag destinations.

## Event behavior

- `click` preserves optional button and click count.
- `hover` uses the resolved target.
- `type` replaces by default, appends when `replace: false`, and distributes an
  authored duration across Unicode code points.
- `scrollTo` accepts exactly one semantic target or absolute page position.
- `drag` accepts a semantic destination or absolute pointer position.
- `waitForState` supports attachment, visibility, enabled/disabled,
  checked/unchecked, and substring text states with an explicit timeout.
- `scriptHook` never imports or evaluates project text. The caller must provide
  `runHook`; otherwise execution fails at the hook event path.

## Verification

Unit tests cover stable merging, duration calculation, duplicate identities,
out-of-order and overlapping timing, required text-wait values, and structured
paths. The Chromium E2E executes every event kind against a real DOM, verifies
accessibility-first targeting and authored overrides, exercises ambiguity and
hook refusal, and asserts that temporary instrumentation is removed.

This layer makes no independent layout, font, glyph, or paint decision. The
browser remains the authority for DOM state, accessibility lookup, hit testing,
scrolling, and pointer behavior.
