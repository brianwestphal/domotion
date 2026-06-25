# Domotion: gradient fills via SVG `<linearGradient>`

Requirements for honoring CSS gradient backgrounds on form-control pseudos in Domotion. Origin: SK-1190 (follow-up from SK-1138).

Today the stylesheet-walker capture for `::-webkit-slider-runnable-track` (and the planned walkers for `::-webkit-slider-thumb`, `::-webkit-progress-value`, `::-webkit-meter-*`, etc.) reduces a `background: linear-gradient(…)` declaration to its first literal color stop via a regex (`_firstColorRe` in `src/capture/script/` CAPTURE_SCRIPT). The renderer then paints a flat fill of that single color, which loses the entire gradient effect.

## Why now

`06-forms-style-range.html` `.r-custom` slider sets:

```css
.r-custom::-webkit-slider-runnable-track {
  height: 8px; border-radius: 4px;
  background: linear-gradient(90deg, #4f46e5, #ec4899);
}
```

Our output paints a flat `#4f46e5` (or no fill if the regex misses) instead of the indigo→pink gradient. The diff is concentrated in the track band. The same issue applies to any gradient-backed `<progress>`, `<meter>`, or styled checkbox/radio that authors paint with `linear-gradient`.

## Goals

- Capture the full `background-image` value (including gradient text) for each pseudo handled by the stylesheet walker.
- For `linear-gradient(...)` backgrounds, emit an SVG `<linearGradient>` def per gradient occurrence and apply it to the painted rect via `fill="url(#${idPrefix}gradN)"`.
- Round-trip color stops with explicit positions, color-mix / oklch / lab colors (via the existing `normColor` probe), and `currentColor` references.
- `radial-gradient(...)`, `conic-gradient(...)`, and the `repeating-*` variants are now all handled too (radial → `<radialGradient>`, conic → rasterized PNG `<pattern>`, repeating → tiled stops); see the Edge-cases / Status sections below.
- Generalize the gradient-emission helper so the same plumbing works for slider track + thumb (SK-1138, SK-1192, SK-1191), progress / meter (SK-1222, doc 27), and the future input pseudos `::-webkit-color-swatch` etc. (SK-1223, doc 26).

## Capture changes

The capture layer needs the **declared gradient text**, not a reduced color, so the renderer can parse and emit it:

1. In `_resolveRangePseudo` (and the future `_resolveProgressMeterPseudo`, `_resolveInputPseudo`), add a new field alongside `backgroundColor`:

   ```js
   { matched, width, height, borderRadius, backgroundColor, backgroundImage }
   ```

   `backgroundImage` holds either the longhand (`d.backgroundImage`) when it isn't `'none'` / `''`, OR the gradient portion of the `background` shorthand when the longhand wasn't expanded (which is the typical case in Chromium for `background: linear-gradient(...)`).

2. Detection: if the candidate text starts with `linear-gradient(`, `radial-gradient(`, `conic-gradient(`, or one of their `repeating-` variants (after any leading whitespace), record it as a gradient. Otherwise record the literal `<color>` and use it as a flat fill (the existing `_firstColorRe` path stays for shorthands that combine a color and a gradient layer, e.g. `background: red linear-gradient(...)`).

3. Resolve `var()` and `calc()` inside the gradient via the same host-probe trick used by `_resolveOne` (SK-1191). Set the gradient text on `host.style.backgroundImage`, read `getComputedStyle(host).backgroundImage` back. Chromium computes color stops to `rgb(…)` / `rgba(…)` form and resolves variables in the angle / position arguments. Restore the host's inline value after the read.

4. New `CapturedElement.styles` fields:

   - `rangeTrackBgImage?: string` — resolved gradient text or `none`.
   - `rangeThumbBgImage?: string` — same for the thumb.
   - (Existing `progressBarBgImage`, `progressValueBgImage`, `meterBarBgImage`, etc. are reused once SK-1222 migrates progress/meter capture to the stylesheet walker — keep the same field names so the renderer change is shared.)

## Render changes

> **Two gradient modules.** There are two parser/emitter modules with distinct callers: `src/render/gradients.ts` builds gradient defs for **form-control pseudos** (`parseGradient` + `buildLinearGradientDef` / `buildRadialGradientDef` + `gradientCacheKey`, consumed by `form-controls.ts`), while `src/render/gradient-defs.ts` builds the element-background (and mask) gradient defs (`buildLinearGradientDef(id, args, …)` / `buildRadialGradientDef`, consumed by the background renderer and `mask.ts`). They share the `userSpaceOnUse` convention but are not the same code.

