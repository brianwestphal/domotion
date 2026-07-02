# Requirements summary — AI agents read me first

This file is the entry point the Hot Sheet ticket template tells you to read
for behaviour contracts. Like `code-summary.md`, it points at the canonical
docs rather than duplicating them.

## The contract surface

Domotion's contract with consumers is "the SVG renders pixel-faithful to
Chromium-on-this-platform at 1×, embeds without external assets, and scales
crisply at any size." That's enforced by the visual-regression suites
(`features.ts`, `showcase.ts`, `html-test-suite.tsx`, `real-world.tsx`) and
documented per-feature in the numbered `docs/` set.

## Read these for behaviour contracts

1. **`docs/README.md`** — index of every numbered doc. Browse by topic
   (fidelity, writing-mode, gradients, animation, scroll, fonts, …).
2. **`FEATURES.md`** — per-feature support checklist with fixture links.
   Keep in sync when fixtures land.
3. **Doc 01 (`docs/01-fidelity.md`)** — the overarching fidelity
   contract. What's in scope, what isn't, what tolerance applies.
4. **`tests/feature-coverage.ts`** — the machine-checkable feature index
   (behavior → export/verb → asserting test), the orthogonal-to-line-coverage
   axis. `npm run check:features` (+ the `tests/conventions.test.ts` mirror in
   `npm test`) flags any behavior with no asserting test, and any new
   export/verb not yet in the index. See **Doc 83** (`docs/83-feature-coverage.md`)
   — and the `CLAUDE.md` "Testing Philosophy" note that line coverage ≠ behavior
   coverage, and stateful modules must test *transitions*.

## Always-in-sync docs

Some docs ARE the canonical reference for a user-facing surface — if the
code changes and the doc doesn't, consumers get a misleading contract.
Update these in the same commit as any change that touches the surface
they describe (see `CLAUDE.md` "Documentation"):

- **`docs/37-scroll-pattern-grammar.md`** — canonical EBNF + semantics for
  the scroll-pattern language. Any change to `src/scroll/pattern.ts`,
  `src/scroll/executor.ts`, or scroll-related CLI flags must update doc
  37 too.

## Recent additions worth knowing about

- **Doc 08 motion presets (`docs/08-animation-model.md`, DM-1526)** — **Shipped.**
  A named motion + easing vocabulary on intra-frame animations so authors don't
  hand-tune cubic-beziers. `src/animation/motion-presets.ts`: motion presets
  (`fade`, `fade-up`, `fade-down`, `pop`, `slide-in-<dir>`, `wipe-in`; `exit:true`
  reverses) that expand to `{property,from,to,fuse,easing}`, and easing presets
  (standard eases + `back`/`spring` overshoot → plain `cubic-bezier`, cross-engine).
  Surfaced as `preset`/`easing`/`exit`/`presetDistance`/`presetScaleFrom` on the
  animate config's intra-frame animations (expanded in `expandMotionPreset`), and
  reused by the template reveals (`staggeredReveal`). **Follow-ups shipped
  (DM-1542):** a true multi-oscillation spring baked to CSS `linear(...)` samples
  (`spring-bouncy` / `spring-soft`, `springEasingFn`/`springLinearEasing` in
  `src/animation/easing.ts` — `resolveEasingPreset` returns the `linear()` for
  these), and a `shine` motion overlay on the shared masked-gradient-sweep helper
  `buildShineSweep` (`src/animation/shine.ts`).

- **Doc 88 (`docs/88-transition-effect-expansion.md`, DM-1524)** — **Shipped.**
  SVG-safe inter-frame transitions beyond crossfade/cut/push-left/scroll/magic-move,
  in `src/animation/animator.ts`: directional pushes (`push-right`/`push-up`/
  `push-down` — generalized the slide engine to signed displacement; `push-left`/
  `scroll` byte-identical), a linear `wipe` + expanding-circle `iris` (clip-path
  reveals via `emitRevealFrame`), `zoom-in`/`zoom-out` scale dollies under a
  crossfade, and a `shine` sweep (reuses `buildShineSweep`). All transform + clip-path
  + opacity + gradient (no animated `filter`); wired into the transition enum, the
  generated `animate-config.schema.json`, and `--transition`. **Still open:** radial/
  clock wipe (conic-mask cross-engine calibration), mixed transition-type chaining
  (unified entrance/exit compositor).

