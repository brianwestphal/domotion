---
id: "requirements/hidden-macos-hebrew-generic-face"
title: "Hidden macOS Hebrew generic face ownership"
kind: "contract"
status: "current"
owners: ["platform-release"]
platforms: ["macos"]
tickets: ["DM-2550"]
code: ["src/render/generic-script-families.test.ts"]
aliases: ["docs/224-hidden-macos-hebrew-generic-face.md","doc-224"]
---

# Hidden macOS Hebrew generic face ownership

DM-2550 closes a stage error in live generic-family replay. The correction is
logical and source-owned: it changes neither screenshot tolerances nor glyph
geometry.

## Source decision

At Chromium revision `7d859f271c`, macOS
`FontCache::CreateFontPlatformData` rejects every dot-prefixed system family via
`IsSystemFontName` and returns null before family matching
(`third_party/blink/renderer/platform/fonts/mac/font_cache_mac.mm:395-406`).
Those protected faces can still be selected later. When the declared primary
lacks a character, `GetSubstituteFont` calls `CTFontCreateForString` from that
primary's `CTFont`; the returned substitute is then used unless it is
LastResort (`font_cache_mac.mm:128-150`).

That distinction is observable for `lang=he; font-family:cursive`. The captured
Common Page setting paints Latin with Apple Chancery. Hebrew is absent from
that face, so CoreText's cascade paints `.ArialHebrewDeskInterface`. Opening
the hidden PostScript name directly does not reproduce the browser route:
CoreText substitutes Times, and Blink would reject the name before that ask.

## Renderer correction

`CSS.getPlatformFontsForNode` reports the painted face, so a script probe may
contain a fallback identity rather than the Page setting's declared primary.
On macOS only, a dot-prefixed script answer is now classified as that fallback
evidence. Domotion retains the captured Common value for the generic primary;
its existing per-codepoint resolver then asks CoreText from the same handle
Blink used. Public script-specific faces and every non-macOS answer retain the
existing exact-face route.

## Exact gate

`src/render/generic-script-families.test.ts` carries both sides of the stage
boundary:

- a captured Hebrew `.ArialHebrewDeskInterface` answer cannot become the
  declared primary and resolves `cursive` to Apple Chancery;
- the native helper must resolve U+05D0 from the Apple Chancery file-backed
  handle to the exact `.ArialHebrewDeskInterface` PostScript identity.

The second assertion is a CoreText face-identity oracle, not a committed font
inventory table or raster comparison.
