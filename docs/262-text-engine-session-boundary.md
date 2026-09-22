---
id: "requirements/text-engine-session-boundary"
title: "262 — text-engine session and document boundary"
kind: "contract"
status: "current"
owners: ["text-fonts", "rendering"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-4CN6YM", "DM-A1KCSY"]
code:
  [
    "packages/text-engine/package.json",
    "packages/text-engine/src/render/text-engine.ts",
    "packages/text-engine/src/render/text-engine.test.ts",
    "packages/text-engine/src/render/font-resolution.ts",
    "packages/text-engine/src/render/text-to-path.ts",
    "src/render/text-engine-boundary.test.ts",
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
seam. Its supported entry point is
`packages/text-engine/src/render/text-engine.ts`; focused integration entry
points expose font-resolution and helper lifecycle controls. Lower modules such
as `text-to-path.ts`, `harfbuzz-shaper.ts`, and the platform helper adapters are
implementation details. Root `src/render/*` files that re-export
`@domotion/text-engine/internal/*` are temporary source-compatibility adapters,
not a second implementation or public package API. In particular,
`text-to-path.ts` must not blanket re-export `font-resolution.ts`.

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

DOM capture types, tree rendering, and authored real-text accessibility
ownership remain in Domotion adapters. They consume the text-engine workspace;
the workspace never imports them.

## Verification boundary

- `npm test --workspace @domotion/text-engine` builds and runs the workspace's
  unit suite independently, then runs the native-helper transport performance
  cases in an isolated single-worker lane.
- `npm run conformance --workspace @domotion/text-engine` invokes the repository
  font-resolution, shaping, and decoration oracles against the built workspace.
- Root `npm test`, `npm run typecheck`, and `npm run build` build and consume the
  workspace on every run. The root package bundles the private workspace into
  its npm artifact; the workspace is not published independently.
- Domotion unit, end-to-end, platform, visual, and grouped Unicode suites remain
  mandatory integration consumers; an isolated engine pass cannot replace them.
