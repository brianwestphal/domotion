# Code map for AI agents

Read `CLAUDE.md` first. This page is deliberately compact; use the generated
[manifest](manifest.json) or an on-demand [domain packet](packets/) instead of
loading the historical documentation corpus.

## Render naming and import order

Render functions use `resolve*` for pure decisions and geometry, `build*` for
owned definitions or value construction, `emit*` for SVG markup insertion,
`paint*` for a CSS paint phase, and `render*` for complete text or element
dispatch. Name helpers for the operation they perform rather than the caller
that first needed them. The ESLint import group rule keeps Node built-ins,
packages, and local imports in that order while preserving each group's source
order; local import evaluation order can affect existing module cycles.

`src/render/mask.ts` resolves the mask region, builds individual layers, then
composes active layers bottom-up. `src/render/element-tree-to-svg.ts` owns the
element paint lifecycle and delegates generated pseudo backgrounds, triangles,
borders, and effect wrappers to named helpers. Text path emitters share their
captured segment typography and common path options through `src/render/text.ts`.
`src/render/gaussian-blur.ts` converts Blink shadow blur radius to SVG standard
deviation for box, inline, control, and text shadows.

## Main pipeline

- `src/capture/` owns browser bring-up, DOM/style/geometry collection, source
  evidence, replaced/native surfaces, and the serialized page capture script.
  `capture/debug-bundle.ts` owns the filesystem-neutral in-memory reproduction
  artifacts used by programmatic capture callers; CLI directory conventions
  remain under `src/cli/`. `capture/index.ts` is the internal barrel;
  `capture/public.ts` is the documented subset the root and the
  `domotion-svg/capture` subpath re-export (likewise `scroll/public.ts`).
  The browser payload enters through `src/capture/script/index.ts`; its
  geometry/style admission, pseudo/closed-shadow normalization, child
  traversal, and result assembly are isolated in
  `src/capture/script/walker/capture-phases.ts`. The capture build inlines those
  importable/testable phases back into one self-contained `page.evaluate`
  function, so no module boundary leaks into the captured page (DM-2639).
  `captureInner` (the per-element walk) is a short orchestrator over named
  handlers under `walker/`: `projective-state.ts` (3D facts and homography),
  `native-controls.ts` (appearance ownership, decoration parts, file input),
  `text-phase.ts`, `image-elements.ts`, `style-record.ts` (the `styles` record),
  `element-rasters.ts` (scrollbar/native-control/backdrop sub-records),
  `fidelity-warnings.ts`, `scroll-markers.ts`, `iframe-recursion.ts`, and
  `counter-scopes.ts`. The Node caller and the script share the typed
  `CaptureScriptArgs` bag (`capture/types.ts`), and `capture/tree-shape.ts`
  validates what `page.evaluate` returns. Every module under
  `src/capture/script/` is type-checked under the repo's strict config; the
  browser bundle erases these annotations before serialization.
- `src/render/` turns captured facts into SVG. It must preserve Chromium's
  decisions; it does not independently lay out the page. Browser-faithful text
  is a private workspace at `packages/text-engine/`: it owns resolution,
  fallback, shaping, glyph/outline and embedded-font emission, platform routing,
  native and ICU helpers, HarfBuzz, font fixtures, and package-local tests.
  `packages/text-engine/src/render/font-resolution.ts` is the compatibility
  barrel. Focused render modules own platform paths/chains, family matching,
  webfont registration, font instances, live and per-codepoint fallback,
  character-cache state, shaping routes, generation, and text mode; see the
  [font-resolution diagram](../font-resolution-diagram.md) for the ownership map.
  The manual Windows fidelity workflow runs
  `tools/mathml-radical-windows-probe.ts` for native MathML font and fourteen-row
  bar evidence; `tests/mathml-radical-windows-probe.test.ts` pins that route.
  `system-ui-cloned-cascade.test.ts` exercises the macOS cloned UI fallback
  request and cache transitions; the root
  `tests/system-ui-cloned-fallback.e2e.test.ts` compares its formerly divergent
  routes with real Chromium.
  The text-engine build imports its compiled Node ESM entry as a runtime
  initialization check after TypeScript compilation.
  Domotion consumes its session/document/run facade and the focused
  `./font-resolution`, `./text`, `./capture`, `./helpers`, `./format`, `./diagnostics`, and
  unstable `./testing` entry points (no deep-import subpath). The stable
  entries carry only what root production code imports; root `src/render/*`
  files that re-export named symbols from them are compatibility adapters, not
  duplicate implementations. Root oracles, probes, and root tests import
  engine internals from `@domotion/text-engine/testing` directly. Tests of engine-only logic (including the native
  helper parity tests) live in the workspace, not the root. Keep resolution and shaping together because shaped-cluster
  fallback makes them mutually dependent. See docs 262 and the canonical font
  resolution diagram.
  `render/real-text-layer.ts` owns the single-frame opt-in paintless authored
  text overlay for inline-SVG search, selection, copy, and accessibility; the
  visible glyph geometry remains the only paint owner.
  `RenderTextMode` selects the text-emit strategy: the pixel-faithful defaults
  `embedded-font` (subset `@font-face`) and `paths` (glyph outlines), plus the
  opt-in `system-font` (`renderTextAsSystemFont` in the text-engine workspace) —
  authored `<text>` painted by the consumer's installed fonts, run-anchor-only,
  browser-owned bidi, not pixel-faithful. Chosen via `--text-mode`,
  `setRenderTextMode`/`withRenderTextMode`, or `elementTreeToSvg({ renderTextMode })`;
  see docs 261.
