---
id: "requirements/studio-interaction-observation"
title: "Domotion Studio proactive interaction observation"
kind: "contract"
status: "current"
owners: ["studio","capture"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2684","DM-2698"]
code: ["src/studio/interaction-observer.ts","src/studio/interaction-observer.e2e.test.ts","src/studio/interactions.ts","src/cli/hover-detect.ts","src/cli/mutation-detect.ts"]
aliases: ["docs/243-studio-interaction-observation.md","doc-243"]
---

# Domotion Studio proactive interaction observation

Status: **Shipped.** Studio can passively inspect what the real page does around
one semantic action. The resulting evidence records live DOM and computed-CSS
behavior for later capture and AI review; it is not durable authored project
state and does not prescribe an animation before seeing the page.

## Evidence boundary

`observeStudioInteraction(page, options, action)` takes a baseline snapshot,
runs the caller-owned action, waits for a bounded quiet window, samples two
animation frames, and returns structured evidence. `observeStudioSemanticStep`
adds accessibility-first resolution for a compiled Studio step and correlates a
drag destination as a related target. Attachment-lifecycle waits observe from
the document root because the authored target may not exist before `attached`
or may cease to exist during `detached`; the executor independently retains the
strict semantic locator and rejects ambiguity.

The observer reads the whole document and existing open shadow roots up to a
configurable node limit. It records:

- DOM attributes, character data, and child-list mutations with old/new values;
- selected computed paint/layout properties and `::before`, `::after`, marker,
  placeholder, and file-selector-button pseudo styles;
- border geometry, element and viewport scrolling, direct text, animations,
  transition/animation lifecycle events, and transient hover/active/focus state;
- target, descendant, ancestor, explicit related-target, and ARIA-related
  relationships; and
- a deterministic sequence number for every mutation and signal. Relative
  `atMs` values are diagnostic; sequence and lifecycle phase own ordering.

Node references are assigned in document order inside the observation and
stored in a page-local `WeakMap`; Studio does not annotate application nodes to
create identities. The known temporary semantic-action marker is ignored only
when explicitly listed in `ignoredAttributes` (it is the default).

## Meaning and provenance

Each changed element is classified as `direct-feedback`, `action-effect`, or
`incidental-churn`. Target/descendant/ancestor/related changes are direct when
they produce rendered or document evidence. Other changes during the action
are effects unless the same mutation root was already active during baseline;
ambient provenance propagates to replacement descendants such as timer-driven
text nodes. Browser bookkeeping such as a bare `:hover` state change remains
available as evidence but does not make a visually inert action meaningful.

The observer reuses the shipped hover snapshot/diff classifier and mutation
settling defaults. CSS-only feedback therefore receives the same synthesis
guidance as hover detection, while synchronous and delayed JavaScript changes
share one ordered record.

## Safety and limits

Instrumentation consists of passive capture listeners, `MutationObserver`s,
computed-style/layout reads, and the temporary page-global session handle.
Cleanup disconnects every observer, removes every listener, disposes element
handles, and deletes that handle even if the action throws. On failure,
`StudioInteractionObservationError` retains the captured evidence as well as
the original cause.

Observation deliberately does not mutate application DOM, monkey-patch browser
APIs, pause animations, or install broad attribute filters. Existing open
shadow roots are observed; closed roots remain browser-owned and can only be
seen through effects visible outside the root. A navigation ends the page-local
session, so callers begin a new observation in the new document.

The Chromium E2E corpus covers CSS-only hover/pseudo/transition feedback,
synchronous and asynchronous JavaScript changes, scrolling, layout shift,
pre-existing ambient churn, no-op actions, marker filtering, cleanup,
page-owned observer/event equivalence, and canonical stable references across
repeat runs. Lifecycle coverage additionally proves initially absent attachment,
existing-target detachment, mutation evidence, and complete observer cleanup.
