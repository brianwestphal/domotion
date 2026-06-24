# 77 — Nested animated compositing (DM-1323)

Status: **Design / proposed.** No new capability shipped yet. Two of the three
hard building blocks already exist (name-collision handling and per-layer
timeline offsetting — see "What already works"); this doc specifies the
composition primitive that ties them together, evaluates feasibility against
Chromium's actual paint, and lays out a phased rollout. Open decisions are
collected at the end and mirrored to a `FEEDBACK NEEDED` note on DM-1323.

## Problem

Domotion can produce animated content several ways — a `cast` (terminal), a
`capture --scroll` (a scrolling page), a `template` (lower-third, kinetic-text,
device-mockup, …), and a full `animate` composition — but there is **no way to
nest one *animated* composition inside another while preserving its animation.**
Composition today is either:

- **Sequential frames** in an `animate` config (doc 43 / 73): template / cast /
  input frames play one after another; they don't *layer* or *nest*. (Each is a
  nested animated SVG, but they're shown one-at-a-time, not composited.)
- **Decorator templates that re-capture to a STATIC SVG** (`device-mockup` /
  `wrapInDeviceChrome`, doc 65 / 70): the wrapped content is flattened to one
  still frame before the bezel is drawn, so an animated input loses its motion.

So any "wrap an animated thing inside another thing, and keep it animating"
workflow silently loses the inner animation.

### Motivating example (what a user wants to express)

1. `capture --scroll` a website scrolling top→bottom (animated), then
2. embed that animated capture inside a **browser/window bezel**
   (`device-mockup`), then
3. place that framed, still-animating window into an **OS/desktop context**
   (another template / background-loop),

i.e. a 3+ level composite where **every level stays animated**. The original
"animated terminal in window chrome" case (a `domotion term` cast → window
chrome) is just the simplest instance — apple-fm (AFM-49) hand-built that as an
SVG post-process around a single cast frame (`scripts/lib/window.mjs`) precisely
because no animated-nesting primitive exists.

## What already works (the building blocks)

This capability is **not** a from-scratch build. The two structurally hardest
problems are already solved, and a feasibility probe confirms the approach:

- **Name-collision handling — `namespaceEmbeddedAnimatedSvg`** (doc 73, DM-1287 /
  DM-1292, `src/animation/embed-namespace.ts`). SVG/CSS names are
  document-global, not scoped to a nested `<svg>`. The namespacer rewrites a
  complete animated-SVG document's ids, `url(#…)`/`href` refs, embedded-font
  families (`dmfN`), frame/anim classes, `@keyframes` names, and the
  `--scene-dur` custom property with a per-layer token, so an embedded animated
  document can't collide with its host or its siblings. It already runs for
  `cast` (`cfN_`) and `template` (`tfN_`) frames.
- **Per-layer timeline offsetting — `offsetEmbeddedAnimatedSvgTimeline`** (doc
  67, DM-1319, `src/animation/embed-timeline.ts`). A nested animated SVG's
  internal timeline is re-anchored to start when its host frame becomes visible
  (and held before/after), instead of running on the shared document origin.
  Generalizing this to arbitrary nesting depth + container offset is the
  timeline half of this feature.
- **Feasibility probe (2026-06).** An already-rendered animated terminal SVG was
  namespaced and nested inside a hand-built window-bezel `<svg>` with a
  `translate + scale` transform, then seek-rendered in Chromium at two
  timestamps: the inner animation **still plays** under nesting + transform, and
  the bezel composites around it. So the user's hypothesis — "achievable by
  nesting and then transforming / masking nested SVGs" — holds, and id-space
  collisions are handled by the existing namespacer. (Reproduce with a throwaway
  probe under `tools/scratch/`; not committed.)

In short: **`<svg>`-in-`<svg>` nesting + transform/clip + the existing
namespacer preserves animation.** What's missing is a first-class primitive that
(a) takes already-rendered animated SVG as a layer's content, (b) lets decorator
templates nest it instead of re-capturing, and (c) offsets each level's timeline
correctly.

## Proposed capability

### 1. A compositing primitive whose layer content can be already-animated SVG

Today every content source is a *fresh capture* of a live page. Add a content
source that is **already-rendered animated SVG** — the output of a `cast`, a
`scroll` capture, a `template`, or another `animate` run — placed into a parent
at a position, with an optional transform and clip. Mechanically each layer is:

```
namespace(innerAnimatedSvg, token)            // collisions handled
  → offsetTimeline(…, containerStart, period) // DM-1319, generalized to depth
  → <g transform="…" clip-path="…"> <svg>…</svg> </g>   // place in parent
```

Layers composite (z-ordered) rather than playing sequentially — this is the
difference from today's sequential `animate` frames.

### 2. Decorator templates accept animated content (nest, don't re-capture)

`device-mockup` / `wrapInDeviceChrome` (doc 65 / 70) should accept an
already-rendered **animated** SVG as their screen/inner region and nest it with
animation intact (via §1), instead of routing through the `captureToSvg` static
primitive. The bezel markup is unchanged; only the screen content changes from
"re-capture to static" to "nest the animated layer." This directly removes the
apple-fm hand-built-chrome workaround.

### 3. Arbitrary nesting depth

content → window → OS-context → … , each level animated. Namespacing composes by
using compound tokens per level (`l0_l1_…`), and timeline offsets accumulate down
the tree (a leaf's start = sum of its ancestors' starts). The probe validates one
level; depth is the same operation applied recursively.

### 4. Correct timeline offsetting at every level (generalize DM-1319)

