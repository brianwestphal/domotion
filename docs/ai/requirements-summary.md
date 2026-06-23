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
  any transform can pivot about the element's own box — doc 08). `blur-in`
  (DM-1296) remains filed, blocked on blur-capture fidelity.
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
  **demo gallery** surfaced on the manual's *Guides → Demo gallery* page. Each
  demo is a self-contained folder under `site/scripts/demos/<demo>/` (HTML
  source + `capture.sh`/`build-*.ts` + committed golden SVG); display copies
  live in `site/assets/img/demos/`. Tier 1 (single-capture: hero card, pricing
  table, code block, phone-framed screen) is shipped; Tier 2/3 (animated)
  reuse the runnable `examples/animate/` configs and land incrementally. Notes
  the missing `--chrome <device>` flag behind the hand-drawn phone bezel.
- **Doc 54 (`docs/54-svg-review-tool.md`, DM-946)** — the published
  `svg-review` CLI for single-fixture render-fidelity bug reports.
- **Doc 55 (`docs/55-debug-mode-capture.md`, DM-945)** — the
  `domotion capture --debug` flag's reproduction bundle (HAR +
  screenshot + actual SVG + captured-tree JSON).
- **Doc 56 (`docs/56-animated-svg-scrubber.md`, DM-1040)** — the
  `animated-svg-scrubber` CLI: a local video-style bench for an animated
  SVG (play / scrub / speed / range-loop / frame-PNG / range-MP4 / trim).
- **Doc 57 (`docs/57-scrubber-crop.md`, DM-1104)** — the scrubber's crop
  mode: a draggable crop rect (8 handles) baked into all three exports
  (raster clip for PNG/MP4, viewBox vector crop for the trimmed SVG).
- **Doc 58 (`docs/58-new-york-optical-cuts.md`, DM-1108)** — macOS New York
  serif optical cuts. Unlike SF Pro's single variable file (DM-1103), New
  York ships its cuts as separate static OTFs (no `opsz` axis), so the
  `OPTICAL_CUT_OPSZ` mechanism does not apply; only `"New York Medium"`
  needed a routing fix (it collided with the variable font's Medium weight).
- **Doc 60 (`docs/60-harfbuzz-use-reroute.md`, DM-1197 + DM-1215)** — two narrow
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
