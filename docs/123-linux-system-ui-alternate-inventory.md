# Linux system-ui parity across font inventories

Linux `system-ui` is a same-machine question, not a Noble-image constant.
Chromium's headless browser preferences obtain `gfx::Font().GetFontName()`;
without a desktop `LinuxUi`, `PlatformFontSkia` starts from the fontconfig
fallback name `sans`. Domotion therefore asks `fc-match("sans")` on the same
host and retains that nomination when selecting weight, style, and stretch
cuts.

DM-2087 adds a second deterministic oracle environment. The stock Playwright
Noble image remains unchanged. The alternate profile installs DejaVu and uses
`tests/fontconfig/alternate-system-ui.conf` to prepend DejaVu Sans to the
`sans` preference. This deliberately changes Chromium's UI answer without
hardcoding that answer in production.

Run it locally with:

```bash
npm run test:linux-system-ui-alternate
```

The manual `Linux alternate system-ui inventory` workflow runs the same
profile independently from the required Noble fidelity baseline. It records
the effective `fc-match` result and font-inventory digest, checks Chromium and
Domotion across normal, bold, italic, condensed, English/Japanese locale, and
warm/fresh renderer order, then runs a bounded same-machine conformance slice
over Latin, Arabic, and Han.

The first run exposed a real cut bug: the initial `sysfb:DejaVuSans` key lost
the browser's `sans` nomination, so later style matching treated it as an
already-final fallback face and kept Regular for weights 600–800. Retaining
`declaredFamilyForKey = "sans"` lets `linuxPrimaryCutKey` re-ask fontconfig per
style. The fixed profile compares 50,774 rows across 106 real `system-ui`
stacks with zero mismatches; stock Noble continues to use its own inventory.
