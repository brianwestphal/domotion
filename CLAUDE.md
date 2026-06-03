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
npm run demos:test:html # html-test-suite vs external/html-test/*.html
npm run demos:test:unicode # html-test-suite vs ../html-test/unicode/*.html (331 per-block fixtures; separate output dir, NOT in :all — slow)
npm run demos:test:all  # features + showcase + html-test-suite
npm run demos:review    # local server to compare expected/actual/diff PNGs
npm run demos:examples  # run the three example demo scripts
npm run test:linux-docker  # run `npm test` inside the Linux container CI uses (reproduce Linux-only failures on a Mac)
```

`npm run test:linux-docker` runs the suite inside `mcr.microsoft.com/playwright:v<locked-version>-noble` — the same Linux image CI's `test` job uses. Because the font-fallback chain is calibrated to the host platform's system fonts, text-rendering tests take a different code path on Linux (no `/System/Library/Fonts/...` → glyph-path rendering falls back to `<text>`), so some failures only surface in CI. This reproduces them without pushing a tag. Pass a file/`-t` filter (`npm run test:linux-docker -- src/scroll/composer.test.ts`) or set `CMD=` to run any other command (e.g. `CMD="npm run typecheck"`) in the container. `node_modules` is isolated in a Docker volume so the container's Linux install never clobbers your host's.

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
- **`tests/html-test-suite.tsx`** — sweeps every `*.html` under `external/html-test/` (clone of `github.com/brianwestphal/html-test`, gitignored) and reports per-tile diff metrics. Bootstrap the clone with `git clone https://github.com/brianwestphal/html-test.git external/html-test`; set the `HTML_TEST_DIR` env var to override the path and `HTML_TEST_OUTPUT_DIR` to redirect the expected/actual/diff triplets so a secondary suite doesn't clobber the canonical results. Capture viewport is 1024 × 768 by default; fixtures whose content runs past 768 px get a per-fixture taller height from the `FIXTURE_HEIGHT_OVERRIDES` map at the top of `tests/html-test-suite.tsx` so the entire painted document is captured (DM-781). When a new fixture is added or grows past its existing entry, re-run `node tools/probe-html-test-heights.mjs` and paste the new entries into the map. `npm run demos:test:unicode` reuses the same harness against the 331 per-Unicode-block fixtures under `../html-test/unicode/` (a SECOND html-test checkout the user maintains separately for broad Unicode coverage); its output lives in `tests/output/html-test-unicode/` and it is intentionally NOT part of `demos:test:all` since the sweep is slow.
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
- The `html-test-suite` against `external/html-test/*.html` is the broad-coverage signal. Some failures are pre-existing and tracked separately; new code shouldn't introduce regressions there.

### JSX Runtime

