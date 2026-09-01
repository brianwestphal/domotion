---
id: "requirements/feature-coverage"
title: "83 — Feature/requirement coverage (behavior coverage, not just line coverage)"
kind: "contract"
status: "current"
owners: ["product-tooling"]
platforms: []
tickets: ["DM-1058","DM-1338","DM-1350","DM-1459","DM-2645"]
code: ["src/index.exports.test.ts","src/render/render-text-mode-guard.test.ts","tests/conventions.test.ts","tests/feature-coverage.ts","tests/feature-transition-evidence.test.ts","tools/check-feature-coverage.ts","tools/feature-transition-evidence.ts","tools/semantic-coverage.json"]
aliases: ["docs/83-feature-coverage.md","doc-83"]
---

# 83 — Feature/requirement coverage (behavior coverage, not just line coverage)

Status: **shipped** (DM-1459). Modeled on the apple-fm coverage-by-feature exercise.

This public-feature catalog is linked to the state-level rendering inventory in
[`tools/semantic-coverage.json`](../tools/semantic-coverage.json). A feature's
presence here means its public surface is tracked; exact Chromium parity is a
separate claim made only for explicitly inventoried semantic transitions with
oracle, metamorphic, visual, and platform evidence.

## Why line coverage isn't enough

Line/branch coverage proves every *line executed*. It says **nothing** about
whether every documented *behavior* — or every *transition between states* — is
actually *asserted*. A bug that lives in an untested interaction or state
transition sails through a green 100% report, because the individual lines still
get hit by isolated, from-a-clean-state tests. Coverage is necessary but not
sufficient; it's structurally blind to "does a test exist that would FAIL if this
behavior regressed?"

This doc describes the orthogonal axis: a **feature index** mapping each
documented behavior to the export(s)/verb(s) that implement it and the test(s)
that would catch its regression, plus a **report** that flags any gap.

## The pieces

| Piece | File | Role |
| --- | --- | --- |
| Feature index | `tests/feature-coverage.ts` | One `FeatureEntry` per behavior: `behavior` → `exports`/`verbs` → `tests` (`[]` = known gap). Stateful features carry a `transition` note plus exact `transitionEvidence` test titles. |
| Report | `tools/check-feature-coverage.ts` (`npm run check:features`) | Flags gaps, broken test refs, weak transition evidence, and drift; exits non-zero on any. |
| Gate | `tests/conventions.test.ts` | Runs the same integrity + drift assertions inside `npm test`, so the axis is enforced without a separate command. |
| Surface guard | `src/index.exports.test.ts` (DM-1058) | Pins the exact public value-export set against `docs/api.md`. |
| Transition guard | `src/render/render-text-mode-guard.test.ts` | Example of a state-transition test (the process-global render mode's save/restore, incl. on-throw). |

## What the report flags

`npm run check:features` (and the `conventions.test.ts` mirror) fails on:

- **GAP** — a feature with no asserting test (`tests: []`): a documented behavior
  nothing would catch regressing.
- **BROKEN REF** — a `tests` path that no longer exists (a renamed/deleted test
  silently dropping its feature's coverage).
- **WEAK TRANSITION** — a state-transition claim has no `transitionEvidence`,
  cites a file outside the feature's `tests`, or names a title that is not an
  actual literal `it(...)` / `test(...)` declaration in that file. The checker
  parses test source, so copying the title into a comment or fixture cannot
  satisfy the gate.
- **DRIFT** — a public value-export (from the package barrel) or a CLI verb/bin
  claimed by **no** feature. This is the self-policing part: **ship a new export
  or verb without adding a feature entry and the check turns red**, even at 100%
  line coverage. A stale claim (an entry for a removed export) fails too.

## Stateful modules — cover the *transitions*

The gap line coverage is blindest to is a **state transition**: operating on a
module after it has already moved through one or more states. The index MUST
include those, not just single operations from a clean state. A transition entry
must cite the exact assertion(s) in `transitionEvidence`; a nearby or broadly
related test file is not evidence. Current
transition-bearing entries (grep `transition:` in `tests/feature-coverage.ts`):

- **`text.mode`** — `default → set(paths) → withRenderTextMode(…) restores paths`,
  including when the callback throws (the DM-1338/DM-1350 leak class).
- **`text.glyph-defs` / `text.embedded-fonts`** — registry/CSS accumulate across a
  render, then `resetGeneration` / `clear*` empties them for the next frame.
- **`scroll.execute`** — `until`-loop re-evaluates per iteration; the final
  iteration clamps to the target; a no-progress body ends the loop.
- **`animate.transitions`** — a frame's entrance is composed from the *previous*
  transition (the transition-to-transition matrix), not a fixed entrance.
- **`composite.layers`** — each layer's internal timeline is re-anchored to its
  own `start` within the master loop and held/stretched/looped before/after.
- **`capture.iframe-recursion`** — `raster-fallback → native-recursion` when the
  frame document becomes readable.
- **`bin.svg-scrubber`** — `/ticket` is review-only (404 unless `--review`);
  `/export-frame` remains a normal scrubber route, and the review region overlay
  stays armed across repeated drags.

## The exercise

Adding a feature = adding its `FeatureEntry` with a real test ref. When you can't
name a test, you found a gap: write the test (or record `tests: []` deliberately,
which fails the gate until filled). Walk the index periodically asking, per item:
*is there a test that would fail if this behavior regressed?* — the check makes
"no" impossible to ship silently.

See also: `docs/ai/requirements-summary.md` (status view), `FEATURES.md`
(per-feature fixture checklist), and the `CLAUDE.md` "Testing Philosophy" section
(which names the line-coverage trap + the transition-matrix mandate).
