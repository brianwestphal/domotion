# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Domotion is a DOM-to-animated-SVG renderer. It captures HTML/CSS rendered in Playwright Chromium and converts the captured tree into a self-contained SVG with optional CSS animations. The output is pixel-faithful to Chromium on the host platform, scales crisply at any size, and embeds without external assets — purpose-built for marketing and documentation demos that need to load lazily and look identical across browsers.

The project was originally built inside the `slicekit` monorepo as `tools/svg-demo-gen`; it was extracted in 2026-04 to live as a standalone package so it can be published to npm and consumed by other projects. See `docs/` for full requirements docs covering rendering fidelity, supported CSS features, and known caveats.

## Platform support — non-negotiable

**Domotion ships as an npm package and must function on macOS, Linux, and Windows like any normal npm package.** The output should be pixel-faithful to Chromium _on the platform the capture is running on_ — Chromium-on-macOS uses CoreText fallback (Hiragino, Apple Symbols, Zapf Dingbats, STIX Two Math), Chromium-on-Linux uses fontconfig (Noto / DejaVu / Liberation), Chromium-on-Windows uses DirectWrite (Segoe UI Symbol, Cambria Math, Consolas, Yu Gothic). Each platform's fallback chain must be calibrated against the actual painted output of Chromium on that platform.

Today the implementation is fully calibrated only for macOS — that's debt, not design. The cross-platform roadmap (system-font path discovery → Linux fallback chains / Windows fallback chains / bundled fallback fonts → CI on Linux + Windows) is tracked in local Hot Sheet tickets only; nothing public yet.

**Rules for new code**:

- Don't add hardcoded `/System/Library/Fonts/...` paths or other macOS-only literals without flagging the cross-platform gap in the change.
- New font / fallback / metric routing must be designed platform-aware from the start (lookup by `process.platform`, not assumed to be `darwin`).
- When matching Chromium's behavior, verify empirically against Chromium on the target platform — measure `Range.getBoundingClientRect().width` of the rendered glyph in a probe div, then match against candidate font advance widths via fontkit's `glyphForCodePoint`. That probe-and-match approach is how the current macOS fallback chain was reverse-engineered out of Chromium's painted output.

## Stack

- **Runtime**: Node.js 22+, TypeScript 5.8+
- **Capture**: `@playwright/test` (Chromium headless) — the only browser engine we target.
- **Glyph paths**: `fontkit` for `font.layout()` shaping and outline extraction from host system fonts (currently macOS-calibrated; Linux/Windows are roadmap).
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
- **`src/text-to-path.ts`** — fontkit glyph-to-path conversion with `<defs>`/`<use>` deduplication. Owns the `FONT_PATHS` map (currently macOS-only paths; cross-platform discovery is a roadmap item), `fallbackFontChain()` script-to-font routing (per-Unicode-block ordered chain, calibrated empirically against Chromium painted widths), and the run-based shaping path that handles Arabic contextual joining, Devanagari cluster reordering, and CJK GPOS.
- **`src/text-renderer.ts`** — chooses single-line, multi-segment, multi-line, or input rendering based on captured shape. Wraps `applyBidi()` for paired-bracket mirroring before handing text to the path renderer.
- **`src/animator.ts`** — `generateAnimatedSvg()` composes multiple captured frames into one SVG with `@keyframes` cross-fade / push-left / scroll transitions.
- **`src/capture.ts`** — Playwright bring-up helpers (`launchBrowser`, `withPage`).
- **`src/form-controls.ts`** — synthesizes the SVG markup for `<input type=checkbox/radio/range/color>`, `<progress>`, `<meter>`, etc., honoring author-styled shadow-DOM pseudos.
- **`src/gradients.ts`** — translates CSS `linear-gradient` / `radial-gradient` to SVG `<linearGradient>` / `<radialGradient>` with px-positioned stops.
- **`src/optimize.ts`** — optional svgo pass (callers pick when to apply).
- **`src/frame-merge.ts`** — combines per-frame element trees into one tree for animation, deduping shared static elements.
- **`tests/features.ts`** — minimal HTML snippets, one per rendering feature. Each test renders both via Chromium and via Domotion's pipeline and diffs the PNGs (3% threshold).
- **`tests/showcase.ts`** — three full-page integration tests.
- **`tests/html-test-suite.tsx`** — sweeps every `*.html` under `~/Documents/html-test/` and reports per-tile diff metrics.
- **`tests/runner.ts`** — shared visual-regression harness used by features.ts and showcase.ts.
- **`tests/review-server.tsx`** — local web UI that loads the expected/actual/diff PNGs from each suite for human review.
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

