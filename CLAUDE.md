# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Domotion is a DOM-to-animated-SVG renderer. It captures HTML/CSS rendered in Playwright Chromium and converts the captured tree into a self-contained SVG with optional CSS animations. The output is pixel-faithful to Chromium on macOS, scales crisply at any size, and embeds without external assets — purpose-built for marketing and documentation demos that need to load lazily and look identical across browsers.

The project was originally built inside the `slicekit` monorepo as `tools/svg-demo-gen`; it was extracted in 2026-04 to live as a standalone package so it can be published to npm and consumed by other projects. See `docs/` for full requirements docs covering rendering fidelity, supported CSS features, and known caveats.

## Stack

- **Runtime**: Node.js 22+, TypeScript 5.8+
- **Capture**: `@playwright/test` (Chromium headless) — the only browser engine we target.
- **Glyph paths**: `fontkit` for `font.layout()` shaping and outline extraction from macOS system fonts.
- **Bidi**: `bidi-js` for paired-bracket mirroring on RTL embedding levels.
- **Optimization**: `svgo` for the optional optimize pass.
- **Tests**: `vitest` for unit tests; bespoke visual-regression harnesses under `tests/`.

## Commands

```bash
npm run build           # tsc compile to dist/
npm test                # vitest run (unit tests in src/**/*.test.ts)
npm run demos:test      # feature visual-regression suite (tests/features.ts)
npm run demos:test:html # html-test-suite vs ~/Documents/html-test/*.html
npm run demos:test:all  # features + showcase + html-test-suite
npm run demos:review    # local server to compare expected/actual/diff PNGs
npm run demos:examples  # run the three example demo scripts
```

## Code Organization

- **`src/dom-to-svg.ts`** — capture entry point. Exports `captureElementTree()` (runs an in-page CAPTURE_SCRIPT to walk the DOM into a serializable tree) and `elementTreeToSvg()` (renders the tree as SVG markup). The CAPTURE_SCRIPT lives as a string literal that's `evaluate()`d in the page context, so it can't import from the rest of the source — keep it self-contained.
- **`src/text-to-path.ts`** — fontkit glyph-to-path conversion with `<defs>`/`<use>` deduplication. Owns the `FONT_PATHS` map (macOS system fonts), `fallbackFontKey()` script-to-font routing, and the run-based shaping path that handles Arabic contextual joining, Devanagari cluster reordering, and CJK GPOS.
- **`src/text-renderer.ts`** — chooses single-line, multi-segment, multi-line, or input rendering based on captured shape. Wraps `applyBidi()` for paired-bracket mirroring before handing text to the path renderer.
- **`src/animator.ts`** — `generateAnimatedSvg()` composes multiple captured frames into one SVG with `@keyframes` cross-fade / push-left / scroll transitions.
- **`src/capture.ts`** — Playwright bring-up helpers (`launchBrowser`, `withPage`).
- **`src/form-controls.ts`** — synthesizes the SVG markup for `<input type=checkbox/radio/range/color>`, `<progress>`, `<meter>`, etc., honoring author-styled shadow-DOM pseudos.
- **`src/gradients.ts`** — translates CSS `linear-gradient` / `radial-gradient` to SVG `<linearGradient>` / `<radialGradient>` with px-positioned stops.
- **`src/optimize.ts`** — optional svgo pass (callers pick when to apply).
- **`src/frame-merge.ts`** — combines per-frame element trees into one tree for animation, deduping shared static elements.
- **`tests/features.ts`** — minimal HTML snippets, one per rendering feature. Each test renders both via Chromium and via Domotion's pipeline and diffs the PNGs (3% threshold).
- **`tests/showcase.ts`** — three full-page integration tests.
- **`tests/html-test-suite.ts`** — sweeps every `*.html` under `~/Documents/html-test/` and reports per-tile diff metrics.
- **`tests/runner.ts`** — shared visual-regression harness used by features.ts and showcase.ts.
- **`tests/review-server.ts`** — local web UI that loads the expected/actual/diff PNGs from each suite for human review.
- **`examples/`** — three runnable demo scripts (`terminal-demo.ts`, `showcase-rendering.ts`, `showcase-transitions.ts`) that produce the SVGs shipped on the consumer site.

## CAPTURE_SCRIPT discipline

The capture function is serialized to a string and executed inside the captured page via `page.evaluate`. That means:

- **No `import`s, no closures over module-scope vars** — only the args passed to `evaluate` and globals available in the page.
- **Use `var` / function declarations or arrow functions** that don't reference outer scope.
- **Test in the test runner**, not in unit tests, because the script only behaves correctly when the surrounding `evaluate()` injects its arguments.
- Anything reusable across capture and render can live as plain TypeScript helpers in `src/` and be reimported by the renderer side; just don't try to call them from inside CAPTURE_SCRIPT.

## Decoration & shaping invariants

- **Subpixel x positioning**: when xOffsets are captured per character, the renderer must NOT round to integer pixels — Chromium uses subpixel positioning and rounding accumulates ~0.5px/char drift across a line.
- **Run-based shaping for fallbacks**: in mixed-script lines, contiguous fallback-font runs are shaped with `font.layout(runText)` (not per-char) so Arabic init/medi/fina forms, Devanagari ligatures, and Thai mark-on-base positioning survive. Anchor at `min(xOffsets[runStart..runEnd])` — the visual-leftmost captured x — which is correct for both LTR and RTL.
- **Decoration metrics from font tables**: `getDecorationMetrics()` reads `post.underlinePosition` / `underlineThickness` and `OS/2.yStrikeoutPosition` / `yStrikeoutSize` rather than fontSize fractions. This matches what Chromium consults.
- **fontkit shaping ≈ HarfBuzz** for the scripts we care about (verified per-fixture in 2026-04). harfbuzzjs is not warranted; the gap is <1% on Arabic/Thai and 0% on Devanagari/CJK ideographs at standard body sizes.

## Quality gates

- **`npm run build`** must succeed (tsc with strict TypeScript). No `any` outside the fontkit/bidi-js boundary types.
- **`npm test`** must pass (unit tests).
- **`npm run demos:test`** is the primary regression signal — every feature has a fixture; new features need fixtures.
- The `html-test-suite` against `~/Documents/html-test/*.html` is the broad-coverage signal. Some failures are pre-existing and tracked separately; new code shouldn't introduce regressions there.

## Git

- **Never commit unless explicitly asked.** Do not run `git commit`, `git add`, or any git write operations proactively. Only commit when the user directly asks.

## Documentation

When you change capture, rendering, or animation behavior, update the relevant requirements doc in `docs/`. Add a new doc when a feature area isn't covered. The docs are the contract with consumers about what CSS round-trips and what doesn't.

The `FEATURES.md` checklist tracks per-feature support and links to fixtures; keep it in sync when fixtures land.
