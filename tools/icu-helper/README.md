# Domotion ICU companion

`domotion-icu` exposes the raw ICU4C Unicode properties used by Domotion's
Chromium font/shaping policy. It is intentionally separate from the platform
glyph helper: it has its own release cadence, acquisition cache and version
handshake.

The binary must be built against ICU 78.2, matching the Chromium revision
pinned by Playwright. Release assets contain the executable, its ICU runtime
libraries where required, and Chromium's exact `icudtl.dat` data image. macOS
and Linux link ICU statically from the pinned source. Windows links Unicode's
official, SHA-512-pinned ICU 78.2 x64/ARM64 libraries and downloads the matching
runtime DLLs beside the helper. The all-codepoint digest gate proves every
target observes the same data and enum surface before release.

Protocol:

```json
{"cps":[65,8205,19968]}
```

Pass `--serve` for one JSON request/response per line. Every response reports
the protocol, ICU and Unicode versions so a mismatched cached companion cannot
silently answer.
