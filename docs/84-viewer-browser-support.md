# 84 — Viewer browser support (where the output SVGs play)

**Status: shipped contract.** This is the support matrix for the browsers that
*view* Domotion's output — distinct from the capture-platform support (which OS
Chromium runs on to *produce* the SVG; that's `docs/42` / the CLAUDE.md platform
section). Here we answer: "I embed a Domotion SVG on a page — which browsers
render its animation faithfully?"

## The contract

Domotion output is a **self-contained animated SVG** whose animation is expressed
as **CSS `@keyframes`** (plus a little SMIL only where a raster is embedded — not
for the frame/timeline animation). It is designed to animate when embedded as a
plain image, so the animation model is deliberately **script-free** (see
"Embedding", below).

| Engine | Browsers | Tier | Notes |
|---|---|---|---|
| **Blink** | Chrome, **Edge**, Brave, Opera, Vivaldi, Arc, Electron/CEF apps | **First-class** | Reference engine. Pixel-faithful; animation timelines stay in sync under load. |
| **WebKit** | Safari (macOS), **all iOS/iPadOS browsers** (Chrome/Firefox/Edge on iOS are WebKit by App-Store rule) | **First-class** | Consistent with Blink for our animation model. |
| **Gecko** | Firefox (desktop, Android) | **Best-effort** | Renders correctly at normal load; **can desync animation under heavy load** — see the OMTA caveat below. Graceful degradation, not a break. |

"First-class" means we hold it to the fidelity + synchronization contract and
treat a deviation as a bug. "Best-effort" means we fix cheap/high-value issues
(and did — see below) but do not contort the architecture solely for it.

Edge deserves a specific callout because it's the most common question: Edge has
been **Chromium/Blink since January 2020** — same renderer, V8, and compositor as
Chrome. It behaves exactly like Chrome. There is no separate "EdgeHTML" to worry
about.

## Embedding: why the animation is CSS, and what that rules out

The output is meant to drop in anywhere an image goes:

- `<img src="demo.svg">` — the canonical, lazy-loadable embed.
- `<object>` / `<iframe>` / inline `<svg>` / CSS `background-image`.

**Inside `<img>` (and CSS `background`), scripts do not run.** CSS animations and
SMIL both play there; JavaScript and the Web Animations API (WAAPI) do **not**.
That's the whole reason the animation is authored as declarative CSS `@keyframes`
baked into the file — so a Domotion SVG animates as a pure `<img>` with zero
runtime, zero external assets, and no CSP/script concerns. It is also why
"drive it with JS/WAAPI" is not an option for the primary use case.

## Why CSS, not SMIL

Both CSS and SMIL animate inside `<img>`, so the choice is about *robustness*, not
capability:

- **CSS** runs on the one document/CSS timeline, is GPU-composited, and supports
  `prefers-reduced-motion` gating. Everything animates on a single clock.
- **SMIL** runs on the SVG's *own* timeline, main-thread only (never
  GPU-composited), has no media-query gating for reduced motion, and its
  development is frozen across engines.

The decisive lesson is **don't mix the two clocks.** When the cursor overlay was
SMIL while the frame animations were CSS, Safari paused/throttled the two
timelines independently when the SVG was offscreen and they drifted apart
(DM-1507). The fix unified everything on CSS. A wholesale move to SMIL would also
be internally consistent, but it would trade the compositor (essential for
"several heavy demos lazy-loaded on one page") for guaranteed main-thread repaint
cost on *every* engine — the wrong trade for our scale target. So: **all CSS, one
timeline, never mixed.** See `docs/08-animation-model.md`.

## The Firefox / OMTA caveat (why Gecko is best-effort)

Firefox runs `opacity` and `transform` animations **off the main thread** (OMTA,
on the compositor). Under heavy load — many animated SVGs on a page, or many
tabs — Firefox exceeds its compositor-animation budget and **demotes some
animations to the main thread**. When two animations that must stay visually
synchronized end up on *different* clocks (one still on the compositor, one
demoted to the main thread), they drift apart. The visible symptom is a unit's
paired tracks separating — e.g. a character's fade running ahead of its
slide/scale in the kinetic-text templates ("two separate steps"), or a card
fading before it finishes sliding in the lower-third template.

- **It is load-dependent and Gecko-specific.** Blink and WebKit keep an element's
  animations coherent; they do not exhibit this. Reproduce/observe it with the
  stress gallery (`examples/output/stress-gallery.html`, DM-1514) at a high load
  multiplier.
- **It degrades gracefully.** The animation still plays and reads; it loses
  per-unit sync momentarily under load. It is not a blank/flash/break.
- **Generator mitigation.** Domotion fuses a visual unit's tracks (opacity +
  transform + …) into a **single** CSS animation via the animation entry's
  `fuse` list (DM-1512/1513). A single animation is one timeline — its properties
  are always sampled at the same instant regardless of thread — so a *unit's own*
  fade and move cannot desync, on any engine. Tracks may share the primary's
  timing (emitted as from/to stops) or carry their own `duration`/`delay`/
  `easing`, in which case the animator bakes each track's eased curve into
  sampled `linear`-timed stops (DM-1517) so independent-timing tracks stay one
  animation too. What remains beyond our control is frame-perfect sync *between
  separate elements* under extreme Firefox load, which is why Gecko stays
  best-effort rather than first-class.

Not to be confused with the **transparent-flash-at-cut-points** bug (DM-1511),
which was a different, harder Firefox failure — the frame show/hide flipped
`opacity` and `visibility` together in one `step-end` keyframe and Firefox
flashed the page-through gap at hand-offs. That is fixed for all engines by
decoupling visibility into a wide-overlap paint-cull track (see
`docs/08-animation-model.md`).

## Reduced motion

All engines honor `@media (prefers-reduced-motion: reduce)`: transitions degrade
to a cut-like reveal and ambient/looping motion is pinned. This is emitted as CSS
(another reason the animation model is CSS, not SMIL — SMIL has no equivalent
media-query gate).
