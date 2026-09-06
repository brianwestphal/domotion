---
id: "requirements/studio-ai-healing-loop"
title: "Domotion Studio AI-led replay healing and review loop"
kind: "contract"
status: "current"
owners: ["studio","capture","review"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2695"]
code: ["src/studio/healing.ts","src/studio/healing.test.ts","src/studio/healing.e2e.test.ts","src/studio/interactive-compile.ts","src/studio/project-schema.ts","tests/fixtures/studio/healing-story.project.json","tests/fixtures/studio/healing-page.html"]
aliases: ["docs/245-studio-ai-healing-loop.md","doc-245"]
---

# Domotion Studio AI-led replay healing and review loop

Status: **Shipped.** Studio can replay an interactive project, ask an
application-owned AI to repair actionable failures, regenerate, require AI
review, revise again, and hand only an AI-accepted candidate to a person.

## Governing loop

`runStudioHealingLoop(browser, project, options)` owns this state machine:

1. Compile the current project from the beginning.
2. For an actionable scene/event failure, call the required `heal` boundary.
3. An AI edit is validated, committed as a parent-linked AI revision, and
   replayed. Clarification pauses with a serializable checkpoint; unrecoverable
   intent returns without changing the project.
4. After a successful candidate, call the required `review` boundary. Review
   may accept, edit and replay, or ask for clarification. It cannot silently
   reject and bypass revision.
5. AI acceptance returns `human-review`; it never means human approval.

There is no fuzzy selector fallback and no default non-AI repair or review.
Exact accessibility-first target resolution remains unchanged. There are also
no iteration, time, token, or cost budget controls in this phase. An optional
`AbortSignal` is only a caller-owned cancellation boundary.

Browser, filesystem, validation, and internal compiler failures are rethrown;
they are not mislabeled as product-intent problems for AI to guess through.

## Current-page evidence

When a semantic event fails, `StudioInteractiveSceneError` retains the scene and
event IDs, successful prior event IDs and evidence, partial failed-action
evidence when available, and an inspection taken before the live page closes.
The inspection contains Playwright's AI-mode ARIA snapshot plus bounded raw DOM
author hints, element rectangles, and selected computed CSS. The ARIA snapshot
is the semantic role/name authority; Studio does not synthesize browser roles
or accessible names from tags.

The geometry and style facts intentionally call the live platform APIs.
Chromium updates lifecycle before `Element::GetBoundingClientRect()` in
`external/chromium/third_party/blink/renderer/core/dom/element.cc`, and computed
style access is governed by
`external/chromium/third_party/blink/renderer/core/css/css_computed_style_declaration.cc`.
The AI receives these browser results and the authored project; it does not
reimplement layout, accessibility, font, glyph, or paint decisions.

## Revision and clarification integrity

AI callbacks receive structured clones, so mutating a request cannot alter the
governing project or accept an unrecorded edit. An accepted edit preserves the
existing review history and generated artifacts, validates the complete project,
and appends a revision with:

- `author.kind: "ai"` and a parent equal to the prior head;
- the exact JSON paths and before/after values changed;
- the AI's evidence plus the actual replay failure or reviewed artifact hashes;
- a digest of that trigger, including any clarification answer.

Project identity is immutable. Without explicit clarification, an edit may add
new stable entities but cannot remove or rename existing scene, beat, track,
event, layer, or hook identities, change script-hook module trust boundaries,
or redirect exports.

A clarification checkpoint contains the unchanged validated project, question,
phase, evidence, and a full-project digest. `resumeStudioHealingLoop` verifies
the checkpoint and replays from the beginning with the answer routed only to
the paused AI phase. Tampering fails closed. If the answer produces an edit, it
is part of that revision's trigger evidence; an accept-after-review answer is
returned in the human handoff.

## Verification

Browser-free tests prove mandatory review, review-driven revision/replay,
exact change provenance, clarification resume, tamper rejection, callback
isolation, unrecoverable intent, and no-op-cycle rejection. Real Chromium E2E
proves a changed input label, renamed and moved button, insufficient delayed
state wait, ambiguous alternatives, clarification/resume, unrecoverable intent,
successful recapture, generated artifact revision provenance, AI review, and
final human handoff.

`waitForState: attached` for an initially absent target remains a separate
semantic executor defect tracked by DM-2698; this loop neither hides nor works
around it.
