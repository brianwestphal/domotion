# 29 — Dark-mode rendering

## Context

Domotion's SVG output today renders every captured page in its **light** variant. Both `captureElementTree` and the renderer assume a light color scheme: form-control stock visuals (`src/form-controls.ts`) hardcode light borders / fills, the body-bg fallback in `tests/real-world.tsx` is `#ffffff`, and there's no signal in the emitted SVG that the captured page intended a particular scheme.

The capture-time `colorScheme` option (`src/capture.ts:23`) already plumbs through to Playwright's context — Chromium's `getComputedStyle()` correctly evaluates `@media (prefers-color-scheme: dark)` rules and serializes the resolved colors. So the **CSS resolution side is already correct**: when `colorScheme: 'dark'` is set, every author-styled element resolves its dark-variant colors and Domotion emits them faithfully.

The gaps are in the **defaults**: stock form controls, transparent-root bg, and the absence of a `color-scheme` declaration on the emitted SVG so consumers know which scheme they got.

The real-world test suite (DM-454) currently forces `colorScheme: 'light'` on every Playwright context as a workaround, since otherwise modern marketing sites (apple, framer, stripe, nytimes) paint dark in Chrome and the SVG repaints them with light defaults — producing a near-100% sig-pixel diff that swamps every other fidelity signal. Once the gaps below are filled, that workaround can be lifted.

## Decisions (per DM-455 feedback)

- **Q1 — Capture-side scheme propagation**: caller-chooses (Option B). `captureElementTree` keeps the existing `colorScheme: 'light' | 'dark' | 'no-preference'` option; output SVG carries a matching `color-scheme=` attr (or wrapper `<style>:root { color-scheme: dark }</style>`). No double-capture / no `@media`-scoped style block.
- **Q2 — Form-controls dark palette**: Option A — empirically calibrate against Chromium's painted dark stock controls on macOS, mirroring the methodology used for the font-fallback chains. Hardcode the resulting RGB values into `src/form-controls.ts` as a parallel dark palette.
- **Q3 — Transparent-root fallback**: Option C — capture-side, query `getComputedStyle(document.documentElement).backgroundColor` and trust Chromium's resolved value rather than hardcoding our own dark palette.

## API surface

`CaptureOptions.colorScheme` is unchanged. The output SVG declares its scheme via the `color-scheme` presentation attribute on the root `<svg>`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" color-scheme="dark">
  <!-- ... -->
</svg>
```

When `colorScheme: 'light'` (default) the attribute is omitted, preserving today's output verbatim — the dark-mode codepath is purely additive and zero-effect at default settings.

When `colorScheme: 'no-preference'` the attribute is also omitted; consumers can decide. The captured tree's serialized colors reflect whatever `getComputedStyle()` resolved under "no preference" (typically equivalent to light for most sites).

## Capture-side changes

### Color-scheme propagation

`captureElementTree` already runs Playwright's `colorScheme` plumbing. Add to the captured tree's root `styles` payload:

```ts
interface RootStyles {
  // existing fields…
  /** Effective color-scheme as resolved by Chromium. */
  rootColorScheme?: "light" | "dark";
  /**
   * `getComputedStyle(document.documentElement).backgroundColor` —
   * trustworthy even when the author hasn't set one (Chromium fills in the
   * UA default per scheme: `#fff` for light, `#1c1c1c` on macOS dark, etc.).
   */
  rootBgComputed?: string;
}
```

Both fields are read inside the CAPTURE_SCRIPT (so the resolution happens in-page where `matchMedia('(prefers-color-scheme: dark)').matches` and `getComputedStyle()` are correct) and serialized onto the captured tree.

### Transparent-root fallback

`tests/real-world.tsx`'s `'#ffffff'` fallback is replaced by reading the captured tree's `rootBgComputed`. The renderer's transparent-root handling (the `<rect width=… height=… fill="#ffffff"/>` emitted at the SVG root) honors the same field. When `rootBgComputed` is missing — older captures, or captures from before this change — fall back to `#ffffff` for `light` and `#1c1c1c` for `dark`.