A nested animated layer must start when its container is shown and run within its
container's visible window — the same contract DM-1319 gives a cast frame, but
applied per nesting level. `embeddedAnimationPeriodMs` + the offset transform are
the seed; the feature generalizes them to (container-start, container-period)
pairs threaded down the tree.

## Feasibility & risks (evaluated against Chromium paint)

- **Animation survives nesting + transform — confirmed** (probe above). SVG CSS
  animations on elements inside a nested `<svg>` run regardless of an ancestor
  `transform` / `clip-path`.
- **Id / name collisions — solved** by `namespaceEmbeddedAnimatedSvg`; depth
  needs compound tokens (mechanical).
- **Masking / clipping** — standard SVG (`clipPath` / `mask` on the layer group);
  the inner document's own clips are namespaced so they don't escape.
- **Raster fallbacks nest fine.** An inner layer may contain raster `<image>`
  paint (color emoji, vertical text, `<canvas>`, conic gradients — see
  `docs/reference/raster-image-fallback-cases.md`); those nest like any other
  element. No new raster fallback is introduced by nesting.
- **Cross-browser-safe.** Nesting uses `<svg>` / `<g transform>` / opacity /
  `clipPath` — all in the cross-engine-safe set (per `llms.txt` gotchas;
  contrast the rejected animated-`filter` approach, DM-1296). No engine-specific
  feature is required.
- **Master-loop commensurability.** DM-1319 re-anchors a layer onto the *master*
  period so it stays in sync across loops. With multiple independently-looping
  layers of different natural lengths, the composite's true loop is the LCM of
  the layer periods; the primitive should either (a) hold each layer after it
  finishes within one master period (DM-1319's choice) or (b) expose a per-layer
  `loop` mode. Decide in "Open questions."
- **Size.** Each nested layer embeds a full animated SVG (incl. its glyph paths /
  fonts). Deep composites grow additively. Font dedup across layers (the
  `manageFonts:false` trick casts already use) should extend to nested layers to
  avoid re-embedding a shared monospace font per level.
- **Main risk:** API surface scope, not technical feasibility. The mechanism is
  proven; the question is how much surface to expose (see Open questions).

## API options (decision needed — see Open questions)

- **(A) Declarative `animate` extension.** A layer/overlay whose `content` is a
  reference to an already-rendered animated SVG (a file, or another inline frame
  spec), plus `transform` / `clip`. And/or `device-mockup`'s screen param accepts
  an animated SVG. Lowest barrier; fits the existing config contract (doc 43).
- **(B) Programmatic primitive.** A `composeLayers([...])` / `nestAnimatedSvg(
  inner, { transform, clip, start, period })` export, mirroring the doc-62/63
  "expose the seam" pattern, for callers who assemble composites in code.
- **(C) Both** — the declarative path built on the primitive (as templates are
  front-ends onto `composeAnimateConfig`). Most consistent with the codebase, but
  the largest scope.

## Phased rollout (→ follow-up tickets)

1. **Generalize the timeline offset to nested depth** — extend DM-1319's
   `offsetEmbeddedAnimatedSvgTimeline` / `embeddedAnimationPeriodMs` to
   (container-start, container-period) threaded down a tree; unit-test depth ≥ 2.
2. **Core nesting primitive** — `nestAnimatedSvg(inner, { transform, clip, start,
   period })`: namespace (compound token) → offset → place. Programmatic export +
   tests + a seek-render regression guard.
3. **Decorator templates accept animated content** — `device-mockup` /
   `wrapInDeviceChrome` nest an animated screen instead of re-capturing; flip the
   doc 65 / 70 "static-only" caveat once shipped.
4. **Declarative surface** (if chosen) — an `animate`-config layer/overlay that
   composites already-animated content; schema + doc 43 update.
5. **Cross-layer font dedup** — one `@font-face` block across nested layers.
6. **Docs** — promote this doc to "shipped" incrementally; update the
   preservation table (doc 43, DM-1322) as decorators move from snapshot →
   preserved.

## Until then (docs already updated)

The "decorator wrappers are static-only / do not preserve animation" caveat is
now stated in `llms.txt`, `docs/43` (the DM-1322 preservation table), `docs/65`
(device chrome), and `docs/70` (template system), so a reader no longer assumes
"render X, wrap it in window/device chrome" yields an animated framed result.

## Pointers

- `src/animation/embed-namespace.ts` — `namespaceEmbeddedAnimatedSvg` (collisions).
- `src/animation/embed-timeline.ts` — `offsetEmbeddedAnimatedSvgTimeline` (DM-1319).
- `src/cli/animate.ts` — `composeAnimateConfig` / frame composition / `embeddedAnimationPeriodMs`.
- `src/templates/builtin/device-mockup.ts` + `src/render/device-chrome.ts` — the
  decorator that re-captures to static today.
- `docs/43` (animate config), `docs/67` (terminal), `docs/70` (templates),
  `docs/73` (template frames).

## Open questions (mirrored to DM-1323 `FEEDBACK NEEDED`)

1. **Near-term target:** the simple "animated terminal/page in window chrome"
   (one level — directly unblocks apple-fm), or the full 3-level
   website→window→OS-context composite up front?
2. **API surface:** (A) declarative `animate` extension, (B) programmatic
   primitive, or (C) both?
3. **Decorator upgrade:** evolve `device-mockup` to nest animated content, or add
   a separate compositing primitive and leave `device-mockup` static?
4. **Per-layer timeline semantics** when an inner layer is shorter/longer than its
   container's window: **hold** after it finishes (DM-1319's choice, recommended
   for consistency), **loop**, or **stretch** to fit? Make it a per-layer option?
