---
id: "requirements/webfont-unicode-range"
title: "30 — Webfont unicode-range partitioning"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-294", "DM-444", "DM-517", "DM-545", "DM-557", "DM-KRMZ4Y", "DM-687YPX", "DM-7QQPJA"]
code:
  [
    "packages/text-engine/src/render/text-to-path.ts",
    "packages/text-engine/src/render/webfont-unicode-range.test.ts",
    "packages/text-engine/src/render/webfont-descriptor-group.test.ts",
    "tests/webfont-descriptor-group.e2e.test.ts",
    "src/webfont-unicode-range.test.ts",
    "src/capture/unicode-range.ts",
    "src/capture/unicode-range.test.ts",
    "tests/unicode-range-descriptor.e2e.test.ts",
    "src/capture/cross-origin-font-face.ts",
    "src/cross-origin-font-face.test.ts",
    "tests/cross-origin-font-face.e2e.test.ts",
  ]
aliases: ["docs/30-webfont-unicode-range.md", "doc-30"]
---

# 30 — Webfont `unicode-range` partitioning

## Context

Modern web font loaders (Google Fonts, self-hosted Next.js / Vercel font pipelines, …) split each `(family, weight, style)` into multiple `@font-face` rules differentiated by `unicode-range`. A typical Geist@400 declaration:

```css
@font-face {
  font-family: Geist;
  font-weight: 400;
  src: url(.../latin.woff2);
  unicode-range: U+0000-00FF, U+0131, …;
}
@font-face {
  font-family: Geist;
  font-weight: 400;
  src: url(.../latin-ext.woff2);
  unicode-range: U+0100-024F, …;
}
@font-face {
  font-family: Geist;
  font-weight: 400;
  src: url(.../cyrillic.woff2);
  unicode-range: U+0400-045F, U+0490-0491, …;
}
```

The browser fetches only the partitions whose declared range covers a codepoint that's actually rendered on the page. Per CSS Fonts 4 §11.5, when laying out a glyph for codepoint `cp`, Chromium picks the partition whose `unicode-range` contains `cp` — partitions whose range doesn't cover `cp` are skipped _even if they expose the right family name_.

## Problem the change solves

Domotion's registry groups declarations by family and retains their weight,
style, stretch and range descriptors. Selection has two ordered stages:

1. Select one descriptor capability group by stretch, style and weight before
   consulting ranges. Pinned Chromium `FontFaceCache::Get` selects a
   `CSSSegmentedFontFace` under one capabilities key.
2. Within that group, walk range partitions in reverse declaration order. A
   requested character outside the entire group's ranges skips the family and
   continues the CSS stack. It must not borrow another descriptor group's face.

Earlier pickers filtered all variants by range first, or let a Latin preference
override descriptors. A family with a 400-weight `U+0041` face and a 700-weight
`U+0030` face could therefore supply its bold zero for a 400 request instead of
using the next CSS family. The corrected order applies to the primary picker,
per-codepoint selection and shaped segmented fallback. The primary's physical
cmap cannot bypass its declared range.

## API

`unicode-range` is captured from each `@font-face` rule and stored on the registered variant. Same-origin rules come from the page-side walker (`scanActiveFontFaceRules`), which keeps only the rules Blink activates (evaluated `@media` / `@supports` / `@import` conditions; see [doc 03](03-font-family-chain.md)). A cross-origin stylesheet (which throws on `cssRules`) is fetched Node-side and its text is parsed by Chromium itself, in a constructed `CSSStyleSheet` in the page (`src/capture/cross-origin-font-face.ts`), and walked by the same scanner, so both paths keep the same rules and read the descriptors from CSSOM. Each descriptor therefore takes Blink's value, the last valid declaration: `CSSParserImpl::ConsumeFontFaceRule` builds the value set through `FilterProperties`, which keeps the last declaration per descriptor (`core/css/parser/css_parser_impl.cc:263-307`, `:1519-1555`), and `AtRuleDescriptorParser::ParseFontFaceDescriptor` drops an invalid value (`at_rule_descriptor_parser.cc:346-430`), both at Chromium 7d859f27. An earlier regex scanner took the first declaration instead and split values at a `;` or `}` inside a string.

