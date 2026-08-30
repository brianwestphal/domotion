---
id: "requirements/macos-ideograph-fallback-cache-audit"
title: "macOS ideograph fallback-cache audit"
kind: "evidence"
status: "current"
owners: ["platform-release"]
platforms: ["macos"]
tickets: ["DM-1949","DM-2342","DM-2401"]
code: []
aliases: ["docs/146-macos-ideograph-fallback-cache-audit.md","doc-146"]
---

# macOS ideograph fallback-cache audit

DM-2342 audited the existing DM-1949 model against Chromium revision
`7d859f271cbda744098ac69f44978d4edfa62be3`. The broad mechanism is correct:
for `Ideographic=Yes` scalars, Blink can reuse the first fallback face associated
with a base-font key when that face covers a later scalar. The ordered
isolated-versus-sequence control already records the visible consequence:
`serif` / 16px / 800 resolves U+4E9F differently alone than after U+3400.

## Exact Chromium decision

`FontCache::PlatformFallbackFontForCharacter` constructs a key only for an
ideographic scalar while `MacCharacterFallbackCache` is enabled. It asks
`CharacterFallbackKey::Make` for:

- the base `CTFont` identifier (normally its PostScript name);
- `FontDescription::Weight().RawValue()`;
- `FontDescription::Style().RawValue()`;
- `FontDescription::Orientation()`; and
- `FontDescription::EffectiveFontSize()`.

Style is not an italic boolean. `FontSelectionValue` stores the slope as a
signed quarter-unit fixed-point number, so normal, italic, and distinct oblique
angles can own distinct entries. Orientation is independently keyed, so an
upright vertical request cannot consume a horizontal entry.

On a hit, Blink verifies the cached `SimpleFontData` still has a typeface and
that `unicharToGlyph(character)` is nonzero. A miss asks CoreText through
`GetAlternateFontPlatformData`. Only a successful result is inserted, and WTF
`HashMap::insert` makes the first result for a key permanent while its weak value
remains live; a later uncovered scalar re-asks but does not replace it.

## Lifetime

The map is not document-owned. It is a member of `FontCache`, which is a member
of the thread-specific persistent `FontGlobalContext`. It can therefore affect
later documents or navigations that execute in the same renderer thread.
`FontCache::Invalidate()` clears platform/data caches and notifies clients but
does not clear `character_fallback_cache_`. The value is a weak
`SimpleFontData`, so collection of that value can make an entry cease to answer,
but there is no source-backed unconditional document-boundary reset.

This distinction explains why dense-page and isolated probes can disagree and
also why a fresh-page probe is not automatically a fresh-cache oracle: process
and renderer placement matter. An exact test matrix must compare ordered text
in one page, navigation in the same renderer, and a newly created renderer
process, recording the actual PostScript face each time.

## Domotion audit result

The current model correctly implements the ideographic gate, base identifier,
weight/size separation, cmap hit test, successful-only insertion,
first-writer-wins behavior, nested scopes, and ordered sequence effect. It has
two known approximations:

1. `characterFallbackDocKey` folds style to `slant !== 0`, losing Blink's raw
   slope distinctions, and it omits orientation.
2. `beginCharacterFallbackDocument` creates a fresh map for every top-level
   render. That is safer than process-global accidental contamination, but it
   is not Blink's renderer-thread lifetime and cannot reproduce same-renderer
   navigation reuse.

DM-2401 owns the implementation correction. It must thread exact slope and
orientation through fallback routing, introduce explicit renderer-session
identity/lifetime, and add activation controls that distinguish same-renderer
navigation from a new renderer. It must not add CJK codepoint, range, or font
rules: pinned ICU supplies the property gate and the selected face's cmap owns
coverage.

## Source map

- `platform/fonts/mac/font_cache_mac.mm:314-372` — gate, lookup, cmap hit,
  CoreText miss, and insert order.
- `platform/fonts/mac/character_fallback_cache.{h,mm}` — exact key and CTFont
  identifier construction.
- `platform/fonts/font_selection_types.h` — quarter-unit raw slope/weight
  representation.
- `platform/fonts/font_global_context.{h,cc}` — thread-specific persistent
  `FontCache` ownership.
- `platform/fonts/font_cache.cc:265-277` — invalidation does not explicitly
  clear the character fallback map.
