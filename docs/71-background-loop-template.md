# 71 — `background-loop` template

Status: **shipped** (DM-1280). The first of the deferred first-party templates
built on the DM-1276 contract (doc 70). A built-in **generator** template that
produces a procedurally-generated, seamlessly-looping animated background.

## What it is

`domotion template background-loop` emits a self-contained animated SVG: a base
fill with N soft color **blobs** that each **drift** (translate) and **breathe**
(opacity-pulse) on independent, staggered, infinitely-looping cycles. It's the
"overlays & graphic assets → backgrounds & loops" category, and a clean showcase
of the template thesis — a seed plus a few knobs expand at author time into a
procedural layout that bakes once and replays forever.

```sh
# Default aurora (soft mesh-gradient look).
domotion template background-loop -o bg.svg

# Playful floating orbs, custom palette via the --colors convenience flag.
domotion template background-loop \
  --variant orbs --colors "#f43f5e,#fb923c,#facc15" --count 7 \
  --width 1280 --height 720 -o orbs.svg

# A twinkling star field / particle background.
domotion template background-loop --variant stars --colors "#7aa2f7,#bb9af7,#7dcfff" -o stars.svg
```

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `variant` | `aurora` \| `orbs` \| `stars` \| `gradient-pan` \| `grid` \| `wave` | `aurora` | See *Variants* below. |
| `colors` | string[] **or** comma-separated string | indigo/pink/cyan/amber | Colors, cycled across the elements. Pass a JSON array via `--params`, or the comma-separated **`--colors`** convenience flag (DM-1285). |
| `background` | string | `#0b1020` | Base fill behind the blobs. |
| `count` | int 1–24 | `5` | Number of blobs. |
| `width` / `height` | int | `1280` / `720` | Output size in px. |
| `durationMs` | int | `9000` | Base loop period; each blob's drift/breathe period varies around it. |
| `seed` | int | `1` | PRNG seed — **same seed ⇒ identical layout** (deterministic, reproducible). |

## How it works (design rules)

Blobs are soft-edged via `radial-gradient(circle, color 0%, transparent N%)`
(natively supported, doc 07) rather than `filter: blur()`, so fidelity doesn't
depend on blur-capture behavior. The looping motion uses Domotion's intra-frame
`animations` (doc 44 repeating animations) with two hard constraints that shape
the markup — both learned from the DM-1276 spike:

1. **One animation per captured element.** A second `animations` entry on the
   same selector overrides the first (same-specificity `.anim-<id>` rule). So
   each blob is a `.bg-pos-<n>` wrapper (drift) around a `.bg-blob-<n>` inner
   (breathe) — two distinct selectors, two animations.
2. **SVG transforms are origin-(0,0).** `rotate`/`scale` would orbit/shift, so
   motion is restricted to origin-safe `translate` (drift) and `opacity`
   (breathe), each looped with `alternate: true` so every cycle ping-pongs
   seamlessly (no snap-back at the loop boundary).
3. **Phase offsets are NEGATIVE delays, not positive waits.** Each blob's drift
   and breathe carry a negative `delay` (a random fraction of its own period) so
   the infinite `alternate` loop starts already mid-cycle — every blob is moving
   from the first frame. A *positive* delay would instead freeze the blob at its
   `from` state until the delay elapsed, then snap into motion (visible as a blob
   abruptly appearing/disappearing rather than fading). The animator also emits
   the per-blob `timing-function` / `delay` / `fill-mode` inside the one
   `animation` shorthand, so the SVG optimizer can't hoist `fill-mode` into an
   earlier rule and have the shorthand reset it.

Layout is deterministic: a seeded `mulberry32` PRNG places each blob's center,
size, drift vector, loop periods, and phase offsets — so a given `seed`
reproduces byte-stable output (and the layout is unit-testable without a
browser, unlike `Math.random`).

## Code

- **`src/templates/builtin/background-loop.ts`** — the blob path (`planBlobs` +
  `buildBackgroundHtml` + `buildBackgroundAnimations`, shared by `aurora` /
  `orbs`), and one pure builder trio per non-blob variant: `planStars` /
  `buildStarsHtml` / `buildStarsAnimations`, `buildGradientPanHtml` /
  `buildGradientPanAnimations`, `planGridDots` / `buildGridHtml` /
  `buildGridAnimations`, `planWaves` / `buildWaveHtml` / `buildWaveAnimations`. The
  `backgroundLoopTemplate` dispatches by variant. All builders are pure +
  unit-tested. Registered in `src/templates/registry.ts`; re-exported from the
  package root.

## Variants (DM-1285, DM-1295, DM-1298)

Every variant keeps to the same two-constraint, `alternate`-looped contract above.

| `variant` | Look | Layout |
|---|---|---|
| `aurora` | Large soft mesh-gradient blobs | blob (radial-gradient) |
| `orbs` | Smaller, more opaque floating circles | blob |
| `stars` | A twinkling night-sky field — sharp points (white-hot core → coloured glow) of varied size that twinkle (opacity) and sparkle (center-origin scale) fast on their own clocks (`count` is a density level, scaled ~16×) | positioned points |
| `gradient-pan` | A colour wash that pans **continuously** in one direction — a `repeating-linear-gradient` translated by exactly one period, so the palette tiles into itself seamlessly (never backs out) | single panning layer |
| `grid` | A dot grid that drifts **continuously** by exactly one cell — periodic, so the one-cell shift wraps seamlessly and reads as an endless drift | dot grid |
| `wave` | Layered **parallax** sine waves — `count` filled inline-`<svg>` sine `<path>`s stacked back→front, each panning one canvas width at a different speed (front fast/opaque/busy, back slow/faint/gentle); the period divides the canvas so the pan wraps seamlessly | sine-wave fills |

The continuous variants (DM-1298: `gradient-pan`, `grid`, `wave`) pan in a single
direction (`linear`, non-`alternate`) and stay seamless because each translates by
exactly one pattern period — the content tiles into itself. `wave` uses real
filled sine `<path>`s (captured inline SVG) for genuine wave crests + obvious
layer-speed parallax; the others keep to positioned elements + `translate`.
