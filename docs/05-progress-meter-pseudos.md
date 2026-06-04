# Domotion: progress / meter pseudo styling

Requirements for fully honoring author CSS on `<progress>` and `<meter>` shadow-DOM pseudos in Domotion. Origin: SK-1126 (follow-up from SK-1092). Today the capture layer pulls the `backgroundColor` for `::-webkit-progress-bar`, `::-webkit-progress-value`, `::-webkit-meter-bar`, and the meter optimal/suboptimal/even-less-good value pseudos. That covers solid-color recolors but misses the rest of the box model: borders, padding, custom heights, gradient backgrounds, box-shadows, border-radius applied to the inner value bar (not just the outer track).

## Why now

`06-forms-style-progress-meter.html` author CSS sets:

- `::-webkit-progress-bar { background: #e2e8f0; border-radius: 8px; height: 12px }`
- `::-webkit-progress-value { background: linear-gradient(...); border-radius: 8px }`
- meter pseudos with similar customizations.

Our output keeps the default heights, ignores the gradients, and skips the radii — leaving the styled bars mostly UA-default. The diff is concentrated in those bars.

## Goals

- Capture the full pseudo box model for each WebKit progress/meter pseudo (not just background-color).
- Apply captured borders, padding, radii, gradients, heights, and box-shadows in `src/render/form-controls.ts`.
- Backwards-compatible: if a pseudo style equals the UA default, fall through to current rendering (so unstyled progress/meter elements look unchanged).

> **Update (SK-1193 / SK-1222):** `getComputedStyle(el, '::-webkit-progress-bar')` and the other meter/progress pseudo getters return the **host element's computed style** in Chromium, not the pseudo's cascaded value. The same quirk SK-1138 worked around for `::-webkit-slider-thumb` was confirmed by probe to apply to `::-webkit-progress-bar`, `::-webkit-progress-value`, `::-webkit-meter-bar`, and the meter value pseudos. The original scalar capture was silently broken — author rules were ignored and the host's transparent background was recorded instead.
>
> **Fixed in SK-1222** by migrating progress/meter capture to the same `document.styleSheets` walker that slider track/thumb use (formerly `_collectRangeRules` / `_resolveRangePseudo`, now generalized as `_collectPseudoRules` / `_resolvePseudo` with a `_kindMap` that registers all six progress/meter pseudo names alongside the slider ones). The walker shares the SK-1191 var/calc resolver and the SK-1192 state-rule support, so progress/meter pseudos pick up those features for free. Gradient backgrounds round-trip via the SK-1224 / SK-1225 / SK-1226 pipeline — `progressBarBgImage`, `progressValueBgImage`, `meterBarBgImage`, and the meter value bgImages all flow through the renderer's `gradientFillFor` helper to emit `<linearGradient>` / `<radialGradient>` defs with `fill="url(#...)"`.

## Capture changes

Replace the existing scalar fields with full pseudo-style records on `CapturedElement`:

```ts
progressBar: {
  bg: string;
  bgImage: string;
  borderRadius: string;
  border: string;
  padding: string;
  height: string;
  boxShadow: string;
} | undefined;
progressValue: { same shape };
meterBar: { same shape };
meterOptimum: { same shape };
meterSuboptimum: { same shape };
meterEvenLessGood: { same shape };
```

The capture is `getComputedStyle(el, pseudo).<each-prop>`. Only emit the field when `el.tag === 'progress'` (for progress bars) or `el.tag === 'meter'` (for meter bars), and only when at least one prop differs from the UA default. The existing `progressBarBg` etc. become deprecated aliases that read from the new records for one release cycle.

## Render changes

In `src/render/form-controls.ts`:

1. `renderProgress(el)` currently emits a track rect with hardcoded radius and a fill rect for the value. Change to read `el.progressBar.borderRadius`, `el.progressBar.height`, `el.progressBar.boxShadow` for the track, and `el.progressValue.{bg,bgImage,borderRadius}` for the fill.
2. `renderMeter(el)` mirrors the same with the optimum/suboptimum/even-less-good selection logic (already exists for the bg color, just needs the rest of the props).
3. Gradient backgrounds (`bgImage`) feed into the existing `buildBackgroundLayerDef` helper used for ordinary element backgrounds.
4. Box-shadow applies through the SK-1113 `parseBoxShadow` + filter pipeline.

## Edge cases

- `<progress>` without a value attribute is indeterminate — Chrome paints a moving stripe. We can't animate; render the track empty and warn (existing behavior).
- `appearance: none` on the host strips ALL UA chrome — at that point the author is responsible for their own styling, but we should still honor the pseudos when they do that.
- Padding on the bar pseudo affects where the value pseudo paints inside; mirror Chrome's content-box clipping.

## Follow-ups to file

- Implementation ticket: "SK-???: extend progress/meter pseudo capture and apply".
- A more general "WebKit pseudo capture utility" — the same pattern (capture full style block, compare against UA defaults, apply) repeats for input pseudos (SK-1125) and could be factored once both are implemented.

## Acceptance criteria

`06-forms-style-progress-meter.html` diff drops below 1.5% avg. Author-styled progress bars with gradient fills, custom heights, and rounded corners render correctly. UA-default progress/meter bars elsewhere don't regress.
