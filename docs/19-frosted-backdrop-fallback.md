# 19 — Backdrop-filter raster fallback and diagnostics

> **Current contract (DM-2490).** DM-2171 preserves Chromium-composited
> backdrop-filter pixels through the isolation snapshot in
> [doc 126](126-backdrop-filter-isolation.md). An exact materialization emits
> no warning. The solid fill below is retained only when that snapshot cannot
> be acquired, and the Node post-pass reports the fallback it actually kept.

## Context

Modern marketing sites (Stripe, Apple, Resend) use a "frosted glass" pattern for fixed/sticky navigation:

```css
nav {
  position: fixed;
  background-color: rgba(255, 255, 255, 0);  /* or some near-transparent value */
  backdrop-filter: saturate(180%) blur(20px);
}
```

Visually the nav appears opaque-white because Chromium's `backdrop-filter`
blurs whatever sits behind the nav and saturates it. An SVG embedded through
`<img>` cannot sample the document pixels already painted behind one of its
groups. Domotion therefore crosses one Chromium-owned raster boundary instead
of reconstructing the filter against the wrong input surface.

Observed regressions:

- DM-463 (Stripe mobile scroll) — gradient blob shows at the top of the page where the white nav should be.
- DM-465 (Apple Mother's Day) — globalnav and country-switcher banner have no opaque background; the banner text reads against a colored photographic backdrop.
- DM-466 (Resend desktop scroll) — top header is barely visible against the dark page.

## Current requirement

The synchronous DOM walk records a viewport rect, a temporary live-DOM token,
and warning selector for each non-empty `backdrop-filter` owner. The Node pass
then uses Chromium `DOMSnapshot` paint order, reversibly hides target
descendants and later overlapping paint, and screenshots the filtered box.
That isolated Chromium image replaces only the box surface; text and
descendants remain vector above it.

The diagnostic follows the materialization result, not the computed property:

| Node outcome | Retained output | Warning |
| --- | --- | --- |
| Token maps, every hide owner resolves, screenshot succeeds | isolated Chromium crop | none |
| Token has no painted layout mapping | unisolated Chromium page crop | `status: "partial"`, planner miss |
| `DOMSnapshot` is unavailable | unisolated Chromium page crop | `status: "partial"`, snapshot unavailable |
| One or more planned hide owners cannot be resolved/mutated | partially isolated Chromium crop | `status: "partial"`, unresolved-owner count |
| Token is missing | vector box/background | `status: "unavailable"`, missing token |
| Screenshot fails | vector box/background | `status: "unavailable"`, screenshot failure |

Every partial/unavailable `backdrop-filter` warning names the retained output in
`detail`; its optional `status` field is machine-readable. A successful host or
generated-pseudo materialization is deliberately silent. The old unconditional
“frosted-glass approximation; no true blur” warning is retired.

## Historical vector fallback

When no raster can be retained and an element has both:

1. `backdrop-filter` non-trivial (`!== 'none' && !== ''`), AND
2. An effectively-transparent `background-color` (alpha ≤ 0.1),

Domotion paints a **synthesized solid background** in place of the missing
source-surface effect. The synthesized fill is only a terminal fallback; it is
not used after an exact or partial Chromium crop succeeds.

## Source of the fallback color

Three options were considered:

1. **Hard-code `rgb(255, 255, 255)`** — simplest, breaks on dark-themed pages.
2. **Use the captured page body's `backgroundColor`** — already known at capture time as a sensible default.
3. **Sample the under-element pixels via canvas readback at capture time** — most accurate but requires html2canvas-style work.

We pick **option 2**: capture the document body's effective background color into `el.styles.frostedBgFallback` when the element triggers the frosted condition. Body color is the most likely "what's underneath" guess for fixed nav bars on real pages, and degrades gracefully (white on light pages, dark on dark pages).

If the body itself reports a transparent background (`rgba(0, 0, 0, 0)`), fall back to `rgb(255, 255, 255)` — matches the implicit white default browsers use.

## Fallback wiring

1. **Capture walk** — after recording `backgroundColor` and
   `backdropFilter`, the background walker stores `frostedBgFallback` for the
   transparent case. Separately, the element record carries
   `backdropFilterRaster` intent plus its live token and selector. The walk does
   not issue a fidelity warning because it cannot know the Node outcome.

2. **CapturedElement.styles** — add `frostedBgFallback?: string` to the `Styles` interface.

3. **Renderer** (`renderElement` in `elementTreeToSvg`) — after computing `bgColor`, the real background-color is painted whenever `bgColor.a > 0.01` (`paintBackgroundColor`, `src/render/element-tree-to-svg.ts`); only in the `else` (null or alpha ≤ 0.01) AND with `el.styles.frostedBgFallback` set does the renderer paint the fallback `<rect>` (respecting `border-radius`) before any background-image layers. Note the two thresholds differ by design: capture *stores* `frostedBgFallback` at alpha ≤ 0.1 (`src/capture/script/walker/borders-backgrounds.ts`), but the renderer only *substitutes* it below 0.01 — so a background-color with 0.01 < alpha ≤ 0.1 keeps its (barely-there) real translucent color rather than the fallback.

## Remaining limits

- **Unavailable raster fallback** — if the screenshot itself fails, the
  synthesized fill is solid. Chromium's actual paint blends and saturates the
  underlying pixels, so this fallback is intentionally reported.
- **Multi-themed pages** — pages that swap body bg color mid-document (one section dark, the next light) get a single body-derived fallback. The previous best alternative (canvas readback under each frosted element) is parked behind option 3 above; revisit if real-world fidelity demands it.
- **Backdrop Root transitions** — ancestor opacity/filter/mask/blend/transform
  ownership and generated-pseudo source ownership are tracked by
  [doc 187](187-backdrop-source-surface-transitions.md) and its follow-ups.

## Test coverage

`src/capture/backdrop-raster-diagnostics.test.ts` drives the Node post-pass
through exact success, planner miss, CDP node-resolution partial failure,
screenshot failure, and missing-token states. The pure planner/diagnostic suite
also pins generated-pseudo selector ownership. The Playwright isolation test
captures a real blurred surface, proves later paint exclusion and live-DOM
restoration, and asserts that exact materialization produces no
`backdrop-filter` warning.
