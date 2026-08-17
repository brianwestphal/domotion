# Domotion ICU companion

`domotion-icu` exposes the raw ICU4C Unicode properties used by Domotion's
Chromium font/shaping policy. It is intentionally separate from the platform
glyph helper: it has its own release cadence, acquisition cache and version
handshake.

The binary must be built against ICU 78.2, matching the Chromium revision
pinned by Playwright. The release bundle contains the executable, its ICU
runtime libraries where required, and Chromium's exact `icudtl.dat` data image.
Official ICU 78.2 binary bundles are reused for Ubuntu 22.04 x64 and Windows;
macOS and Linux ARM64 are built in the helper-release workflow.

Protocol:

```json
{"cps":[65,8205,19968]}
```

Pass `--serve` for one JSON request/response per line. Every response reports
the protocol, ICU and Unicode versions so a mismatched cached companion cannot
silently answer.
