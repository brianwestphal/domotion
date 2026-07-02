# 89 — Storyboard sequencing (DM-1527)

Status: **Shipped (core).** A declarative **storyboard** runner sequences distinct
SCENES end-to-end into ONE self-contained animated SVG, with an inter-scene
transition between each: a title card → a device-mockup / live-capture demo → a
lower-third → a CTA, all in one file.

It is the third multi-source composer, and it fills the gap the other two leave:

| Verb | Composition model | Sources |
| --- | --- | --- |
| `composite` (doc 77) | **Layers** animated SVGs spatially — z-ordered, each placed, independent timelines. | cast · template · svg |
| `animate` (doc 43 / 62 / 73) | Sequences **captured frames** of ONE evolving page (continuous session). | input · cast · template · scroll |
| **`storyboard` (this)** | Sequences **whole, independent SCENES** — one after another with a transition between each. | template · capture · cast · svg |

## CLI

```sh
domotion storyboard <config.json> [-o out.svg]
```

Reads a JSON config, renders each scene, and writes one animated SVG (to the
config's `output`, `-o`, or stdout).

## Config

```jsonc
{
  "$schema": "./schemas/storyboard-config.schema.json",
  "width": 1280,
  "height": 720,
  "background": "#0b1020",        // optional — a full-canvas rect behind every scene
  "title": "Product tour",        // optional — a11y name  (role=img + <title>)
  "desc": "…",                    // optional — a11y long description (<desc>)
  "scenes": [
    {
      "template": "title-card",   // ── one source per scene (see below) ──
      "params": { "title": "Domotion", "subtitle": "DOM → animated SVG" },
      "duration": 2500,           // ms on screen
      "transition": { "type": "crossfade", "duration": 400 }   // TO the next scene
    },
    { "capture": { "file": "./demo.html" }, "duration": 2000,
      "transition": { "type": "push-left", "duration": 400 } },
    { "cast": "./session.cast", "term": { "theme": "dark" }, "duration": 3000,
      "transition": { "type": "scroll", "duration": 400 } },
    { "svg": "./closing-card.svg", "duration": 2500,
      "transition": { "type": "cut", "duration": 0 } }   // last scene loops → scene 1
  ]
}
```

### Scene sources (exactly one per scene)

- **`template`** — a named template (`domotion template list`) rendered as the
  scene. `params` is validated against that template's own schema. The template
  inherits the canvas `width`/`height` by default (so it fills the scene).
- **`capture`** — a live capture of a URL or local file: `{ "url" | "file",
  "selector"?, "wait"?, "waitFor"?, "mobile"?, "colorScheme"? }`. Captured
  HTML/CSS → native SVG, exactly like `domotion capture`. A **static** scene.
- **`cast`** — an asciinema v2 `.cast` rendered as an animated terminal (doc 67),
  with an optional `term` options block.
- **`svg`** — a path to a **pre-rendered** SVG (static or animated) — the output
  of any earlier `capture` / `animate` / `template` / `composite` run. An
  animated svg's play length is auto-detected from `--scene-dur` / its longest
  `animation:` duration; override with `period` (ms) when it can't be detected.

### Duration

`duration` is the time a scene is held on screen (ms).

- For an **animated** source (a `template` with an intrinsic play time, a `cast`,
  or an animated `svg`), `duration` is **optional** — omit it to inherit the
  scene's own play time. Setting it shorter than the scene plays cuts the scene
  off (a warning is logged).
- For a **static** source (a `capture`, or a static `svg`), `duration` is
  **required** (there's no intrinsic play time to inherit).

### Placement (`fit`)

When a scene's intrinsic size differs from the canvas, `fit` places it (mirrors
the `animate` template-frame policy): `center` (default; 1:1, oversized →
clipped), `contain` (scale to fit, letterboxed), `cover` (scale to fill,
cropped).

### Transitions

`transition` is the effect FROM this scene TO the next. The last scene's
transition (if any) dissolves back to scene 1 on loop; omit it to hold-then-cut.

The runner reuses the animator's frame-transition enum (`generateAnimatedSvg`) —
it does **not** reinvent transitions. The opaque-scene-safe subset is exposed:

| `type` | Effect |
| --- | --- |
| `crossfade` | Fade the outgoing scene out while the incoming fades in (a dissolve). |
| `cut` | Instant switch — no fade, no slide (`duration` ignored). |
| `push-left` | The outgoing scene slides off left while the incoming slides in from the right (horizontal directional). |
| `scroll` | The vertical equivalent of `push-left` (slide up / in from below). |

> `magic-move` (doc 53) is intentionally **not** offered: it needs a per-frame
> element-tree bridge built from two captured DOMs, which distinct opaque scenes
> don't share. **Reveal transitions** (wipe / iris / zoom / shine) are a planned
> follow-up — they land here once the transition-effect expansion adds them to
> the shared animator's frame path (see "Roadmap").

## How it works (reuse, not rebuild)

A storyboard IS an `animate`-style multi-frame composition where each "frame" is
a whole scene. The runner reuses the exact template-frame / cast-frame embedding
machinery (docs 62 / 67 / 73):

1. **Render** each scene to a self-contained (possibly animated) SVG + intrinsic
   size + play length (`renderTemplateToSvg` / `castToAnimatedSvg` / a live
   `captureElementTree` → `elementTreeToSvg` / a file read).
2. **Namespace** each with a per-scene token (`sb<i>_`) via
   `namespaceEmbeddedAnimatedSvg` — SVG/CSS ids, font families, frame classes,
   `@keyframes`, and `--scene-dur` are document-global, so sibling scenes would
   otherwise collide once concatenated.
3. **Place** it in the canvas with `placeEmbeddedFrame` per `fit`.
4. **Wrap** it as an `AnimationFrame` carrying `embeddedAnimationPeriodMs` (the
   scene's own play length) so the animator **re-anchors** the scene's internal
   timeline to start when the scene is shown and **hold** before/after
   (`offsetEmbeddedAnimatedSvgTimeline`, DM-1319) — each scene runs its own
   animation only while on screen.
5. **Sequence** the frames through `generateAnimatedSvg`, which emits the
   CSS-`@keyframes` inter-scene transitions.

The output is a normal animated SVG: CSS `@keyframes` only (plays in `<img>`, no
JS/SMIL), rests at identity, cross-engine-safe (opacity / transform / clip).

Programmatic entry point: `composeStoryboardConfig(browser, config, configDir,
log?)` in `src/cli/storyboard.ts`.

## MP4 / video export

A storyboard is just an animated SVG, so it exports to video with the existing
`svg-to-video` bin (doc 78's sibling) — no storyboard-specific export path:

```sh
domotion storyboard story.json -o story.svg
svg-to-video story.svg -o story.mp4       # .mp4 / .webm / .mov / …
```

(Verified end-to-end: the 4-scene demo below round-trips through `svg-to-video`
to a valid H.264 MP4.)

## Published JSON Schema

`schemas/storyboard-config.schema.json` is generated from the zod
`storyboardConfigSchema` (the single source of truth) by
`npm run build:storyboard-schema` — point a config's `"$schema"` at it for editor
autocompletion. A sync test (`storyboard-config-json-schema.test.ts`) keeps it
from drifting. The exactly-one-source-per-scene rule (and the
`params`/`term`/`period` companion-field rules) stay enforced at runtime by zod;
they have no JSON Schema equivalent.

## Example

`examples/storyboard-demo.ts` (committed golden:
`examples/output/storyboard-demo.svg`) sequences all four scene kinds with a
different transition between each: title-card `──crossfade──▶` live HTML capture
`──push-left──▶` kinetic-text `──scroll──▶` a pre-rendered CTA `──cut──▶` (loops).

```sh
npx tsx examples/storyboard-demo.ts   # → examples/output/storyboard-demo.svg
```

## Roadmap / follow-ups

- **Reveal transitions** (wipe / iris / zoom / shine): expose them here once the
  transition-effect expansion adds them to the shared animator frame path. The
  storyboard transition enum then just widens to include them — no new
  storyboard-side machinery.
- **Cross-scene font dedup:** each scene currently embeds its own `@font-face`
  payload (self-contained, namespaced). `composite` already dedupes byte-identical
  payloads across layers (DM-1329) and shares one builder across cast layers
  (DM-1331); the same treatment can shrink a storyboard whose scenes share a font.
- **Per-scene overlays / cursor:** `animate` frames support typing / tap / svg /
  blink overlays and a scene-spanning cursor; a storyboard scene does not yet.

## Pointers

- `src/cli/storyboard.ts` — the runner (`storyboardConfigSchema`,
  `composeStoryboardConfig`, `runStoryboard`).
- `src/cli/storyboard-config-json-schema.ts` + `scripts/generate-storyboard-schema.ts`
  — the published JSON Schema.
- `src/animation/animator.ts` (`generateAnimatedSvg`) — the sequencing +
  transition emitter.
- `src/animation/embed-namespace.ts` / `embed-timeline.ts` — per-scene name
  namespacing + timeline re-anchoring.
- `src/cli/animate.ts` (`placeEmbeddedFrame`) — canvas placement per `fit`.
- Related: doc 43 (animate config), doc 77 (composite), doc 78 (svg-to-image /
  svg-to-video), doc 73 (template frames), doc 67 (terminal capture).
```