The captured value is **whatever Chromium resolved**, including:

- Author-set bg (`html { background: #0e0e10 }`): resolves to that.
- Transparent (the common case): resolves to the UA default for the scheme.
- `currentColor` / `inherit` / `var()`: resolves through the cascade.

Per user direction: trust Chromium, don't second-guess.

## Renderer changes

### Form-controls dark palette

`src/form-controls.ts` exposes named constants for stock visual colors. Today there is one set of constants matching Chromium's macOS light palette. Add a parallel dark palette:

```ts
const STOCK_LIGHT = {
  checkboxBorder: "#767676",
  checkboxBg: "#fff",
  checkboxCheckmark: "#fff", // overlaid on the accent-color bg
  radioBorder: "#767676",
  radioBg: "#fff",
  rangeTrackBg: "#dfdfdf",
  rangeThumbBg: "#fff",
  rangeThumbBorder: "rgba(0,0,0,0.4)",
  // …
};

const STOCK_DARK = {
  checkboxBorder: "<probe-result>",
  checkboxBg: "<probe-result>",
  // …
};

function stockPalette(scheme: "light" | "dark"): typeof STOCK_LIGHT {
  return scheme === "dark" ? STOCK_DARK : STOCK_LIGHT;
}
```

The dark palette values come from the **same probe methodology used for font-fallback chains**: take a per-control fixture (an unstyled `<input type=checkbox>`, `<input type=radio>`, `<input type=range>`, `<progress>`, `<meter>`), capture it under `prefers-color-scheme: dark` in headless Chromium on macOS, sample the painted RGB at well-known positions (border ring, fill background, thumb center), and hardcode the resulting values.

Per the project's cross-platform note: today the calibration is macOS-only. Linux (Chromium-on-fontconfig with its own dark UA palette) and Windows (DirectWrite + Fluent dark palette) are tracked under DM-258+ alongside the font-chain calibration. macOS-only literals in `STOCK_DARK` are debt to flag, not design.

### Color-scheme attr on emitted SVG

`elementTreeToSvg` reads `tree.styles.rootColorScheme` and, when it's `'dark'`, adds `color-scheme="dark"` to the root `<svg>`. The attribute is part of the SVG 2 / CSS Color Adjust spec and is honored by browsers; static-image viewers ignore it harmlessly. No effect on the rasterized appearance — it's metadata that lets a consumer SVG composer apply context-aware styling on top of Domotion's output.

### Form-controls dispatch

Each form-control synthesizer (`renderRange`, `renderCheckbox`, `renderRadio`, `renderProgress`, `renderMeter`, `renderColorSwatch`, etc.) gets the captured `rootColorScheme` threaded through (or reads it from a per-render context object). When the **author hasn't styled the control** (the no-author-CSS path that draws stock visuals), the synthesizer pulls colors from `stockPalette(rootColorScheme)`. When the author **has** styled it, the existing path is unchanged — author colors round-trip identically.

## Test-suite changes

### Lift the `colorScheme: 'light'` force

`tests/real-world.tsx` currently forces `colorScheme: 'light'` on every Playwright context. After this work lands, drop the force and let Playwright's default apply (or test both schemes in parallel suites). The success criterion from the original DM-455 ticket: real-world diff under default (no-force) capture should be dominated by typography drift, not bg-color inversion — i.e., the per-tile sig-pixel rate drops back into the same ballpark as today's light-only run.

### New fixture: dark-mode form controls

Add a dark-mode counterpart to the existing form-control suite — a single page with unstyled `<input type=checkbox>`, `<input type=radio>`, `<input type=range>`, `<progress>`, `<meter>`, `<input type=color>`, captured at `prefers-color-scheme: dark`. Diff against Chromium's painted dark stock visuals. This is the calibration acceptance test for the dark palette: if the diff is >2% on stock-control colors, the palette table is wrong.

## Edge cases

