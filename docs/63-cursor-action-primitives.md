# 63 — Cursor-target + action-runner public primitives

Status: **proposed** (DM-1135). Design + contract for exposing the cursor
selector → point resolution and the declarative action runner as public
primitives, so imperative scripting-API callers (`captureElementTree` +
`generateAnimatedSvg`) get the same selector-anchoring and DOM-mutation
vocabulary the declarative CLI uses. Implementation tracked as follow-up tickets
(below).

## Why

DM-1132 (doc 61) exposed `resolveOverlays(page, overlays)` — overlay selector
`anchor` + typing `maxWidth: "anchor"` → concrete coords — but deliberately
scoped OUT two sibling resolution steps that still live private inside
`composeAnimateConfig` (`src/cli/animate.ts`):

1. **Cursor `selector` → point.** `queryCursorBox(page, sel)` returns the
   element's **border-box center** in viewport coords; `buildCursorOverlay`
   assembles those into a global-time `CursorOverlay`. An imperative caller
   building its own `CursorOverlay` for `generateAnimatedSvg` cannot reuse the
   resolution — it re-measures `getBoundingClientRect` by hand.
2. **The declarative action runner.** `runActions(page, actions)` /
   `applyDomAction` (click / fill / press / hover / focus / selectOption /
   scroll / wait / evaluate + the DOM-mutation set: setText / setHtml / remove /
   setAttribute / addClass / toggleClass / setStyle / insert / setValue / check /
   clear / scrollIntoView / blur / dispatch / selectText / replaceText) is
   private. An imperative caller re-drives Playwright by hand and loses the
   declarative DOM-mutation actions that aren't raw-Playwright one-liners.

This is the *other* half of the JSON ↔ programmatic gap from DM-1136 (doc 62):
that ticket opens up the *whole pipeline*; this one exposes the *per-feature
primitives* so an imperative caller can mix them into its own loop.

## The border-box vs content-box discrepancy

`contentBox(page, sel, { at: "center" })` (DM-1133) already exists and returns
the **content**-box center (border + padding removed). The cursor, however,
targets the **border**-box center (`getBoundingClientRect` center — what
`queryCursorBox` computes). They differ by the element's border + padding, so
the existing `contentBox` is **not** a drop-in for cursor choreography. Any
unification must preserve that distinction rather than paper over it.

## Proposed surface

### 1. Cursor target — symmetric `borderBox` + `resolveCursorTarget` (primary)

The cleanest fit is a sibling to `contentBox` that measures the **border** box,
sharing the same `{ at, dx, dy }` anchor vocabulary and the same `boxAnchorPoint`
corner math (DM-1133):

```ts
import { borderBox, resolveCursorTarget } from "domotion-svg";

// Full border box + a resolved anchor point (mirrors contentBox's shape).
const box = await borderBox(page, "#submit", { at: "center" });
// box: { x, y, width, height, at: [cx, cy] }

// Cursor-specific sugar: the border-box CENTER point the CLI's cursor uses.
const [cx, cy] = await resolveCursorTarget(page, "#submit");
// === borderBox(page, "#submit", { at: "center" }).at — exactly what
// queryCursorBox returns, so imperative cursor choreography matches the CLI's
// cursor: "auto" / explicit-event resolution.
```

- **`borderBox`** is the general primitive (symmetric with `contentBox`):
  `getBoundingClientRect` → `{ x, y, width, height, at }`, `at` resolved via the
  shared `boxAnchorPoint`. Throws on no-match (same fail-fast as `contentBox`).
- **`resolveCursorTarget`** is the one-liner sugar callers actually reach for
  when building a `CursorOverlay` move event — returns just the center point so
  it drops straight into `{ type: "move", to: { x, y } }`.
- `queryCursorBox` inside `composeAnimateConfig` collapses to a wrapper over
  `borderBox(page, sel, { at: "center" })` — one engine, two callers, can't
  diverge (the DM-1132 / DM-1133 pattern).

