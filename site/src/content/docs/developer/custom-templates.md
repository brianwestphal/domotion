---
title: Building custom templates
description: Package reusable, parameterized SVG generators as domotion-template-<name> npm packages.
---

A template is a parameterized generator that produces a self-contained SVG
through Domotion's capture/compose pipeline. The built-ins (`lower-third`,
`device-mockup`, `background-loop`, `kinetic-text`, `chart`, `chat`,
`subscribe`) are just templates that ship in the box — you can author your own
and publish them as ordinary npm packages.

This page is the complete authoring guide: the contract you implement, a
step-by-step walkthrough of a real package, how to render and test it, and the
discovery convention that lets users invoke it by name.

## What a template is

A Domotion template is **not** a baked vector asset (the After Effects / Lottie
model), and Domotion is not a real-time motion engine. A template is a
`render(params)` function that produces a self-contained SVG by driving
Domotion's **existing** capture → compose pipeline.

That reframing is what makes templates powerful:

- A template's `render()` may do arbitrary expensive pre-processing —
  synthesize per-word keyframes, lay out a chart, capture a live page — because
  that work runs **once at author time**. The emitted SVG then replays for free.
- Because templates are authored in HTML/CSS, they reflow, re-theme, and use
  real web fonts, and the text is laid out by the browser and captured as crisp
  glyph paths — things baked keyframes can't do.
- Templates add **no new rendering code**. They are thin front-ends onto the
  same animate/capture pipeline everything else uses, so every fidelity fix in
  the core is inherited automatically.

Two shapes have emerged, both expressible on one contract:

- **Generator** (the common case — `lower-third`, `kinetic-text`, the example
  below): synthesize HTML/CSS plus an animation config and run it for *animated*
  output.
- **Decorator** (`device-mockup`): capture an existing page to a *static* SVG
  and wrap/post-process it (e.g. frame it in a device bezel).

## Why author one

The strongest way to keep many on-brand visuals consistent is to bake the brand
— palette, type scale, spacing, motion vocabulary — into a template and expose
only the content as parameters. Then every banner, card, or chart is
`domotion template <name> --title …` and is consistent by construction.

## The contract you implement

A template implements the `Template<P>` interface, where `P` is the type of its
validated parameters:

```ts
interface Template<P> {
  name: string;          // the registry key + `domotion template <name>` verb
  description: string;   // one line; shown by `domotion template list`
  paramsSchema: ZodType<P>;
  render(params: P, ctx: TemplateRenderContext): Promise<TemplateOutput>;
}
```

`render` receives **already-validated, defaulted** params (the host runs your
`paramsSchema` first) and a context of building blocks:

```ts
interface TemplateRenderContext {
  /** Shared Chromium browser. Do NOT close it — the host owns its lifecycle. */
  browser: Browser;
  /** Scratch dir to write generated HTML/assets into; the default base for a
   *  generated config's relative `input` paths. */
  workDir: string;
  /** Progress logger (stderr in the CLI; a no-op by default). */
  log: (msg: string) => void;
  /** Run an in-memory animate config through the pipeline → an animated SVG.
   *  Use this for generators. `configDir` resolves the config's relative
   *  `input`/overlay paths; defaults to `workDir`. */
  runAnimateConfig(cfg: AnimateConfig, configDir?: string): Promise<string>;
  /** Capture a page to a STATIC SVG (the `domotion capture` recipe). Use this
   *  for a decorator that wraps a captured page. */
  captureToSvg(params: CaptureToSvgParams): Promise<TemplateOutput>;
}
```

Your `render` returns a **complete, self-contained `<svg>` document** plus its
dimensions:

```ts
interface TemplateOutput {
  svg: string;       // a finished, self-contained <svg> document
  width: number;     // intrinsic width in px (after any bezel growth)
  height: number;    // intrinsic height in px
  durationMs?: number; // intrinsic play time in ms (see "durationMs" below)
}
```

