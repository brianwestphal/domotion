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
| `variant` | `aurora` \| `orbs` \| `stars` \| `gradient-pan` \| `grid` | `aurora` | See *Variants* below. |
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
  `buildBackgroundHtml` + `buildBackgroundAnimations`, shared by `aurora` / `orbs`
  / `stars`), the non-blob builders (`buildGradientPanHtml` /
  `buildGradientPanAnimations`, `planGridDots` / `buildGridHtml` /
  `buildGridAnimations`, `planWaves` / `buildWaveHtml` / `buildWaveAnimations`),
  and the `backgroundLoopTemplate` that dispatches by variant. All builders are
  pure + unit-tested. Registered in `src/templates/registry.ts`; re-exported from
  the package root.

## Variants (DM-1285, DM-1295)

Every variant keeps to the same two-constraint, `alternate`-looped contract above.

| `variant` | Look | Layout |
|---|---|---|
| `aurora` | Large soft mesh-gradient blobs | blob (radial-gradient) |
| `orbs` | Smaller, more opaque floating circles | blob |
| `stars` | Twinkling particle / star field — many tiny sharp dots that fade and barely drift (`count` is a density level, scaled ~14×) | blob |
| `gradient-pan` | A sweeping color wash — one angled `linear-gradient` layer, twice the canvas width, sliding horizontally | single sliding layer |
| `grid` | A drifting dot grid — evenly-spaced colored dots laid one cell beyond every edge, drifting by exactly one cell (so endpoints read seamless) | dot grid |
| `wave` | Flowing ribbon bands — `count` wide soft horizontal stripes (`transparent → color → transparent`) stacked down the canvas, each wider than the frame and parallax-drifting horizontally while bobbing vertically | ribbon bands |

The `wave` ribbon approach (DM-1295) deliberately stays in the positioned-element +
`translate` model — wide soft `linear-gradient` stripes with horizontal parallax +
a vertical bob — rather than literal sine `<path>` shapes, so it keeps the same
seamless-loop guarantees as the other variants.
