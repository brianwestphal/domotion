# 74 — Authoring & publishing a third-party template

Status: **shipped** (DM-1282). This is the hands-on guide for **third-party
authors** who want to publish a reusable Domotion template as an npm package.
It builds on doc 70 (the template system + the `Template` contract) and doc 73
(using a template inside an `animate` config). The contract reference lives in
doc 70; this doc is the *how-to*.

A complete, runnable scaffold lives in **`examples/template-package/`**
(`domotion-template-quote-card`) — copy it as your starting point. Everything
below is demonstrated there.

## The deal: a template is just an npm package

A Domotion template is an ordinary npm package named **`domotion-template-<name>`**
that exports a `Template`. There is no registry to sign up for, no plugin API to
implement, no config to edit. A user runs:

```sh
npm install -g domotion-svg domotion-template-quote-card
domotion template quote-card --quote "Ship it." -o quote.svg
```

…and `domotion template quote-card` resolves the bare name `quote-card` to the
`domotion-template-quote-card` package by convention (see *Discovery* below).
Built-in templates and third-party packages use the **exact same mechanism** —
the npm graph *is* the registry.

## Package shape

Three things make a valid package:

1. **Name** it `domotion-template-<name>` (the `<name>` is what users type).
2. **Export** the `Template` as the **default export** (or a named `template`
   export) from the package's main entry.
3. **Depend** on `domotion-svg` as a **peer dependency** — it's used only for the
   TypeScript types (`Template`, `TemplateRenderContext`, `TemplateOutput`); the
   render context is supplied by the host at runtime. `zod` is a normal
   dependency (it describes + validates your params).

```jsonc
// package.json (see examples/template-package/package.json)
{
  "name": "domotion-template-quote-card",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "peerDependencies": { "domotion-svg": ">=0.14.0" },
  "dependencies": { "zod": "^4.0.0" }
}
```

```ts
// index.ts
import type { Template } from "domotion-svg";
export const quoteCardTemplate: Template<QuoteCardParams> = { name, description, paramsSchema, render };
export default quoteCardTemplate;   // ← what loadTemplate("quote-card") picks up
```

## The contract you implement

```ts
interface Template<P> {
  name: string;          // the registry key + `domotion template <name>`
  description: string;   // one line; shown by `domotion template list`
  paramsSchema: ZodType<P>;
  render(params: P, ctx: TemplateRenderContext): Promise<TemplateOutput>;
}
```

`render` receives **already-validated, defaulted** params (the host runs your
`paramsSchema` first) and a context of building blocks:

```ts
interface TemplateRenderContext {
  browser: Browser;            // shared Chromium — do NOT close it
  workDir: string;             // scratch dir; default base for relative `input` paths
  log: (msg: string) => void;  // progress (stderr in the CLI)
  runAnimateConfig(cfg, configDir?): Promise<string>;   // → an animated SVG (generators)
  captureToSvg(params): Promise<TemplateOutput>;        // → a static SVG (decorators)
}

interface TemplateOutput { svg: string; width: number; height: number; durationMs?: number; }
```

You return a **complete, self-contained `<svg>` document** plus its dimensions.
You add **no rendering code** — `runAnimateConfig` / `captureToSvg` route your
HTML through the same capture/compose pipeline everything else uses, so every
fidelity fix in the core is inherited for free.

## Two shapes

### Generator — synthesize HTML/CSS, run it animated

The common case (`lower-third`, `kinetic-text`, the example `quote-card`): build
an HTML string, write it into `ctx.workDir`, and run it through
`ctx.runAnimateConfig`. Animate it with **intra-frame `animations`** (doc 08),
not baked keyframes — that's how the output stays re-themeable and the text stays
real, selectable glyph paths.

```ts
async render(p, ctx) {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(ctx.workDir, "card.html"), buildHtml(p));
  const svg = await ctx.runAnimateConfig({
    width: p.width, height: p.height,
    frames: [{
      input: "card.html",        // relative → resolves against ctx.workDir
      duration: p.holdMs,
      transition: { type: "cut", duration: 0 },
      animations: [
        { selector: ".inner", property: "opacity",    from: "0",     to: "1",   duration: 500 },
        { selector: ".card",  property: "translateY", from: "0.6em", to: "0em", duration: 650 },
      ],
    }],
  });
  return { svg, width: p.width, height: p.height, durationMs: p.holdMs };
}
```

### Decorator — wrap a captured page

For a template that captures a user-supplied URL/file and post-processes it (like
`device-mockup` wrapping a page in a bezel), use `ctx.captureToSvg` to get a
**static** SVG, then transform it.

