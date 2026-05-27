# Magic-move transition

Requirements for a Keynote-style **magic move** transition between animation
frames: when two consecutive frames share or evolve the same elements, the
shared elements animate from their old position/size/style to their new one
(rather than the whole frame cross-fading), so the eye tracks each object
across the cut. Origin: DM-112.

> **Status: SPECIFIED.** This doc is the contract; implementation is split into
> the follow-up tickets listed under [Phasing](#phasing). Maintainer decisions
> are recorded in [Decisions](#decisions-adopted).

## Goal

Add `magic-move` as a new value of the per-frame `transition.type` (alongside
`crossfade` / `push-left` / `scroll` / `cut` — see `docs/08-animation-model.md`
and `docs/43-declarative-animate-config.md`). With it, a multi-frame demo whose
pages share elements (a card that grows, a list item that moves, a logo that
relocates) blends between pages the way Keynote's "Magic Move" build does:
matched objects glide/scale/tween in place while genuinely new or gone objects
cross-fade.

## Decisions adopted

1. **Matching = heuristic + author-key override.** Default to the existing
   `diffTrees()` content-fingerprint + tree-path heuristic (the same matcher the
   scroll composer uses — `src/tree-ops/tree-diff.ts`). An explicit author key
   (`data-magic-key="…"`, view-transition-name in spirit) **forces** a pair and
   wins over the heuristic, for cases where two elements are too similar (or too
   changed) for the heuristic to pair correctly.
2. **Morph scope = position + size + style.** A matched element animates its
   `translate` (bbox origin delta) and `scale` (bbox size ratio) AND tweens its
   paint — `color` / `opacity` / `background` / `border` — from the prev state to
   the next state.
3. **Unmatched = crossfade.** Elements present in only one frame (`added` /
   `removed` from the diff) fade in / out over the transition, concurrent with
   the matched-element moves. (`cut` for unmatched is not offered in v1.)

## The mechanism (reuses existing infrastructure)

`diffTrees(prev, next)` already classifies every element across two
`CapturedElement` trees as `unchanged` / `moved` (matched, bbox shifted) /
`modified` (matched, same path) / `added` / `removed`, and `dominantTranslate()`
already finds bulk-shifted groups. The scroll-segment composer
(`src/scroll/executor.ts`) already consumes this to pick per-element treatment
(translate for shifted, crossfade for added/removed). Magic-move is the same
idea promoted to a **frame-to-frame transition type** in the animator:

| Diff kind | Magic-move treatment |
| --- | --- |
| `unchanged` | Emit once, hold across the transition (no animation). |
| `moved` / `modified` | Animate `translate`+`scale` from prev bbox → next bbox, plus tween color/opacity/border. |
| `added` | Fade in (opacity 0→1) over the transition. |
| `removed` | Fade out (opacity 1→0) over the transition. |

The transition therefore emits, per matched element, one CSS `@keyframes` block
keyed to the transition window `[frameStart, frameStart+transitionDuration]`,
and the unchanged elements collapse to a single emission (as `frame-merge.ts`
already does for shared static content).

## Architecture / what must be built

1. **New transition type.** Add `"magic-move"` to the union in
   `src/animation/animator.ts` (the `transition.type` field) and to the Zod enum
   in `src/cli/animate.ts` (`transitionSchema`). Update `docs/08` + `docs/43`
   pointers.

2. **Element-tree input to the animator.** `generateAnimatedSvg` composes from
   per-frame **rendered `svgContent` strings** today — it cannot diff those. A
   magic-move frame needs the prev+next **`CapturedElement` trees** so it can run
   `diffTrees`. Thread the captured tree alongside `svgContent` on the frame
   input (the scroll pipeline already carries trees, so this is precedent, not a
   new concept). When a frame requests `magic-move` but its tree isn't available,
   fall back to `crossfade` (never throw).

3. **Author match-key capture.** Arbitrary `data-*` attributes are NOT captured
   today (only targeted ones — `start`, `value`, `placeholder`, the internal
   `data-domotion-rid`). Add a capture-side hook (a walker in
   `src/capture/script/walker/`) that records `data-magic-key` onto the
   `CapturedElement`, and teach `diffTrees` (or a thin pre-pass) to pair by key
   first, heuristic second. Keys are scoped per transition pair.

4. **Per-element keyframe emission.** For each matched element, derive
   `(dx, dy)` and `(sx, sy)` from the prev/next bboxes and emit a keyframe that
   interpolates `transform: translate()/scale()` plus the style deltas. Anchor
   the scale at the element's top-left to match the bbox mapping. Reuse the
   crossfade emission already in the animator for `added`/`removed`.

## Contract & caveats

- **What morphs:** bbox position, bbox size (via scale), `color`, `opacity`,
  and solid `background` / `border` color. Text *content* changes are not
  morphed — a matched element whose text differs cross-fades its glyph layer
  while its box moves (v1 simplification; revisit if a fixture needs it).
- **Scale vs re-layout:** matched elements are *scaled* between bboxes, not
  re-laid-out mid-transition. A block that reflows (e.g. text wrapping
  differently) will scale-distort during the transition and snap correct at the
  end — acceptable for demo blends; documented so consumers don't expect true
  reflow tweening.
- **Nesting:** when a parent and its children both match, the parent's transform
  already moves the children; child-level transforms must be expressed relative
  to the parent to avoid double-application (same rule the scroll composer
  follows). The matcher should prefer the highest matched ancestor.
- **`prefers-reduced-motion`:** like the other transitions, magic-move should
  degrade to `cut`/`crossfade` under reduced-motion (consistent with `docs/08`).
- **Determinism:** the heuristic can mis-pair ambiguous elements; `data-magic-key`
  is the escape hatch and should be recommended in docs for any demo where the
  automatic blend looks wrong.

## Phasing

Each becomes a follow-up ticket (filed from this ticket):

1. **Core transition + tree threading** — add the `magic-move` type, thread
   element trees to the animator, wire `diffTrees`, emit translate-only moves +
   crossfade unmatched. Smallest end-to-end slice that demonstrates the effect.
2. **Size + style morph** — add scale and color/opacity/border tweening to
   matched elements (decision #2's full scope).
3. **Author match keys** — capture `data-magic-key` and the key-first matching
   override (decision #1's override half).
4. **Reduced-motion + nesting hardening + a feature fixture** — the
   `prefers-reduced-motion` fallback, the parent/child relative-transform rule,
   and a `tests/features.ts` fixture (two frames sharing a relocating/resizing
   card) plus a showcase example.