- **Mixed-scheme single document** (an author painting parts of a page in `color-scheme: light` and others in `color-scheme: dark` via inline declarations): not supported in v1. The captured tree carries one root `rootColorScheme`. Author-styled per-element overrides via inline `color` / `background` round-trip correctly through the existing computed-style serialization, but stock controls always pick from the root scheme.
- **`color-scheme: light dark`** (CSS lets a page declare it accepts both): we read whichever Chromium actually painted under the requested `prefers-color-scheme`. The output SVG's `color-scheme` attr matches that resolved scheme, not the original `light dark` declaration.
- **Captures from before this change** (no `rootColorScheme` in the tree): renderer treats them as light, identical to today's behavior. No migration required.
- **`<input type=color>` swatch in dark mode**: the swatch surface remains the author-color (the `value` attribute). Only the surrounding chrome (border, focus ring) flips dark.
- **Native scrollbars** (already filed under SK-468 and unrelated to this work): would need their own dark palette when scrollbar emulation lands. Out of scope here.
- **`accent-color` CSS interaction**: when an author sets `accent-color: …` on a control, that color drives the checked-state fill in both schemes. The dark palette only governs the *background* / border / focus ring of the chrome around an unstyled control.
- **Color emoji + dark mode**: emoji bitmap rendering is unchanged — emoji are full-color glyphs that don't recolor based on scheme.

## Implementation slices

This doc fans out into the following sub-tickets:

1. **DM-455a — Capture-side propagation**: add `rootColorScheme` + `rootBgComputed` to the CAPTURE_SCRIPT, surface them on the captured tree, and emit `color-scheme="dark"` on the root `<svg>` from `elementTreeToSvg`.
2. **DM-455b — Form-controls dark palette**: empirical probe of Chromium's painted dark stock controls on macOS, hardcode the values into a `STOCK_DARK` table in `src/form-controls.ts`, dispatch via `stockPalette(scheme)`. New dark-mode form-control fixture for calibration.
3. **DM-455c — Transparent-root fallback**: renderer's transparent-root path consumes `rootBgComputed`; `tests/real-world.tsx` body-bg fallback consumes `rootBgComputed`. Hardcoded `#ffffff` only fires when the field is missing.
4. **DM-455d — Real-world suite re-evaluation**: drop the `colorScheme: 'light'` force in `tests/real-world.tsx`, re-run the suite, and verify the diff is dominated by typography drift, not bg-color inversion.

## Acceptance criteria

- A new fixture rendering an unstyled `<input type=checkbox>` / `<input type=range>` / `<progress>` page captured at `colorScheme: 'dark'` produces a diff <2% avg against Chromium's painted output.
- A real-world capture (apple / nytimes / stripe / framer) at `colorScheme: 'dark'` produces a body-bg matching Chromium's painted root, not white.
- `tests/real-world.tsx` no longer needs `colorScheme: 'light'` to keep diffs in a comparable range — sig-pixel rate at default-scheme is within ±1pp of the forced-light rate per fixture.
- Captures with default `colorScheme` (i.e. light) produce output byte-identical to today's, modulo the absence of a `color-scheme` attr (which is a no-op for static viewers).
- All previously passing html-test, features, and showcase tests stay passing.

## Status

- Requirements doc landed (this file).
- Slice 1 (DM-552 — capture-side propagation) landed. CAPTURE_SCRIPT stamps `rootColorScheme` and `rootBgComputed` on the captured tree's root element. Renderer's `wrapSvg` accepts `{ tree }` and emits `color-scheme="dark"` when applicable. New `rootSvgColorSchemeAttr(elements)` exported helper for the call sites that build their own root `<svg>` (`tests/runner.tsx`, `tests/real-world.tsx`, `src/animator.ts`). 9 unit tests in `src/dark-mode-capture.test.ts`. **No dependents wired in this slice** — `tests/real-world.tsx` still uses the hardcoded `#ffffff` body-bg fallback (DM-554 will swap that to `rootBgComputed`); `tests/runner.tsx`/animator.ts still emit no color-scheme attr (will pass `{ tree }` to `wrapSvg` once dependents land). Today's SVG output is byte-identical at default light scheme.
- Slices 2–4 (DM-553, DM-554, DM-555) pending.
