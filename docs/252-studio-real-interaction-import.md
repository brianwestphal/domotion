---
id: "requirements/studio-real-interaction-import"
title: "Real browser interaction recording and semantic Studio import"
kind: "contract"
status: "current"
owners: ["studio","capture","ai","security"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2696"]
code: ["src/studio/recording.ts","src/studio/recording.test.ts","src/studio/recording.e2e.test.ts","src/studio/client.tsx","src/studio/server.ts","src/studio/interactive-compile.ts"]
aliases: ["docs/252-studio-real-interaction-import.md","doc-252"]
---

# Real browser interaction recording and semantic Studio import

Status: implemented in DM-2696.

## Recording contract

`recordStudioInteractions` observes a caller-owned Playwright page while the
caller performs a real flow. The self-contained page payload remains active
across document loads and records ordered pointer movement/down/up/click,
keyboard down/up, input, element or document scroll, history/navigation, and
batched DOM-mutation feedback. Every addressed or mutated element carries its
live rectangle, relevant control state, a semantic identity candidate, a
fallback selector, and a bounded computed-style snapshot. This is evidence for
inference and review, not a coordinate replay format.

Mutation delivery follows Blink's browser-owned observer path in
`external/chromium/third_party/blink/renderer/core/dom/mutation_observer.cc`.
Computed values are read from the live page rather than re-derived; Blink's
CSSOM authority is
`external/chromium/third_party/blink/renderer/core/css/css_computed_style_declaration.cc`.
Same-document URL changes are retained as evidence in addition to full page
loads, consistent with the renderer/navigation distinction described in
`external/chromium/third_party/blink/renderer/core/loader/document_loader.cc`.
No font, glyph, HarfBuzz, or Skia ownership changes in this feature.

## Redaction boundary

Passwords, payment/credential autocomplete fields, elements beneath
`data-domotion-redact`, and caller-supplied redaction selectors are classified
inside the recorded page. Their input values and printable key values become
the literal `[REDACTED]` before crossing the Playwright binding. Sensitive query
and fragment parameters are likewise removed from recorded URLs. The runtime
schema rejects a sensitive input event unless its value is already redacted and
checks the exact redaction count.

Persisted evidence is canonical validated JSON written with an atomic rename
and mode `0600` inside the Studio workspace. It is attached to the imported
scene as a digest-bearing `capture-evidence` artifact. An existing different
file is never overwritten.

## Required AI interpretation and review

Import has no deterministic or replay-only shortcut. A configured AI healing
adapter receives the complete redacted recording, current project, and the
non-optional policy `{ healing: "required", review: "required" }`. It removes
pointer/key/mutation noise, chooses accessibility-first stable targets,
naturalizes timing, and returns one ordinary `StudioScene`. It may instead ask
a clarifying question, which leaves the project and filesystem unchanged.

A separate required AI review then accepts, edits, or asks for clarification
about the candidate. Both candidate and reviewed edit pass the normal scene and
semantic-track validators. Import rejects duplicate scene identity and empty
semantic intent. An accepted result appends the scene, reconciles narrative
beat membership, stores the evidence artifact, and records an AI-authored
content revision with both stages' summaries and evidence.

## Editable Studio result

Imported scenes use the same capture recipe, semantic tracks, treatments,
narrative links, revision model, and interactive compiler as hand-authored
scenes. Studio shows imported semantic actions by kind and stable target and
lets authors retime them without editing JSON. Further scene title, source,
duration, transition, treatment, and generation edits use the existing
immutable authoring command and exact undo model.

The standalone app accepts a validated redacted recording document through
`POST /api/recording/import`. The route checks the expected project revision,
requires both AI adapters, preserves clarification as a non-mutating result,
persists evidence inside the workspace, and atomically saves the imported
project.

## Verification

`src/studio/recording.test.ts` covers pre-persistence redaction enforcement,
healing clarification, mandatory healing plus review, normal project/track
validation, AI revision provenance, beat reconciliation, evidence digests, and
safe idempotent persistence. `src/studio/app-projects.test.ts` covers the local
server route and evidence file.

`src/studio/recording.e2e.test.ts` records a real Chromium flow containing
password entry, pointer travel/click, scrolling, DOM/class feedback, computed
CSS, and a secret-bearing history URL. It proves the secrets are absent,
imports a noise-reduced semantic scene through both AI stages, edits its timing
with the normal authoring command, changes the fixture's DOM nesting, visual
CSS, and button name, and replays it through `compileStudioInteractiveProject`
using the AI-selected stable target.
