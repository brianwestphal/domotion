---
id: "requirements/authenticated-profile-oopif-generic-preferences"
title: "Authenticated profile and OOPIF generic preferences"
kind: "reference"
status: "current"
owners: ["rendering"]
platforms: ["macos","windows"]
tickets: ["DM-2539"]
code: [".github/workflows/generic-profile-target-parity.yml"]
aliases: ["docs/219-authenticated-profile-oopif-generic-preferences.md","doc-219"]
---

# Authenticated profile and OOPIF generic preferences

DM-2539 replaces the sampled Chrome-profile check with one exact logical
contract. The gate authenticates the browser process, the raw isolated-profile
file, Playwright's launch-time overlay, and the renderer `Settings` owned by
each target. It captures no screenshot, compares no pixels, and has no font-name
answer table or adjustable tolerance.

## Source ownership

The model is pinned to Chromium revision
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `ChromeContentBrowserClient::OverrideWebPreferences()` in
  `chrome/browser/chrome_content_browser_client.cc` reads the current
  `Profile::GetPrefs()` and fills all seven standard/fixed/serif/sans-serif/
  cursive/fantasy/math maps.
- `FontFamilyCache::FillFontFamilyMap()` in
  `chrome/browser/font_family_cache.cc` walks every registered script and reads
  `<map>.<script>` from `PrefService`. `RegisterFontFamilyPrefs()` in
  `chrome/browser/ui/prefs/prefs_tab_helper.cc` registers every map/script
  combination, including fields with no platform default.
- `GenericFontFamilySettings` stores each family by ICU script and falls back
  to Common only when a script key is absent. `FontSelector::FamilyNameFromSettings()`
  selects the map from the CSS generic and the key from
  `FontDescription::GetScript()`.
- `InspectorPageAgent::setFontFamilies()` updates the inspected root frame's
  `Settings`, accepts all seven maps for Common and each `forScripts` row, and
  notifies generic-family change. Its once-only guard belongs to that Inspector
  session; a fresh session can independently mutate another renderer target.

Playwright 1.59.1 applies its own `Page.setFontFamilies` call to every headless
target from `playwright-core/lib/server/chromium/defaultFontFamilies.js`
(`crPage.js::_setDefaultFontFamilies`). The gate loads that installed module,
hashes the exact source file, and derives the current OS mask structurally from
its Common and `forScripts` keys. It does not encode the number of overwritten
rows or assume that a future Playwright table has the same shape.

## Full-Chrome and raw-profile authentication

The Playwright registry must resolve channel `chrome`, registry name `chrome`,
and browser name `chromium`. The report records the canonical executable path,
byte size, and streaming SHA-256. Every launch separately calls
`Browser.getVersion` and `Browser.getBrowserCommandLine`; it must report a
`Chrome/*` product, the command's first argument must be the hashed executable,
and `--user-data-dir` must be the exact isolated directory under test.

The requested profile is derived only from faces painted by a clean target on
the current browser and font inventory. For each of Common, Japanese, and
Devanagari, every requested field differs from its own baseline and the script
uses at least two distinct painted mutation families. That gives 21 non-inert
fields without fitting code points to a known outcome.

Two profiles run in opposite orders: headed then headless, and headless then
headed. Before launch and after each close, the gate reparses raw
`Default/Preferences`, extracts all 21 `webkit.webprefs.fonts` values, and
requires exact persistence. Headed Chrome must paint all 21 requested values.
For headless Chrome, only fields present in the source-derived Playwright mask
may match the independently observed clean-headless state; every unmasked field
must retain the profile-owned headed identity. Both orders must satisfy the
same ownership rule.

## Locale discriminator

HTML `lang` becomes Blink's inherited `-webkit-locale` presentation property
(`Element::MapLanguageAttributeToLocale`), and that locale supplies
`FontDescription::GetScript()`. A probe that sets `all: initial` after `lang`
silently resets this property and does not test the advertised script map.
DM-2539 therefore restores an explicit quoted `-webkit-locale` after probe
neutralization and paints a scalar covered by the requested script. This is why
the gate can require all seven Japanese and all seven Devanagari fields rather
than counting unchecked rows as successes.

The broader production capture probe and its independent preference gate now
apply the same correction across their complete dynamic-script matrices.
Their mutations are derived per script from faces already proven to paint that
script's scalar, while locale-tagged `system-ui` controls retain an ASCII glyph
so generic-map fallback cannot masquerade as system-family ownership. Protected
macOS Hebrew identities exposed by the locale-honest probe are handled by the
CoreText route documented in [doc 224](224-hidden-macos-hebrew-generic-face.md).

## Per-target OOPIF settings

The target leg serves the main document from `127.0.0.1` and its child from
`localhost` under `--site-per-process`. CDP must authenticate two different
target IDs, a `page` main target and an `iframe` child target with different
hostnames. Each starts with the same 21-field state.

Two fresh isolated launches apply the complete non-inert mutation in opposite
orders:

1. child, then main;
2. main, then child.

After each step the mutated target must match all 21 requested families, the
other target must retain all 21 prior identities, and the final forward/reverse
states must be identical. Three locale-tagged `system-ui` controls use an ASCII
glyph covered directly by every platform UI face; this isolates route ownership
instead of accidentally measuring Han/Devanagari glyph fallback after
`system-ui`. All three must remain stable on both targets after every generic-map
mutation.

## Gate

Run:

```sh
npm run fonts:generic-profile-target -- --json generic-profile-target.json
```

`.github/workflows/generic-profile-target-parity.yml` runs the gate on native
macOS, Ubuntu under Xvfb, and Windows with installed full Chrome. It uploads the
logical JSON report even on failure. A passing report requires eight
authenticated Chrome launches, both three-checkpoint profile orders, both
two-step target orders, source-derived overlay ownership, exact 21-field target
mutations, and stable `system-ui` controls.
