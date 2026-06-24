# 77 — Nested animated compositing (DM-1323)

Status: **Shipped (core).** General animated-SVG compositing is implemented: a
programmatic primitive (`composeAnimatedLayers`), a declarative `domotion
composite` config/verb, per-layer independent timelines (`hold` / `stretch` /
`loop`), layer-level animations (move / scale / fade, plus `clipScaleX` /
`clipScaleY` to resize a layer's *box* without scaling its contents), and
`device-mockup` nesting *animated* screen content. The E2E proof — a macOS-like
desktop with a terminal **window that the cursor resizes mid-run, reflowing the
terminal (80 → 50 cols) while the title-bar buttons keep their size** — ships as
`examples/composite-desktop.ts` (and a simpler declarative
`examples/composite/desktop-terminal.json`). That demo is a genuine **three-step
composite**: (1) the terminal layer reflows via a mid-session cast `resize` event,
(2) it's composited into fixed-size window chrome, (3) the window is placed on the
desktop with a `clipScaleX` resize matched to the terminal's reflow time + a
cursor dragging the edge. A published **JSON Schema** for the composite config
ships at `schemas/composite-config.schema.json` (point a config's `"$schema"`
key at it for editor autocompletion). Byte-identical embedded fonts are deduped
across layers (DM-1329): the renderer emits identical base64 for identical glyph
subsets, so two layers built from the same font + glyph set (a reused layer, or
the same composite nested twice) embed the heavy payload once.

**Resizing a window correctly (not scaling it).** A real window resize changes the
content's size and reflows it; it does not scale the chrome. So the demo (a) emits
the terminal at the new column count via a cast `resize` event — reflow happens at
the *terminal* layer, pre-composite — and (b) shrinks the window's box with
`clipScaleX` (a `clip-path` whose clip-rect is `transform: scaleX`-animated), which
trims the window from the right with the traffic-light buttons untouched. The
reflow's *rendered* time + before/after column counts come from `buildFrames`
(each settle-point carries its grid + `durationMs`), so the chrome resize lines up
with the terminal reflow. Animating `clip-path: inset()` directly was tried first
but fails to clip over nested-SVG content; the `scaleX`-clip-rect approach is
robust and uses only transforms (cross-browser-safe).

## What shipped

- **`composeAnimatedLayers(layers, opts)`** (`src/animation/composite.ts`,
  exported from the package root) — stacks already-rendered SVGs (each possibly
  animated) into one self-contained animated SVG: per-layer namespace → timeline
  re-anchor → place (`x`/`y`/`width`/`height`/`clip`) → optional layer-level
  animation. Returns `{ svg, width, height, durationMs }`. Because the output is
  itself a complete animated SVG, composites **nest recursively**.
- **Per-layer timeline** (`offsetEmbeddedAnimatedSvgTimeline`,
  `src/animation/embed-timeline.ts`) generalized to `mode: "hold" | "stretch" |
  "loop"` + independent `start` / `duration` — a layer's animation starts and
  runs independently of its container (the user's core requirement).
- **`domotion composite <config.json>`** (`src/cli/composite.ts`) — the
  declarative surface: layers whose source is a `cast`, a `template`, or a
  pre-rendered `svg` (any animated), each with placement, timeline, layer
  animations, and optional device `chrome`.
- **`device-mockup` nests animated content** — a new `screenSvg` param nests a
  pre-rendered animated SVG (a cast / scroll capture / animate output) as the
  bezel's screen, animation preserved (`wrapInDeviceChrome` already nested; it
  just needed the screen namespaced + its play length reported). The old
  `input`-capture path stays for static screens.

The rest of this doc is the original design + feasibility evaluation; the
"Phased rollout" section marks what's done.

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

## Phased rollout

1. ✅ **Timeline modes + independent start/duration** — `offsetEmbeddedAnimatedSvgTimeline`
   now takes `mode: hold | stretch | loop`. (Recursive depth falls out of the
   primitive: a composite is itself an animated SVG whose anims all run at its
   master period, so nesting it in a parent re-anchors cleanly.)
2. ✅ **Core compositing primitive** — `composeAnimatedLayers` (namespace → offset
   → place + layer animations). Programmatic export + unit tests.
3. ✅ **Decorator nests animated content** — `device-mockup` `screenSvg` param.
   The doc 43 / 65 / 70 "static-only" caveats are updated to "static unless you
   pass animated content."
4. ✅ **Declarative surface** — `domotion composite` config/verb (`src/cli/composite.ts`).
5. ✅ **Cross-layer font dedup.** Two complementary mechanisms:
   - **Exact-payload dedup** (DM-1329, `dedupeCompositeFonts`, applies to ANY
     composite incl. the programmatic primitive over pre-rendered SVGs): collapses
     byte-identical `@font-face` payloads (same descriptors + same base64 `src`),
     repointing the removed families' references at the survivor. Covers a reused
     layer / the same composite nested twice.
   - **Shared-builder merge** (DM-1331, the declarative `domotion composite` path):
     `cast` layers are rendered through ONE embedded-font builder
     (`manageFonts:false` → `getEmbeddedFontFaceCss()`), so several terminals in
     the same monospace but with **different text (different glyph subsets)** embed
     the font's *union* subset **once**. The layers carry `deferFonts:true` (their
     `dmfN` families are kept un-prefixed during namespacing) and the single
     `@font-face` block is emitted once via `ComposeLayersOptions.fontFaceCss`.
     Scoped to cast layers in the config path — `svg` layers are pre-rendered and
     `template` layers render via their own pipeline, so they can't share the
     builder; they fall back to exact-payload dedup. Guarded by
     `src/cli/composite-font-dedup.e2e.test.ts`.
6. ✅ **Published JSON Schema** — `schemas/composite-config.schema.json`, generated
   from `compositeConfigSchema` by `npm run build:composite-schema` (the same
   pattern as the animate schema); a config can point its `"$schema"` at it. A
   sync test (`composite-config-json-schema.test.ts`) keeps it from drifting.

A layer-level animation currently supports **one transform animation per layer**
(CSS last-wins if several animate `transform`); compose move-and-scale by nesting
wrapper layers, the same rule the rest of the pipeline follows. A `loop` layer
nested inside another composite keeps looping at its own rate (its period doesn't
collapse to the parent master), which can seam at the parent's loop boundary —
fine for seamless-by-design loops; documented so it isn't a surprise.

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
