# Shaping fixtures

`FontWithFancyFeatures.otf.base64` is the real OpenType webfont used by WPT's
`css/css-fonts/font-variant-alternates-01.html` through `-19.html`, copied from
the pinned Chromium checkout (`7d859f271cbda744098ac69f44978d4edfa62be3`):

```
third_party/blink/web_tests/external/wpt/css/css-fonts/support/fonts/FontWithFancyFeatures.otf
```

Decoded SHA-256:
`0f7e550009d5d7348fdbaf79365e9cdbe010feb04e3af00bacc49f825e1f93f2`.
The font exposes the `salt`, `ss01`–`ss03`, `cv01`–`cv03`, `swsh`, `cswh`,
`ornm`, and `nalt` substitutions needed to make every named
`font-variant-alternates` function non-vacuous. Tests decode it in memory; the
base64 transport keeps the binary fixture reviewable and platform-independent.