You add no rendering code: `runAnimateConfig` and `captureToSvg` route your
HTML through the same capture/compose pipeline the rest of Domotion uses.

### Parameters: schema, coercion, defaults

`paramsSchema` does triple duty. It **validates** input, supplies **defaults**,
and is **projected to CLI flags** plus a JSON Schema for `--help` and editor
tooling. The zod schema stays the authoritative validator.

- Use **`z.coerce.number()` / `z.coerce.boolean()`** for non-string scalars, so
  the CLI's string flags (`--width 960`) and raw JSON values (`"width": 960`)
  both parse.
- Give every field a **`.describe()`** — that text is what
  `domotion template <name> --help` prints.
- Scalar params (string / number / boolean / enum) become `--flags`
  automatically. Arrays and objects are reachable via `--params '<json>'` or
  `--params-file <file.json>`. (A `z.union([z.string(), z.array(...)])` lets an
  array param also accept a comma-separated flag.)
- Invalid params fail **before** render with a path-specific error.

### How animation is expressed

Animate with **intra-frame animations**, not baked keyframes — that's what keeps
the output re-themeable and the text as real glyph paths. Two constraints come
straight from the SVG output model; respect them or motion breaks:

1. **One animation per captured element.** A second animation entry on the same
   selector overrides the first. So put the *move* on a wrapper element and the
   *fade* on an inner element — two distinct selectors, two animations.
2. **SVG transforms pivot about the origin (0, 0).** A `scale`/`rotate` pivots
   about the SVG origin, not the element. So motion is normally restricted to
   origin-safe `translate` + `opacity`, looped with `alternate: true` for
   seamless ambient loops. To scale or rotate **about an element's own center**,
   set `transformOrigin: "center"` on the animation — the renderer then pivots
   about the element's box.

### `durationMs` — composing into larger animations

A generator should return **`durationMs`**: its on-screen play time, or one loop
period for an infinite loop. When a user drops your template into an `animate`
config as a `template` frame and omits the frame `duration`, the frame inherits
this value. A static decorator (which has no intrinsic play time) omits
`durationMs` — and a frame using such a decorator must set an explicit duration.

## Walkthrough: authoring `domotion-template-quote-card`

The runnable scaffold for everything below lives in the repo at
`examples/template-package/` — the `domotion-template-quote-card` package, a
generator that animates a pull quote rising and fading into place on a colored
card. Copy that directory as the starting point for your own package.

### 1. Package shape

Three things make a valid package:

1. **Name** it `domotion-template-<name>` (the `<name>` is what users type).
2. **Export** the `Template` as the **default export** (or a named `template`
   export) from the package's main entry.
3. **Depend** on `domotion-svg` as a **peer dependency** — it's used only for
   the TypeScript types; the render context is supplied by the host at runtime.
   `zod` is a normal dependency (it describes and validates your params).

```json
{
  "name": "domotion-template-quote-card",
  "version": "0.1.0",
  "description": "A Domotion template: an animated pull-quote card that rises and fades into place.",
  "keywords": ["domotion", "domotion-template", "svg", "animation"],
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "peerDependencies": {
    "domotion-svg": ">=0.14.0"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "domotion-svg": ">=0.14.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

Add the `domotion-template` keyword so the package is discoverable on npm (see
*Discovery* below). A minimal `tsconfig.json` that emits ESM + declarations to
`dist/` rounds out the package:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["index.ts"]
}
```

### 2. The parameter schema

Describe the params with a zod schema. Use `z.coerce.*` for non-string scalars,
and give every field a `.describe()`:

```ts
import { z } from "zod";

export const quoteCardParamsSchema = z.object({
  quote: z.string().min(1).describe("The pull-quote text (required)."),
  author: z.string().optional().describe("Attribution line under the quote."),
  accent: z.string().default("#6366f1").describe("Accent / card color (CSS color)."),
  color: z.string().default("#f8fafc").describe("Text color (CSS color)."),
  width: z.coerce.number().int().positive().default(1080).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(620).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(2600).describe("Total on-screen time in ms."),
});

export type QuoteCardParams = z.infer<typeof quoteCardParamsSchema>;
```