```ts
interface WebfontVariant {
  weight: number;
  italic: boolean;
  font: FontInstance;
  unicodeRange?: Array<[number, number]>; // inclusive intervals, undefined = U+0..U+10FFFF
}
```

### Descriptor parsing

One parser, `parseUnicodeRangeDescriptor` in `src/capture/unicode-range.ts`, reads every `unicode-range` value. It has no imports and uses no Node or DOM API, so the bundled CAPTURE_SCRIPT (the line-clamp ellipsis probe in `src/capture/script/line-clamp.ts`) imports it directly. The page-side `@font-face` walker returns the CSSOM serialization (`CSSFontFaceRule.style.getPropertyValue("unicode-range")`), and Node parses it with the same function. Before this, three separate copies used `parseInt`, so they accepted trailing garbage such as `U+41zz` and reversed ranges.

The parser transcribes Blink (Chromium `7d859f27`, 2026-06-27). The tokenizer is `CSSTokenizer::LetterU` + `ConsumeUnicodeRange` (`core/css/parser/css_tokenizer.cc:117-123`, `:437-468`): `u`/`U`, `+`, up to six hex digits, then either `?` wildcards filling the remaining six-digit budget or `-` and one to six hex digits. The descriptor parser is `ConsumeFontFaceUnicodeRange` (`core/css/parser/at_rule_descriptor_parser.cc:63-82`) plus the end-of-stream check at `:427`. It takes a comma-separated list of such tokens. The whole descriptor is invalid when an entry is not a token, an entry is empty, anything follows a token before the next comma, or `start > end || end > 0x10FFFF`.

An invalid descriptor is dropped, so the face keeps the initial value U+0-10FFFF. The parser returns `undefined` for an invalid value as well as an empty one, and the registry reads `undefined` as full coverage.

`tests/unicode-range-descriptor.e2e.test.ts` uses Chromium as the oracle. It feeds a corpus of valid and malformed values through a real `@font-face` rule and requires the parser to accept and reject the same values, with the same intervals.

Two pickers consult it:

- `pickWebfontVariant(family, weight, fontSize, slant, variationSettings?, stretch?)` — exported Latin-bias scorer (in `packages/text-engine/src/render/webfont-registry.ts`). Returns the primary variant for the family when no codepoint context is known (e.g., the fast-path single-font lookup before run-splitting).
- `pickWebfontVariantForCodepoint(family, weight, fontSize, slant, codepoint, variationSettings?, stretch?)` — descriptor-group selection followed by a range lookup. Returns null when the selected group excludes the codepoint; the caller continues the CSS family stack.

## Run-splitter integration

The default renderer uses shaped-cluster fallback in both output modes; its
segmented iterator retains each selected group's reverse-declared partitions
and clamps shaping to their ranges. The explicit degraded per-codepoint walk
also respects the selected group:

1. The primary's range includes `cp` and its glyph check succeeds → primary.
2. Walk declared CSS families in order. Webfont families use their selected
   group's range lookup, including the primary family's other partitions.
   A different partition retains its concrete instance even when its family
   key is the same as the primary.
3. After declared families are exhausted, proceed to platform fallback.

The run-splitter's grouping is widened to discriminate runs by `(fontKey, fontInstance)` rather than just `fontKey`. A Latin-partition Geist run and a Cyrillic-partition Geist run share the same `webfont:geist` key but use different `FontInstance` objects, so they form separate runs even though their key matches. Each run is shaped separately against its own instance by the production HarfBuzz pass (`harfbuzzShapedRunOverride`; see [doc 115](115-production-harfbuzz-shaping.md)).

## Behavior at the edges

- **Single-partition family** (no `unicode-range` declared): The variant has `unicodeRange = undefined` which `unicodeRangeCovers` treats as covering all codepoints. The codepoint pick returns it for any input — same behavior as today, no regression.
- **Selected group excludes the codepoint**: return null and continue the CSS
  family stack even if another weight/style/stretch group advertises it.
