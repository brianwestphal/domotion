---
id: "requirements/macos-ideograph-fallback-cache-audit"
title: "macOS ideograph fallback-cache audit"
kind: "evidence"
status: "current"
owners: ["platform-release"]
platforms: ["macos"]
tickets: ["DM-1949", "DM-2342", "DM-2401"]
code:
  [
    "packages/text-engine/src/render/character-fallback-cache.ts",
    "packages/text-engine/src/render/character-fallback-document-cache.test.ts",
    "packages/text-engine/src/render/font-resolution.ts",
    "packages/text-engine/src/render/generation.ts",
    "tools/ideograph-fallback-cache-oracle.ts",
  ]
aliases: ["docs/146-macos-ideograph-fallback-cache-audit.md", "doc-146"]
---

# macOS ideograph fallback-cache audit

The oracle accepts `--disabled-arm` for the controlled cache mutation. Unknown
options fail before browser launch; importing the module does not run it.

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

`CharacterFallbackKey::Make` returns no key, so nothing is looked up or
inserted, when `BuildIdentifierKey` yields an empty identifier
(`mac/character_fallback_cache.mm:21-82`). A face whose PostScript name starts
with `.` gets an identifier only when its descriptor carries both
`NSCTFontUIUsageAttribute` and `CTFontDescriptorLanguageAttribute`. Blink
builds the `system-ui` font with
`CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr)`, and with a
null language the descriptor has no language attribute (probed with the
identical call: the attribute keys are `NSCTFontUIUsageAttribute` and
`NSFontSizeAttribute`). Domotion's `characterFallbackDocKey` therefore returns
no key for a `system-ui` base or any `.`-prefixed base name. This is a source
transcription, not a judgment call; it would need revisiting only if Blink began
passing a language to that call.

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

DM-2401 completed the exact-key and renderer-lifetime work. The current
`characterFallbackDocKey` includes the base identifier, raw weight, full raw
slope, orientation, and effective font size. It retains the ideographic gate,
cmap hit test, successful-only insertion, and first-writer-wins behavior.

`beginCharacterFallbackDocument` opens a fresh map for a top-level render by
default. When a caller uses `createFontRendererSession` and
`withFontRendererSession`, the map belongs to that renderer identity and can
survive subsequent document scopes, including a simulated same-renderer
navigation. A different session gets a separate map. The
`fonts:ideograph-cache:oracle` command compares those lifetimes with browser and
helper evidence; `character-fallback-document-cache.test.ts` covers raw key
identity and ordered transitions. Pinned ICU supplies the property gate, and
the selected face's cmap owns coverage; no CJK-specific codepoint or font rules
are added.

`invalidateFontEnvironmentCaches()` empties the open document map in place and
replaces every session-owned map. Blink's `Invalidate()` does not clear the map
itself, so this is not a transcription of that call. It models the state after
the next garbage collection. `Invalidate()` clears the `FontDataCache` strong
LRU, and its clients release every fallback list that held the old faces
(`FontFallbackMap::FontCacheInvalidated` calls `InvalidateAll`;
`CSSFontSelector` dispatches a general invalidation). After that, the map's
weak `SimpleFontData` values are collectable, and the next Oilpan GC removes
each entry whose face is no longer reachable. Domotion models the values as
strong everywhere else and leaves GC timing unmodeled (it cannot be observed
from a capture), so the pre-GC window, when an old entry can still answer, is
not represented. Keeping the entries would also be wrong in a second way: each
value is a `sysfb:` key that resolves through `dynamicSystemFontPaths`, which
the same invalidation clears, so a surviving entry would name a face that no
longer opens. `character-fallback-document-cache.test.ts` pins the reset of the
open scope and of session-owned maps, and the continued reuse within a session
after an invalidation.

## Source map

- `platform/fonts/mac/font_cache_mac.mm:314-372` — gate, lookup, cmap hit,
  CoreText miss, and insert order.
- `platform/fonts/mac/character_fallback_cache.{h,mm}` — exact key and CTFont
  identifier construction.
- `platform/fonts/font_selection_types.h` — quarter-unit raw slope/weight
  representation.
- `platform/fonts/font_global_context.{h,cc}` — thread-specific persistent
  `FontCache` ownership.
- `platform/fonts/font_cache.cc:265-276` — invalidation does not explicitly
  clear the character fallback map.
- `platform/fonts/font_data_cache.h:69-84` — `Clear()` drops the weak map and
  its strong-reference LRU.
- `platform/fonts/font_fallback_map.cc:65-67` and
  `core/css/css_font_selector.cc:162-164` — the invalidation clients that
  release the fallback lists.