- `src/animation/`, `src/tree-ops/`, and `src/scroll/` compose and transform
  static captures into timed frames, nested scenes, and scrolling outputs.
  `animation/animator.ts` is the stable facade; `svg-generator.ts` and
  `frame-timeline.ts` own SVG emission and the deterministic clock.
  Declarative capture is split across the `cli/animate-*` command, artifact,
  capture-session, frame-capture, debug-bundle, and orchestration modules;
  `cli/debug-bundle.ts` shares reproduction-directory naming with static
  capture. Declarative layer
  composition itself enters through `src/cli/composite.ts`.
- `src/terminal/` and `src/templates/` are authoring front ends that reuse the
  same render/animation pipeline.
- `src/studio/` owns the versioned Studio project source of truth: strict schema,
  stable cross-object identities, JSON persistence, legacy-storyboard import,
  recursive composition lowering, and the static storyboard compile adapter.
  The generated editor schema is
  `schemas/domotion-studio-project.schema.json`; generated SVG/video remains
  artifact provenance, never project state. Its AI-led healing loop replays
  exact semantic intent, records browser failure evidence and parent-linked AI
  revisions, requires AI review, and pauses through tamper-checked clarification
  checkpoints before a human handoff. The same directory owns the
  standalone local Studio server/Kerf client; `src/cli/studio.ts` exposes it as
  both `domotion-studio` and `domotion studio`. Studio embeds the existing
  Scrubber client behind a versioned same-origin preview protocol, so scene and
  story inspection share the standalone tool's playback engine. Its high-level
  authoring layer applies reversible scene/beat edits, commits explicit content
  revisions, and routes generation only through required AI healing/review.
  Its real-interaction recorder redacts sensitive values inside the page,
  retains browser DOM/CSS/navigation evidence, and requires AI healing plus AI
  review before importing a normal editable semantic scene.
  The recorder's installed browser payload and the shared recorder/healing
  selector and observation DOM-path helpers live in `src/studio/page-script/`;
  Studio and Scrubber share checked-response POST
  handling through `src/utils/post-json.ts`.
  Its detailed timeline projects every authored timing primitive onto the
  production scene clock and applies pointer, keyboard, undo/redo, and AI edits
  through one explicit revisioned command before seeking the embedded Scrubber.
- `benchmarks/glassbox/` is Studio's north-star product integration: a durable
  AI-authored JSON storyboard, small explicit TypeScript hooks, and a live runner
  against the sibling Glassbox checkout. It requires DOM/CSS-backed capture,
  evidence-constrained AI healing, AI candidate review, production video review,
  controlled-change recapture, self-containment checks, and optional publication
  to Glassbox's README hero asset.
- `src/post-processing/` exports the self-contained SVG to raster or video.
- `src/review/` and `src/scrubber/` provide local review and timeline UIs.
- `tests/html-test-suite.tsx` coordinates the broad HTML fixture sweep;
  `tests/html-test/` owns its cache, fixture tables, text evidence, compare
  lock, worker page recovery, and index renderer. Shared page timeouts and
  platform hinting floors live in `tests/harness-constants.ts`.
  `compare-pngs.ts` coordinates PNG diffing, while typed
  `compare-pngs.browser.ts` is bundled at build time for the canvas analysis;
  it imports the shared digest from `side-digest.ts`.