### 2. Action runner — `runActions(page, actions)` (secondary)

Expose the declarative action vocabulary so an imperative caller can drive the
same interaction + DOM-mutation set without authoring a whole JSON config:

```ts
import { runActions, type AnimateAction } from "domotion-svg";

const actions: AnimateAction[] = [
  { type: "fill", selector: "#email", value: "a@b.com" },
  { type: "addClass", selector: ".row", class: "is-active" },
  { type: "replaceText", selector: ".price", pattern: "\\$0", replacement: "$49" },
  { type: "click", selector: "#submit" },
];
await runActions(page, actions);   // applied against the live page, in order
```

- **Public type**: `AnimateAction` (today `z.infer<typeof actionSchema>`, private)
  is re-exported so callers get the typed union.
- **Value proposition** (from the ticket): Playwright is already available to
  imperative callers, so the click/fill/hover/press wrappers are low-value on
  their own — the payoff is the **DOM-mutation actions**
  (setText / addClass / insert / replaceText / setStyle / dispatch / …) that are
  *not* one-line Playwright calls and that already encode the
  "apply across every matched element, throw if the selector matches nothing"
  semantics (doc 43 → Selectors).
- **`log` is optional.** The CLI passes a logger for the `evaluate`-too-long
  nudge; the public form defaults it to a no-op, matching the doc 60 / 61
  convention.

## Open questions (follow-up decisions, not blocking this doc)

- **Is `runActions` worth a public surface, or just `AnimateAction` + a doc
  pointer?** The DOM-mutation actions are the only non-trivial part; one option
  is to expose just the typed union and a single `applyDomAction`-style helper
  rather than the full Playwright-native dispatcher. Recommendation: expose the
  whole `runActions` (it is the SSOT the CLI uses; splitting risks divergence).
- **Should `borderBox` and `contentBox` be unified under one
  `elementBox(page, sel, { box: "border" | "content", at, dx, dy })`?**
  Recommendation: **no** — keep two named helpers. `contentBox` is already
  public and named (DM-1133); a symmetric `borderBox` reads better at call
  sites than a `box:` discriminator, and the two are the only boxes that matter.

## Scope / not covered

- **`buildCursorOverlay` (the event-timeline assembler)** stays private. It bakes
  in the declarative cursor model (`"auto"` staging across continuous-session
  frames, explicit-event global-time mapping) that only makes sense with the
  config's frame timeline. Imperative callers assemble their own `CursorEvent[]`
  from `resolveCursorTarget` points — which is the point of exposing the target
  resolver, not the whole overlay builder.
- **`evaluate` action string-length nudge.** The public `runActions` keeps the
  warning (via the optional `log`) but does not block long scripts — same as the
  CLI.

## Follow-up tickets

- **Implement `borderBox` + `resolveCursorTarget`** — symmetric with
  `contentBox`; collapse `queryCursorBox` to a wrapper; re-export from the
  package root; unit-test the border-vs-content distinction; update
  `docs/api.md` + doc 13.
- **Implement public `runActions` + `AnimateAction` export** — re-export the
  runner and the typed union; default `log` to no-op; unit/integration-test the
  DOM-mutation actions against a live page; update `docs/api.md` + doc 43.
- **Companion: DM-1136** (doc 62) — frames-out variant + per-frame hook, the
  whole-pipeline half of the same JSON ↔ programmatic gap.

## Related

- `docs/61-overlay-resolution-primitive.md` — the overlay-resolution primitive
  this extends to cursor + actions.
- `docs/api.md` — `contentBox` / `boxAnchorPoint` (DM-1133), the existing box
  helpers `borderBox` mirrors.
- `docs/13-cursor-overlay.md` — the cursor overlay model these targets feed.
- `docs/43-declarative-animate-config.md` — the action vocabulary `runActions`
  drives.
