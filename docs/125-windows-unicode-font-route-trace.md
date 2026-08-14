# 125 — Windows Unicode font-route trace

Status: **Shipped diagnostic**.

## Requirement

A focused Windows Unicode visual run must preserve enough per-cell evidence to
locate a face mismatch without rerunning the original CI host. Aggregate
`chromeFaces` counts remain useful for detecting that a fixture changed, but
cannot identify which declared stack or fallback stage selected each cell.

For focused Windows Unicode runs, shard 1 writes `font-route-trace.json`. Every
`<x><g>` cell records:

- codepoint, literal computed `font-family`, style, weight, size, stretch, and
  language;
- every declared family in order, whether DirectWrite can install it, and the
  index at which the declared walk first becomes usable;
- Chromium's painted face from `CSS.getPlatformFontsForNode`, reopened through
  the native helper to obtain the final glyph id;
- Blink's transcribed hardcoded Windows candidates, their installed/coverage
  results, and the accepted candidate if any;
- the exact `MapCharacters` base family, Blink-derived locale, and style tuple,
  plus DirectWrite's reopened final answer; and
- Domotion's primary key, declared key chain, final route key, face/path, and
  glyph id.

The trace is observational and Windows-only. It uses the production resolver
and the same DirectWrite helper as rendering; it does not introduce block or
codepoint overrides. A trace is emitted only for a focused (`only` non-empty)
Unicode dispatch so broad sweeps do not pay a second per-cell browser/native
probe across every block.

## Upstream correspondence

The stage boundary follows Chromium revision `7d859f27`:
`GetFallbackFamilyNameFromHardcodedChoices` runs first and only falls through
to `GetDWriteFallbackFamily` when no candidate both loads and covers the
character (`font_cache_skia_win.cc`). The hardcoded candidate ordering is the
source transcription in `src/render/win-font-fallback.ts`. The DirectWrite ask
uses the literal first CSS family as `baseFamilyName`, the run's Skia style, and
`FallbackLocaleForCharacter(...)->LocaleForSkFontMgr()`; Skia revision
`ebf5052` forwards those values to `IDWriteFontFallback::MapCharacters`.

## Command

```bash
npx tsx tools/unicode-font-route-trace.ts \
  external/html-test/unicode/2100-214F-letterlike-symbols.html \
  --out tests/output/html-test-unicode/font-route-trace.json
```

The command requires native Windows, a built win32 glyph helper, and installed
Playwright Chromium.