- `src/cli/` exposes the capture, animate, composite, storyboard, template,
  terminal, review, scrubber, studio, and svg-to-image/video workflows.
- `src/utils/` holds cross-cutting runtime helpers; checked-in generated
  source lives beside its owner (`packages/text-engine/src/generated/` for the
  MathML operator dictionary, `src/capture/script.generated.ts`, and the
  `*.bundle.generated.ts` clients); `src/test-support/` contains reusable test
  lifecycle helpers; and `src/tooling/` holds root-level probe tests that are
  not shipped.

## Published command-line programs

- `domotion` — capture, animate, terminal, template, composite, and storyboard
- `svg-to-video` and `svg-to-image` — export animated or static SVG output
- `svg-review` and `svg-scrubber` — inspect static diffs or animated timelines
- `domotion-studio` — launch the standalone local Studio application

The `npm run benchmark:glassbox` workflow exercises the complete Studio pipeline
against Glassbox and publishes the accepted baseline asset;
`benchmark:glassbox:quick` omits video and publication while retaining baseline
plus controlled-healing browser passes.

## Correctness and evidence

- `tests/feature-coverage.ts` maps supported behaviors to asserting tests.
- `tools/parity-program.json` and `tools/semantic-coverage.json` inventory
  source ownership, stage gates, activation, platform coverage, and gaps.
- `tools/*oracle*`, `tools/*gate*`, and `.github/workflows/` produce and
  adjudicate exact logical, native, and visual evidence.
- `tools/sfns-mask-report.ts` validates the versioned persistence boundary for
  SFNS outline and terminal-mask evidence. The SFNS domain schemas retain their
  own v2/v3 digests; the terminal adjudicator seals raw input file bytes before
  reading either flat historical reports or current envelopes.
- `tools/unicode-font-route-report.ts` validates Windows Unicode font-route
  trace envelopes and explicit flat v2 artifacts; the native-only probe keeps
  its stdout contract in `tools/unicode-font-route-trace.ts`.
- The renderer route, paint order, mixed bidi, shaping, and decoration oracles
  separate collection from pure comparison and report construction. Their CLI
  entry points retain browser ownership, exit codes, and existing JSON schemas;
  `tests/oracle-phases.test.ts` covers the pure seams and
  `tests/oracle-phases.e2e.test.ts` exercises a live Chromium paint order flow.
- `tools/lib/conformance-args.ts` validates numeric flags and 1-based shard
  selection for conformance tools and the visual harness.
- `tools/lib/browser.ts` owns TypeScript tool browsers, while
  `tools/lib/browser.mjs` gives plain-Node probes the same callback and
  idempotent cleanup pattern. See `docs/tool-browser-lifecycle.md`.
- `scripts/install-windows-profile-fixture-fonts.ps1` installs the generated
  Devanagari comparison faces used by the native Windows profile/target gate.
- `scripts/materialize-source-authorities.mjs` reconstructs the source subset
  required by clean-checkout CI from immutable Chromium, Chromium-pinned
  Skia/ICU, HarfBuzz, and html-test revisions. Release validation installs its
  headless browser and native helper explicitly; helper builds retain staged
  artifacts and attach only after the GitHub release exists.
- `external/chromium`, pinned Skia, HarfBuzz, ICU, and platform-native helpers
  are the authority for fidelity work. Cite the governing decision before
  changing a parity branch.
- Generated client/capture bundles must be rebuilt with their package scripts
  and committed with their source.

## Domain routing

- [Text and fonts](../handbook/text-and-fonts.md)
- [Layout and fragmentation](../handbook/layout-and-fragmentation.md)
- [Paint, effects, and native controls](../handbook/paint-effects-and-native-controls.md)
- [Images, media, and embedding](../handbook/images-media-and-embedding.md)
- [Animation and interaction](../handbook/animation-and-interaction.md)
- [Platforms, testing, and release](../handbook/platforms-testing-and-release.md)
- [Major-release visual capture checklist](../handbook/major-release-visual-capture.md)
  (release-time README/examples/site demo refresh, not a domain handbook)

Search the [manifest](manifest.json) by stable ID or code path, then open only
the handbook and current reference/evidence records relevant to the change.
