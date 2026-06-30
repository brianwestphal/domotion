# Domotion site (Astro + Starlight) — DM-1308 rebuild

This is the new Domotion marketing + docs site, built with **Astro + Starlight**
(mirroring `~/Documents/kerf/site`). It's being developed **alongside** the
legacy custom generator in `../site/`, and will replace it at cutover.

## Develop

```bash
cd site-next
npm install
npm run dev        # prebuild copies demo SVGs → public/demos, then astro dev
npm run build      # static build → dist/
npm run preview
npm test           # hero layout guard: spawns astro dev, asserts the homepage
                   # hero is centered (desktop) and the actions stack with
                   # consistent-width filled buttons (mobile)
```

`npm test` runs `scripts/check-hero-layout.mjs`, a Playwright layout-regression
guard for the homepage hero. It renders the page in Chromium and measures DOM
rects to assert the wordmark, tagline, and action buttons stay centered at
desktop widths and that the actions stack vertically (filled buttons sharing one
width) on phones — the two regressions fixed in the `.hero` block of
`src/styles/site.css`. Playwright resolves from the root project's
`node_modules` (the site is developed alongside it). Pass `BASE_URL=<origin>` to
check an already-running server instead of spawning one.

`prebuild` runs `scripts/build-demos.mjs` (copies the committed demo SVGs from
`../examples/output` + `../site/assets/img/demos` into `public/demos/`, gitignored)
and `scripts/sync-docs.mjs` (a placeholder for now — see below).

## Information architecture (marketing-forward)

1. **Landing** (`src/content/docs/index.mdx`, splash) — hero + best demos.
2. **Showcase** — capability demos + full-app demos.
3. **Why Domotion** — the case vs. video / GIF / screenshots.
4. **Usage** — one page per CLI.
5. **Developer** (last) — API, animate-config format, custom templates, using AI.

## Status — Phase 1 (scaffold)

Building, deployable scaffold with the full IA, the landing wired to real demo
SVGs, and real initial content on every page.

### Planned next (awaiting "looks good")

- **Full-app demos** (`showcase.mdx` currently has placeholders): real `domotion`
  captures of two live local apps —
  - **Hotsheet** (ticket / Up-Next worklist tool): open board → create ticket →
    categorize + prioritize → mark Up Next → export worklist.
  - **Glassbox** (AI code review): open a diff → annotate a line → region note →
    export feedback.
  Both captured via the `domotion animate` continuous-session pipeline (real
  clicks + typing), composited into a browser bezel, committed as gallery SVGs.
- **Docs sync** (`scripts/sync-docs.mjs`): pull the canonical animate-config
  grammar + API surface out of the repo's `docs/` so the Developer pages can't
  drift from source.
- **Deeper content** on the Why / Usage pages; polish the landing.

### Cutover (Phase 5)

- Point `.github/workflows/pages.yml` at this site's `npm run build` (it
  currently builds `../site/` via `site/build.ts`).
- Retire the legacy `../site/` generator.
- Same GitHub Pages URL: `https://brianwestphal.github.io/domotion`.
- README already links the hosted site prominently.

Tracked in DM-1308.
