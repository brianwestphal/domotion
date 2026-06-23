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

# Playful floating orbs, custom palette (arrays go through --params).
domotion template background-loop \
  --params '{"variant":"orbs","colors":["#f43f5e","#fb923c","#facc15"],"count":7}' \
  --width 1280 --height 720 -o orbs.svg
```

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `variant` | `aurora` \| `orbs` | `aurora` | `aurora` = large soft mesh; `orbs` = smaller, more opaque floating circles. |
| `colors` | string[] | indigo/pink/cyan/amber | Blob colors, cycled across the blobs. Array → pass via `--params`. |
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

- **`src/templates/builtin/background-loop.ts`** — `planBlobs` (deterministic
  layout), `buildBackgroundHtml` + `buildBackgroundAnimations` (pure, testable
  generators), and the `backgroundLoopTemplate`. Registered in
  `src/templates/registry.ts`; re-exported from the package root.

## Follow-ups

More variants are the obvious next step (see DM-1280 notes for the filed list):
panning gradient, wave/ribbon shapes, particle/star field, grid drift. Each is a
new `variant` value (or a sibling template) on the same contract — the procedural
layout + the two-constraint animation pattern here are the reusable core. A
`colors`-as-flag convenience (comma-separated) could complement the `--params`
array path.
