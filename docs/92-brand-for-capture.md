# 92 — Brand for `capture` / `animate` (CSS-variable injection)

**Status: shipped (DM-1540).** `capture` and `animate` gain a `--brand <file>`
flag. Unlike a *template*'s brand defaults (docs/85 — the brand fills a generated
template's *params*), theming a **captured real page** is a distinct mechanism:
the brand's tokens are injected as **CSS custom properties** onto the page's
`:root` *before it paints*, so a page authored against `var(--brand-*)` picks up
the brand's palette / font / radius.

```sh
# The page (page.html) styles itself with var(--brand-primary), etc.
domotion capture ./page.html --brand ./acme.json -o page.svg
domotion animate ./demo.json  --brand ./acme.json -o demo.svg
```

Both flags reuse the same `brandSchema` + `loadBrand` as the template brand kit
(docs/85) — one brand file drives templates *and* captured pages.

## The variable-naming contract

The brand file (docs/85 `brandSchema`) maps to these CSS custom properties.
**Only the tokens the brand file actually set are emitted** — an unset token is
NOT declared, so a page's own `var(--brand-x, fallback)` keeps its fallback.

| Brand token | CSS variable | Notes |
|---|---|---|
| `palette.primary` | `--brand-primary` | main brand color |
| `palette.accent` | `--brand-accent` | secondary accent |
| `background` ?? `palette.background` | `--brand-background` | the richer top-level `background` (e.g. a gradient) wins over the flat `palette.background` |
| `palette.text` | `--brand-text` | primary text / foreground |
| `palette.muted` | `--brand-muted` | secondary text |
| `font.family` | `--brand-font-family` | CSS font-family stack |
| `radius` | `--brand-radius` | emitted as `<n>px` |

Example — a page authored against the contract:

```html
<style>
  :root {
    /* neutral fallbacks so the page still renders un-branded */
    --brand-primary: #64748b;
    --brand-background: #0f172a;
    --brand-font-family: system-ui, sans-serif;
    --brand-radius: 6px;
  }
  body { background: var(--brand-background); font-family: var(--brand-font-family); }
  .cta { background: var(--brand-primary); border-radius: var(--brand-radius); }
</style>
```

Captured with `--brand acme.json`, `--brand-primary` / `--brand-background` /
`--brand-font-family` / `--brand-radius` resolve to Acme's values instead of the
page's fallbacks. See `examples/templates/brand-page.html` +
`examples/brand-capture-demo.ts` (output `examples/output/brand-capture.svg`).

## How the injection works

`injectBrandVariables(context, brand)` (exported from the package root) calls
`context.addInitScript(...)`, which runs on every page + navigation in the
context **before any page script**. The script sets the mapped properties as
**inline styles on the document element** (`:root`).

Two design points:

- **Inline on `:root`, not a stylesheet.** Inline author styles win over any
  author-stylesheet `:root { --brand-x: fallback }` the page declares regardless
  of source order — the intent is "the brand overrides the page's built-in
  defaults."
- **Applied at document-start AND re-applied on `DOMContentLoaded`.** At
  document-start `document.documentElement` is often still null (before the
  parser creates `<html>`) and is replaced once the real document is parsed, so
  a single early apply doesn't survive. Re-applying on `DOMContentLoaded` — which
  fires after `<html>` exists and well before the capture reads
  `getComputedStyle` — guarantees the variables are present when capture samples
  computed styles. (This also survives `page.setContent`, whose `document.write`
  wipes an early apply.)

The properties inherit from `:root` to every element, so `var(--brand-*)`
anywhere in the page resolves.

## Scope

- **`capture`** — injects onto the single captured page.
- **`animate`** — injects onto **every captured frame** (the brand rides the
  browser context). `template` and `cast` frames render before the capture loop
  and carry their own theming (a template frame uses the template's brand
  defaults / explicit params, docs/85 + docs/73), so `--brand` on `animate` does
  **not** re-theme them.
- **Library:** `injectBrandVariables(context, brand)` for imperative callers;
  `brandCustomProperties(brand)` (ordered `[name, value]` pairs) and
  `brandRootCss(brand)` (a `:root { … }` block, `""` when nothing maps) are the
  pure building blocks, exported for third parties + tests.

## Relationships

- **docs/85** (brand kit) — the shared `brandSchema` + `loadBrand`. Template
  defaults (docs/85) and captured-page CSS variables (this doc) are two consumers
  of the same brand file.
- **docs/70/73** (template system) — a `template` frame inside an `animate`
  config themes itself via its params, not via this injection.

## Follow-ups

- **Theme an `animate` config's `template` frames from `--brand`.** Today a
  template frame ignores `animate --brand`; wiring the same brand into
  `renderTemplateFrames` would let one flag theme captured *and* template frames.
- **Author-facing config `brand` key.** `animate`'s JSON config could carry an
  inline `brand` object (or a `brand` path) so a config is self-contained without
  the CLI flag.