This schema is the whole CLI surface: `quote` becomes a required `--quote`,
`width`/`height`/`holdMs` become coerced numeric flags, and each `.describe()`
string shows up in `--help`.

### 3. The HTML builder (keep it pure)

Build the captured HTML in a pure function — no I/O — so it's unit-testable
without a browser. Escape any author-supplied text you interpolate:

```ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pure HTML builder — no I/O, so it's unit-testable without a browser. */
export function buildQuoteCardHtml(p: QuoteCardParams): string {
  const author = p.author != null && p.author !== ""
    ? `<div class="qc-author">— ${escapeHtml(p.author)}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body {
    background: ${p.accent};
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 9%;
  }
  /* Two selectors so the move (wrapper) and the fade (inner) are two separate
     intra-frame animations that don't clobber each other. */
  .qc { display: flex; }
  .qc-inner { color: ${p.color}; max-width: 100%; }
  .qc-quote { font-size: 46px; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; }
  .qc-author { margin-top: 22px; font-size: 22px; font-weight: 500; opacity: 0.85; }
</style></head>
<body>
  <div class="qc">
    <div class="qc-inner">
      <div class="qc-quote">“${escapeHtml(p.quote)}”</div>
      ${author}
    </div>
  </div>
</body></html>`;
}
```

Note the two-element structure (`.qc` wrapper around `.qc-inner`): that's
deliberate, so the move can ride one element and the fade the other.

### 4. The template object and its `render`

The generator writes its HTML into the scratch `workDir`, then drives the
existing animate pipeline via `ctx.runAnimateConfig` — no new rendering code:

```ts
import type { Template, TemplateRenderContext, TemplateOutput } from "domotion-svg";

export const quoteCardTemplate: Template<QuoteCardParams> = {
  name: "quote-card",
  description: "Animated pull-quote card that rises and fades into place.",
  paramsSchema: quoteCardParamsSchema,
  async render(params: QuoteCardParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const htmlPath = join(ctx.workDir, "quote-card.html");
    writeFileSync(htmlPath, buildQuoteCardHtml(params));
    ctx.log(`quote-card: ${params.width}×${params.height}`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "quote-card.html", // relative → resolves against ctx.workDir
          duration: params.holdMs,
          transition: { type: "cut", duration: 0 },
          // ONE animation per element: the wrapper carries the move, the inner
          // carries the fade. Origin-safe transforms only (translateY, never an
          // origin-(0,0) scale/rotate).
          animations: [
            { selector: ".qc-inner", property: "opacity", from: "0", to: "1", duration: 500, easing: "ease-out" },
            { selector: ".qc", property: "translateY", from: "0.6em", to: "0em", duration: 650, easing: "cubic-bezier(0.22,1,0.36,1)" },
          ],
        },
      ],
    });

    // durationMs lets a `template` frame in an animate config inherit this
    // template's play time. A static decorator would omit it.
    return { svg, width: params.width, height: params.height, durationMs: params.holdMs };
  },
};

// Export as the default (or a named `template`) export so loadTemplate finds it.
export default quoteCardTemplate;
```

### Decorator variant

If your template wraps a user-supplied page instead of synthesizing one, use
`ctx.captureToSvg` to get a **static** SVG, then transform it:

```ts
async render(params, ctx) {
  const captured = await ctx.captureToSvg({
    input: params.input,        // absolute local path or URL
    width: params.width,
    height: params.height,
    selector: "body",
  });
  const framed = wrapInBezel(captured.svg, params);  // your post-processing
  return { svg: framed, width: params.width, height: params.height };
  // no durationMs — a static decorator has no intrinsic play time
}
```

Use `captureToSvg`, **not** a one-frame `runAnimateConfig`, for decorators: a
static capture SVG nests cleanly inside a wrapper, whereas an animated SVG's
keyframe `<style>` and frame-group wrappers don't survive re-nesting.

