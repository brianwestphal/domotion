# 70 — Template system

Status: **shipped** (DM-1276 spike + the first-party library). The `Template`
contract, the registry/loader, the `domotion template` CLI verb, and **seven**
built-in templates (`lower-third`, `device-mockup`, `background-loop`,
`kinetic-text`, `chart`, `chat`, `subscribe`) are implemented and tested. The
only remaining follow-up is the Lottie input adapter (not yet built).

## What a template is (and isn't)

A Domotion **template** is a *parameterized generator* — a `render(params)`
function that produces a self-contained SVG by driving Domotion's **existing**
capture → compose pipeline. It is **not** a baked vector asset (the After Effects
/ Lottie model) and Domotion is **not** a real-time motion engine.

The reframing matters: a template's `render()` may do arbitrary expensive
pre-processing (synthesize per-word keyframes, lay out a chart, capture a live
page) because that work runs **once at author time** — the emitted SVG then
replays for free. And because templates are authored in HTML/CSS, they reflow,
re-theme, and use real web fonts, which baked keyframes can't.

Templates add **no new rendering code**. They are thin front-ends onto the
animate / capture pipeline, exactly like the terminal (`--cast`) and live-pty
front-ends are front-ends onto one terminal backend. Every fidelity fix in the
core pipeline is inherited automatically.

A template is invokable three ways: the `domotion template <name>` CLI verb
(below), the programmatic `renderTemplateToSvg` API, and — as of DM-1287 — as a
`template` frame **inside an `animate` config**, so a template composes
declaratively into a larger multi-frame animation. See **`docs/73-template-frames.md`**.

Two shapes have emerged, both expressible on one contract:

- **Generator** (e.g. `lower-third`): synthesizes HTML/CSS + an `animate` config
  and runs it for *animated* output.
- **Decorator** (e.g. `device-mockup`): wraps/post-processes existing content.
  Its `input`-capture path renders a page to a *static* SVG and frames it. To
  frame **animated** content, `device-mockup` takes a `screenSvg` param (DM-1323)
  that nests a pre-rendered animated SVG (a cast, a scroll capture, an `animate`
  result) with animation intact — `wrapInDeviceChrome` nests rather than
  re-renders, so the motion survives. For general multi-layer animated nesting
  (a framed window *on a desktop*, etc.) use the `composite` primitive /
  `domotion composite` verb (doc 77).

## The contract

```ts
interface Template<P> {
  name: string;                 // the `domotion template <name>` verb + registry key
  description: string;          // one-liner for `template list` / `--help`
  paramsSchema: ZodType<P>;     // validated + projected to JSON Schema for --help
  render(params: P, ctx: TemplateRenderContext): Promise<TemplateOutput>;
}
interface TemplateOutput { svg: string; width: number; height: number; durationMs?: number; }
```

`durationMs` (optional, DM-1294) is the output's intrinsic play time — a
*generator* reports it (its `holdMs` / computed reveal end / loop period), a
static *decorator* omits it. A `template` frame in an `animate` config uses it to
default the frame's `duration` (doc 73).

`render` receives already-validated, defaulted params and a context of building
blocks:

```ts
interface TemplateRenderContext {
  browser: Browser;             // shared; the template must NOT close it
  workDir: string;              // scratch dir; default configDir for generated configs
  log: (msg: string) => void;
  runAnimateConfig(cfg, configDir?): Promise<string>;   // → animated SVG (generators)
  captureToSvg(params): Promise<TemplateOutput>;          // → static SVG (decorators)
}
```

**Use `captureToSvg` for a decorator, not a one-frame `runAnimateConfig`.** A
static capture SVG nests cleanly inside a bezel; an *animated* SVG's keyframe
`<style>` + frame-group wrappers do not survive `wrapInDeviceChrome`'s
re-nesting (the screen renders blank). `device-mockup` learned this the hard
way during the spike.

Numeric params should use `z.coerce.number()` so a CLI string flag (`--width
960`) and a JSON value (`"width": 960`) both validate. The JSON-Schema
projection (`templateParamsJsonSchema`, mirroring the animate-config schema in
`src/cli/animate-config-json-schema.ts`) drives `--help` and tells the CLI which
params take a boolean presence flag vs a string value.

## CLI

```sh
domotion template list                         # the built-in templates
domotion template <name> --help                # a template's parameters
domotion template <name> [--param …] -o out.svg
```

Params arrive as scalar flags derived from the schema (`--title "…"`), and/or as
JSON via `--params '<json>'` / `--params-file <file.json>` for nested/array
params. Precedence: individual flags > `--params` > `--params-file`. The verb
shares `animate`'s optimize / `.svgz` / output handling.

Examples:

```sh
domotion template lower-third --title "Ada Lovelace" --subtitle "First Programmer" \
  --accent "#22d3ee" -o title.svg

domotion template device-mockup --input ./app.html --device browser \
  --label "acme.dev/app" --width 960 --height 600 -o mockup.svg
```

## Distribution — npm by convention

