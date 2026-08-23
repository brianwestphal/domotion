# Chrome profile and target generic-family authority

Domotion captures the live Blink `Settings` generic-family maps owned by the
exact Playwright `Page`. It does not infer those maps from static platform
tables or from a different browser target.

`npm run fonts:generic-profile-target` creates an isolated full-Chrome profile
whose requested families are chosen from faces painted by the current browser
and font inventory. It then checks the logical face identity for seven Common
generic families and the supported Japanese and Devanagari script fields.
There are no screenshot comparisons or pixel thresholds.

The gate records two distinct source-owned launch outcomes:

- Headed full Chrome applies the profile-owned Common and supported script
  preferences.
- Headless full Chrome applies its clean headless settings to 20 of 21 rows.
  The profile's Common `math` row survives because the headless override table
  does not assign it.

The browser oracle also creates a cross-site OOPIF. An ordinary child initially
matches the main Page. A target-local `Page.setFontFamilies` mutation then moves
only the OOPIF. This proves that one main-Page record is insufficient when
target Settings diverge. Production therefore authenticates every distinct
target and refuses capture on disagreement; the supported contract is one
non-divergent Page authority.

Every script-key probe paints a scalar belonging to that script, including
Thai `ก` and Georgian `ა` discovered from response-header and closed-shadow
language facts. This prevents Latin glyph fallback from masquerading as proof
that a script-specific family map was exercised.

The native workflow runs the exact logical gate on macOS, Linux under Xvfb,
and Windows and retains its fingerprinted JSON report. Platform-owned
`system-ui` remains a separate route covered by
[doc 211](211-platform-system-ui-preference-route.md).
