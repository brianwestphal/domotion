---
name: analyze-code-quality
description: Run all available tests and linters, check for anti-patterns, and generate a comprehensive code quality report
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the overall quality of the source code in this project. Generate a comprehensive report.

> **Line coverage is a floor, not a ceiling (DM-1459).** 100% line/branch/function
> coverage proves every line *ran* — it says nothing about whether every
> documented *behavior*, or every *transition between internal states*, is
> actually *asserted*. Two basic bugs recently shipped in a stateful module at
> 100% coverage because each operation was tested only from a clean state and the
> transitions between states never were. So treat a green coverage number as the
> **trigger for the behavioral audit (Step 5)**, never as a stopping point.

## Steps

1. **Run unit tests with coverage**
   ```
   npm test
   ```
   Report: total tests, pass/fail count, coverage percentage by directory. State
   explicitly that this is the *floor* (see the note above) — proceed to Step 5.

2. **Run E2E tests**
   ```
   npm run test:e2e
   ```
   Report: total E2E tests, pass/fail count. (E2E spawns the BUILT `dist/cli/*.js`,
   so it runs `build:capture-script` first via the `test:e2e` script.)

3. **Run linter**
   ```
   npm run lint
   ```
   Report: total errors/warnings, categorized by rule.

4. **Check for anti-patterns documented in CLAUDE.md**
   Read `CLAUDE.md` and the `docs/` requirements files. Prefer **ast-grep** for
   the structural ones (`CLAUDE.md` § Investigation lists the exact patterns) —
   a text grep drowns them in legitimate page-context uses. Look for violations
   of documented conventions:
   - Files that are excessively long (against `docs/ai/code-summary.md` + the
     code-organization guidance; the recent `/check-code-hygiene` bar was
     ~200+-line functions carrying inline decision logic).
   - **Browser globals in node-side render** — `document.createElement` / `document.body`
     / bare `window.` / `getComputedStyle` in `src/render/*` belong ONLY inside the
     page-`evaluate`d CAPTURE_SCRIPT (§ CAPTURE_SCRIPT discipline), never in the
     renderer.
   - `exec()` / `execSync()` (shell-string) instead of the argv forms
     `execFile` / `spawn` / `*Sync` (the DM-1332 no-shell-exec rule).
   - Missing `.js` extension on relative import paths (ESM / NodeNext).
   - Duplicate code across files (a re-implemented predicate/helper instead of the
     canonical one — e.g. the DM-1457 transparent-background check).
   - `any` outside the fontkit / bidi-js library boundary (the `as any` /
     `as unknown as` casts § Quality gates flags).

5. **Behavioral / state-transition audit** *(the axis line coverage is blind to)*
   ```
   npm run check:features
   ```
   `check:features` (backed by `tests/feature-coverage.ts`; see
   `docs/83-feature-coverage.md`) reports any **GAP** (a documented behavior with
   no asserting test), **BROKEN REF**, or **DRIFT** (a public export / CLI verb
   with no feature entry). **Treat every GAP and DRIFT as a finding** — a green
   line-coverage number *with* a feature-coverage gap is a failure, not a pass.

   Then audit the **stateful modules** directly (don't rely on the index alone):
   - **Identify them** — any module with multiple code paths keyed on an internal
     mode / flag / phase, a state machine, a cache with fallback paths, or
     lifecycle transitions. In this repo the usual suspects are the process-global
     render mode (`withRenderTextMode`), the glyph-defs / embedded-font registries
     (per-generation lifecycle), the scroll executor (`until`-loop state), the
     frame-transition composition (a frame's entrance depends on the *previous*
     transition), nested-composite timeline re-anchoring, and the scrubber's
     review mode. Grep for module-level `let` / mutable maps + `set*`/`clear*`/`reset*`
     pairs to surface others.
   - **Enumerate states + transitions** for each, then check whether the tests
     exercise the *transitions* — multi-step sequences ACROSS state boundaries —
     not just each operation from a clean initial state.
   - **Flag** any stateful module whose tests only cover single-operation-from-clean-state,
     and recommend an **adversarial transition-matrix test**. Concrete sequences to
     try: out-of-order, interleaved, repeated, empty-then-refill, set→scope→restore
     (incl. restore-on-throw — the `render-text-mode-guard.test.ts` template), and
     the mid-lifecycle operation. If a stateful behavior has no index entry, that's
     also a `tests/feature-coverage.ts` gap to file.

6. **Check TypeScript strictness**
   ```
   npm run typecheck
   ```
   (Not a bare `tsc --noEmit`: `typecheck` builds the generated capture-script /
   review-client / scrubber-client first, so a bare run would fail on missing
   generated files.) Report any type errors.

## Report Format

Generate a structured report with:
- **Summary**: Overall health score (tests passing, lint clean, coverage % — noted as a floor, not the bar).
- **Test Results**: Unit and E2E pass rates.
- **Coverage**: By directory, highlighting files below 50% — AND the Step 5 result.
- **Behavioral / transition coverage**: the `check:features` gaps/drift, plus a
  per-stateful-module transition-coverage assessment (which transitions are
  untested even at 100% line coverage, with the adversarial sequences to add).
  This section must be able to flag a stateful module whose transitions are
  untested even when line/branch coverage is green.
- **Lint Issues**: Grouped by severity.
- **Anti-Pattern Violations**: Specific files and lines.
- **Recommendations**: Prioritized list of improvements.
