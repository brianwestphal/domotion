---
id: "requirements/text-engine-session-boundary"
title: "262 — text-engine session and document boundary"
kind: "contract"
status: "current"
owners: ["text-fonts", "rendering"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-4CN6YM", "DM-A1KCSY", "DM-DS8AGC", "DM-7GC0MM"]
code:
  [
    "packages/text-engine/package.json",
    "packages/text-engine/README.md",
    "packages/text-engine/src/index.ts",
    "packages/text-engine/src/font-resolution.ts",
    "packages/text-engine/src/text.ts",
    "packages/text-engine/src/capture.ts",
    "packages/text-engine/src/helpers.ts",
    "packages/text-engine/src/format.ts",
    "packages/text-engine/src/diagnostics.ts",
    "packages/text-engine/src/testing.ts",
    "packages/text-engine/src/render/synth-test-fonts.ts",
    "packages/text-engine/src/render/text-engine.ts",
    "packages/text-engine/src/render/text-engine.test.ts",
    "packages/text-engine/src/render/font-resolution.ts",
    "packages/text-engine/src/render/text-to-path.ts",
    "src/render/text-engine-boundary.test.ts",
    "tests/conventions.test.ts",
    "src/render/element-tree-to-svg.ts",
  ]
aliases: ["docs/262-text-engine-session-boundary.md", "doc-262"]
---

# 262 — text-engine session and document boundary

Domotion exposes one cohesive browser-faithful text engine. Font selection,
fallback, shaping, native glyph extraction, outline emission, and embedded-font
construction are one dependency unit: shaped-cluster fallback asks the resolver
and shaper to cooperate, so they must not be published as cyclic resolver and
shaper packages.

The private `@domotion/text-engine` npm workspace is the deliberate package
seam. Its supported package-root (`.`) entry point is
`packages/text-engine/src/index.ts`, backed by
`packages/text-engine/src/render/text-engine.ts`; focused integration entry
points (`./font-resolution`, `./text`, `./capture`, `./helpers`, `./format`,
`./diagnostics`, and the unstable `./testing` hooks) each publish an explicit
named-export list; `packages/text-engine/README.md` tabulates what each owns.
The exports map has no deep-import wildcard, so lower modules such as
`text-to-path.ts`, `harfbuzz-shaper.ts`, and the platform helper adapters stay
implementation details. Root `src/render/*` files are compatibility adapters
that re-export named symbols from those entry points, not a second
implementation; none may use `export *`, and production root code may not
import `./testing` (`src/render/text-engine-boundary.test.ts` and
`tests/conventions.test.ts` enforce both, plus the ban on relative imports into
`packages/text-engine/{src,dist}`).

The stable entry points are sized to exactly what root production code
imports. Everything a root oracle, probe, fixture tool, or root test needs
beyond that — resolver and shaping internals, helper and ICU queries,
provenance enable/read/reset, cache resets, platform overrides, the
synthetic-font builder — lives on the single unstable `./testing` entry, which
tools and tests import directly rather than through a root adapter.
`src/render/text-engine-boundary.test.ts` holds both directions: a stable entry
point or root adapter exporting a symbol no production module imports fails,
and so does a `./testing` symbol no root tool or test imports. Neither set is
sized to what tests of engine logic would find convenient. A test that exercises only engine modules lives in the workspace
(`packages/text-engine/src/**/*.test.ts`, run by
`npm test --workspace @domotion/text-engine` on macOS and Linux CI) and imports
those modules directly; that includes the native-helper parity tests
(`packages/text-engine/src/render/{linux,win32}-glyph-extractor.test.ts`) and the
synthetic-font builder they share (`packages/text-engine/src/render/synth-test-fonts.ts`).
A root test stays in the root only when it also needs root infrastructure — a
captured tree rendered through `elementTreeToSvg`, the root capture layer, a
Playwright browser, or a root oracle under `tools/` — and then splits so its
engine-only cases move (for example the root and workspace halves of
`embedded-font-snapshot.test.ts`, `font-family-stack.test.ts`, and
`webfont-unicode-range.test.ts`). `./testing` therefore carries only symbols a
root tool or root test still needs.

Resolution and shaping intentionally remain together. The shaped-cluster
fallback loop alternates between candidate selection, shaping, `.notdef`
inspection, and requeueing; splitting those responsibilities would create a
cyclic package boundary. The workspace also owns the native and ICU helper
sources, acquisition contract, HarfBuzz build, routing data, font fixtures,
and their package-local tests.

## Lifetimes

- A `TextEngineSession` owns the reusable renderer identity and its registered
  webfonts/local aliases. Two sessions cannot observe each other's registrations.
- Omitting a session joins Domotion's ambient compatibility generation, so
  existing clear/render/collect producers can read generated definitions and
  embedded-font CSS after the document callback. Callers that require isolation
  create and pass an explicit session.
- `withTextEngineDocument` owns one synchronous render transaction: selected
  text mode, generic-family profile, macOS/Fontconfig fallback scope, generated
  glyph definitions, embedded-font subsets, and their diagnostics.
- A document starts a fresh generation by default. `generation: "continue"`
  explicitly resumes the same session's prior generated-artifact state for a
  multi-frame composition.
- Nested render adapters join the active document. They may add a scoped mode,
  generic-family profile, or baseline policy, but may not switch sessions or
  reset the enclosing generation.
- `activeTextEngineDocument()` lets an internal renderer adapter join the
  current document; `TextEngineDocumentRequest.genericFamilies` scopes the
  captured browser's generic-family preferences to that document.
- Every synchronous scope restores the previous process state on success,
  exceptions, and rejected Promise-like callbacks. Async work happens before
  entering a document; no engine state scope may cross an `await`.

The current implementation installs session-owned values into module registries
for the duration of the synchronous callback. That is an implementation bridge,
not part of the contract; a later internal refactor may move those values into
instance fields without changing callers or the package boundary.

## Run and result surface

`TextEngineRunRequest` is the standalone run-shaped input: source text,
coordinates, CSS font selection/shaping inputs, paint, and captured layout
overrides. `TextEngineDocument.renderRun` returns `TextEngineRunResult` with SVG
markup. `withTextEngineDocument` returns the caller value plus
`TextEngineArtifacts`: glyph definitions, embedded `@font-face` CSS, and
embedded-font diagnostics.

The `system-font` path records a `system-font-emitted` text-emitter transition
when it emits authored SVG text; see doc 261 for its visual contract.

DOM capture types, tree rendering, and authored real-text accessibility
ownership remain in Domotion adapters. They consume the text-engine workspace;
the workspace never imports them.

## Verification boundary

- `npm test --workspace @domotion/text-engine` builds and runs the workspace's
  unit suite independently, then runs the native-helper transport performance
  cases in the isolated `test:transport-performance` lane.
- `npm run conformance --workspace @domotion/text-engine` invokes the repository
  font-resolution, shaping, and decoration oracles against the built workspace.
- Root `npm test`, `npm run typecheck`, and `npm run build` build and consume the
  workspace on every run. The root package bundles the private workspace into
  its npm artifact; the workspace is not published independently.
- Domotion unit, end-to-end, platform, visual, and grouped Unicode suites remain
  mandatory integration consumers; an isolated engine pass cannot replace them.
