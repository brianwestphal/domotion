# Code summary — AI agents read me first

This file is the entry point the Hot Sheet ticket template tells you to read.
It points you at the existing canonical docs rather than duplicating them;
the source of truth lives in `CLAUDE.md` and the numbered `docs/*.md` set.

## Read these first, in order

1. **`CLAUDE.md`** (repo root) — the operating manual. Covers stack, code
   organisation, CAPTURE_SCRIPT discipline, decoration & shaping invariants,
   quality gates, language, **investigation + debugging tools (Playwright
   probes, `--debug` bundles, `svg-review`)**, git, ticket workflow,
   documentation rules. Always re-read when the date drifts past your last
   read — the file is updated as patterns emerge.

2. **`docs/README.md`** — index of the numbered docs. Each numbered doc is
   a per-feature requirements + design reference (what CSS round-trips, what
   doesn't, why). When you change capture/render/animate behaviour, the
   corresponding doc updates in the same commit.

3. **`docs/api.md`** — the published-package API surface. What
   `domotion-svg` consumers import. When you rename / add / break a public
   symbol, this is the contract document to keep in sync.

## Key code orientation

The same orientation lives in `CLAUDE.md` "Code Organization" but the
shortest possible map:

- **`src/capture/`** — Playwright bring-up + the `CAPTURE_SCRIPT` (a
  serialised function that runs inside the page to walk the DOM). The
  capture-script bundle is pre-built into `src/capture/script.generated
  .ts` by `scripts/build-capture-script.mjs`.
- **`src/render/`** — pure node-side renderers that convert a captured
  element tree into SVG markup. `element-tree-to-svg.ts` is the big one;
  `text-to-path.ts` + `text.ts` own glyph/decoration/wrap logic;
  `font-resolution.ts` owns font-key resolution + the per-Unicode-block
  fallback chains + `FONT_PATHS`/`LINUX_FONT_PATHS`/`WIN32_FONT_PATHS`
  (extracted out of `text-to-path.ts`, DM-1305/DM-1307; still re-exported from
  it) + the per-platform generated routing tables
  (`unicode-font-routing.{darwin,linux,noto-linux,win32}.generated.ts`) + the
  Linux bare-vs-Noto runtime profile selector (`linuxFontProfile()`, DM-1404) +
  the live `fc-match`/CoreText system-fallback resolver (DM-1416/DM-1018);
  `unicode-classification.ts` owns the Unicode predicates;
  `mask.ts` owns mask-def emission; `borders.ts` owns border math.
- **`src/animation/`** — multi-frame composition (animator, magic-move) +
  **animated-SVG compositing** (DM-1323, doc 77): `composite.ts`
  (`composeAnimatedLayers` — stack animated SVGs as placed, independently-timed
  layers), `embed-namespace.ts` (per-layer name namespacing), `embed-timeline.ts`
  (per-layer `hold`/`stretch`/`loop` timeline re-anchoring). **Motion presets**
  (doc 08 / DM-1526) live in `motion-presets.ts` — named motions
  (`fade-up`/`pop`/`slide-in-<dir>`/`wipe-in`) + easing presets (spring/back/
  standard) that expand to intra-frame animation fields (`preset`/`easing` on the
  animate config; also reused by the template reveals).
- **`src/scroll/`** — scroll-pattern grammar (DM-604) and the composer
  that stitches per-segment captures into one animated SVG.
- **`src/cli/`** — the five published bins: `domotion`, `svg-to-video`,
  `svg-to-image` (still SVG → PNG/JPEG/PDF/WebP/AVIF/TIFF, DM-1353 + DM-1354 /
  doc 78 — `svg-to-image.ts` + `svg-to-image-core.ts`, reusing the
  `svg-to-video-core` seek+screenshot machinery; WebP/AVIF/TIFF transcode via a
  lazy `sharp` import), `svg-review`, `svg-scrubber`. The
  `domotion` bin has six subcommands: `capture`, `animate`, `term`
  (terminal-session → animated SVG, DM-1225 / doc 67), `template` (render a
  parameterized template, DM-1276 / doc 70), `composite` (layer animated
  SVGs into one — `composite.ts`, DM-1323 / doc 77), and `storyboard` (sequence
  distinct scenes — template/capture/cast/svg — into one timeline with inter-scene
  transitions; `src/cli/storyboard.ts`, DM-1527 / doc 89). `capture`/`animate` also
  take `--brand` (brand-for-capture, doc 92); `--format` is on `template`,
  `capture`, and `animate` (viewport sizing, doc 90).
- **`src/terminal/`** — `domotion term` backend (DM-1225): asciinema `.cast`
  parser (`cast.ts`), `@xterm/headless` VT-emulator snapshot wrapper
  (`emulator.ts`), frame-selection + grid→HTML (`render.ts`), the incremental
  line-pool composer (`incremental.ts`), theme palettes (`theme.ts`), and
  `castToAnimatedSvg` (`index.ts`). Two front-ends: `--cast` (recording) and the
  live `pty.ts` shim (`domotion term -- <cmd>`, DM-1226 / doc 68 — optional
  `node-pty`).
- **`src/review/`** — the published review-tool surface
  (`compare-pngs.ts`, `region-overlay.ts`, `server.ts`, `client.tsx`)
  shared between the in-repo `tests/review-server.tsx` and the
  consumer-facing `svg-review` CLI.
- **`src/scrubber/`** — the `svg-scrubber` server + kerfjs
  page-side UI (`server.ts`, `client.tsx`, `trim.ts`): video-style
  play/scrub/range-loop/frame-export/trim for an animated SVG (doc 56), plus
  `--review` mode (DM-1445, doc 82) — an issue-reporting panel + region overlay
  that writes importable `.ticket` JSON via `POST /ticket` (`buildTicketFile`).
- **`src/templates/`** — the template system (DM-1276 / doc 70): the `Template`
  contract (`types.ts`), registry + `domotion-template-*` loader (`registry.ts`),
  param validation + render driver + the `captureToSvg` static-capture primitive
  (`render.ts`), zod→JSON-Schema projection (`json-schema.ts`), and the seven
  built-ins: `builtin/lower-third.ts`, `builtin/device-mockup.ts`,
  `builtin/background-loop.ts` (doc 71), `builtin/kinetic-text.ts` (doc 72),
  `builtin/chart.ts` (doc 75), `builtin/chat.ts` + `builtin/subscribe.ts` (doc 76),
  the **creative-pack text cards** `builtin/{title-card,quote,caption,cta}.ts`
  (doc 86 / DM-1531, sharing `builtin/text-card-common.ts`), and the
  **number-animation** cards `builtin/{counter,stat}.ts` (doc 86 / DM-1532, sharing
  the odometer digit-reel module `builtin/odometer.ts`), and the **before/after
  compare** `builtin/compare.ts` (doc 86 / DM-1533 — a clip-wipe reveal on
  `composeAnimatedLayers`' Firefox-safe `clipScale`).
  **Format presets** (doc 87 / DM-1534, DM-1537) live in `formats.ts` — the
  `FORMATS` table + `resolveFormat` (preset/alias/raw `WxH` → canvas size +
  `safeInset`) + `applyFormatSize` + `safeAreaPadding`, surfaced as `--format` on
  the CLI (`src/cli/template.ts`) and a `safeInset` field on
  `TemplateRenderContext` that the themeable built-ins consume to keep content
  within `canvas − safeInset`. **Brand kit** (doc 85 /
  DM-1530) lives in `brand.ts` — the zod `brandSchema` + `loadBrand` + the
  `brandParams`/`brandSeriesColors`/`brandBackground` helpers; each themeable
  built-in has a `brandDefaults(brand)` method, merged beneath explicit params by
  `applyBrandDefaults` (in `render.ts`) and surfaced as `--brand`. `brand.ts` also
  owns `brandCustomProperties`/`brandRootCss` (brand → CSS custom properties) for
  **brand-for-capture** (doc 92 / DM-1540): `--brand` on `capture`/`animate` injects
  those vars into the page before capture via `injectBrandVariables` (`src/capture/
  index.ts`), so a real page authored against `var(--brand-*)` themes at capture time.
  Templates are front-ends onto the animate/capture pipeline; the verb lives in
  `src/cli/template.ts`.
- **`src/tree-ops/`** — element-tree transforms (`tree-diff.ts`,
  `viewbox-culling.ts`, `resize-embedded-images.ts`, `prune-tree.ts`,
  `for-each-element.ts`). (The old `frame-merge.ts` fast path was removed — see
  doc 08.)
- **`src/post-processing/`** — the optional svgo `optimize.ts` + `gzip.ts`.
- **`src/utils/`** — small shared helpers.
- **`src/test-support/`** — shared test helpers (`close-browser-safely.ts`).
- **`tests/`** — visual-regression suites (`features.ts`, `showcase.ts`,
  `html-test-suite.tsx`, `real-world.tsx`) + the in-repo review server
  (`review-server.tsx`). Also the **feature-coverage** axis (DM-1459):
  `tests/feature-coverage.ts` (behavior → export/verb → asserting-test index),
  `tests/conventions.test.ts` (dep allow-list + no-shell-exec + manifest
  integrity/drift, in the `npm test` gate), and `tools/check-feature-coverage.ts`
  (`npm run check:features` — the standalone report). See `docs/83-feature-coverage.md`.

## Debugging a render-fidelity bug

The shortest possible path, per `CLAUDE.md` "Debugging the generated output":

```sh
# 1. Capture the source page with a debug bundle.
domotion capture <url-or-file> --debug -o out.svg

# 2. Review the diff in a browser UI with draggable region markers.
svg-review --expected out.debug/expected.png --actual out.debug/actual.svg

# 3. For a fixture already in the suite, crop the ticket's REGIONS:
npx tsx tools/crop-regions.ts --ticket DM-{id}
```

If those don't surface the cause, fall through to a Playwright probe under
`tools/probe-*.mjs` — `CLAUDE.md` has copy-pasteable patterns for the two
most common probes (measure-an-element, screenshot-a-region).

## What this file is NOT

- Not a complete summary of the codebase — `CLAUDE.md` is. Don't grow
  this file into a parallel orientation; update `CLAUDE.md` instead.
- Not a substitute for reading the relevant numbered doc — when a ticket
  touches a specific feature area (animation, scroll, gradients, fonts,
  ...), read its dedicated doc.