## Rendering programmatically: `renderTemplateToSvg`

`renderTemplateToSvg` is the public entry the CLI uses. It validates raw params,
sets up a throwaway `workDir`, wires the render context, runs your `render`, and
cleans up:

```ts
async function renderTemplateToSvg<P>(
  template: Template<P>,
  rawParams: unknown,
  opts?: {
    browser?: Browser;          // reuse an existing browser; else one is launched + closed
    log?: (msg: string) => void; // progress logger; default no-op
  },
): Promise<TemplateOutput>;
```

Pass raw (unvalidated) params — `renderTemplateToSvg` runs your zod schema for
you, applying defaults and throwing a path-specific error on invalid input. When
you omit `opts.browser`, it launches and closes a Chromium instance around the
render; pass one in to share a browser across many renders.

```ts
import { renderTemplateToSvg } from "domotion-svg";
import quoteCard from "domotion-template-quote-card";

const out = await renderTemplateToSvg(quoteCard, { quote: "Ship it.", author: "Ada" });
// out.svg is a complete, self-contained animated <svg>; out.durationMs === 2600
```

## Build, publish, and use

```bash
npm install
npm run build            # tsc → dist/ (ship the compiled JS + .d.ts, per "files")
npm publish              # the name MUST be domotion-template-<name>
```

Once published, a user installs and invokes it by the bare `<name>`:

```bash
npm install -g domotion-svg domotion-template-quote-card
domotion template quote-card --quote "Ship it." --author "Ada" -o quote.svg
```

The same template also composes into an `animate` config as a `template` frame,
so authors can drop it into a larger multi-frame animation declaratively rather
than through the programmatic API.

## The discovery convention

`domotion template <name>` resolves a bare `name` in two steps:

1. Is it a **built-in**? (`lower-third`, `device-mockup`, `background-loop`,
   `kinetic-text`, `chart`, `chat`, `subscribe`.) If so, use it.
2. Otherwise it dynamically imports `domotion-template-<name>` and validates the
   export.

So built-ins and third-party packages use the **exact same mechanism** — there
is no registry to sign up for, no plugin API, no config to edit. The npm graph
*is* the registry. An unknown name fails with an actionable message naming the
built-ins and the `npm install domotion-template-<name>` to run; a package whose
export isn't a valid template fails saying so.

**Finding templates.** Because third-party templates are plain npm packages, the
npm registry is the discovery surface: search npm for the **`domotion-template`**
keyword or the `domotion-template-` name prefix. A curated community gallery can
layer on top of the same convention without any new infrastructure.

## Testing

Test with the public `renderTemplateToSvg` API — no need to shell out to the
CLI. Keep your HTML/animation builders pure so most logic is testable without a
browser; reserve the full Chromium render for one or two integration checks:

```ts
import { describe, it, expect } from "vitest";
import { renderTemplateToSvg } from "domotion-svg";
import { quoteCardTemplate, buildQuoteCardHtml } from "./index.js";

describe("quote-card", () => {
  // Pure builders need no browser.
  it("escapes the quote text", () => {
    expect(buildQuoteCardHtml({ quote: "<b>", accent: "#000", color: "#fff", width: 100, height: 100, holdMs: 1000 }))
      .toContain("&lt;b&gt;");
  });

  // The full render needs Chromium (Playwright).
  it("renders a self-contained animated SVG", async () => {
    const out = await renderTemplateToSvg(quoteCardTemplate, { quote: "Ship it.", author: "Ada" });
    expect(out.svg).toContain("<svg");
    expect(out.svg).toMatch(/@keyframes/);   // the rise + fade reveal
    expect(out.durationMs).toBe(2600);
  });
});
```

## Keeping output on-brand

A template that's merely *correct* isn't enough — the point is output that looks
genuinely compelling. Bake your palette, type scale, spacing, and motion
vocabulary into the template so every invocation is on-brand by construction. For
a deeper playbook on getting the design itself right, see the
[design playbook](/domotion/developer/using-ai/).
