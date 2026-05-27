# Magic-move transition

Requirements for a Keynote-style **magic move** transition between animation
frames: when two consecutive frames share or evolve the same elements, the
shared elements animate from their old position/size/style to their new one
(rather than the whole frame cross-fading), so the eye tracks each object
across the cut. Origin: DM-112.

> **Status: PHASE 1 IMPLEMENTED (DM-898).** The core (translate-only moves +
> cross-faded add/remove) ships in `src/animation/magic-move.ts` +
> `generateAnimatedSvg`'s `magic-move` branch + the CLI wiring. Phases 2-4
> (size/style morph, `data-magic-key`, reduced-motion/nesting) remain — see
> [Phasing](#phasing). Maintainer decisions are in [Decisions](#decisions-adopted).
>
> **Architecture note (revised in DM-898):** the original sketch below had the
> animator re-render from the trees. That isn't workable — the caller finalizes
> the glyph/font `<defs>` (`getEmbeddedFontFaceCss()`) *before* calling
> `generateAnimatedSvg`, so re-rendering inside the animator would reference
> glyphs missing from the emitted defs. The bridge layer is therefore built
> **caller-side** (`buildMagicMove`, invoked from `src/cli/animate.ts` while the
> page/trees are live and before defs are finalized) and passed to the animator
> as a pre-rendered `frame.magicMove` payload; the animator only schedules it
> and emits the keyframes.

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

Each is a follow-up ticket (filed from DM-112):

1. ✅ **Core transition + tree threading (DM-898, done).** `magic-move` type +
   Zod enum; caller-side bridge builder (`buildMagicMove`) wired into the CLI
   (which has the live trees / pre-defs render); `diffTrees`-driven translate
   moves + cross-faded add/remove; highest-matched-ancestor nesting handled even
   here (else a moved card's moved children double-translate); crossfade
   fallback when no bridge. Unit-tested + verified end-to-end (a card slides
   diagonally while add/remove cross-fade).
2. ✅ **Size morph (DM-899, done).** A "mover" is now any matched element whose
   prev→next rect changed in origin OR size (re-derived from the rects, since
   `diffTrees` keys its kind on origin only and a grow-in-place lands as
   `static`). Each mover animates the full prev→next affine — `translate` for a
   pure move, `translate · scale · translate` for a size change, anchored so the
   element's next-rendered box maps back onto its prev box. Highest-moved-
   ancestor filtering covers scale too. Unit-tested + verified end-to-end (a
   card grows 120×60→260×130 and relocates, mid-transition shows it part-grown).
   **Style morph split out → DM-903:** color / background / border / opacity
   tweening (and content cross-fade for `modified` movers) needs a different
   mechanism — the bridge renders each mover once at its NEXT appearance, so
   color/border/content currently SNAP to next at the window start while the box
   morphs; tweening them means rendering the mover twice (prev + next
   appearance) and cross-fading, because the SVG children carry baked-in fills a
   wrapper can't restyle.
3. ✅ **Author match keys (DM-900, done).** Capture records `data-magic-key`
   onto `CapturedElement.magicKey` (a `el.dataset.magicKey` read alongside the
   existing `data-domotion-anim` capture). `buildMagicMove` collects keyed
   elements in both frames and force-pairs any key present in both as a mover
   AHEAD of the fingerprint heuristic — superseding whatever `diffTrees`
   decided, including splitting a content-changed element into add+remove. Such
   pairs are removed from the add/remove (fade) sets so they slide instead.
   Verified end-to-end: a card whose text changes between frames still slides
   (1 slide keyframe, 0 fades) when both copies carry `data-magic-key="card"`.
   **Use it** for any demo where the automatic blend mis-pairs similar elements
   or a moving element's content changes (the heuristic would cross-fade those).
4. ✅ **Reduced-motion + nesting + showcase (DM-901, done).**
   `prefers-reduced-motion: reduce` cancels the slide/scale animations (a
   trailing `@media` block sets `animation: none` on the mover classes) so
   matched elements sit at their final position instead of gliding — the
   opacity cross-fades stay (acceptable under the reduced-motion guidelines);
   static CSS, so output stays deterministic and rasterizers (Chromium default
   = `no-preference`) still play the full move. Nesting is already correct from
   phase 1: only the highest moved ancestor animates, so children ride its
   transform (no double-application) — relative child transforms would only
   matter if a child moved DIFFERENTLY than its parent, a non-uniform edge left
   for later. Coverage: a committed `examples/animate/magic-move/` showcase (a
   card relocating AND growing 180×90→240×130, with a Draft→Published chip
   add/remove) drives the deterministic golden suite (`demos:test:animate`),
   doubling as the demo. Verified by rasterizing the golden: card mid-morph
   under normal motion, card at final position under emulated reduced-motion.
