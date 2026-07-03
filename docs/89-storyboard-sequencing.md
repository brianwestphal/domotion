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
  ],
  "cursor": {                     // optional — a scene-spanning cursor track (DM-1554)
    "events": [
      { "frame": 1, "at": 300, "type": "moveClick", "to": { "x": 640, "y": 360 } }
    ]
  }
}
```

A scene may also carry `overlays` (per-scene typing / tap / svg / blink / shine / interact):

```jsonc
{ "capture": { "file": "./demo.html" }, "duration": 2400,
  "transition": { "type": "wipe", "duration": 500 },
  "overlays": [
    { "kind": "typing", "text": "Typed on top", "x": 300, "y": 430, "caret": true },
    { "kind": "tap", "x": 640, "y": 360, "delay": 1400 }
  ] }
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
it does **not** reinvent transitions. The full **cross-engine-safe (opaque-scene-
safe)** vocabulary is exposed — the originals plus the DM-1524 expansion (docs/88),
plumbed straight through (DM-1552; no storyboard-side machinery, just a wider enum):

| `type` | Effect |
| --- | --- |
| `crossfade` | Fade the outgoing scene out while the incoming fades in (a dissolve). |
| `cut` | Instant switch — no fade, no slide (`duration` ignored). |
| `push-left` / `push-right` | The outgoing scene slides off one side; the incoming slides in from the other (horizontal directional). |
| `scroll` (== `push-up`) / `push-down` | The vertical directional pushes (slide up-and-in-from-below, or down-and-in-from-above). |
| `wipe` | A linear left→right `clip-path` reveal — the incoming scene unveils on top while the outgoing holds beneath. |
| `iris` | An expanding-circle `clip-path` reveal from the center. |
| `zoom-in` / `zoom-out` | A scale dolly under a crossfade — the incoming scene grows `0.9→1` (in) or settles `1.1→1` (out), resting at `scale(1)`. |
| `shine` | A crossfade with a swept gradient highlight over the handoff window. |

Every one is pure `transform` / `clip-path` / `opacity` / gradient (no animated CSS
`filter`), so it plays identically on Blink and WebKit — see docs/88 for the full
effect reference.

> `magic-move` (doc 53) is intentionally **not** offered: it needs a per-frame
> element-tree bridge built from two captured DOMs, which distinct opaque scenes
> don't share.

## Per-scene overlays (DM-1554)

Each scene may carry an `overlays` array — the SAME authoring vocabulary and
render path `animate` uses (typing / tap / svg / blink / shine / interact — docs 43 / 88 / 94),
reused verbatim. A `capture` scene can thus show a typed-caption / tap demo layered
on top of the live capture:

```jsonc
"overlays": [
  { "kind": "typing", "text": "Overlays on a live capture", "x": 300, "y": 430, "caret": true },
  { "kind": "tap", "x": 640, "y": 360, "delay": 1400 }
]
```

Overlay coordinates are in the **canvas** coordinate space (overlays paint at the
top level, on top of the placed scene — the same convention `animate`'s embedded
`cast`/`template` frames follow). A scene retains **no live DOM** by the time the
storyboard is assembled, so a selector `anchor` (or typing `maxWidth: "anchor"`)
can't resolve — it warns and falls back to the overlay's explicit `x`/`y`. Position
overlays with explicit coordinates (a fixed `wrapWidth` for a typing field).

## Scene-spanning cursor (DM-1554)

A storyboard-level `cursor` track paints ONE macOS-style pointer that glides and
clicks across the **whole loop** (across scene boundaries), so a capture scene's
typing / tap demo can be driven by a visible cursor. It reuses `animate`'s cursor
event / style authoring (doc 13 / §6), restricted to the **explicit** form:

- Events carry **absolute `to` coordinates** — `frame` is the SCENE index, `at` is
  ms into that scene. There is no `"auto"` mode (a storyboard has no interaction
  actions to derive a cursor from) and no `selector` events (a scene retains no
  live DOM to resolve against — using one is a validation error).
- Event `type`s: `move`, `click`, `moveClick`, `hide` (hide the pointer, e.g. so it
  doesn't linger into later scenes after its click).

```jsonc
"cursor": {
  "style": { "scale": 1.1 },
  "events": [
    { "frame": 1, "at": 300, "type": "moveClick", "to": { "x": 640, "y": 360 } },
    { "frame": 1, "at": 2000, "type": "hide" }
  ]
}
```

## Cross-scene font dedup (DM-1553)

Two mechanisms — both ported from `composite` (doc 77) — shrink a storyboard whose
scenes share a font:

1. **Shared-builder cast merge** (DM-1331): every `cast` scene renders through ONE
   embedded-font builder (`manageFonts:false`), so several terminals in the same
   monospace embed its **union** glyph subset **once**, not one subset per scene.
   The single finished `@font-face` block is collected with `getEmbeddedFontFaceCss()`
   and emitted once by `generateAnimatedSvg` (`config.fontFaceCss`); those scenes
   keep their `dmfN` families **un-prefixed** during namespacing so they resolve
   against it.
2. **Byte-identical-payload collapse** (`dedupeCompositeFonts`, DM-1329): the
   assembled SVG is post-processed to fold any two scenes that embed the exact same
   base64 payload (a reused face across `template`/`svg` scenes, or the same scene
   twice) down to a single copy, repointing the removed families at the survivor.

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
`──wipe──▶` kinetic-text `──zoom-in──▶` a pre-rendered CTA `──cut──▶` (loops). The
capture scene also carries per-scene overlays (a typed caption + a tap ripple), and
a storyboard-level cursor track glides a pointer onto the card, clicks, then hides
— exercising DM-1552 (reveal transitions), DM-1554 (overlays + cursor), and DM-1553
(shared-font dedup) together.

```sh
npx tsx examples/storyboard-demo.ts   # → examples/output/storyboard-demo.svg
```

## Roadmap / follow-ups

- **Anchored overlays on a `capture` scene:** overlays currently take explicit
  `x`/`y` (a selector `anchor` warns and falls back), because the storyboard
  assembly no longer holds the captured scene's live DOM. A future pass could
  resolve anchors for `capture` scenes against their page during capture (the
  `animate` per-frame model, which keeps the page live, already does this).

## Pointers

- `src/cli/storyboard.ts` — the runner (`storyboardConfigSchema`,
  `composeStoryboardConfig`, `runStoryboard`).
- `src/cli/storyboard-config-json-schema.ts` + `scripts/generate-storyboard-schema.ts`
  — the published JSON Schema.
- `src/animation/animator.ts` (`generateAnimatedSvg`) — the sequencing +
  transition emitter.
- `src/animation/embed-namespace.ts` / `embed-timeline.ts` — per-scene name
  namespacing + timeline re-anchoring.
- `src/cli/animate.ts` — reused verbatim for placement (`placeEmbeddedFrame`),
  overlays (`resolveEmbeddedFrameOverlays` + the `overlaySchema` authoring union),
  and the cursor track (`buildCursorOverlay` + `cursorEventSchema` /
  `cursorStyleSchema`).
- `src/animation/composite.ts` (`dedupeCompositeFonts`) — the byte-identical
  `@font-face` collapse ported for cross-scene font dedup (DM-1553).
- Related: doc 43 (animate config), doc 77 (composite), doc 78 (svg-to-image /
  svg-to-video), doc 73 (template frames), doc 67 (terminal capture), doc 88
  (transition/effect expansion), doc 13 (cursor overlay).
