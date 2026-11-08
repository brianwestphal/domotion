---
id: "requirements/ui-conventions"
title: "273 — UI conventions for Domotion's browser tools"
kind: "contract"
status: "current"
owners: ["product-tooling"]
platforms: []
tickets: ["DM-QW1NMD", "DM-HRBJ8M", "DM-2PA7G8"]
code:
  [
    "src/kerf-ui-theme.ts",
    "src/kerf-ui-select.ts",
    "src/test-support/kerf-select.ts",
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

The tools use kerf-ui's `Toolbar`, `ToolbarControlGroup`, `LucideIcon`, `StateBanner`, `EmptyState`, `LoadingSpinner`, `SegmentedControl` and `Select`. Each is imported from its own subpath (`@kerfjs/ui/toolbar`, …), never from the root barrel.

kerfjs, `@kerfjs/ui` and `eslint-plugin-kerfjs` are pinned to the exact 5.0 beta `5.0.0-beta.126` until 5.0 is released stable. Under kerf-ui 5 none of these components depends on Web Awesome, and `@awesome.me/webawesome` is not installed. Web Awesome components stay out: they are an optional kerf-ui integration, and Web Awesome's default icon library builds Font Awesome CDN URLs, which would break the pages' self-contained, offline contract. Every choice control is a kerf-ui `Select`; no tool renders a native `<select>`.

**Bundle sizes.** Upgrading from kerfjs 4.4 / kerf-ui 4.4.1 to the 5.0 beta grew the three shipped bundles as follows (JavaScript including the folded CSS string; "minified" is an esbuild `minify` pass over the shipped unminified bundle):

| Bundle                        | 4.4 raw  | 5.0 beta raw     | 4.4 minified | 5.0 beta minified |
| ----------------------------- | -------- | ---------------- | ------------ | ----------------- |
| svg-review (`src/review`)     | 65.0 KB  | 99.4 KB (+34.3)  | 42.7 KB      | 69.1 KB (+26.5)   |
| svg-scrubber (`src/scrubber`) | 161.7 KB | 235.2 KB (+73.5) | 93.4 KB      | 149.1 KB (+55.7)  |
| Studio (`src/studio`)         | 785.2 KB | 837.1 KB (+51.9) | 451.4 KB     | 486.5 KB (+35.2)  |

Most of the growth is the kerfjs 5 runtime itself, which now builds on `@preact/signals-core`.

## Select

Every choice control in the tools is a kerf-ui `Select`:

- the `demos:review` harness: result source, filter, suite, sort and each card's logical-stage classification;
- svg-scrubber: playback speed, zoom preset, crop aspect ratio and ticket category;
- Studio: timeline snap, and each scene's narrative beat, source type, fit, transition and cinematic preset, plus the annotation scope.

svg-review has no choice control and does not load Select support.

kerf-ui 5's `Select` renders a light-DOM `<kui-select>` root with a native trigger `<button role="combobox">` and a top-layer `role="listbox"` popup. It draws its caret and check marks as inline SVG and does not use Web Awesome, so no icon library is registered and the pages make no network request. `tests/kerf-client-uis.e2e.test.ts` loads every tool, opens a Select, chooses an option, and fails on any request that leaves the local server.

- **Registration.** A client that renders a `Select` imports `src/kerf-ui-select.ts`, which imports `@kerfjs/ui/select/register` once and exports `selectValue` / `setSelectValue`. The register module defines the form-associated `kui-select` element and announces each choice with bubbling `input` and `change` events.
- **Wiring.** `Select` takes no `id` or `data-*` hook, so its `name` identifies it: delegates match `kui-select[name=…]` and read the element's `value`. Studio's field dispatcher treats a `kui-select`'s `name` as its `data-field`.
- **Controlled values.** Every Select's `value` comes from state, and its change handler writes that state, so a re-render never resets a choice the person made. The scrubber's ticket category, uncontrolled as a native `<select>`, is now a signal. A pick whose re-render cannot change the markup (choosing "Fit", which shows the level it computes) sets the element's value directly with `setSelectValue`.
- **Unavailable choices** use the per-choice `disabled` flag: the harness's sources with no data, and Studio's "Custom treatments" preset, which names the current state but cannot be chosen.
- **Names.** A toolbar Select is named by `ariaLabel`; the harness keeps its visible "Source:" / "Filter:" text in a wrapping `<label>`. The classification Select uses the `label` prop, which renders kerf-ui's stacked label.
- **Size.** Toolbar Selects use `size="compact"` and `triggerWidth="fit-content"`; Studio's form fields use `triggerWidth="fill"`.
- **Page CSS.** The scrubber and Studio style bare `button` elements. Those rules now read `button:where(:not(.kui-select__trigger))`, so they skip the Select trigger and keep their original specificity.
- **Tests.** Playwright's `selectOption` and `inputValue` work only on native controls. Browser tests use `src/test-support/kerf-select.ts` (`chooseKerfSelectOption`, `kerfSelectValue`, `kerfSelectOptionValues`), which opens the trigger and clicks an option as a person does. Address a Select by `getByRole("combobox", { name })` or `kui-select[name=…]`, not `getByLabel`: the listbox carries the same accessible name, so `getByLabel` matches two elements.

**Bundle size.** Measured against the native-`<select>` builds on the same 5.0 beta (same method as above):

| Bundle       | native `<select>` raw | kerf `Select` raw | native minified | kerf `Select` minified |
| ------------ | --------------------- | ----------------- | --------------- | ---------------------- |
| svg-review   | 99.4 KB               | 99.4 KB (+0)      | 69.1 KB         | 69.1 KB (+0)           |
| svg-scrubber | 235.2 KB              | 354.8 KB (+119.6) | 149.1 KB        | 207.7 KB (+58.6)       |
| Studio       | 837.1 KB              | 956.6 KB (+119.4) | 486.5 KB        | 545.0 KB (+58.5)       |

The growth is `select/register` (the Select controller, which also wires kerf-ui popup menus and help tags), its floating-ui positioning, and the Select CSS. kerf-ui 4's Web Awesome Select would have added about 216 KB minified and needed a bundled icon library to stay offline.

**Known issue.** In a scrolled page the popup can open on the wrong side, with too little height. kerf-ui positions it against `document.documentElement` with fixed positioning, and that boundary is offset by the scroll distance. Studio, whose page scrolls, shows it most; at phone width the popup collapsed to a few pixels. Until kerf-ui bounds the popup by the viewport, `src/kerf-ui-select.ts` injects a temporary floor on the popup's height. CSS lets `min-height` win over the inline `max-height`, and the floor grows with the option count but stays under the real row height (2.5 rem per option, capped at `min(15rem, 40vh)`), so a short list never gains empty space. Remove the floor when the upstream fix lands.

Icons come from the [`lucide`](https://lucide.dev) package, imported by name (`import { Play } from "lucide"`) so only the referenced icon nodes are bundled, and rendered through `LucideIcon`. Icon-only buttons carry an `aria-label`; the icon itself is decorative.

## Packaging

`@kerfjs/ui` and `lucide` are **devDependencies**. Every shipped use is compiled into a pre-built bundle string (`src/{review,scrubber,studio}/client.bundle.generated.ts`), so consumers of the npm package install nothing new and the shipped servers never import either package at runtime.

`scripts/bundle-kerf-client.mjs` is the shared esbuild step. It anchors esbuild's per-module path comments at their `node_modules/` segment, so a checkout whose dependencies are symlinked from elsewhere regenerates byte-identical bundles. Under the `browser` export condition each kerf-ui subpath pulls in its own CSS, which esbuild emits as a second output. The script folds that CSS back into the JavaScript as a one-line prologue that prepends a `<style data-kerf-ui>` element to `<head>` before any client code runs, so each page is still one HTML shell plus one `/client.js`. Because the package CSS is prepended, each page's own stylesheet comes later in the cascade and overrides package defaults without specificity tricks. The prologue sits on the bundle's first line, so inline source maps used for browser coverage keep their line numbers.

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
- **Page element selectors must not reach kerf-ui markup.** kerf-ui 5 renders `Toolbar` as a `<header>` element, so the harness's former bare `header { … }` rule gave the toolbar a second border and padding. Scope page rules for structural elements to the page's own element (`body > header`), not the tag.
- **Page CSS goes in `<head>`, never in a JSX `<style>` child.** kerf escapes text children, so quotes become `&quot;` and `>` becomes `&gt;` inside the stylesheet. Studio lost its whole font stack this way and rendered in the browser's serif font until the migration moved its stylesheet into a `<head>` element created outside the `mount()` tree.
- **`EmptyState` is a status region.** kerf-ui renders it with `role="status"`, so a page can hold more than one status region. Tests that read "the" status message scope the query to their container (for example `.notice` in Studio) rather than taking the page's only `status` role.
- **Status messages use `StateBanner`.** Operation results, save outcomes and validation errors render as a `StateBanner` whose tone follows the message kind (`info`, `success`, `warning`, `danger`). Live-region semantics (`role="status"`/`"alert"`) come from the banner's `urgency`.