The project uses [`kerfjs`](https://github.com/brianwestphal/kerf) for JSX. JSX renders to HTML strings via the `SafeHtml` class — same SSR-only contract we used to ship in-repo. Configured via `tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "kerfjs"`); .tsx files outside `src/` (e.g. `tests/`, `site/`) carry a per-file `/** @jsxImportSource kerfjs */` pragma so `tsx`/vitest pick it up.

When writing TSX, components return `SafeHtml` (which is `JSX.Element`). Use `raw()` to inject pre-escaped HTML strings; all string children are auto-escaped. Render to a string with `.toString()`. Import `SafeHtml`, `raw`, and `Fragment` from the `"kerfjs"` barrel. (kerfjs ≤0.1.2 had a duplicate-`SafeHtml` bug between the barrel and the jsx-runtime entry that required importing from `"kerfjs/jsx-runtime"`; fixed in 0.2.0 via a shared chunk — DM-533.) kerfjs's `signal`/`mount`/`delegate`/`toElement` (browser-side) are also available from `"kerfjs"` directly — no current call sites in this repo.

## Language

- **Always use American-English spelling and grammar** in code, comments, docs, commit messages, ticket notes, and UI copy. Prefer `color` over `colour`, `behavior` over `behaviour`, `optimize` over `optimise`, `synthesize` over `synthesise`, `rasterize` over `rasterise`, `center` over `centre`, `gray` over `grey`, `honor` over `honour`, `defense` over `defence`, `labeled` over `labelled`, etc. The one exception is when quoting a CSS keyword that the spec accepts in both forms (e.g. the `grey` color keyword in the CSS color-name map and its parsing regex) — those literals must match what Chromium accepts.

## Investigation

You have **standing permission to use Playwright freely** for any investigation, debugging, or experimentation — driving live pages, replaying cached HARs (`tests/cache/real-world/*.har`), dumping captured trees with computed styles, comparing painted output against captured rects, or any other interactive probe. Do NOT defer a ticket as "needs DOM access" or "blocked on interactive Playwright session" — write the probe script, run it, and proceed. Probes can land as throwaway scripts under `tools/` or be inlined directly in a Bash invocation; whatever's expedient.

**Always read Chromium source code when stuck on Chrome-paint behavior.** `chromium.googlesource.com` and `source.chromium.org` are in the sandbox allowlist and reachable via `WebFetch`. The project's fidelity rule says Chrome's actual paint is the source of truth — the Chromium source IS that source of truth, written down and citable. Whenever a ticket investigation reaches "I'm not sure why Chrome does X here," go read the blink renderer code instead of probing-and-curve-fitting. Useful entry points:

- `third_party/blink/renderer/platform/fonts/` — font fallback, glyph metrics, sbix / COLR painters, `font-palette` resolution
- `third_party/blink/renderer/platform/fonts/shaping/` — `ShapeResult`, glyph offset / advance math
- `third_party/blink/renderer/core/paint/` — text painter, decoration painter, paint-order resolution
- `third_party/blink/renderer/core/css/` — CSS property parsing + computed-style serialization
- `third_party/blink/renderer/core/layout/` — flex / grid / inline layout
- Skia (`SkScalerContext`, `SkGlyph`) for the actual glyph rasterization

Cite the exact file + line in commit messages and ticket notes so the rationale is auditable. Example from a prior fix: `kSmallCapsFontSizeMultiplier = 0.7f` in `simple_font_data.cc` is the constant DM-294 / DM-444 / DM-938 mirrored for the synthesised small-caps multiplier.

When investigating a real-world fixture (`tests/real-world.tsx`), prefer replaying the existing HAR in `tests/cache/real-world/` over hitting the live site — it's faster, deterministic, and matches what the failing test actually saw.

## Debugging the generated output

Before reverse-engineering a render-fidelity bug by reading source, reach for the dedicated debug surfaces — they exist precisely so you don't have to redo this work each ticket:

- **`domotion capture --debug` (doc 55, DM-945)** writes a four-file reproduction bundle next to the SVG output: `capture.har` (Playwright `recordHar`), `expected.png` (1× Chromium screenshot of the clip rect), `actual.svg`, and `captured-tree.json` (intermediate element tree). Default location is `<output>.debug/`; override with `--debug-dir <path>`. The CLI prints the matching `svg-review` invocation as its final log line.

  ```sh
  domotion capture <url-or-file> --debug -o out.svg
  # → out.debug/{capture.har, expected.png, actual.svg, captured-tree.json}
  ```

- **`svg-review` (doc 54, DM-946)** is the published CLI for single-fixture diff review. `svg-review --expected <png> --actual <svg|png>` rasterises the SVG via Playwright at 1×, computes the same pixel-diff the regression suites use (`src/review/compare-pngs.ts`), and opens a local web UI showing expected / actual / diff with arrow-key lightbox cycling and draggable issue regions. Use this instead of re-implementing crop-and-compare from scratch when you need to see how Chrome's paint differs from the SVG we produce.

- **`tools/crop-regions.ts`** crops a ticket's `REGIONS:` rectangles out of the canonical expected/actual/diff triplet (see Ticket-Driven Work below). Always run this before reasoning about an attached screenshot — pixel-level evidence beats narrative description.

- **Throwaway Playwright probes** are the right tool for "what does Chrome actually capture for this element / this CSS property?" questions. Drop a `.mjs` under `tools/probe-*.mjs` and run with `node tools/probe-foo.mjs`. The pattern for the two most common probes:

  ```js
  // tools/probe-foo.mjs — measure an element's actual layout
  import { chromium } from "@playwright/test";
  import { readFileSync } from "node:fs";
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
  const page = await ctx.newPage();
  await page.setContent(readFileSync("external/html-test/<fixture>.html", "utf-8"));
  await page.waitForLoadState("networkidle");
  const info = await page.evaluate(() => {
    const el = document.querySelector(".target")!;
    const r = el.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, cs: getComputedStyle(el).<prop> };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
  ```

  ```js
  // tools/probe-foo.mjs — screenshot a sub-region and save it
  const buf = await page.screenshot({ clip: { x, y, width: w, height: h }, omitBackground: false });
  writeFileSync("/tmp/probe-foo.png", buf);
  ```

  For HAR recording from a probe: `ctx = await browser.newContext({ recordHar: { path: "/tmp/probe.har", mode: "minimal" } })` then `await ctx.close()` (the HAR only flushes on context close, not browser close — DM-945's `--debug` learned this the hard way).

- **`elementTreeToSvg` vs `elementTreeToSvgInner` (doc 54, DM-950)** — the public `elementTreeToSvg(elements, w, h, opts?)` returns a complete `<svg>` document (most callers want this). `elementTreeToSvgInner(...)` returns only the body markup, for multi-frame composers (animator, scroll composer) that emit one outer `<svg>` themselves. If you're building a probe SVG to inspect, use `elementTreeToSvg`.

- **`src/review/compare-pngs.ts`** is the shared pixel-diff routine (used by both `demos:test` and `svg-review`). Call it directly from a probe to score a hand-built comparison.

- **`animated-svg-scrubber` (doc 56, DM-1040)** is the 4th published bin (`bin.animated-svg-scrubber` → `src/cli/scrubber.ts`): a local video-style bench for an *animated* SVG — play / pause / speed / manual scrub / mark an in-out range + loop / export the current frame as PNG / export the range as MP4 / trim the range to a new self-contained animated SVG. Reach for it when debugging an animated SVG's timeline (the static-frame analogue is `svg-review`). Server + kerfjs UI live under `src/scrubber/`.

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
- **Deferral is the user's call, not yours.** Never unilaterally mark a ticket as "deferred" or write a note that amounts to "this is too complex / out of session scope / needs broader work — deferred." If you can't finish a ticket in the current session, leave it in `started` status with a `FEEDBACK NEEDED:` note that lays out (i) what you found, (ii) the specific options for how to proceed, (iii) why each option has the cost / risk it does — and then signal channel done. The user decides whether to defer, scope down, escalate, or push you to try harder. "I judged this too big to do now" is not yours to declare.
- **When a ticket carries a `REGIONS:` block** (left by the demos:review tool — see `docs/31-region-feedback.md`), run `npx tsx tools/crop-regions.ts --ticket DM-{id}` before reasoning about the attached screenshots. It crops each rectangle out of the canonical expected/actual/diff triplet and writes them to `tests/output/region-crops/DM-{id}/{noteId}/[{idx}]-{base}.png`. Read those crops as your primary visual evidence in addition to (not instead of) the full PNGs.

## Documentation

When you change capture, rendering, or animation behavior, update the relevant requirements doc in `docs/`. Add a new doc when a feature area isn't covered. The docs are the contract with consumers about what CSS round-trips and what doesn't.

The `FEATURES.md` checklist tracks per-feature support and links to fixtures; keep it in sync when fixtures land.

### AI-summary docs

`docs/ai/code-summary.md` and `docs/ai/requirements-summary.md` are the AI-agent entry points (the Hot Sheet ticket template points there first). They're intentionally thin — pointers into this file + the numbered `docs/`, not a parallel source of truth. Keep them in sync when the structure they describe changes: `code-summary.md` lists the `src/` subdirs + the published bins; `requirements-summary.md` tracks the cross-platform calibration status + recent doc additions. When you reorganize `src/`, add a bin, or land a platform-calibration milestone, update the matching summary in the same change.

### Always-in-sync docs

A handful of docs ARE the canonical reference for a user-facing surface — if the code changes and the doc doesn't, consumers get a misleading contract. Update these in the same commit as any change that touches the surface they describe:

- `docs/37-scroll-pattern-grammar.md` is the canonical EBNF + semantics reference for the scroll-pattern language. Any change to `src/scroll/pattern.ts` (tokeniser, parser, AST), `src/scroll/executor.ts` (axis resolution, speed-derived duration, `until` semantics), or scroll-related user-visible flags in `src/cli/capture.ts` / `src/cli/animate.ts` must update doc 37 too. The parser + executor headers carry pointers back to doc 37; keep those accurate as well.
- `docs/reference/raster-image-fallback-cases.md` is the index of every code path that falls back to embedding a raster `<image>` instead of native SVG (color emoji, vertical text, `<textarea>` content, `<canvas>`/`<iframe>`/`<video>` snapshots, conic gradients, mask-image `element()` refs, etc.). When you add a new fallback site, remove one, or change the trigger condition for an existing one, update the matching entry in the same commit — consumers reading the SVG use this doc to figure out "why is this paint a raster?" and a stale entry sends them the wrong direction.

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
