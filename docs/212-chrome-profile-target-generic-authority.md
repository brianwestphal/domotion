---
id: "requirements/chrome-profile-target-generic-authority"
title: "Chrome profile and target generic-family authority"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2539","DM-2550","DM-2551"]
code: []
aliases: ["docs/212-chrome-profile-target-generic-authority.md","doc-212"]
---

# Chrome profile and target generic-family authority

Domotion captures the live Blink `Settings` generic-family maps owned by the
exact Playwright `Page`. It does not infer those maps from static platform
tables or from a different browser target.

`npm run fonts:generic-profile-target` creates isolated full-Chrome profiles
whose requested families are chosen from faces painted by the current browser
and font inventory. DM-2539 now authenticates all 21 Common, Japanese, and
Devanagari fields, the raw preference file, the full-Chrome process, and both
renderer targets; [doc 219](219-authenticated-profile-oopif-generic-preferences.md)
is the current gate contract. There are no screenshot comparisons or pixel
thresholds.

The gate records two distinct source-owned launch outcomes in both forward and
reverse profile-launch order:

- Headed full Chrome applies every one of the 21 persisted profile fields.
- Headless full Chrome applies exactly the Common/script fields present in the
  installed Playwright source table and retains the profile for every omitted
  field. The OS mask is derived from source keys, not a fixed row count.

The browser oracle also creates a cross-site OOPIF. The main and child have
distinct authenticated CDP target IDs. It applies all 21 non-inert
`Page.setFontFamilies` fields child→main and main→child: each step moves only
the selected target, while locale-tagged `system-ui` controls remain stable.
This proves that one main-Page record is insufficient when target Settings
diverge. Production therefore authenticates every distinct target and refuses
capture on disagreement; the supported capture contract remains one
non-divergent Page authority.

Every script-key probe paints a scalar belonging to that script and restores
Blink's `lang`-owned `-webkit-locale` after `all: initial` neutralization. This
prevents the document script or Latin glyph fallback from masquerading as proof
that a script-specific family map was exercised. DM-2550/DM-2551 own the
separate production-probe consequences described in doc 219.

The native workflow runs the exact logical gate on macOS, Linux under Xvfb,
and Windows and retains its fingerprinted JSON report. Platform-owned
`system-ui` remains a separate route covered by
[doc 211](211-platform-system-ui-preference-route.md).