The project uses [`kerfjs`](https://github.com/brianwestphal/kerf) for JSX. JSX renders to HTML strings via the `SafeHtml` class — same SSR-only contract we used to ship in-repo. Configured via `tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "kerfjs"`); .tsx files outside `src/` (e.g. `tests/`, `site/`) carry a per-file `/** @jsxImportSource kerfjs */` pragma so `tsx`/vitest pick it up.

When writing TSX, components return `SafeHtml` (which is `JSX.Element`). Use `raw()` to inject pre-escaped HTML strings; all string children are auto-escaped. Render to a string with `.toString()`. Import `SafeHtml`, `raw`, and `Fragment` from the `"kerfjs"` barrel. (kerfjs ≤0.1.2 had a duplicate-`SafeHtml` bug between the barrel and the jsx-runtime entry that required importing from `"kerfjs/jsx-runtime"`; fixed in 0.2.0 via a shared chunk — DM-533.) kerfjs's `signal`/`mount`/`delegate`/`toElement` (browser-side) are also available from `"kerfjs"` directly — no current call sites in this repo.

## Language

- **Always use American-English spelling and grammar** in code, comments, docs, commit messages, ticket notes, and UI copy. Prefer `color` over `colour`, `behavior` over `behaviour`, `optimize` over `optimise`, `synthesize` over `synthesise`, `rasterize` over `rasterise`, `center` over `centre`, `gray` over `grey`, `honor` over `honour`, `defense` over `defence`, `labeled` over `labelled`, etc. The one exception is when quoting a CSS keyword that the spec accepts in both forms (e.g. the `grey` color keyword in the CSS color-name map and its parsing regex) — those literals must match what Chromium accepts.

## Investigation

You have **standing permission to use Playwright freely** for any investigation, debugging, or experimentation — driving live pages, replaying cached HARs (`tests/cache/real-world/*.har`), dumping captured trees with computed styles, comparing painted output against captured rects, or any other interactive probe. Do NOT defer a ticket as "needs DOM access" or "blocked on interactive Playwright session" — write the probe script, run it, and proceed. Probes can land as throwaway scripts under `tools/` or be inlined directly in a Bash invocation; whatever's expedient.

When investigating a real-world fixture (`tests/real-world.tsx`), prefer replaying the existing HAR in `tests/cache/real-world/` over hitting the live site — it's faster, deterministic, and matches what the failing test actually saw.

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
- **When a ticket carries a `REGIONS:` block** (left by the demos:review tool — see `docs/31-region-feedback.md`), run `npx tsx tools/crop-regions.ts --ticket DM-{id}` before reasoning about the attached screenshots. It crops each rectangle out of the canonical expected/actual/diff triplet and writes them to `tests/output/region-crops/DM-{id}/{noteId}/[{idx}]-{base}.png`. Read those crops as your primary visual evidence in addition to (not instead of) the full PNGs.

## Documentation

When you change capture, rendering, or animation behavior, update the relevant requirements doc in `docs/`. Add a new doc when a feature area isn't covered. The docs are the contract with consumers about what CSS round-trips and what doesn't.

The `FEATURES.md` checklist tracks per-feature support and links to fixtures; keep it in sync when fixtures land.

### Hot Sheet tickets are local-only

The Hot Sheet workflow (`.hotsheet/`, `DM-XXX` ticket numbers) is a local development tool. Outside this repo nobody can resolve those IDs. So when writing for any audience that isn't just the maintainer:

- **Never tell readers to "see DM-123" / "see `.hotsheet/`" or imply the ticket itself is the documentation.** Anything important enough to reference belongs in code or in `docs/`.
- **A bare `DM-XXX` is not a citation.** If you mention one, pair it with a short, self-contained summary that's understandable without opening the ticket. The summary is the substance; the ticket id is just provenance for the local reader.
- This applies to **commit messages, source comments, `docs/` files, and `README.md`** — everywhere outside Hot Sheet itself.
- **Within Hot Sheet ticket notes / details, bare ticket references are fine.** If you're reading a ticket, Hot Sheet is by definition available — so `see DM-275` or `blocked on DM-619` inside a ticket is a working link, not a dangling one. The rule above is about reaching audiences who *don't* have Hot Sheet.

Examples:

- ❌ `// see DM-275 for background.`
- ❌ `// fix per DM-275.`
- ✅ `// DM-275: repeating-gradient angle stops weren't being normalised to (0, 2π], so the renderer emitted out-of-range angles to the SVG.`
- ✅ Skip the id entirely when the summary is enough: `// repeating-gradient angle stops weren't being normalised…`

The id is optional context for me; the summary is what helps the reader.
