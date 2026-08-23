# Linux arm64 decoration coordinate ownership

DM-2501 closes the uniform `+1 CSS px` decoration result from Linux arm64
release-parity run `32611751700` without changing renderer geometry or widening
the `0.3px` rule-to-SVG envelope. The failure was in the oracle: its Chrome
paint and rule legs used a DPR-4 page, while its Domotion capture and SVG leg
used a separate page whose implicit device scale was DPR 1. Those pages did
not expose the same Blink text-fragment state.

## Source verdict

Pinned Blink takes the decoration box from the current
`FragmentItem::RectInContainerFragment()` and applies paint-y rounding in
`core/paint/text_fragment_painter.cc:62-83`; the rotated line-relative box is
built at `:352-375`, and the text baseline and decoration box remain separate
facts at `:517-532`. `text_decoration_painter.cc:88-95` passes that box offset
with the text item's `UsedFont`, while `text_decoration_info.cc:142-145` and
`:312-318` form each line from the local origin, line offset, and target
`FloatAscent`.

Those inputs are device-scale qualified on Linux. Pinned
`platform/fonts/font_platform_data.cc:239-242` sends the device scale to font
strike render-style selection; `ui/gfx/font_render_params_linux.cc:258-272`
enables subpixel positioning and disables hinting above DPR 1; and
`platform/fonts/font_metrics.cc:117-130` may move one rounded unit between
ascent and descent under that state. A fragment's CSS-pixel top is therefore
not required to be invariant between independently laid-out DPR-1 and DPR-4
pages.

The exact pinned Linux arm64 discriminator measured the same 12px Helvetica
span at fragment top `123` on DPR 1 and `122` on DPR 4, with canvas
`fontBoundingBoxAscent=11` on both. This is the observed one-pixel signature.
It also explains why run `32611751700` passed Chrome-versus-rule `106/106` and
skip-ink `29/29`, yet passed rule-versus-SVG only `35/106`: 74 bars moved by
exactly `+1` with unchanged thickness, including solid and patterned rows.
In the combined-line discriminator, overline and line-through remained exact
while only the underline moved, ruling out a blanket emitter correction.

## Ownership fix

`tools/decoration-oracle.ts` now creates an explicit scale plan and refuses a
Chrome-paint/Domotion-capture mismatch. Both legs use DPR 4 in the full matrix.
The JSON evidence fingerprints platform, architecture, Chromium version, the
`blink-physical-text-fragment-same-dpr-v1` ownership contract, and both device
scales. The Linux arm64 finalizer additionally requires all three gates to be
armed, exactly 106 matrix rows and 29 skip-ink/pattern rows, and the unchanged
`0.3px` SVG-geometry tolerance.

The production path already had the right ownership. Capture obtains segment
coordinates from same-page `Range` rectangles and font metrics from same-page
canvas measurement; rendering consumes those serialized facts. No capture,
renderer, font-helper, baseline, or visual-tolerance code changed. Subtracting
one on Linux, importing raw helper design-unit metrics, or relaxing the
envelope would each corrupt valid DPR-1 results and already-exact overlines.

`tests/decoration-coordinate-ownership.e2e.test.ts` exercises focused DPR-1
and DPR-4 lanes. In each lane it requires captured fragment top and ascent to
equal the live page and grades emitted SVG against the rule at `0.3px`.
`tests/decoration-oracle.test.ts` rejects the historical cross-DPR plan and
proves that a one-pixel origin mutation still fails. The pinned Playwright
1.59.1 Noble Linux arm64 image now reports:

| Gate | Exact result |
| --- | ---: |
| Chrome paint vs source rule | 106 / 106 |
| Chrome paint vs SVG skip-ink/pattern segments | 29 / 29 |
| Source rule vs emitted SVG | 106 / 106 |
| Focused coherent-DPR browser rows | DPR 1 + DPR 4 |

The local arm64 container report records Chromium `147.0.7727.0`,
`platform=linux`, `architecture=arm64`, and DPR `4/4`. A fresh retained
`ubuntu-22.04-arm` workflow artifact is still required after integration; the
local result proves the corrected source/geometry contract but does not stand
in for that release-consumer run. Windows remains a separate platform row.

```sh
npx vitest run tests/decoration-oracle.test.ts \
  tests/linux-arm64-release-evidence.test.ts \
  tests/linux-arm64-release-parity-workflow.test.ts
npx vitest run --config vitest.e2e.config.ts \
  tests/decoration-coordinate-ownership.e2e.test.ts
npm run decorations:oracle -- --json tests/output/decoration.json
```
