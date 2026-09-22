---
id: "requirements/text-engine-session-boundary"
title: "262 — text-engine session and document boundary"
kind: "contract"
status: "current"
owners: ["text-fonts", "rendering"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-4CN6YM"]
code:
  [
    "src/render/text-engine.ts",
    "src/render/text-engine.test.ts",
    "src/render/text-engine-boundary.test.ts",
    "src/render/font-resolution.ts",
    "src/render/text-to-path.ts",
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

`src/render/text-engine.ts` is the deliberate package seam. Lower modules such
as `font-resolution.ts`, `text-to-path.ts`, `harfbuzz-shaper.ts`, and the native
helper adapters are implementation details of that seam. In particular,
`text-to-path.ts` must not blanket re-export `font-resolution.ts`.

## Lifetimes

- A `TextEngineSession` owns the reusable renderer identity and its registered
  webfonts/local aliases. Two sessions cannot observe each other's registrations.
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

The current implementation installs session-owned values into the existing
module registries for the duration of the synchronous callback. That is an
implementation bridge, not part of the contract; the workspace extraction may
move those values into instance fields without changing callers.

## Run and result surface

`TextEngineRunRequest` is the standalone run-shaped input: source text,
coordinates, CSS font selection/shaping inputs, paint, and captured layout
overrides. `TextEngineDocument.renderRun` returns `TextEngineRunResult` with SVG
markup. `withTextEngineDocument` returns the caller value plus
`TextEngineArtifacts`: glyph definitions, embedded `@font-face` CSS, and
embedded-font diagnostics.

DOM capture types and authored real-text accessibility ownership remain in
Domotion adapters. They are not dependencies of the text-engine facade.

## Verification boundary

- `npm run test:text-engine` runs the facade and dependency-boundary unit tests
  without capture or animation tests.
- `npm run text-engine:conformance` runs the existing font-resolution, shaping,
  and decoration conformance entry points.
- Domotion unit, end-to-end, platform, visual, and grouped Unicode suites remain
  mandatory integration consumers; an isolated engine pass cannot replace them.
