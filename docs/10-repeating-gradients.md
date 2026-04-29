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

Chrome paints visible vertical tick stripes; the previous Domotion output painted a flat track because (a) `parseGradient` in `src/gradients.ts` rejected the `repeating-` prefix, and (b) the calc-based stop boundaries were unparseable. Both pieces are now in scope.

## Capture changes

`_resolvePseudo` in `src/dom-to-svg.ts` (`CAPTURE_SCRIPT`) extracts gradient layers from both `rule.style.backgroundImage` and the `rule.style.background` shorthand via a new helper `_extractGradients(text)`. The helper walks balanced parens and emits a comma-joined list of just the gradient calls — necessary because Chromium serializes the `backgroundImage` longhand for a shorthand like `background: <gradient>, #color` as `<gradient>, initial`, and assigning that directly to `host.style.backgroundImage` to resolve `var()` / `calc()` would be rejected (`initial` is not a valid layer value, so the whole assignment fails and the host's computed `backgroundImage` reads back as `none`).

After extraction, `_resolveOne(el, 'backgroundImage', gradientText)` round-trips through Chrome's CSS parser and returns the resolved gradient string (with `var()` substituted and color tokens normalized to `rgb()` form). `calc()` expressions in stop positions are **preserved as text** by Chrome — they aren't resolved against the gradient line length until layout, which `getComputedStyle` doesn't expose.

## Render changes — `parseGradient`

- `parseLinearGradient` and `parseRadialGradient` accept the optional `repeating-` prefix and set `LinearGradient.repeating: true` / `RadialGradient.repeating: true` accordingly.
- `parseStopToken` recognizes `calc(...)` tokens as positions (regex `/^calc\(.*\)$/`) so they ride the position-walking heuristic at the end of the stop string.
- A new `parseCalcPosition` parses the limited Chrome-emitted form `calc(<pct>% ± <px>px)` (or just `<pct>%` / `<px>px`) into a `{pct, px}` pair stored on the stop as `calcOffset`.
- `gradientCacheKey` includes the repeating flag and a serialized form of `calcOffset` so equivalent rects dedup correctly.

The supported `calc` form is intentionally narrow — it covers what Chrome emits for `repeating-*-gradient` stops on stripe boundaries (and on common explicit single-term stops like `calc(50% + 10px)`). More elaborate calc expressions fall through to the un-positioned fallback, where auto-distribution fills in.

## Render changes — `buildLinearGradientDef` / `buildRadialGradientDef`

When `gradient.repeating === true`:

- `resolveStops` skips its first/last default offsets (`0` and `1`) — the author-declared first/last stops define the tile period.
- `tileRepeatingStops` clones the resolved stop list, shifted by the period, until the list spans `[0, 1]`. Clipped boundary stops are filtered out (offsets outside `[0, 1] ± 1e-9`).
- `<linearGradient>` is then emitted with the tiled stop list. SVG's `spreadMethod="repeat"` only repeats *outside* the declared 0..1 range, which `userSpaceOnUse` clips to the gradient line endpoints, so up-front tile expansion is the most portable approach.

`resolveStops` also resolves `calcOffset` to a fraction at the same point it resolves `pxOffset`: `offset = pct/100 + px/L` where `L` is the gradient line length.

## Render changes — `renderRange` background layering

When both a gradient image and a non-transparent track background color are captured, `renderRange` paints the color rect first and overlays the gradient. Without this, repeating gradients with `transparent` stops show through to `TRACK_BG` (gray) instead of the author's solid color.

## Edge cases / out of scope

- `repeating-conic-gradient` — `parseGradient` doesn't yet route conic, repeating or not. File a ticket if a fixture surfaces it.
- `calc()` involving more than one percentage or one pixel term (e.g. `calc(50% + 10% + 5px)`) — `parseCalcPosition` sums all `%` and `px` terms regardless of count, so this works incidentally; mixed-unit terms (`em`, `vh`, etc.) are not supported.
- Gradient line length for radial repeating gradients uses `rx` (the x-axis radius) as the canonical ray, matching the non-repeating path.
- `spreadMethod="repeat"` on the SVG element is not used; tile expansion is preferred for predictable cross-renderer behavior.

## Tests

`src/gradients.test.ts` covers parse + emit:

- `parseLinearGradient` recognizes the `repeating-` prefix.
- `parseGradient` populates `calcOffset` for `calc(N% ± Mpx)` stop positions.
- `buildLinearGradientDef` tiles a 10%-period gradient into 40+ stops over a 100px gradient line.

The `06-forms-style-range` html-test fixture is the visual regression: its section 4 tick-marks are now painted (previously a flat gray track).
