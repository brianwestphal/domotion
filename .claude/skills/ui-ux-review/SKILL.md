---
name: ui-ux-review
description: Audit Domotion user interfaces, workflows, websites, or rendered Markdown and turn substantiated UX findings into actionable Hot Sheet work.
allowed-tools: Read, Grep, Glob, Bash, Agent
---
<!-- ui-ux-review-skill-version: 1 -->

# UI/UX review

Review the surface as a product experience, not just as source code. Include the
states a user encounters: first use, populated use, keyboard use, narrow screens,
loading, empty, error, success, and recovery where they exist. Treat rendered
`README.md` as an interface constrained by GitHub and npm Markdown.

Evaluate four lenses:

- **Visual hierarchy and layout:** focal point, scanning order, grouping, grid,
  whitespace, responsive behavior, and primary versus secondary actions.
- **Friction and cognitive load:** discoverability, steps, terminology, ambiguous
  controls, navigation, feedback, undo/recovery, and consistency.
- **Accessibility and readability:** semantics, keyboard and focus behavior,
  contrast, zoom/reflow, reduced motion, labels, status announcements, and target
  size. Use 44 CSS px as the WCAG 2.2 minimum target-size baseline; recommend
  larger touch targets when the interface is intended for touch.
- **Microcopy and content:** labels, instructions, errors, empty states, tone,
  progressive disclosure, and actionability.

Inspect the implementation and use a rendered build when visual or interaction
claims depend on it. Distinguish observed facts from hypotheses. Do not invent a
problem merely to fill every category, and preserve intentional product character.

For a broad or consequential review, obtain an independent review without giving
the reviewer the first pass's conclusions, then reconcile agreements and explain
meaningful disagreements. Skip this for a narrow follow-up where a second pass
would not improve confidence.

Report:

1. **The Good** — choices worth preserving.
2. **Critical Issues** — ranked by user impact, with evidence and affected state.
3. **Actionable Recommendations** — a specific correction and validation criterion
   for every issue.

Create Hot Sheet tickets for substantiated critical issues and recommendations
when the review is part of Hot Sheet work. Keep related symptoms together when
one change should address them. If a recommendation depends on an unresolved
taste, brand, or product-policy choice, create the ticket and request feedback
there; do not block evidence-backed accessibility or usability corrections on a
taste decision.