- **Doc 89 (`docs/89-storyboard-sequencing.md`, DM-1527)** — **Shipped.** A
  declarative **storyboard** runner + `domotion storyboard <config.json>` verb that
  sequences distinct SCENES end-to-end into one self-contained animated SVG with
  inter-scene transitions. Each scene is one source — `template`+`params` / `capture`
  / `cast` / existing `svg` — with a per-scene `duration` (optional for animated
  sources → inherits play time) and a `transition` (`{type,duration}`). Reuses the
  scene→SVG→`namespaceEmbeddedAnimatedSvg`→`placeEmbeddedFrame`→`AnimationFrame`
  (`embeddedAnimationPeriodMs`)→`generateAnimatedSvg` path — no new render code — and
  exports to MP4 via `svg-to-video` unchanged. `src/cli/storyboard.ts` +
  `schemas/storyboard-config.schema.json`. **Still open:** expose the doc-88 reveal
  transitions in the storyboard enum, cross-scene font dedup, per-scene overlays/cursor.

- **Doc 93 (`docs/93-realistic-typing.md`, DM-1518)** — **Shipped.** The `typing`
  overlay now animates character-by-character with the caret glued to the *measured*
  glyph edge (was ~12.7px behind on a long line — it estimated a monospace advance of
  `fontSize×0.6` vs the real ~0.618em). `measureTypingLines` builds a cumulative
  per-glyph advance array from fontkit; one shared reveal plan drives both the line
  clips and the caret (can't desync); reveal/caret step per keystroke (`step-end`),
  falling back to the estimate when the mono face can't resolve. New params: `mode:
  "type"|"paste"`, `jitter` (seeded, byte-stable). Verified vs Chromium (animate suite
  13/13). **Still open:** mistake→backspace→correct, per-keystroke real-site
  re-sampling, glyph-path/proportional rendering, `fontFamily` override.

- **Doc 86 (`docs/86-creative-template-pack.md`, DM-1523 design → DM-1531/1532/1533 impl)** —
  **All three batches shipped.** Batch A: four narrative text-card templates
  (`title-card`, `quote`, `caption` [transparent overlay subtitle, distinct from
  lower-third], `cta` [end-card with a pulsing button + logo slot]) sharing
  `src/templates/builtin/text-card-common.ts`. Batch B: `counter` (count
  up/down/timer) + `stat` (KPI + trend chip) on the **odometer digit-reel** module
  `src/templates/builtin/odometer.ts` (per-digit `translateY` roll — cross-engine-
  safe; **rests at identity** and rolls in from an offset, so Domotion's capture
  doesn't double-transform; real spin on low-order digits). This needed a
  **capture fix**: the script (`src/capture/script/index.ts`) now exempts
  `[data-domotion-anim]` subtrees from the off-viewport drop so a reel's off-canvas
  cells (which scroll into view) survive capture — the animation-aware viewBox cull
  trims the rest. Batch C: `compare` (`builtin/compare.ts`, DM-1533) reveals the
  after over the before with a clip wipe (+ optional divider) + labels, via
  `composeAnimatedLayers`' Firefox-safe `clipScale`; page/image/SVG inputs resolved
  through `captureToSvg`. All have `brandDefaults` (DM-1522) + honor format
  `safeInset` (DM-1537) where applicable.

- **Doc 85 (`docs/85-brand-kit.md`, DM-1522 design → DM-1530 impl)** —
  **Shipped v1.** A reusable brand file (palette / font / radius / logo /
  background) supplies every built-in template's *defaults*: `--brand acme.json`
  on `domotion template`. `loadBrand` (in `src/templates/brand.ts`) parses +
  validates (zod `brandSchema`) + resolves a relative `logo`; each themeable
  built-in exposes `brandDefaults(brand)`, merged BENEATH explicit params by
  `applyBrandDefaults` before zod defaults (precedence: explicit > brand >
  default). Composes with format presets (`--brand acme.json --format reel`).
  **Logo slot wired (DM-1539):** `cta`'s `brandDefaults` maps `brand.logo` → its
  `logo` param (first built-in to consume `brand.logo`).

- **Doc 92 (`docs/92-brand-for-capture.md`, DM-1540)** — **Shipped.** `--brand
  <file>` on `domotion capture` / `animate` injects the brand as CSS custom
  properties into the page *before capture*, so a real page authored against
  `var(--brand-*)` picks up the brand at capture time (distinct from the template
  *defaults* mechanism above). `brandCustomProperties` / `brandRootCss` (pure, in
  `src/templates/brand.ts`) emit only the tokens the brand set; `injectBrandVariables`
  (`src/capture/index.ts`) applies them as inline `:root` styles at document-start
  and re-applies on `DOMContentLoaded`. Contract: `palette.primary`→`--brand-primary`,
  `accent`→`--brand-accent`, `background`→`--brand-background`, `text`→`--brand-text`,
  `muted`→`--brand-muted`, `font.family`→`--brand-font-family`, `radius`→`--brand-radius`.
  **Still open (follow-ups):** brand → `template` frames in `animate` (they render
  before the capture loop), an inline `brand` key in the animate config, more logo-slot
  built-ins.

- **Doc 87 (`docs/87-format-presets.md`, DM-1521 design → DM-1534 impl)** —
  **Shipped v1.** Social-format presets on `domotion template`: `--format <name|WxH>`
  where names are `reel`/`story` (1080×1920), `square` (1080×1080), `portrait`
  (1080×1350), `landscape` (1920×1080). `resolveFormat` (in `src/templates/formats.ts`)
  returns `{width,height,safeInset}`; size precedence is explicit `--width`/`--height`
  > format > template default. The safe-area inset (px per side; vertical formats
  reserve top/bottom room) rides `TemplateRenderContext.safeInset` and is now
  **consumed by the themeable built-ins** (DM-1537): flex templates via
  `safeAreaPadding`, `chart` via an inner-dimension safe-rect wrapper — content
  stays within `canvas − safeInset` at 9:16 (default output byte-identical when no
  format). **Still open (follow-ups):** deeper responsive font-scaling per ratio,
  and `--format` on `capture` / `animate`.

- **Doc 84 (`docs/84-viewer-browser-support.md`, DM-1515)** — **Shipped contract.**
  The support matrix for the browsers that *view* the output (distinct from the
  capture-platform matrix). **Blink** (Chrome/**Edge**/Brave/Opera/Electron) +
  **WebKit** (Safari + all iOS browsers) are **first-class**; **Gecko** (Firefox)
  is **best-effort**: under heavy load Firefox demotes some OMTA animations to the
  main thread and a unit's paired opacity/transform can desync (graceful, not a
  break). Animation is authored as **CSS `@keyframes`** (not SMIL, never mixed —
  DM-1507) so it plays inside `<img>` with no runtime (JS/WAAPI don't run there).
  Generator mitigation: fuse a unit's co-timed tracks into one CSS animation
  (DM-1512/1513). Stress-test harness: `examples/output/stress-gallery.html`
  (DM-1514, regenerate via `examples/build-stress-gallery.ts`). Not to be confused
  with the fixed DM-1511 transparent-flash-at-cut-points bug (see doc 08).

- **Doc 82 (`docs/82-svg-scrubber-review-mode.md`, DM-1445 + DM-1449)** — **Shipped.**
  `svg-scrubber --review` adds an issue-reporting panel (title + category + note +
  drag-to-draw regions) that writes importable `.ticket` JSON files to the launch
  cwd, capturing the current frame time, the in/out range, and the region(s) (SVG
  user-units). `title`/`category`/`details` map straight onto `hotsheet_create_ticket`
  (the "tell Claude to import the .ticket files" flow). `POST /ticket` (review-only,
  404 otherwise) + the pure unit-tested `buildTicketFile` in `src/scrubber/server.ts`;
  the region overlay reuses the crop overlay's zoom/pan-aware SVG-unit math in
  `client.tsx`. **DM-1449** added **multiple regions** (overlay stays armed across
  drags; `regions` array, with `region` kept as the first for back-compat) and an
  **Attach frame** option that renders the current frame to a sibling `.png`
  (`framePng`, via the `/export-frame` seek+screenshot path). A built-in import
  command was explicitly deferred. Animated-SVG analogue of `svg-review`.
- **Doc 81 (`docs/81-iframe-recursion.md`, DM-1441 + DM-1442)** — **Both phases Shipped.**
  **Phase 2 (DM-1442):** `--cross-origin-frames "*"|host[:port],…` (config-object
  `captureCrossOriginFrames`) recurses **allowlisted** cross-origin frames by launching
  Chromium with web security disabled (`crossOriginFramesLaunchArgs`); non-allowlisted
  frames stay raster even when readable (blast-radius limit). Matching is two pure
  functions in `src/capture/script/cross-origin.ts` (bundled into the capture script +
  unit-tested), exact-host with optional port (default ports normalized). Default off +
  a stderr security warning (web-security-off disables CORS). Unit + e2e tested
  (`tests/cross-origin-iframe-recursion.e2e.test.ts`). Scroll-path threading is a minor
  follow-up. **Phase 1 (DM-1441):** a same-origin `<iframe>` no longer rasters to a flat `<image>`
  (raster-fallback §E4) — its `contentDocument` is recursed with the **same** capture
  logic and spliced in as the iframe node's child, yielding crisp/scalable/selectable
  native SVG. Placement uses a **temporary `vp`-origin shift** during the inner walk
  (every capture helper reads `vp.x/vp.y` live, so the inner subtree comes out already
  positioned at the iframe content box, the viewport cull tests inner content against
  the real region, and the shift composes for nested frames) rather than a fragile
  per-field offset; the iframe node is set `overflow:hidden` so the existing renderer
  clip bounds the inner content to the content box (no renderer change). Cross-origin
  frames stay raster until **Phase 2** (planned `--cross-origin-frames` host allowlist +
  `--disable-web-security`, default-off + a security warning). **DM-1443** then ran the
  inner-document pre-passes (`_runInnerDocumentPrePasses`) so inner CSS counters,
  `@counter-style`, fixed/sticky/transform cull exemptions, and scale/zoom font metrics
  all resolve against the iframe's own document; inner mask/clip/filter `<defs>`
  fragment refs remain a tracked gap.
- **Doc 78 (`docs/78-svg-to-image.md`, DM-1353 + DM-1354)** — **Shipped.** A fifth
  published bin, `svg-to-image`: convert one SVG to a single image file — PNG /
  JPEG / PDF / WebP / AVIF / TIFF, format inferred from the `-o` extension (or
  `--format`). The headless, one-shot counterpart to the scrubber's interactive
  frame export and the still analogue of `svg-to-video`; built for the agent review
  loop ("render → look at the pixels → critique"). `--at <ms>` samples an animated
  SVG's timeline; `--scale` supersamples raster output (retina); `--width/--height`
  contain preserving aspect; PNG/WebP/AVIF/TIFF keep alpha (JPEG/PDF composite on
  white). PNG/JPEG/PDF are native Chromium (`page.screenshot`/`page.pdf`); WebP/AVIF/
  TIFF transcode from the PNG buffer via the already-bundled `sharp` (DM-1354),
  lazy-`import()`ed only when requested. Input is an SVG file only (URL/HTML → image
  is `domotion capture` then this). Reuses the `svg-to-video-core` seek+screenshot
  machinery (`src/cli/svg-to-image{,-core}.ts`).
- **Doc 77 (`docs/77-nested-animated-compositing.md`, DM-1323)** — **Shipped (core).**
  General animated-SVG compositing: nest one *animated* composition (cast / scroll
  capture / template / `animate` result) inside another, animation intact — the
  terminal-window-on-a-desktop / website-in-a-browser-bezel composite. Ships:
  `composeAnimatedLayers` (`src/animation/composite.ts`, package-root export) — z-
  ordered layers, each placed with an independent timeline (`hold`/`stretch`/`loop`,
  `offsetEmbeddedAnimatedSvgTimeline`) + layer-level animations (move/scale/fade,
  e.g. a window resized mid-playback); the `domotion composite <config.json>` verb
  (`src/cli/composite.ts`); and `device-mockup`'s `screenSvg` param (nest an
  animated screen instead of capturing to static). E2E demo:
  `examples/composite-desktop.ts` + `examples/composite/`. A published JSON Schema
  ships at `schemas/composite-config.schema.json` (generated from the zod schema by
  `npm run build:composite-schema`). Embedded fonts are deduped across layers two
  ways: byte-identical payloads collapse anywhere (DM-1329, `dedupeCompositeFonts`),
  and `cast` layers in the declarative `composite` path share ONE embedded-font
  builder so terminals in the same monospace with *different* text embed the union
  subset once (DM-1331, `deferFonts` + `fontFaceCss`).
- **DM-1319 cast/template timeline re-sync (`src/animation/embed-timeline.ts`)** —
  **Shipped.** A `cast` / `template` frame's nested animation now starts when its
  frame becomes visible (offset by preceding frames) and holds before/after,
  instead of running on the shared document origin. New `AnimationFrame.
  embeddedAnimationPeriodMs` field drives it inside `generateAnimatedSvg`. See
  `docs/67`.
- **Doc 76 (`docs/76-social-templates.md`, DM-1278)** — **Shipped.** Two social
  built-ins: `chat` (a message thread whose bubbles pop in one at a time,
  alternating `me`/`them` sides; parsed from a `{from,text}[]` array or `me:`/
  `them:` lines) and `subscribe` (a follow/subscribe pop-up card that pops in with
  a looping `alternate` pulse on the CTA). Both are timed-reveal staggered
  intra-frame animation passes. Code in `src/templates/builtin/{chat,subscribe}.ts`.
- **Doc 75 (`docs/75-chart-template.md`, DM-1279)** — **Shipped.** The `chart`
  built-in: an animated `column` / `bar` / `line` chart from a list of values
  (CSV or JSON `data`). Bars grow from the axis via `scaleY`/`scaleX` +
  `transformOrigin` (the `width`/`height` intra-frame properties don't apply to
  the `<g>` wrapper); the line is an inline `<svg>` revealed by a `clipPath` wipe.
  Title, value/category labels, palette, nice axis max. Code in
  `src/templates/builtin/chart.ts`.
- **Doc 74 (`docs/74-template-authoring.md`, DM-1282)** — **Shipped.** The
  third-party template authoring + publishing guide: a template is an npm package
  named `domotion-template-<name>` exporting a `Template` (`domotion-svg` is a
  types-only peer dep); covers package shape, generator vs decorator, the two
  animation constraints (incl. `transformOrigin`), params/`z.coerce`, `durationMs`,
  testing via `renderTemplateToSvg`, and the `domotion-template-*` discovery
  convention. Runnable scaffold in `examples/template-package/`; public template
  gallery + authoring guide on the site (`site/src/content/docs/usage/templates.md`,
  `site/src/content/docs/developer/custom-templates.md`).
- **Doc 73 (`docs/73-template-frames.md`, DM-1287)** — **Shipped.** A `template`
  frame kind in the `animate` config: `{"template":"lower-third","params":{…}}`
  embeds a named template (doc 70) as a nested animated SVG, composing it into a
  larger multi-frame animation. Params validated against the template's own
  schema; template inherits the canvas size (centered otherwise). The crux is
  nesting an animated SVG inside another: template frames are pre-rendered before
  the outer font lifecycle, and the nested document's global names (ids, font
  families, `.f-N` classes, `@keyframes`, `--scene-dur`) are namespaced per-frame
  (`namespaceEmbeddedAnimatedSvg`, `src/animation/embed-namespace.ts`) so they
  can't collide with the outer animation or sibling template frames. The same
  namespacer (with `namespaceFonts:false`) now also fixes the `cast` path's latent
  class/`@keyframes`/`--scene-dur` collision (DM-1292). A template frame's
  `duration` is optional (DM-1294) — omitted, it's derived from the template's
  intrinsic play time (`TemplateOutput.durationMs`).
- **Doc 72 (`docs/72-kinetic-text-template.md`, DM-1277 + DM-1286)** — **Shipped.**
  The `kinetic-text` **generator** template: a headline string is expanded at
  author time into per-word / per-char units, each revealed with a staggered
  animation (`rise` / `slide` / `fade` / `clip`) then held assembled. DM-1286 added
  the `clip` wipe, multi-line `\n`, light inline emphasis tags (`<b>`/`<i>`/`<u>`/
  `<font color>` safelist, others dropped), and `loop` / `boomerang` modes. The
  clearest showcase of the doc-70 "pre-process once, replay free" thesis; same two
  animation constraints as doc 71. DM-1297 added the `pop` (center-origin
  scale-up) variant + the underlying intra-frame `scale` property and
  `transformOrigin` support (emits `transform-box: fill-box; transform-origin` so
  any transform can pivot about the element's own box — doc 08). A `blur-in`
  variant (DM-1296) was built (a `filter: blur()` keyframe reveal) but **dropped**:
  animated CSS `filter` on an `<img>`-embedded SVG works in Chromium but not
  Safari/other engines, so it isn't cross-browser-safe. Do not re-attempt the
  `filter`-keyframe approach.
- **Doc 71 (`docs/71-background-loop-template.md`, DM-1280 + DM-1285 + DM-1295)** —
  **Shipped.** The first deferred first-party template built on the doc-70
  contract: a `background-loop` **generator** that emits a procedural seamlessly-
  looping animated background. Six variants: `aurora` / `orbs` / `stars` blobs, a
  `gradient-pan` color wash, a drifting `grid`, and `wave` ribbon bands (DM-1285 +
  DM-1295); deterministic from a `seed`; comma-separated `--colors`. Demonstrates
  the two animation constraints templates must respect —
  one intra-frame animation per captured element (so each blob is a drift-wrapper
  around a breathe-inner), and origin-(0,0) SVG transforms (so motion is
  origin-safe translate + opacity, looped with `alternate`).
- **Doc 70 (`docs/70-template-system.md`, DM-1276)** — **Spike shipped** (the
  de-risking spike from the DM-1210 templates investigation). A Domotion
  *template* is a parameterized generator — `render(params)` produces a
  self-contained SVG by driving the **existing** capture/compose pipeline (no new
  rendering code), so it can do arbitrary author-time pre-processing and stay
  HTML/CSS-native. Ships: the `Template` contract + registry/loader (`src/
  templates/`), the `domotion template <name>` CLI verb, and two built-ins —
  `lower-third` (generator) and `device-mockup` (decorator reusing
  `wrapInDeviceChrome`). Third-party templates are npm `domotion-template-*`
  packages (same mechanism as built-ins). Decorators must use the `captureToSvg`
  *static* primitive, not a one-frame animate config (an animated SVG won't nest
  in a bezel). The wider first-party library + a Lottie **input** adapter are
  filed follow-ups, **not yet built**.
- **Doc 69 (`docs/69-scroll-button-rendering.md`, DM-1234)** — **Shipped.**
  `::scroll-button(left/right/up/down)` paging arrows are captured + rendered as
  replica siblings of the scroller. `getComputedStyle` can't disambiguate the
  parameterized pseudo, so per-side `content` + the `:disabled` rule are read
  from the author stylesheet (CSSOM); geometry is resolved by a `<body>`-appended
  replica that — like the real generated button — takes the **viewport** as its
  containing block (`top:50%` = 50% of the viewport, not the scroller, verified
  by probe-and-match); enabled/disabled comes from the captured scroll offset.
  `_captureScrollButtons` in `src/capture/script/index.ts`. Companion to doc 38.
- **Doc 67 (`docs/67-terminal-capture.md`, DM-1225)** — `domotion term --cast
  <file.cast>` converts a recorded terminal session (asciinema v2) into an
  animated SVG. Backend in `src/terminal/`: `@xterm/headless` VT emulation →
  settle-point frames → terminal HTML → the normal capture→SVG pipeline →
  `generateAnimatedSvg` with hard cuts. **Two front-ends** now ship: asciinema
  `--cast` import, and live `node-pty` capture (`domotion term -- <cmd>`, DM-1226
  / **doc 68**, `src/terminal/pty.ts`, optional dep) onto the same backend.
  Composes into larger animations two ways: a `cast` frame in the `domotion
  animate` JSON config (embeds the terminal as a nested animated SVG, sized like
  a `scroll` block), and the `castToTermFrames` frames-out API (+ the terminal
  primitives) re-exported from the package root for retiming / chrome-wrapping.
- **Doc 65 (`docs/65-device-chrome.md`, DM-1206 / DM-1211 / DM-1212)** — `domotion capture
  --chrome <device>` wraps a capture in a hand-drawn device bezel: `phone`,
  `browser` (traffic lights + URL pill), `window` (title bar); `--chrome-label`
  sets the browser URL / window title and `--chrome-theme dark|light` themes the
  bezel (DM-1212). `src/render/device-chrome.ts`
  (`wrapInDeviceChrome`, optional `{ label }`) nests the *rendered* capture as a
  child `<svg>` rather than re-rendering the tree (re-rendering drops the system
  font to `.notdef` tofu). Pure-SVG + cross-platform (the label is the one live
  `<text>`).
- **Doc 64 (`docs/64-demo-gallery.md`, DM-214..223)** — the progressive
  **demo gallery** concept. NOTE: the legacy kerfjs manual it described
  (`site/scripts/demos/`, `site/pages/guides/`) was removed when the site was
  rebuilt as Astro + Starlight (DM-1308); the gallery now lives across the new
  `site/` Showcase + Usage pages, sourced from `examples/output`,
  `examples/output/templates`, and the runnable `examples/animate/` goldens. Doc
  64 itself is partly historical — reconciliation tracked separately.
- **Doc 54 (`docs/54-svg-review-tool.md`, DM-946)** — the published
  `svg-review` CLI for single-fixture render-fidelity bug reports.
- **Doc 55 (`docs/55-debug-mode-capture.md`, DM-945)** — the
  `domotion capture --debug` flag's reproduction bundle (HAR +
  screenshot + actual SVG + captured-tree JSON).
- **Doc 56 (`docs/56-svg-scrubber.md`, DM-1040)** — the
  `svg-scrubber` CLI: a local video-style bench for an animated
  SVG (play / scrub / speed / range-loop / frame-PNG / range-MP4 / trim).
- **Doc 57 (`docs/57-scrubber-crop.md`, DM-1104)** — the scrubber's crop
  mode: a draggable crop rect (8 handles) baked into all three exports
  (raster clip for PNG/MP4, viewBox vector crop for the trimmed SVG).
- **Doc 58 (`docs/58-new-york-optical-cuts.md`, DM-1108)** — macOS New York
  serif optical cuts. Unlike SF Pro's single variable file (DM-1103), New
  York ships its cuts as separate static OTFs (no `opsz` axis), so the
  `OPTICAL_CUT_OPSZ` mechanism does not apply; only `"New York Medium"`
  needed a routing fix (it collided with the variable font's Medium weight).
- **Doc 79 (`docs/79-harfbuzz-use-reroute.md`, DM-1197 + DM-1215)** — two narrow
  uses of real HarfBuzz (harfbuzzjs) where macOS shaping diverges from Chrome.
  (1) DM-1197: USE-shaped precomposed letters with a canonical base+mark NFD
  (Kaithi `U+110AB`, Balinese, Tulu-Tigalari — 13 cps) shape via HarfBuzz instead
  of the CoreText helper, which recomposes and mis-places the mark; scoped to the
  USE shaper, `DEDICATED_SHAPER_RANGES` stay on CoreText. (2) DM-1215: an
  ORPHANED complex-script combining mark (no spacing base) routes through the
  mark's own font as a HarfBuzz instance so the dotted circle `U+25CC` Chrome
  inserts + GPOS-positions the mark on is reproduced — fontkit drops the ◌ for
  USE faces (Adlam/Miao) and mis-centers it otherwise. Fixed adlam/miao/brahmi/
  kharoshthi/tagalog/tai-tham/syloti via `resolveDottedCircleHbRun` in both
  run-splitters.
- **Doc 80 (`docs/80-cross-platform-system-fallback-resolver.md`, DM-1403)** —
  **macOS / Linux / Windows all Shipped + default-on.** The per-codepoint live
  system-fallback resolver (macOS CoreText `CTFontCreateForString`) that catches
  codepoints the static per-block table misses — previously hard-gated
  `process.platform !== "darwin" → null` — is now one platform-dispatched entry
  point (`resolveSystemFallbackKeyForCp`). Linux backend via fontconfig
  `fc-match :charset=<hex>` (`resolveLinuxSystemFallbackKeyForCp`, reusing the
  existing `fcMatch` — no new native code), calibrated against Chromium-on-noble
  and flipped default-on in DM-1416 (with a `fontFileCoversCodepoint` coverage
  guard). Windows backend via DirectWrite `IDWriteFontFallback::MapCharacters`
  (the win32 glyph helper's `fallback` query, `HasCharacter` coverage guard),
  calibrated against Chromium-on-Win11 and flipped default-on in DM-1424 — the
  4,899-codepoint sweep found 0 sampled codepoints move (every MapCharacters/
  Chromium divergence is on a static-table-owned cp). `DOMOTION_SYSTEM_FALLBACK=0`
  forces it off on Linux/Windows. The chain walker's `glyphForCodePoint` check
  makes a non-covering backend result harmless (falls through to tofu, never a
  wrong glyph).
- **Doc 61 (`docs/61-overlay-resolution-primitive.md`, DM-1132)** — `resolveOverlays(
  page, overlays)` lowers an overlay's selector `anchor` + typing `maxWidth:
  "anchor"` into concrete `x`/`y`/`bgWidth` for imperative scripting-API callers.
  The CLI and the public primitive share one engine; the box helper `contentBox`
  / `boxAnchorPoint` (DM-1133) and overlay SSOT (DM-1131) underpin it.
- **Doc 62 (`docs/62-frames-out-animate-pipeline.md`, DM-1136)** — **SHIPPED.**
  Opened up the all-or-nothing `composeAnimateConfig`: a frames-out variant
  (`composeAnimateFrames` returning the assembled `AnimationConfig` before the
  final `generateAnimatedSvg`, DM-1137) + an optional `onFrame` per-frame hook
  with an options-object signature (DM-1138). Lets a JSON-config consumer inject
  custom per-frame edits without reimplementing the capture→compose loop.
- **Doc 63 (`docs/63-cursor-action-primitives.md`, DM-1135)** — **SHIPPED.**
  Exposed the cursor selector→point resolution (`borderBox` + `resolveCursorTarget`,
  DM-1139) and the declarative action runner (`runActions` + the `AnimateAction`
  union, DM-1140) as public primitives. Companion to doc 62 (per-feature
  primitives vs the whole pipeline). Notes the border-box (cursor) vs content-box
  discrepancy.
- **Doc 60 (`docs/60-programmatic-animate-pipeline.md`, DM-1130)** — the
  declarative `animate` pipeline (`composeAnimateConfig` / `validateAnimateConfig`
  / `interpolateConfigVars` / `AnimateConfig`) is now re-exported from the
  package root, so library callers run a JSON-config animation in-process.
  `configDir` defaults to `process.cwd()`; the CLI is a thin file-read wrapper.
- **Doc 59 (`docs/59-overlay-schema-ssot.md`, DM-1131)** — overlay / intra-frame
  animation shapes are now defined once as zod base schemas in
  `src/animation/overlay-schema.ts`; the renderer's runtime types are `z.infer`red
  from them and the declarative config (`src/cli/animate.ts`) extends the same
  bases. One base, two views (resolved vs authoring) — renames cascade at compile
  time, and `schemas/animate-config.schema.json` stays generated from the source.
- **Doc 13 cursor-type matching (DM-1106)** — the cursor overlay now paints
  the correct cursor glyph for whatever is under the pointer (hand over links,
  I-beam over text, resize arrows, grab, …) and switches at element boundaries.
  Capture records the effective `cursor` per element (`auto` resolved per Blink);
  glyphs are Lucide-composed in `src/animation/cursor-glyphs.ts`.

These two together form the consumer-side bug-report workflow: capture
with `--debug`, review with `svg-review`, file an issue with the
generated Markdown. AI agents working on render bugs should reach for
the same flow internally — see `CLAUDE.md` "Debugging the generated
output".

## Cross-platform support

Per `CLAUDE.md` "Platform support — non-negotiable":

- macOS, Linux, Windows must all work. The output should be pixel-faithful
  to Chromium ON the platform the capture runs on (CoreText on macOS,
  fontconfig on Linux, DirectWrite on Windows).
- All three platforms now have calibrated fallback chains AND generated
  per-Unicode-block routing tables — `unicode-font-routing.{darwin,linux,win32}
  .generated.ts`, from Chrome CDP `CSS.getPlatformFontsForNode` sweeps
  (macOS DM-983, Linux DM-984, Windows DM-987). macOS remains the most
  mature / most-validated; Linux + Windows native glyph extractors and CI
  are partially landed (docs 41 / 45 / 49–52). Treat macOS as the reference
  and re-probe the others when their font set changes.
- New font / fallback / metric routing must be designed platform-aware
  from the start — `process.platform` based, not assumed `darwin`.

## Platform-specific docs

- **Doc 40 (`docs/40-cross-platform-font-paths.md`)** — how the platform
  font-path lookup works.
- **Doc 42 (`docs/42-cross-platform-fallback-calibration.md`)** — how
  fallback chains get probed against Chromium's painted output.
- **Doc 41 (`docs/41-windows-glyph-extraction.md`)** and
  **doc 45 (`docs/45-linux-glyph-extraction.md`)** — native glyph
  extraction helpers (currently macOS via CoreText is doc 16).
- **Doc 49 / 50 / 51 / 52** — glyph-helper dispatch, acquisition,
  probe-then-fallback, embedded-mode glyph fallback.

## What this file is NOT

- Not a complete requirements doc — the per-feature docs are.
- Not a substitute for opening the actual numbered doc — when a ticket
  touches gradients, open `docs/07-gradient-fills.md` /
  `docs/10-repeating-gradients.md`. When it touches fonts, open
  `docs/03-font-family-chain.md` / `docs/52-embedded-mode-glyph-fallback
  .md`. And so on.