A third-party template is a plain npm package named `domotion-template-<name>`
whose default (or named `template`) export is a `Template`. `domotion template
<name>` resolves a built-in first, then dynamically imports
`domotion-template-<name>`. So **"plugins" and "built-ins" are the same
mechanism** — first-party templates just live in-repo and seed the registry; the
npm graph is the registry. An unknown name or a package whose export isn't a
valid `Template` fails with an actionable error.

The full **third-party authoring & publishing guide** is **`docs/74-template-
authoring.md`** (package shape, generator vs decorator, the animation
constraints, params, testing, the discovery convention), with a runnable scaffold
in **`examples/template-package/`** (`domotion-template-quote-card`) and a public
template gallery on the site (`site/src/content/docs/usage/templates.md`).

## Built-in templates

| Template | Kind | Headline |
|---|---|---|
| `lower-third` | generator | Broadcast-style banner (title + subtitle + accent) that slides + fades in. The reveal is a real intra-frame `animations` (opacity + translateY), not baked into the capture. |
| `device-mockup` | decorator | Wrap a captured URL/page in a phone / browser / window bezel. Reuses the shipped `wrapInDeviceChrome` (doc 65) as the single source of truth, so it can't diverge from `capture --chrome`. |
| `background-loop` | generator | Procedural seamlessly-looping animated background — `aurora` / `orbs` / `stars` blobs, a `gradient-pan` color wash, a drifting `grid`, or `wave` ribbon bands. Deterministic from a `seed`; comma-separated `--colors`. See **doc 71**. |
| `kinetic-text` | generator | Kinetic typography — reveal a headline word-by-word or char-by-char with a staggered one-shot animation (`rise` / `slide` / `fade` / `clip` / `pop`). See **doc 72**. |
| `chart` | generator | Data/infographics — an animated `column` / `bar` / `line` chart from a list of values (bars grow, the line draws in). See **doc 75**. |
| `chat` | generator | A message thread whose bubbles pop in one at a time, alternating sides (iMessage / WhatsApp style). See **doc 76**. |
| `subscribe` | generator | A subscribe / follow pop-up card that pops in with a pulsing call-to-action button. See **doc 76**. |

## Code

- **`src/templates/types.ts`** — the `Template` / `TemplateRenderContext` /
  `TemplateOutput` / `CaptureToSvgParams` contract + the `isTemplate` shape guard.
- **`src/templates/render.ts`** — `validateTemplateParams`, `renderTemplateToSvg`
  (owns a temp `workDir` + browser + the wired context), and the `captureToSvg`
  static-capture primitive (the `domotion capture` recipe).
- **`src/templates/registry.ts`** — built-in registry + `loadTemplate`
  (built-in, else `domotion-template-<name>` npm resolution).
- **`src/templates/json-schema.ts`** — `templateParamsJsonSchema` /
  `describeTemplateParams` (zod → JSON Schema, the same machinery as the animate
  config).
- **`src/templates/builtin/`** — the seven built-ins (`lower-third`,
  `device-mockup`, `background-loop`, `kinetic-text`, `chart`, `chat`,
  `subscribe`), registered in `registry.ts`. Their pure HTML/plan builders
  (e.g. `buildLowerThirdHtml`) are unit-tested without a browser.
- **`src/cli/template.ts`** — the `domotion template` verb.
- Public API: the contract, registry, render, and all seven built-ins are re-exported
  from the package root (`src/index.ts`).

## Examples

`examples/output/templates/` holds committed example SVGs across the built-ins
(both `lower-third` themes, the `device-mockup` bezels, the `background-loop`
variants, `kinetic-text` reveals, `chart` types, `chat`, `subscribe`).
Regenerate with `npx tsx examples/templates-demo.ts` (also wired into
`npm run demos:examples`). The generator uses only the public
`renderTemplateToSvg` API, so it doubles as worked usage. (`examples/templates/`
itself holds the authoring scaffold — `README.md` + `sample-app.html`.)

## Follow-ups

The first-party library that the spike validated is now **shipped** — kinetic
typography (doc 72), chat + subscribe (doc 76), charts (doc 75), and
backgrounds/loops (doc 71) are all built-ins. The third-party authoring guide +
discovery/gallery shipped too (DM-1282) — see `docs/74-template-authoring.md`,
`examples/template-package/`, and the manual's Templates page. The **only**
remaining follow-up is a Lottie **input adapter** (`domotion-template-lottie` —
Lottie stays an input, never the engine), not yet built.

**Resolved — `capture --chrome` is NOT folded onto the `device-mockup`
template.** The bezel-drawing logic is already a single source of truth
(`wrapInDeviceChrome` in `src/render/device-chrome.ts`), called identically by
both surfaces — there is no duplicated bezel code. They differ only in how they
*capture* before wrapping, and that difference is deliberate: `capture --chrome`
runs the full capture-CLI pipeline (`--scroll`, `--debug` bundles, `--clip`, HAR,
…) while the template's `captureToSvg` is a minimal primitive. Delegating would
regress those CLI-only features for chromed captures, so the two stay separate
with `wrapInDeviceChrome` as the shared SSOT.
