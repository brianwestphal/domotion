# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Domotion is a DOM-to-animated-SVG renderer. It captures HTML/CSS rendered in Playwright Chromium and converts the captured tree into a self-contained SVG with optional CSS animations. The output is pixel-faithful to Chromium on the host platform, scales crisply at any size, and embeds without external assets — purpose-built for marketing and documentation demos that need to load lazily and look identical across browsers.

The project was originally built inside the `slicekit` monorepo as `tools/svg-demo-gen`; it was extracted in 2026-04 to live as a standalone package so it can be published to npm and consumed by other projects. See `docs/` for full requirements docs covering rendering fidelity, supported CSS features, and known caveats.

## Platform support — non-negotiable

**Domotion ships as an npm package and must function on macOS, Linux, and Windows like any normal npm package.** The output should be pixel-faithful to Chromium _on the platform the capture is running on_ — Chromium-on-macOS uses CoreText fallback (Hiragino, Apple Symbols, Zapf Dingbats, STIX Two Math), Chromium-on-Linux uses fontconfig (Noto / DejaVu / Liberation), Chromium-on-Windows uses DirectWrite (Segoe UI Symbol, Cambria Math, Consolas, Yu Gothic). Each platform's fallback chain must be calibrated against the actual painted output of Chromium on that platform.

Today the implementation is fully calibrated only for macOS — that's debt, not design. The cross-platform roadmap lives in tickets DM-258 (path discovery) → DM-259 (Linux chains) / DM-260 (Windows chains) / DM-261 (bundled fallback fonts) → DM-262 (CI on Linux + Windows).

**Rules for new code**:

- Don't add hardcoded `/System/Library/Fonts/...` paths or other macOS-only literals without flagging the cross-platform gap in the change.
- New font / fallback / metric routing must be designed platform-aware from the start (lookup by `process.platform`, not assumed to be `darwin`).
- When matching Chromium's behavior, verify empirically against Chromium on the target platform — the same probe methodology used for DM-241 / DM-256 / DM-257 (measure `Range.getBoundingClientRect().width`, match against candidate font advance widths via fontkit's `glyphForCodePoint`).

## Stack

- **Runtime**: Node.js 22+, TypeScript 5.8+
- **Capture**: `@playwright/test` (Chromium headless) — the only browser engine we target.
- **Glyph paths**: `fontkit` for `font.layout()` shaping and outline extraction from host system fonts (currently macOS-calibrated; Linux/Windows tracked DM-258+).
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
- **`src/text-to-path.ts`** — fontkit glyph-to-path conversion with `<defs>`/`<use>` deduplication. Owns the `FONT_PATHS` map (currently macOS-only paths; cross-platform path discovery tracked DM-258), `fallbackFontChain()` script-to-font routing (per-Unicode-block ordered chain, calibrated empirically against Chromium painted widths), and the run-based shaping path that handles Arabic contextual joining, Devanagari cluster reordering, and CJK GPOS.
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

### JSX Runtime

The project uses a custom JSX runtime (`src/jsx-runtime.ts`) instead of React. It renders JSX to HTML strings via the `SafeHtml` class. This runtime is shared by both the server-side components and client-side modules. Configured via:
- `tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "#jsx"`
- `package.json` imports map: `"#jsx/jsx-runtime": "./src/jsx-runtime.ts"`
- `tsup.config.ts`: esbuild alias resolves `#jsx/jsx-runtime` at build time (both server and client configs)

When writing TSX components, they return `SafeHtml` (which is `JSX.Element`). Use `raw()` to inject pre-escaped HTML strings. All string children are auto-escaped. In client code, convert JSX to DOM elements with `toElement()` from `src/client/dom.ts`, or to string for `innerHTML` with `.toString()`.

## Git

- **Never commit unless explicitly asked.** Do not run `git commit`, `git add`, or any git write operations proactively. Only commit when the user directly asks.

## Ticket-Driven Work

When the user gives you work directly via the CLI (not via MCP channel or Hot Sheet events), analyze the request and create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work. This keeps work visible, trackable, and consistent with the Hot Sheet workflow.

- **Do create tickets** for: feature implementation, bug fixes, refactoring, multi-step tasks, anything that involves changing code.
- **Don't create tickets** for: simple questions, git commits, quick lookups, trivial one-line changes.
- **When in doubt, create the tickets.** The overhead is minimal and the tracking value is high.
- Use the Hot Sheet API to create tickets, mark them as Up Next, then work through them normally (set status to "started", implement, set to "completed" with notes).
- **Always create follow-up tickets** for work that isn't completed in the current session: unfinished implementation steps, open design questions needing answers, known gaps discovered during work, features designed but not yet built (e.g., a requirements doc without implementation). Never leave follow-up work undocumented — if it's not in a ticket, it will be forgotten.
- **Use FEEDBACK NEEDED before deferring or asking about follow-up tickets.** When you're about to (a) defer a ticket because it needs more work, (b) ask the user whether to file follow-up tickets, or (c) close a ticket with a question buried in the notes ("let me know if you want X" / "happy to do Y if you want"), DO NOT close it that way. Instead, leave the ticket in `started` status and add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), then signal channel done and wait for the user. Closing with an unanswered question buries the question and the user can't easily see it. The FEEDBACK NEEDED mechanism is the only way to reliably get attention on a question.

## Documentation

When you change capture, rendering, or animation behavior, update the relevant requirements doc in `docs/`. Add a new doc when a feature area isn't covered. The docs are the contract with consumers about what CSS round-trips and what doesn't.

The `FEATURES.md` checklist tracks per-feature support and links to fixtures; keep it in sync when fixtures land.
