# Domotion: `repeating-linear-gradient` (and `calc()` stop offsets)

Requirements for honoring CSS `repeating-linear-gradient(...)` (and `repeating-radial-gradient(...)`) plus simple `calc()` expressions in stop positions. Origin: DM-275 (follow-up from DM-273; doc 29 left repeating gradients explicitly out of scope).

## Why now

`06-forms-style-range.html` section 4 ("Tick-marks track") declares:

```css
.r-ticks::-webkit-slider-runnable-track {
  height: 6px; border-radius: 3px;
  background:
    repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), #94a3b8 calc(10% - 1px) 10%),
    #cbd5e1;
}
```

Chrome paints visible vertical tick stripes; the previous Domotion output painted a flat track because (a) `parseGradient` in `src/render/gradients.ts` rejected the `repeating-` prefix, and (b) the calc-based stop boundaries were unparseable. Both pieces are now in scope.

## Capture changes

The current capture no longer parses author declarations or probes the host.
`src/capture/pseudo-style-cdp.ts` reads `background-image` from Blink's final
ComputedStyle on the instantiated UA-shadow pseudo node. Chromium has therefore
already expanded `background`, selected the winning shorthand/longhand,
substituted variables, normalized colors, and discarded inactive cascade
branches. `calc()` expressions in stop positions are **preserved as text** by
Chrome — they aren't resolved against the gradient line length until layout,
which computed style doesn't expose. See
[doc 158](158-authoritative-control-pseudo-cascade.md).

## Render changes — `parseGradient`

- `parseLinearGradient` and `parseRadialGradient` accept the optional `repeating-` prefix and set `LinearGradient.repeating: true` / `RadialGradient.repeating: true` accordingly.
- `parseStopToken` recognizes `calc(...)` tokens as positions (regex `/^calc\(.*\)$/`) so they ride the position-walking heuristic at the end of the stop string.
- A new `parseCalcPosition` parses the limited Chrome-emitted form `calc(<pct>% ± <px>px)` (or just `<pct>%` / `<px>px`) into a `{pct, px}` pair stored on the stop as `calcOffset`.
- `gradientCacheKey` includes the repeating flag and a serialized form of `calcOffset` so equivalent rects dedup correctly.

The supported `calc` form is intentionally narrow — it covers the flat
length-percentage sums Chrome emits for `repeating-*-gradient` stops on stripe
boundaries (including exact absolute lengths). Context-dependent units have
already become px in Chromium's computed value. An expression outside this
computed-value grammar is rejected rather than silently auto-distributed.

## Render changes — `buildLinearGradientDef` / `buildRadialGradientDef`

When `gradient.repeating === true`:

- `resolveStops` skips its first/last default offsets (`0` and `1`) — the author-declared first/last stops define the tile period.
- `tileRepeatingStops` clones the resolved stop list, shifted by the period, until the list spans `[0, 1]`. Clipped boundary stops are filtered out (offsets outside `[0, 1] ± 1e-9`).
- `<linearGradient>` is then emitted with the tiled stop list. SVG's `spreadMethod="repeat"` only repeats *outside* the declared 0..1 range, which `userSpaceOnUse` clips to the gradient line endpoints, so up-front tile expansion is the most portable approach.

`resolveStops` also resolves `calcOffset` to a fraction at the same point it resolves `pxOffset`: `offset = pct/100 + px/L` where `L` is the gradient line length.

## Render changes — `renderRange` background layering

When both a gradient image and a non-transparent track background color are captured, `renderRange` paints the color rect first and overlays the gradient. Without this, repeating gradients with `transparent` stops show through to `TRACK_BG` (gray) instead of the author's solid color.

## Edge cases / out of scope

- `repeating-conic-gradient` — handled: `parseGradient` routes conic (`parseConicGradient`, `gradients.ts` ~lines 369–407 parse the `repeating-` prefix), which the conic raster pre-pass renders to a PNG `<pattern>`.
- `calc()` involving more than one percentage or one pixel term (e.g. `calc(50% + 10% + 5px)`) — `parseCalcPosition` sums all `%` and `px` terms regardless of count, so this works incidentally; mixed-unit terms (`em`, `vh`, etc.) are not supported.
- Gradient line length for radial repeating gradients uses the **computed** `rx`
  (the x-axis intersection of the ending shape), including non-square boxes and
  off-center focal positions. Px and percentage stops are normalized only after
  that radius is known.
- Background radial gradients encode one CSS period as SVG `fr`→`r`, normalize
  that period's stops to 0→1, and use `spreadMethod="repeat"`. This is the radial
  equivalent of shortening a repeating linear gradient's vector; leaving a
  20px period inside a full 200px radius makes SVG pad the last color across the
  remaining 90%. Coincident or sub-serialization-precision periods collapse to
  the final solid color.

## Tests

`src/render/gradients.test.ts` covers parse + emit:

- `parseLinearGradient` recognizes the `repeating-` prefix.
- `parseGradient` populates `calcOffset` for `calc(N% ± Mpx)` stop positions.
- `buildLinearGradientDef` tiles a 10%-period gradient into 40+ stops over a 100px gradient line.

The `06-forms-style-range` html-test fixture is the visual regression: its section 4 tick-marks are now painted (previously a flat gray track).
