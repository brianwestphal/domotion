# `@domotion/text-engine`

Private npm workspace for Domotion's browser-faithful text engine. It owns font
resolution and fallback, shaping, glyph extraction, outline and embedded-font
emission, native/ICU helper acquisition, platform routing data, and focused
conformance tests.

The supported package entry point is the session/document/run API exported from
`@domotion/text-engine`. The exports map also publishes focused integration
subpaths, each an explicit named-export list (`src/<subpath>.ts`):

| Subpath                 | Owns                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@domotion/text-engine` | `TextEngineSession`, `withTextEngineDocument`, run/document/artifact types                                                                                                       |
| `./font-resolution`     | family-key and face lookup, webfont and local-alias registries, render-text mode, glyph-definition and embedded-font generation state                                            |
| `./text`                | text-to-path emission, bidi levels, visual-text semantics, decoration/ink and emphasis-mark metrics, stretchy-fence and radical glyphs                                           |
| `./capture`             | page-context-safe helpers shared with the in-page capture script (CSS `font-family` stack parsing/serialization, emoji-presentation detection); must stay free of Node built-ins |
| `./helpers`             | native glyph-helper and ICU companion acquisition                                                                                                                                |
| `./format`              | the SVG number/escape/attribute formatting primitives the engine emits with                                                                                                      |
| `./diagnostics`         | render-phase profiling counters and text-emitter transition recording                                                                                                            |
| `./testing`             | **unstable**: everything root oracles, probes, fixture tooling and root tests need that production does not — see below                                                          |

The stable subpaths are sized to exactly what Domotion's root production code
imports; nothing else. `./testing` is the single unstable entry point. It holds
the resolver internals (`resolveFont`, `resolveFontForCodepoint`,
`fallbackFontChain`, the character-fallback document and renderer-scope hooks,
the Windows fallback table queries), the shaping and segmentation internals
(`harfbuzzShapeRun`, `harfbuzzGlyphQuery`, `segmentForShaping`,
`hbSubsetRetainGids`), the native glyph-helper and ICU queries and availability
probes, provenance enable/read/reset, cache and registry resets, platform
overrides, and the synthetic-font builder (`buildSfnt`). Any of it may change
or disappear without a version bump.

There is no deep-import subpath. Domotion's root `src/render/*` adapters
re-export named symbols from the stable entry points; root tools and tests
import `@domotion/text-engine/testing` directly. Three guards hold the surface:

- `src/render/text-engine-boundary.test.ts` fails when a stable entry point or a
  root adapter exports a symbol no root production module imports, and when
  `./testing` exports a symbol no root tool or test imports (or a root file
  imports one it does not export).
- `tests/conventions.test.ts` rejects any root import of another subpath, any
  relative import into `packages/text-engine/{src,dist}`, and any production
  `src/` import of `./testing`.
- The exports map has no wildcard, so Node and TypeScript cannot resolve
  anything else.

Move a symbol from `./testing` to a stable entry point, and add it to the
matching root adapter, when root production code starts needing it.

Tests of engine-only logic live in this workspace (`src/**/*.test.ts`) and
import modules directly, including the native-helper parity tests
(`src/render/{linux,win32}-glyph-extractor.test.ts`) and the synthetic test
fonts (`src/render/synth-test-fonts.ts`). A root test stays in the root only
when it also needs root infrastructure (a captured tree rendered by
`elementTreeToSvg`, the root capture layer, Playwright, or a root oracle); do
not widen an entry point just so such a test can reach an engine internal —
move or split the test instead.

Run it independently from the repository root with:

```sh
npm test --workspace @domotion/text-engine
npm run typecheck --workspace @domotion/text-engine
npm run conformance --workspace @domotion/text-engine
```

The unit suite and isolated helper-transport lane (`test:transport-performance`,
which exercises the persistent helper channel and proves the
`DOMOTION_HELPER_NO_SERVE` switch by counting helper process spawns rather than
by timing) are owned and run entirely by this workspace. CI runs
`npm test --workspace @domotion/text-engine` on macOS (the `test` job in
`.github/workflows/ci.yml`) and on Linux (the `regression` job in
`.github/workflows/test-linux.yml`), each after building the platform glyph
helper so the transport lane is live rather than skipped. The conformance command deliberately exercises the
repository's browser/font/decoration integration oracles against the workspace;
root unit, end-to-end, platform, visual, and grouped Unicode gates remain the
integration contract for the published Domotion package.