The renderer parses the gradient text and emits SVG. The work fans out into three pieces:

### 1. Parser

Add a `parseLinearGradient(text)` helper to `src/render/form-controls.ts` (or a new `gradients.ts`) that returns:

```ts
type LinearGradient = {
  kind: "linear";
  /** Angle in degrees, 0deg = bottom→top in CSS, 0deg = top→bottom in SVG userSpaceOnUse. */
  angleDeg: number;
  stops: Array<{ color: string; offset: number /* 0..1 */ }>;
};
```

Handle:

- Direction syntax: `to top`, `to right`, `to bottom right`, `45deg`, `0.25turn`, `100grad`, `1.57rad`. Normalize to degrees, then to the SVG convention (CSS 0deg = upward = SVG `(x1=0,y1=1) → (x2=0,y2=0)`).
- Color stops: `<color>`, `<color> <pct>`, `<color> <px>`. Px-positioned stops get normalized to a fraction of the painted rect's longest gradient axis (a downstream concern — pass through px and let the emit step resolve, since we know the final rect dimensions there).
- Stops without explicit positions are auto-distributed (CSS rule: missing position = midpoint between neighbors with positions).
- Hard color stops (`linear-gradient(red 50%, blue 50%)`) emit two SVG stops at the same offset.
- Angles outside [0, 360) are normalized via mod 360; negative angles add 360.

### 2. Emit `<defs>`

Each unique gradient gets a `<linearGradient id="${idPrefix}gradN" gradientUnits="userSpaceOnUse" x1=… y1=… x2=… y2=…>` with one `<stop offset=… stop-color=… stop-opacity=… />` per parsed stop. IDs are minted by the render context's `nextGradId()` (`() => \`${idPrefix}grad${gradIdx++}\``); the per-render `idPrefix` keeps gradient IDs from different frames/scenes from colliding.

`gradientUnits="userSpaceOnUse"` is preferred over the default `objectBoundingBox` because the painted shape might not be the bounding box of the rect (e.g. when the rect has a border-radius and we're painting via a clipPath). Setting absolute coords keeps the math straightforward.

The defs accumulate in a per-render `gradientDefs` array; the SVG composer emits `<defs>...</defs>` once at the top alongside the existing glyph defs.

### 3. Apply via `fill="url(#${idPrefix}gradN)"`

A single `gradientFillFor(bgImage, rect, ctx)` helper in `form-controls.ts` does
parse + emit + apply for every form-control pseudo. It returns a `url(#…)` fill
string (or `null` to fall back to the flat color):

```ts
const trackGrad = gradientFillFor(el.styles.rangeTrackBgImage, trackRect, defCtx);
const trackFill = trackGrad ?? trackBg;
parts.push(`<rect ... fill="${trackFill}" .../>`);
```

Deduplication is inline, not via a separate `ensureGradientDef` function:
`gradientFillFor` computes `gradientCacheKey(grad, rect)` (a string over the
parsed gradient + its mapped rect) and looks it up in the render context's
`gradientCache` map. On a hit it reuses the existing ID; on a miss it mints a new
ID via `nextGradId()`, builds the def (`buildLinearGradientDef` /
`buildRadialGradientDef`), pushes it onto `defsParts`, and records the ID under
the cache key. Two sliders sharing the same `linear-gradient(90deg, #4f46e5,
#ec4899)` over the same rect therefore share one `<linearGradient>` def. (Conic
layers take a separate branch — they rasterize to a PNG `<pattern>` via
`buildConicTile`.)

The same `gradientFillFor` helper handles the thumb fill (`renderRange` thumb
path) and the progress-value / meter-value fills (SK-1222).

## Edge cases

- **Radial gradients (SK-1225)**: shipped via `<radialGradient>`. Supports `circle`/`ellipse` shapes, the four extent keywords (`closest-side` / `closest-corner` / `farthest-side` / `farthest-corner`), explicit length sizing, and the `at <position>` clause (single keyword, two-token keyword/length pairs, percent positions). Ellipses use `gradientTransform="translate(cx, cy) scale(1, ry/rx) translate(-cx, -cy)"` to bend the natively-circular SVG radial into the desired aspect. For the corner keywords the ellipse keeps the matching side's aspect ratio and is scaled to pass through the corner — exactly `√2 ×` the side radii (DM-1243; verified against Chrome's painted ring).
- **Color hints (DM-1242)**: the bare `<percentage>` between two color stops (e.g. `linear-gradient(red, 20%, blue)`) shifts the 50% transition to that position via a power curve (`weight(t) = t^(ln0.5/lnH)`). SVG only interpolates linearly between stops, so `parseGradientStops` samples that curve at uniform mix-weight and emits a stop at each sample — clustering stops where the curve is steep and landing one exactly on the hint. Matches Chrome's paint within ~Δ4/channel (vs. the old single-mid-stop, which read too linear).
- **Conic gradients**: shipped. `parseGradient()` routes `parseConicGradient` (`gradients.ts`), and because SVG has no native conic, `form-controls.ts` rasterizes each conic layer to a PNG `<pattern>` (`buildConicGradientDef`, fed by the async raster pre-pass) that the form-control pseudo paints as its background.
- **Multi-layer backgrounds** (`background: red, linear-gradient(...)` or two gradients stacked): paint only the topmost layer. CSS `background` lists paint top-to-bottom in source order; we honor the first item that is a renderable gradient. Emit a warning if a layer is dropped.
- **`background-attachment`, `background-position`, `background-size` on a gradient**: ignore — their effect on a small fixed-size pseudo box is usually nil, and modeling them in SVG is non-trivial.
- **`currentColor` in stops**: resolve via the host's computed `color`, captured during the host-probe.
- **Border-radius interaction**: the gradient rect should be clipped to the rounded shape. The existing `<rect rx ry>` carries the radius; SVG's gradient `fill` paints inside the rounded rect natively.
- **Animation across frames**: if a scene has two frames where the gradient differs (different stops via :hover, etc.), each frame's rect references its own gradient ID and the cross-fade swap pipeline (already shared with everything else) handles the transition. No special gradient-animation work needed.