**Use `captureToSvg`, not a one-frame `runAnimateConfig`, for decorators.** A
static capture SVG nests cleanly inside a wrapper; an *animated* SVG's keyframe
`<style>` + frame-group wrappers don't survive re-nesting (doc 70).

## The two animation constraints

These come straight from the SVG output model — respect them or motion breaks
(both are demonstrated in `background-loop` / doc 71 and `kinetic-text` / doc 72):

1. **One intra-frame animation per captured element.** A second `animations`
   entry on the same selector overrides the first. So put the *move* on a wrapper
   and the *fade* on an inner element — two distinct selectors, two animations.
2. **SVG transforms are origin-(0,0).** `scale`/`rotate` pivot about the SVG
   origin, not the element — so motion is normally restricted to origin-safe
   `translate` + `opacity`, looped with `alternate: true` for seamless ambient
   loops. To scale/rotate **about an element's own center**, set
   `transformOrigin: "center"` on the animation (DM-1297) — the renderer emits
   `transform-box: fill-box; transform-origin: …` so the transform pivots about
   the element's box (doc 08).

## Params: schema, coercion, defaults

`paramsSchema` does triple duty: it **validates** input, supplies **defaults**,
and is **projected to CLI flags** + a JSON Schema.

- Use **`z.coerce.number()` / `z.coerce.boolean()`** for non-string scalars so the
  CLI's string flags AND raw JSON values both parse.
- Give every field a **`.describe()`** — it's the text `domotion template <name>
  --help` prints.
- Scalar params (string / number / boolean / enum) become `--flags`
  automatically; arrays / objects are reachable via `--params '<json>'` /
  `--params-file`. (A `union(string | array)` lets an array param also accept a
  comma-separated flag — see `background-loop`'s `--colors`.)
- Invalid params fail before render with a path-specific error.

## `durationMs` — play nicely in animate configs

A generator should return **`durationMs`** (its on-screen play time, or one loop
period). When a user drops your template into an `animate` config as a `template`
frame and omits the frame `duration`, it inherits this value (doc 73). A static
decorator omits `durationMs`.

## Testing

Test with the public **`renderTemplateToSvg`** API — no need to shell out to the
CLI. Keep your HTML/animation builders pure so most logic is testable without a
browser:

```ts
import { renderTemplateToSvg } from "domotion-svg";
import quoteCard, { buildQuoteCardHtml } from "./index.js";

it("escapes text", () => expect(buildQuoteCardHtml({ quote: "<b>", /* … */ })).toContain("&lt;b&gt;"));
it("renders", async () => {
  const out = await renderTemplateToSvg(quoteCard, { quote: "Ship it." });   // needs Chromium
  expect(out.svg).toMatch(/@keyframes/);
});
```

## Build & publish

```sh
npm run build      # tsc → dist/ (ship the compiled JS + .d.ts, per "files")
npm publish        # the name MUST be domotion-template-<name>
```

Add the `domotion-template` keyword to `package.json` so the package is
discoverable on the npm registry (see *Discovery*).

## Discovery — the `domotion-template-*` convention

`loadTemplate(name)` (`src/templates/registry.ts`) resolves a bare `name` in two
steps:

1. Is it a **built-in**? (`lower-third` / `device-mockup` / `background-loop` /
   `kinetic-text` / `chart` / `chat` / `subscribe`, plus the creative pack
   `title-card` / `quote` / `caption` / `cta` / `counter` / `stat` / `compare`.)
   If so, use it.
2. Otherwise `import("domotion-template-" + name)` and validate the export with
   `isTemplate()`.

An unknown name fails with an actionable message naming the built-ins and the
`npm install domotion-template-<name>` to run; a package that doesn't export a
valid template fails saying so.

**Finding templates.** Third-party templates are plain npm packages, so the
registry is the discovery surface: search npm for the **`domotion-template`**
keyword (or the `domotion-template-` name prefix). The site's
[Templates page](../site/src/content/docs/usage/templates.md) showcases the
built-ins and the
[custom-templates guide](../site/src/content/docs/developer/custom-templates.md)
covers "write your own"; a curated community gallery can layer on top of
the same npm convention without any new infrastructure.

## See also

- doc 70 — the template system + the full `Template` / context / output contract.
- doc 73 — using a template as a frame in an `animate` config.
- doc 08 — the intra-frame `animations` surface (`property`, `transformOrigin`, …).
- doc 71 / 72 — the `background-loop` / `kinetic-text` built-ins as worked
  generators (the two animation constraints in practice).
- `examples/template-package/` — the runnable `domotion-template-quote-card` scaffold.
