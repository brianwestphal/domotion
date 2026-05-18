# 19 — Frosted-glass background fallback (`backdrop-filter` synthesis)

## Context

Modern marketing sites (Stripe, Apple, Resend) use a "frosted glass" pattern for fixed/sticky navigation:

```css
nav {
  position: fixed;
  background-color: rgba(255, 255, 255, 0);  /* or some near-transparent value */
  backdrop-filter: saturate(180%) blur(20px);
}
```

Visually the nav appears opaque-white because Chromium's `backdrop-filter` blurs whatever sits behind the nav and saturates it. SVG has no `backdrop-filter` equivalent, so domotion's CAPTURE_SCRIPT emits a warning (`backdrop-filter: captured but not emitted — no SVG equivalent`) and the renderer paints only the literal `rgba(*, 0)` background — i.e. nothing. Result: the nav goes invisible and any content sitting behind it (a hero gradient blob, etc.) shows through.

Observed regressions:

- DM-463 (Stripe mobile scroll) — gradient blob shows at the top of the page where the white nav should be.
- DM-465 (Apple Mother's Day) — globalnav and country-switcher banner have no opaque background; the banner text reads against a colored photographic backdrop.
- DM-466 (Resend desktop scroll) — top header is barely visible against the dark page.

## Requirement

When an element has both:

1. `backdrop-filter` non-trivial (`!== 'none' && !== ''`), AND
2. An effectively-transparent `background-color` (alpha ≤ 0.1),

domotion should paint a **synthesized solid background** in place of the missing frosted-glass effect. The synthesized fill is a coarse approximation of what the filter would have produced — good enough that the nav covers what's behind it, not pixel-perfect to Chromium's actual blur.

## Source of the fallback color

Three options were considered:

1. **Hard-code `rgb(255, 255, 255)`** — simplest, breaks on dark-themed pages.
2. **Use the captured page body's `backgroundColor`** — already known at capture time as a sensible default.
3. **Sample the under-element pixels via canvas readback at capture time** — most accurate but requires html2canvas-style work.

We pick **option 2**: capture the document body's effective background color into `el.styles.frostedBgFallback` when the element triggers the frosted condition. Body color is the most likely "what's underneath" guess for fixed nav bars on real pages, and degrades gracefully (white on light pages, dark on dark pages).

If the body itself reports a transparent background (`rgba(0, 0, 0, 0)`), fall back to `rgb(255, 255, 255)` — matches the implicit white default browsers use.

## Wiring

1. **CAPTURE_SCRIPT** — in the per-element style capture path (`src/dom-to-svg.ts` around line 2037), after recording `backgroundColor` and `backdropFilter`, check the trigger conditions. When met, walk to `document.body` and read its `getComputedStyle(...).backgroundColor`, normalize via the existing `normColor()`, and store as `frostedBgFallback`. If body bg is also alpha-0, store `'rgb(255,255,255)'`.

2. **CapturedElement.styles** — add `frostedBgFallback?: string` to the `Styles` interface.

3. **Renderer** (`renderElement` in `elementTreeToSvg`) — after computing `bgColor`, if `bgColor` is null or alpha ≤ 0.1 AND `el.styles.frostedBgFallback` is set, paint an extra `<rect>` with the fallback fill at the element's box (respecting `border-radius`) before any background-image layers. Mirrors the existing `bgColor != null && bgColor.a > 0.01` block at line ~3333.

## What still doesn't work

- **Per-element backdrop blur** — the synthesized fill is solid. Chromium's actual paint blends and saturates the underlying pixels. For dark-on-light or light-on-dark contrasts the color mismatch is small; for navs over a saturated hero image the synthesized fill reads as a flat block where Chromium showed a tinted blur.
- **Multi-themed pages** — pages that swap body bg color mid-document (one section dark, the next light) get a single body-derived fallback. The previous best alternative (canvas readback under each frosted element) is parked behind option 3 above; revisit if real-world fidelity demands it.

## Test fixture

Added to `tests/features.ts`:

- `frosted-nav-fallback` — a fixed nav with `background-color: rgba(255,255,255,0); backdrop-filter: blur(20px)` over a body with a colored gradient. Asserts the SVG emits an opaque `<rect>` with `fill="rgb(...)"` matching the body bg, instead of the literal transparent fill.

The fixture only verifies the *fallback color is opaque* — not that the result is pixel-perfect to Chromium's blur, since that's the documented limit.
