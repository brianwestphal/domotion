# `@domotion/text-engine`

Private npm workspace for Domotion's browser-faithful text engine. It owns font
resolution and fallback, shaping, glyph extraction, outline and embedded-font
emission, native/ICU helper acquisition, platform routing data, and focused
conformance tests.

The supported package entry point is the session/document/run API exported from
`@domotion/text-engine`. `font-resolution` and `helpers` are focused integration
subpaths. `internal/*` exists only for Domotion's compatibility adapters while
the monorepo migration is in progress and is not a public API.

Run it independently from the repository root with:

```sh
npm test --workspace @domotion/text-engine
npm run typecheck --workspace @domotion/text-engine
npm run conformance --workspace @domotion/text-engine
```

The unit suite and isolated helper-transport performance lane are owned and run
entirely by this workspace. The conformance command deliberately exercises the
repository's browser/font/decoration integration oracles against the workspace;
root unit, end-to-end, platform, visual, and grouped Unicode gates remain the
integration contract for the published Domotion package.
