# 73 — Template frames in the `animate` config

Status: **shipped** (DM-1287). A frame in an `animate` config (doc 43 / doc 08)
may embed a named Domotion template (doc 70) instead of capturing an `input` page
or a terminal `cast`. This is the declarative way to compose a template — a
`lower-third` banner, a `kinetic-text` title, a `device-mockup` framing — into a
larger multi-frame animation, without dropping to the programmatic
`renderTemplateToSvg` API.

It is the config-level use doc 70 anticipated ("an animate config could reference
a template for one frame") and the doc-70 follow-up to the `domotion template` CLI
verb.

## Surface

A new frame kind, alongside `input` / `cast` / `continue`:

```jsonc
{
  "width": 1280, "height": 720,
  "frames": [
    { "input": "intro.html", "duration": 1500, "transition": { "type": "crossfade", "duration": 300 } },
    { "template": "lower-third",
      "params": { "title": "Ada Lovelace", "subtitle": "First Programmer", "accent": "#22d3ee" },
      "duration": 3000, "transition": { "type": "cut", "duration": 0 } }
  ]
}
```

- **`template`** — a template name resolved exactly like the CLI verb: a built-in
  (`lower-third`, `device-mockup`, `background-loop`, `kinetic-text`) or an
  installed `domotion-template-<name>` package (see doc 70).
- **`params`** — the template's parameters, **validated against that template's
  own zod schema** at compose time. Unknown template name or invalid params fail
  with a path-specific error (`animate: frames[2]: template "lower-third": invalid
  params — title: …`).
- `duration` and `transition` work as on any frame.

### Validation rules

- Frame 0 may be a `template` frame (it doesn't need an `input` / `cast`).
- `template` is mutually exclusive with `input`, `cast`, and `continue` — a
  template frame is its own self-contained content source.
- `params` without a `template` is an error (nothing to validate against).
- `${vars}` interpolation applies to `params` string values like every other
  config string field (doc 43 §7) — interpolation runs before template validation.

## Sizing & placement

The template **inherits the config's `width`/`height` by default**: when the
template's params schema declares `width` / `height` (the generators all do) and
the caller didn't set them in `params`, the config's canvas size is injected, so
the template fills the frame.

A template whose output still differs from the canvas — e.g. `device-mockup`,
which grows by its bezel — is **centered** within the frame. An output larger than
the canvas is centered and **clipped** to the frame viewport (a log note warns).
There is no auto-scaling; author the template at the frame size for a pixel-exact
fit. (A `fit: contain | cover | center` option is a filed follow-up.)

## Timeline

The template's own internal animation plays within the frame's `duration`, the
same rule as a `cast` frame: size `duration` to ≈ the template's play time. If the
frame is longer, the template finishes and holds its last state; if shorter, it is
cut off. The frame `duration` is authored explicitly — it is not auto-derived from
the template (a `TemplateOutput.durationMs` for auto-sizing is a filed follow-up).

## How it works (implementation)

A template is itself a front-end onto `composeAnimateConfig`, so a template frame
is `config → template → (its own) config → nested animated SVG`. Two things make
that nesting correct (`src/cli/animate.ts`):

1. **Pre-render before the outer font lifecycle.** `renderTemplateFrames` renders
   every template frame **up front**, before the outer run clears the
   module-global webfont / embedded-font builders. The nested per-template
   `composeAnimateConfig` clears + manages those builders itself; doing it first
   keeps each template's output self-contained (its own `@font-face`) and stops
   the nested run from clobbering the outer frames' embedded fonts. Each template
   SVG is a finished string by the time the outer loop reaches its frame, which it
   then nests exactly like a `cast` frame (strip the XML prolog, push as
   `svgContent`).

2. **Namespace the nested document's global names.** SVG and CSS names are
   document-global — they do **not** scope to a nested `<svg>` subtree — so the
   template's `generateAnimatedSvg` output collides with the outer animation (and
   sibling template frames) on element ids, embedded-font families (`dmfN`),
   frame/anim classes (`.f`, `.f-N`, `.anim-…`), `@keyframes` names (`fv-N`, the
   intra-frame `f0-…`), and the `:root { --scene-dur }` custom property. A
   duplicate `@font-face` family or `@keyframes` name makes the later one win
   globally, which reshapes the OTHER frame's text or hijacks its timeline.
   `namespaceEmbeddedAnimatedSvg` (`src/animation/embed-namespace.ts`) prefixes
   every such name with a per-frame token (`tf<i>_`). The vocabulary is fully
   renderer-controlled, so the rewrite is precise (it never touches CSS decimals,
   base64 font bytes, or captured content).

   This is the same collision the `cast` path sidesteps for fonts only, by sharing
   the outer embedded-font builder (`manageFonts: false`). A template can't share
   that state (it runs a fully independent compose), so it is namespaced after the
   fact instead. The cast path could adopt the same namespacing for the
   mixed-cast-plus-input case (a filed follow-up).

## Tests

- `src/animation/embed-namespace.test.ts` — the namespacing pass (ids, fonts,
  classes vs CSS decimals, keyframes, `--scene-dur`, two-token isolation).
- `src/cli/animate.test.ts` → "template frames (DM-1287)" — schema validation
  (acceptance at frame 0, mixed with html frames, the mutual-exclusion + bare-
  `params` rejections).
- `tests/compose-animate-frames.e2e.test.ts` — an html frame + a `lower-third`
  template frame compose with no duplicate `@font-face` family or `@keyframes`
  name across the merged document.

## See also

- doc 70 — the template system + `Template` contract.
- doc 43 — the declarative `animate` config contract (§9 lists this frame kind).
- doc 08 — the animation model (frame composition, intra-frame animations).
