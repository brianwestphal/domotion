# 30 — Webfont `unicode-range` partitioning

## Context

Modern web font loaders (Google Fonts, self-hosted Next.js / Vercel font pipelines, …) split each `(family, weight, style)` into multiple `@font-face` rules differentiated by `unicode-range`. A typical Geist@400 declaration:

```css
@font-face { font-family: Geist; font-weight: 400; src: url(.../latin.woff2);     unicode-range: U+0000-00FF, U+0131, …; }
@font-face { font-family: Geist; font-weight: 400; src: url(.../latin-ext.woff2); unicode-range: U+0100-024F, …; }
@font-face { font-family: Geist; font-weight: 400; src: url(.../cyrillic.woff2);  unicode-range: U+0400-045F, U+0490-0491, …; }
```

The browser fetches only the partitions whose declared range covers a codepoint that's actually rendered on the page. Per CSS Fonts 4 §11.5, when laying out a glyph for codepoint `cp`, Chromium picks the partition whose `unicode-range` contains `cp` — partitions whose range doesn't cover `cp` are skipped *even if they expose the right family name*.

## Problem the change solves

Domotion's webfont registry stores variants keyed by `(family, weight, italic)` only. Pre-DM-557 there was no `unicode-range` filtering at pick time:

1. **DM-517 (`pickWebfontVariant`)**: returns the Latin-covering variant when ties exist (a tertiary scoring component biased toward Basic Latin coverage). Worked for Latin-only text but had no per-codepoint awareness — non-Latin runs in a partitioned family fell to system fonts.
2. **DM-557 (`pickWebfontVariantForCodepoint`)**: this doc. Filters variants by `unicodeRangeCovers(v.unicodeRange, codepoint)` then scores by italic + weight. Wired into the run-splitter in `textToPathMarkup` so a mixed-script run (Latin + Cyrillic + Greek in the same `<p>`) routes each codepoint to the matching partition before falling through to the system fallback chain.

## API

`unicode-range` is captured from each `@font-face` rule (both same-origin via the page-side walker and cross-origin via the server-side `parseFontFaceRulesFromCssText`, DM-545) and stored on the registered variant:

```ts
interface WebfontVariant {
  weight: number;
  italic: boolean;
  font: FontInstance;
  unicodeRange?: Array<[number, number]>;  // inclusive intervals, undefined = U+0..U+10FFFF
}
```

Two pickers consult it:

- `pickWebfontVariant(family, weight, fontSize, slant)` — Latin-bias scorer. Returns the primary variant for the family when no codepoint context is known (e.g., the fast-path single-font lookup before run-splitting).
- `pickWebfontVariantForCodepoint(family, weight, fontSize, slant, codepoint)` — codepoint filter + italic/weight scorer. Returns null when no registered variant covers the codepoint; the caller then falls through to the system fallback chain.

## Run-splitter integration

`textToPathMarkup` in `src/render/text-to-path.ts` walks the input text codepoint-by-codepoint, building runs of contiguous codepoints that route to the same font. Pre-DM-557 the routing was:

1. If `primaryFont.glyphForCodePoint(cp).id !== 0` → primary.
2. Otherwise → walk `fallbackFontChain(cp)` (system fonts: Apple Symbols, PingFang, Hiragino, etc.).

DM-557 inserts a step between (1) and (2) for primary fonts that come from the webfont registry:

1. Primary covers `cp` → primary.
2. **NEW**: Primary is `webfont:<family>` but doesn't cover `cp` → `pickWebfontVariantForCodepoint(family, …, cp)`. If a variant covers `cp`, use it.
3. Otherwise → system fallback chain.

The run-splitter's grouping is widened to discriminate runs by `(fontKey, fontInstance)` rather than just `fontKey`. A Latin-partition Geist run and a Cyrillic-partition Geist run share the same `webfont:geist` key but use different `FontInstance` objects, so they form separate runs even though their key matches. Each run shapes through its own `font.layout(runText)`.

## Behavior at the edges

- **Single-partition family** (no `unicode-range` declared): The variant has `unicodeRange = undefined` which `unicodeRangeCovers` treats as covering all codepoints. The codepoint pick returns it for any input — same behavior as today, no regression.
- **Codepoint not covered by any registered variant**: `pickWebfontVariantForCodepoint` returns null. The run-splitter walks the system fallback chain instead, just as it did before DM-557. The diff in this case is unchanged.
- **Italic mismatch + range coverage tradeoff**: `pickWebfontVariantForCodepoint`'s scoring uses italic mismatch (1000) + weight delta. It does NOT have the 2000-penalty range mismatch term that `pickWebfontVariant` carries, because the codepoint variant has already filtered to range-covering candidates. Among range-covering candidates, italic match dominates weight match — same priority order as the rest of the picker family.

## Verification

- `src/webfont-unicode-range.test.ts` — covers `pickWebfontVariantForCodepoint` directly. Tests cover: codepoint covered by exactly one variant, ASCII routing to Latin partition, return-null when no variant covers, single-non-partitioned variant covers everything (CSS default range), italic + weight scoring among multiple covering variants, unregistered family.
- The run-splitter integration is exercised end-to-end whenever real-world tests run against pages that load partitioned families. Stripe, Framer, NYT, Resend, Apple all use Google Fonts or their own partition pipelines.

## Cross-platform note

`unicode-range` parsing and the picker are both pure JavaScript — no platform-specific paths. The cross-platform calibration concern (CLAUDE.md §"Platform support") doesn't apply here. The downstream font rasterisation (fontkit `font.layout()` + `getVariation()`) is the same code path for system fonts.

## What's NOT in scope

- **`unicode-range`-driven on-demand fetching**: Domotion captures whatever the page already loaded; we don't re-fetch partitions the page didn't request. If a captured tree has a Latin-only run but the page loaded a Cyrillic partition (because some other element used it), we'll register the Cyrillic partition too — but it never fires for the captured Latin run.
- **`unicode-bidi` / BiDi reordering interaction**: covered by DM's existing BiDi pass (`bidi-js` + `applyBidi`). The run-splitter operates on the BiDi-reordered text, so each visual run gets its own partition pick.
- **Synthetic small-caps cross-partition**: `font-variant-caps: small-caps` synthesis (DM-294/DM-444) operates per-character. With per-codepoint routing, a synthesized small-cap glyph from the Latin partition co-exists with a synthesized small-cap glyph from the Cyrillic partition in the same line. Today's synthesis logic doesn't special-case this; the per-character render uses whatever font the run-splitter picked.

## Related work

- DM-517 — initial unicode-range parse + Latin-bias picker.
- DM-545 — cross-origin `@font-face` discovery (Stripe / CDN-hosted CSS), prerequisite for partitions to register at all on those sites.
- DM-557 — this slice; codepoint-aware variant pick + run-splitter integration.