## Generalization roadmap

The gradient pipeline lands in three slices, each tracked as a separate ticket:

1. **Slider track + thumb (SK-1224, this doc)**: parse + emit + apply for `rangeTrackBgImage` and `rangeThumbBgImage`. Covers `06-forms-style-range.html` `.r-custom` and friends. Linear (SK-1224) + px-positioned stops (SK-1226) + radial (SK-1225) shipped together.
2. **Progress / meter (SK-1222 follow-up)**: once progress / meter capture migrates to the stylesheet walker (per the SK-1193 broader-quirk finding), reuse the same parse + emit + apply helpers for `progressBarBgImage`, `progressValueBgImage`, `meterBarBgImage`, `meterOptimumBgImage`, etc.
3. **Color-swatch / inner-spin / search-cancel (SK-1223 follow-up)**: when those input pseudos land via the stylesheet walker, they pick up gradient support for free.

## Acceptance criteria

- `06-forms-style-range.html` `.r-custom` track renders the indigo→pink linear gradient (90deg) instead of a flat fill. Diff for that file drops below 1.5% avg.
- Per-tile fail bands (currently dominated by the wrong-color track stripe) drop below the suite-level pass thresholds.
- A slider with `linear-gradient(45deg, red 0%, yellow 50%, blue 100%)` renders three correctly positioned stops at the right diagonal angle.
- Two sliders sharing the same gradient text deduplicate to one `<linearGradient>` def.
- A slider with `radial-gradient(...)` falls back to the first color stop and emits a `warn()` with the host's selector.
- All previously passing html-test, features, and showcase tests stay passing.

## Status

- **SK-1224 — Linear-gradient track + thumb**: shipped. parseLinearGradient + buildLinearGradientDef + DefCtx integration in form-controls.ts. 06-forms-style-range diff dropped from 1.85% to 1.54% avg.
- **SK-1226 — Px-positioned color stops**: shipped. parser captures pxOffset; resolveStops converts to fractions at emit time using the rect's gradient line length. Em / pt / pc / in / cm / mm coerce to px via approximate conversions.
- **SK-1225 — Radial gradient support**: shipped. parseRadialGradient + buildRadialGradientDef.
- **Conic gradient support**: shipped. parseConicGradient + buildConicGradientDef rasterize each conic layer into a PNG `<pattern>` (SVG has no native conic) via the async raster pre-pass.
- **SK-1222 / SK-1223 hand-off**: progress / meter / color-swatch / inner-spin / search-cancel pickups happen automatically once those pseudos move to the stylesheet walker — gradientFillFor and DefCtx are already factored.
