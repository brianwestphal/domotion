---
id: "requirements/ui-conventions"
title: "273 — UI conventions for Domotion's browser tools"
kind: "contract"
status: "current"
owners: ["product-tooling"]
platforms: []
tickets: ["DM-QW1NMD"]
code:
  [
    "src/kerf-ui-theme.ts",
    "scripts/bundle-kerf-client.mjs",
    "src/review/client.tsx",
    "src/scrubber/client.tsx",
    "src/studio/client.tsx",
    "tests/review-client.tsx",
    "tests/review-server.tsx",
  ]
aliases: ["docs/273-ui-conventions.md", "doc-273"]
---

# 273 — UI conventions for Domotion's browser tools

Domotion ships three browser tools — `svg-review` ([doc 54](54-svg-review-tool.md)), `svg-scrubber` ([doc 56](56-svg-scrubber.md)) and Studio ([doc 240](240-studio-application-shell.md)) — and keeps one local harness, `npm run demos:review` (`tests/review-server.tsx`). All four are built with [kerfjs](https://github.com/brianwestphal/kerf) and take their shared chrome from the [`@kerfjs/ui`](https://brianwestphal.github.io/kerf/docs/ui-package/) component package.

The design philosophy, accessibility contract and component-selection guidance are kerf-ui's own: read `node_modules/@kerfjs/ui/llms.txt`, `ai/skill.md` and `docs/{component-contract,accessibility,design-philosophy}.md`. This document records only Domotion's deviations and project-specific decisions.

## Component subset

Only kerf-ui's **non-Web-Awesome** components are used: `Toolbar`, `ToolbarControlGroup`, `ToolbarText`, `LucideIcon`, `StateBanner`, `EmptyState`, `LoadingSpinner`, `PageHeader` and similar. Each is imported from its own subpath (`@kerfjs/ui/toolbar`, …), never from the root barrel.

**Kerf `Select` and every Web Awesome component are excluded.** Measured with esbuild (IIFE, es2022, browser conditions), the subset adds about 15 KB of JavaScript and 30 KB of CSS before minification to a kerf bundle, with no network access. Adding `@kerfjs/ui/select` and its `select/register` instead adds about 321 KB raw (216 KB minified). Its Web Awesome icon code also builds `https://ka-f.fontawesome.com/…` URLs, which would make the shipped pages fetch from a CDN and break their self-contained, offline contract. Native `<select>` elements stay everywhere, and the browser tests drive them with `selectOption`.

Icons come from the [`lucide`](https://lucide.dev) package, imported by name (`import { Play } from "lucide"`) so only the referenced icon nodes are bundled, and rendered through `LucideIcon`. Icon-only buttons carry an `aria-label`; the icon itself is decorative.

## Packaging

`@kerfjs/ui` and `lucide` are **devDependencies**. Every shipped use is compiled into a pre-built bundle string (`src/{review,scrubber,studio}/client.bundle.generated.ts`), so consumers of the npm package install nothing new and the shipped servers never import either package at runtime.

`scripts/bundle-kerf-client.mjs` is the shared esbuild step. Under the `browser` export condition each kerf-ui subpath pulls in its own CSS, which esbuild emits as a second output. The script folds that CSS back into the JavaScript as a one-line prologue that prepends a `<style data-kerf-ui>` element to `<head>` before any client code runs, so each page is still one HTML shell plus one `/client.js`. Because the package CSS is prepended, each page's own stylesheet comes later in the cascade and overrides package defaults without specificity tricks. The prologue sits on the bundle's first line, so inline source maps used for browser coverage keep their line numbers.

The local harness renders kerf-ui components on the server too, so it inlines the stylesheets it needs (`KERF_UI_STYLESHEETS` in `tests/review-server.tsx`) in `<head>` and discards the client bundle's copy. Keep that list in step with the harness's `@kerfjs/ui/*` imports.

## Theme

All four pages are dark-only. kerf-ui's foundation declares `:root { color-scheme: light dark }` and resolves its `--kui-color-*` ramps with `light-dark()`, so every page appends `KERF_UI_DARK_THEME_CSS` (`src/kerf-ui-theme.ts`) after the package CSS. That stylesheet:

- pins `color-scheme: dark`;
- maps the base surface, text, border and brand ramps onto the GitHub-dark palette the tools already used;
- overrides the `success`/`warning`/`danger` `*-on-quiet` text colors, whose package defaults are tuned for a light surface and are unreadable on `#161b22`.

Only public `--kui-*` tokens are set, never kerf-ui's private descendant rules. `tests/kerf-client-uis.e2e.test.ts` asserts on every surface that one package-owned computed style is present and that the root color scheme resolves to `dark`.

## Project-specific decisions

- **Domain UI stays bespoke.** The review cards, region overlays, lightbox, scrubber timeline/range track, crop layer, Studio forms and the multitrack timeline have no kerf-ui equivalent and keep their own markup and CSS. kerf-ui supplies the chrome around them: toolbars, icon buttons, status banners, empty and loading states.
- **Behavior hooks are unchanged.** Every `data-action`, `id` and class that a delegate, a test or a downstream tool reads was preserved through the migration. A kerf-ui component that needs a hook receives it through its `className` or `action` prop. The one consolidation is Studio's preview selector: a controlled `SegmentedControl` gives all of its segments one `action`, so the former `preview-story` / `preview-scene` pair became `preview-select` with the choice in `data-segment-value` (doc 240). Only the Studio delegate read the old names, and the tests address the segments by their unchanged accessible names.
- **Page CSS goes in `<head>`, never in a JSX `<style>` child.** kerf escapes text children, so quotes become `&quot;` and `>` becomes `&gt;` inside the stylesheet. Studio lost its whole font stack this way and rendered in the browser's serif font until the migration moved its stylesheet into a `<head>` element created outside the `mount()` tree.
- **`EmptyState` is a status region.** kerf-ui renders it with `role="status"`, so a page can hold more than one status region. Tests that read "the" status message scope the query to their container (for example `.notice` in Studio) rather than taking the page's only `status` role.
- **Status messages use `StateBanner`.** Operation results, save outcomes and validation errors render as a `StateBanner` whose tone follows the message kind (`info`, `success`, `warning`, `danger`). Live-region semantics (`role="status"`/`"alert"`) come from the banner's `urgency`.
