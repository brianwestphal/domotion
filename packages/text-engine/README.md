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
| `./font-resolution`     | face/key resolution, per-codepoint and cluster fallback, webfont and local-alias registries, render-text mode, glyph-definition and embedded-font generation state               |
| `./text`                | text-to-path emission, HarfBuzz shaping, script/bidi segmentation, Unicode and emoji classification, decoration/ink metrics, synthetic-bold paint, hb-subset                     |
| `./capture`             | page-context-safe helpers shared with the in-page capture script (CSS `font-family` stack parsing/serialization, emoji-presentation detection); must stay free of Node built-ins |
| `./helpers`             | native glyph-helper and ICU companion acquisition, availability, and queries                                                                                                     |
| `./format`              | the SVG number/escape/attribute formatting primitives the engine emits with                                                                                                      |
| `./diagnostics`         | opt-in text-run provenance and render-phase profiling                                                                                                                            |
| `./testing`             | cache/registry introspection, deterministic resets, and platform overrides for tests and oracles; not a stable API                                                               |

There is no deep-import subpath. Domotion's root `src/render/*` adapters
re-export named symbols from these entry points, and
`tests/conventions.test.ts` rejects any root import of another subpath, any
relative import into `packages/text-engine/{src,dist}`, and any production
`src/` import of `./testing`. Widen an entry point deliberately, by adding the
symbol to its list, when a root caller genuinely needs it.

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