- **In-range missing glyph**: selection still returns the declared face; its
  physical glyph coverage and shaping verdict govern subsequent fallback. A
  missing glyph is not reclassified as a unicode-range exclusion. Isolated
  image metric selection keeps its separate authenticated-face policy.
- **Primary Latin preference**: `WEBFONT_RANGE_MISMATCH` chooses a useful
  primary partition only inside the selected capability group. It cannot
  override weight, style or stretch selection.
- **Cross-group ties and CSS-less inference**: existing ordinary and segmented
  selection policies are retained. Their different tie direction and the
  descriptor-less OS/2 inference are not claimed as Chromium guarantees;
  native parity remains a separate investigation (DM-M5E64N).

## Verification

- `packages/text-engine/src/render/webfont-unicode-range.test.ts` — covers `pickWebfontVariantForCodepoint` directly. Tests cover: codepoint covered by exactly one variant, ASCII routing to Latin partition, return-null when no variant covers, single-non-partitioned variant covers everything (CSS default range), italic + weight scoring among multiple covering variants, unregistered family.
- `src/webfont-unicode-range.test.ts` and `src/capture/unicode-range.test.ts` cover the capture-side `parseUnicodeRangeDescriptor`, which produces the ranges the registry consumes. The second carries Blink's own tokenizer cases plus the reversed, out-of-range, empty-entry and trailing-garbage rejections.
- `tests/unicode-range-descriptor.e2e.test.ts` checks the parser's accept and reject verdicts and intervals against Chromium's CSS parser.
- `webfont-descriptor-group.test.ts` covers primary/secondary CSS families,
  descriptor groups, source order, partitions and in-range missing glyphs.
  `webfont-descriptor-group.e2e.test.ts` requires real Chromium's selected custom
  face and Range advance to match: excluded groups use the generated fallback's
  14px zero while the in-range control uses the Mono fixture's 12px zero.
  Native runs retain `webfont-descriptor-group-*.json` with the actual browser
  revision, selected face, Range width and engine answer. Linux artifacts live
  under `tests/output-linux/`; macOS and Windows use `tests/output/`.
- The run-splitter integration is exercised end-to-end whenever real-world tests run against pages that load partitioned families. Stripe, Framer, NYT, Resend, Apple all use Google Fonts or their own partition pipelines.

## Cross-platform note

Parsing and selection are shared JavaScript, but the result reaches native
font selection and shaping on every supported platform. The descriptor-group
controls use authored fonts to discriminate the same ordering on macOS, Linux
and Windows. Local macOS evidence does not establish Linux or Windows parity.

## What's NOT in scope

- **`unicode-range`-driven on-demand fetching**: Domotion captures whatever the page already loaded; we don't re-fetch partitions the page didn't request. If a captured tree has a Latin-only run but the page loaded a Cyrillic partition (because some other element used it), we'll register the Cyrillic partition too — but it never fires for the captured Latin run.
- **`unicode-bidi` / BiDi reordering interaction**: covered by DM's existing BiDi pass (`bidi-js` + `applyBidi`). The run-splitter operates on the BiDi-reordered text, so each visual run gets its own partition pick.
- **Synthetic small-caps cross-partition**: `font-variant-caps: small-caps` synthesis (DM-294/DM-444) operates per-character. With per-codepoint routing, a synthesized small-cap glyph from the Latin partition co-exists with a synthesized small-cap glyph from the Cyrillic partition in the same line. Today's synthesis logic doesn't special-case this; the per-character render uses whatever font the run-splitter picked.

## Related work

- DM-517 — initial unicode-range parse + Latin-bias picker.
- DM-545 — cross-origin `@font-face` discovery (Stripe / CDN-hosted CSS), prerequisite for partitions to register at all on those sites.
- DM-557 — this slice; codepoint-aware variant pick + run-splitter integration.
