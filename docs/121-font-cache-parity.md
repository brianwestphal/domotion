# 121 — Font cache identity and lifetime parity

This is the cache inventory for the same-machine text contract in doc 120.
“Trim” means `clearFontResolutionCaches()`; “invalidate” means
`invalidateFontEnvironmentCaches()`. Registries are state, not recomputable
memos, and therefore have their own explicit lifecycle.

| Domotion state | Identity | Lifetime / reset | Chromium analogue |
| --- | --- | --- | --- |
| `fontInstanceCache` | effective face, weight, size, slope, sorted axes, system-ui/declaration provenance, effective width | process memo; trim + invalidate | `FontPlatformDataCache`, keyed by `FontDescription::CacheKey` plus family |
| `resolvedSpecCache` | platform + logical/dynamic key | process memo; trim + invalidate | platform font manager/typeface lookup caches |
| `coverageBitsets` | file + physical collection member | process memo; trim + invalidate | DirectWrite `HasCharacter` / fontconfig charset; deliberately unused for CoreText |
| `fallbackBaseCache` | primary key + CSS description | process memo; trim + invalidate | base `FontPlatformData` passed into platform fallback |
| `systemFallbackKeyCache` | platform, codepoint, base, CSS description, locale, presentation | process query memo; trim + invalidate | platform fallback result, except modeled order-dependent caches below |
| helper `_systemFallbackCache` | base face, codepoint, complete platform request | process query memo; trim + invalidate | CoreText/DirectWrite fallback call result |
| helper `_fcFallbackCache` | locale + codepoint outside renderer scope | low-level query memo; trim + invalidate | browser-side locale-sensitive miss computation |
| scoped Linux renderer fallback | codepoint only | renderer/document scope; first writer wins; survives trim | `WebSandboxSupportLinux::unicode_font_families_` |
| macOS character fallback | base face, weight, italic bit, size; value is first successful ideograph face | renderer/document scope; first writer wins; survives trim | `FontCache::character_fallback_cache_` / `CharacterFallbackCache` |
| `fallbackFamilyCutCache` | candidate face, codepoint, CSS description | process memo; trim + invalidate | macOS alternate-family in-family reselection |
| `_sysfbCoverage` | resolved face + codepoint | process query memo; trim + invalidate | coverage returned by the platform nomination |
| Darwin/Linux/Windows primary-cut caches | logical/declared key + full weight/style/stretch request | process memo; trim + invalidate | `BestStyleMatchForFamilyNS` / fontconfig matcher / DirectWrite family-style match |
| `win32FamilyKeyCache` | normalized family + optional complete style | process memo; trim + invalidate | DirectWrite `FindFamilyName` / `matchFamilyStyle` |
| `_famAvailCache` | modeled platform + normalized declared family | process memo; trim + invalidate | Blink unavailable-family/platform-data caches, which belong to one platform font environment |
| helper installed/family/style/trait caches | normalized OS query + complete style where applicable | helper lifetime; invalidate (not memory trim) | CoreText, fontconfig, and DirectWrite font-manager caches |
| `fileFaceInfoCache` | file + requested PostScript/name instance | process memo; trim + invalidate | `SkTypeface::openStream` collection index and variation position |
| `darwinHandleAxesMap` | resolved key + weight + size + slope | process side-band memo; trim + invalidate | substituted CoreText handle’s current axes |
| HarfBuzz `hbFontCache` | source id/path + physical face index | process memo; environment invalidate | Blink `HarfBuzzFace` / `HbFaceFromSkTypeface` |
| HarfBuzz proxy cache | base object identity + face, size, axes/features | weak lifetime of base font instance | Blink font-data/shaping object ownership |
| cluster `verdictCache` | face/member, size, axes, direction, script, language, features, item + bounded context | capped process optimization; explicit clear | `ShapeCache`-class optimization; answer-neutral |
| `webfontRegistry` | CSS family; ordered variants carry descriptors, unicode-range, and bytes | capture/session registry; `clearWebfonts`; survives trim/invalidate | `CSSFontSelector` / segmented `FontFace` state |
| `localFontAliasRegistry` | CSS family + ordered weight/style variants | capture/session registry; clear on `clearWebfonts` and environment invalidate | `local()` source resolution in `CSSFontSelector` |
| `dynamicSystemFontPaths` | resolved PostScript face key | process discovered registry; survives trim, clears on environment invalidate | concrete platform typeface retained by font data |
| `sessionGenericFamilyOverrides` | common or script-specific generic keyword | launched-browser session; replaced explicitly, survives font-cache invalidation | `GenericFontFamilySettings` / Playwright `Page.setFontFamilies` |
| embedded-font/glyph-def registries | resolved source/instance/glyph identity | output generation; `resetGeneration` | no selection analogue; SVG output state |

## Required transition properties

- Reordering identical asks within one macOS or Linux renderer may change later
  answers only where Chromium is itself first-query-wins.
- A fresh renderer/document scope starts without prior order state.
- Memory trim reproduces the same answer and preserves modeled renderer state.
- Environment invalidation re-asks installed-family, style, coverage, fallback,
  file/member, and generic-preference questions; downloaded webfont bytes stay.
- Webfont/local registries never leak between capture sessions, and a reloaded
  webfont receives fresh face/shape identities even when its CSS family is the
  same.
- Oracle reports record their renderer/document isolation; results with a
  different isolation or shard order are not comparable.
