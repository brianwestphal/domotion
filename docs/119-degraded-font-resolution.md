# Degraded font-resolution contract

Domotion's Chromium-parity font path requires the native helper for the running
platform. The helper is not merely an outline accelerator: it is the bridge to
CoreText, fontconfig/FreeType, or DirectWrite for installed-family matching,
per-codepoint fallback, face traits, and variable-axis identity.

If helper acquisition fails, `DOMOTION_DISABLE_HELPER=1` is set, or live system
fallback is explicitly disabled, rendering continues in a bounded degraded
mode. Degraded mode is a reliability fallback, not a second parity engine.

## Guarantees that remain

- Rendering does not fail solely because the helper is unavailable.
- A fixed Domotion version, platform inventory, input, and environment produce
  deterministic output.
- Author webfonts whose bytes were captured keep their normal shaping and
  coverage behavior.
- Installed-font checks still reject known-unavailable author families where
  the host APIs available to Node can establish that fact.
- Static fallback routes terminate safely and do not invent raw CSS, script, or
  viewer-side dependencies.

## Precision deliberately relinquished

- Exact installed family and style-cut nomination.
- Exact per-codepoint system fallback and locale/script ordering.
- Native symbolic bold/italic traits and some variable-axis coordinates.
- Family identity, glyph geometry, and pixel equality with Chromium.

The degraded tables are sampled approximations. They must never pre-empt a live
answer. On macOS and Linux the static Unicode chain is armed only when the
helper is absent or the live resolver is disabled. On Windows Blink itself has
a hardcoded nomination stage before DirectWrite, so that transcribed stage
remains live; only its generated per-block tail is deferred behind DirectWrite.
Session-probed generic families likewise win over compiled defaults whenever a
browser-side probe is present.

## Inventory of degraded seams

1. Helper acquisition failure falls back to fontkit for readable outlines.
   Helper-only/native formats may lose native outline and trait information.
2. Primary-family style selection falls back from native CoreText/fontconfig/
   DirectWrite matching to calibrated cut ladders.
3. macOS/Linux per-codepoint fallback falls back from CoreText/fontconfig to
   `fallbackFontChain`'s generated/static routes.
4. Windows retains Blink's source-backed hardcoded nomination table, but uses
   the generated range tail only when DirectWrite cannot be asked.
5. Browser generic/system-family probing falls back to the checked-in platform
   defaults when no session result is available.
6. Synthetic-bold/oblique decisions degrade when native face traits or resolved
   variation coordinates are unavailable; the renderer prefers avoiding a
   double synthesis over guessing that a real bold/italic trait is absent.

`DOMOTION_HELPER_NO_SERVE=1` is not degraded mode. It changes only the helper
transport from the persistent channel to one-shot processes and must preserve
answers exactly.

## Test contract

`static-chain-degraded-net.test.ts` proves the critical ordering invariant and
requires a discriminating codepoint to move between live and resolver-disabled
arms when a helper is available. Cross-platform helper dispatch tests use
cassette helpers for Linux and Windows, while native-host tests cover macOS.
`helper-acquire.test.ts` pins the warning so acquisition failure cannot again be
misreported as performance-only.
