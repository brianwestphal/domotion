# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Domotion is a DOM-to-animated-SVG renderer. It captures HTML/CSS rendered in Playwright Chromium and converts the captured tree into a self-contained SVG with optional CSS animations. The output is pixel-faithful to Chromium on the host platform, scales crisply at any size, and embeds without external assets — purpose-built for marketing and documentation demos that need to load lazily and look identical across browsers.

The project was originally built inside the `slicekit` monorepo as `tools/svg-demo-gen`; it was extracted in 2026-04 to live as a standalone package so it can be published to npm and consumed by other projects. See `docs/` for full requirements docs covering rendering fidelity, supported CSS features, and known caveats.

## Platform support — non-negotiable

**Domotion ships as an npm package and must function on macOS, Linux, and Windows like any normal npm package.** The output should be pixel-faithful to Chromium _on the platform the capture is running on_ — Chromium-on-macOS uses CoreText fallback (Hiragino, Apple Symbols, Zapf Dingbats, STIX Two Math), Chromium-on-Linux uses fontconfig (Noto / DejaVu / Liberation), Chromium-on-Windows uses DirectWrite (Segoe UI Symbol, Cambria Math, Consolas, Yu Gothic). Each platform's fallback chain must be calibrated against the actual painted output of Chromium on that platform.

All three platforms are now calibrated, not just macOS (the earlier "macOS-only" note is out of date). `src/render/font-resolution.ts` carries populated, empirically-calibrated `FONT_PATHS` (macOS), `LINUX_FONT_PATHS`, and `WIN32_FONT_PATHS` tables plus three real fallback chains (`darwinFallbackChain` / `linuxFallbackChain` / `win32FallbackChain`), each dispatched by `process.platform`, with per-platform glyph extractors (`tools/{macos,linux,win32}-glyph-extractor`) and CI gates (`.github/workflows/test-linux.yml`, `windows-fidelity.yml`). macOS is held to pixel-exact parity (`regionCount === 0`); Linux and Windows match Chromium's glyph selection and metrics within a documented native-hinting floor (Linux ≤1%, Windows ≤4% — see `docs/42-cross-platform-fallback-calibration.md`). The residual gap is unhinted-outline-vs-native-raster hinting, not missing calibration. The live per-codepoint system-fallback resolver is now calibrated and default-on on all three platforms (macOS CoreText, Linux fontconfig in DM-1416, Windows DirectWrite in DM-1424 — see `docs/80-cross-platform-system-fallback-resolver.md`). Remaining roadmap items (tracked in local Hot Sheet tickets): a Noto desktop-Linux profile, and promoting the Linux/Windows visual gates to required checks.

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

### Run large visual sweeps on CI, not locally

**Rule: any time a validation needs to run more than ~50 visual fixtures (e.g. broad `demos:test:html` / `demos:test:unicode` re-validation after a render-pipeline change), run it on CI — do NOT wait ~40-60 min on a local sweep.** The local run blocks for the better part of an hour and only exercises the host's macOS calibration; CI shards across runners (parallel, ~minutes) and can also cross-check the Linux/Windows runners.

CI runs a **pushed git ref**, not your local working tree (`tools/run-ci-visual-tests.mjs` refuses to dispatch unless `origin/<branch>` matches local HEAD). So even though the standing rule is "never commit unless asked," a CI sweep of an in-progress change requires a commit + push. The accepted workflow for that — it does NOT touch `main` and is self-contained:

1. `git checkout -b <topic-branch>` (a throwaway validation branch, never `main`).
2. Commit the working-tree changes to it.
3. `git push -u origin <topic-branch>`.
4. Dispatch the sharded run against that branch, **selecting just what you need** rather than the whole suite: `node tools/run-ci-visual-tests.mjs --suite unicode --only <filter>` (or `--suite html`; default OS macOS, `--os linux`/`windows` only for platform-specific debugging). The `--only` filter takes a fixture-name substring — narrow it to the blocks your change actually touches (e.g. the specific Unicode blocks a shaping change affects) so the run is minutes, not the full sweep.

This is the only case where committing/pushing without an explicit "commit this" request is expected — it's a validation branch, not a merge. See the `tests/html-test-suite.tsx` bullet below and `docs/66-ci-visual-tests.md` for the sharding details; a single shard is reproducible locally with `HTML_TEST_SHARD=i/N`.

## Code Organization

> The codebase was reorganized into subdirectories (`src/render/`, `src/animation/`,
> `src/capture/`, `src/tree-ops/`, `src/post-processing/`, `src/terminal/`,
> `src/templates/`, `src/cli/`, …). `docs/ai/code-summary.md` is the always-current
> map; the bullets below give the per-area orientation with current paths.

- **`src/capture/` + `src/render/element-tree-to-svg.ts`** — capture entry point. `captureElementTree()` runs the in-page CAPTURE_SCRIPT (built into `src/capture/script.generated.ts`) to walk the DOM into a serializable tree; `elementTreeToSvg()` (in `src/render/`) renders the tree as SVG markup. The CAPTURE_SCRIPT is `evaluate()`d in the page context, so it can't import from the rest of the source — keep it self-contained.
- **`src/render/text-to-path.ts`** — fontkit glyph-to-path conversion (`renderTextAsPath`, run-based shaping for Arabic contextual joining, Devanagari cluster reordering, CJK GPOS). The font-routing tables + chains — `FONT_PATHS`/`LINUX_FONT_PATHS`/`WIN32_FONT_PATHS`, `fallbackFontChain()`, `resolveFontKey`, `matchFamilyNameToKey` — live in **`src/render/font-resolution.ts`** (DM-1305/DM-1307; still re-exported from `text-to-path.ts`), and the Unicode predicates in **`src/render/unicode-classification.ts`**.
- **`src/render/text.ts`** — chooses single-line, multi-segment, multi-line, or input rendering based on captured shape. Wraps `applyBidi()` for paired-bracket mirroring before handing text to the path renderer.
- **`src/animation/animator.ts`** — `generateAnimatedSvg()` composes multiple captured frames into one SVG with `@keyframes` cross-fade / push-left / scroll / cut / magic-move transitions.
- **`src/capture/index.ts`** — Playwright bring-up helpers (`launchBrowser` / `launchChromium`, `withPage`).
- **`src/render/form-controls.ts`** — synthesizes the SVG markup for `<input type=checkbox/radio/range/color>`, `<progress>`, `<meter>`, etc., honoring author-styled shadow-DOM pseudos.
- **`src/render/gradients.ts`** — translates CSS `linear-gradient` / `radial-gradient` (and conic, rasterized) to SVG gradient defs with px-positioned stops.
- **`src/post-processing/optimize.ts`** — optional svgo pass (callers pick when to apply).
- **`src/tree-ops/frame-merge.ts`** — element-tree transforms for animation (the old `mergeFrames` fast path was removed; compositing now z-orders per-frame groups — see `docs/08`).
- **`tests/features.ts`** — minimal HTML snippets, one per rendering feature. Each test renders both via Chromium and via Domotion's pipeline and diffs the PNGs (3% threshold).
- **`tests/showcase.ts`** — three full-page integration tests.
- **`tests/html-test-suite.tsx`** — sweeps every `*.html` under `external/html-test/` (clone of `github.com/brianwestphal/html-test`, gitignored) and reports per-tile diff metrics. Bootstrap the clone with `git clone https://github.com/brianwestphal/html-test.git external/html-test`; set the `HTML_TEST_DIR` env var to override the path and `HTML_TEST_OUTPUT_DIR` to redirect the expected/actual/diff triplets so a secondary suite doesn't clobber the canonical results. Capture viewport is 1024 × 768 by default; fixtures whose content runs past 768 px get a per-fixture taller height from the `FIXTURE_HEIGHT_OVERRIDES` map at the top of `tests/html-test-suite.tsx` so the entire painted document is captured (DM-781). When a new fixture is added or grows past its existing entry, re-run `node tools/probe-html-test-heights.mjs` and paste the new entries into the map. `npm run demos:test:unicode` reuses the same harness against the 331 per-Unicode-block fixtures under `../html-test/unicode/` (a SECOND html-test checkout the user maintains separately for broad Unicode coverage); its output lives in `tests/output/html-test-unicode/` and it is intentionally NOT part of `demos:test:all` since the sweep is slow. **For a big sweep (>50 fixtures), distribute it across free public-repo GitHub Actions runners instead of waiting ~1h locally**: `node tools/run-ci-visual-tests.mjs --suite unicode` (default macOS; `--os linux`/`windows` only for platform-specific debugging) dispatches `.github/workflows/visual-tests.yml`, which shards by stride (`HTML_TEST_SHARD=i/N`, `tests/shard.ts`), waits, and merges the per-shard `results.json` — see `docs/66-ci-visual-tests.md`. A single shard is reproducible locally: `HTML_TEST_SHARD=2/5 npm run demos:test:unicode`.
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

### Code search (prefer ast-grep for structure)

For **structural / syntax-aware** searches over source (this project is `.ts` / `.tsx` — no other languages), use **ast-grep** (the `ast-grep` skill, or the CLI: `ast-grep run --lang <ts|tsx> -p '<pattern>' <path>`) rather than text grep — it matches the AST, so it skips comments/strings and catches multi-line/nested shapes. Same mindset as the AST-based `eslint-plugin-kerfjs` rules the repo already lints with (e.g. `kerfjs/no-raw-with-dynamic-arg`). Good fits for this codebase:

- **`$A as $B`** casts — the "no `any` outside the fontkit / bidi-js boundary" rule (§ Quality gates) means casts are worth auditing; `$X as any` / `$X as unknown as $T` especially.
- **`document.createElement($X)`**, `document.body`, bare `window.` / `getComputedStyle` in **node-side** `src/render/*` — these belong ONLY inside the page-`evaluate`d CAPTURE_SCRIPT (§ CAPTURE_SCRIPT discipline), never in the renderer; ast-grep finds them where a text match would drown in legit page-context uses.
- **`execSync($X)` / `exec($X)` / `child_process`** — the no-`exec()` convention from the DM-1332 audit.
- **`process.platform === $X`** branches — cross-platform font / metric / path routing must be platform-aware from the start (§ Platform support), so these are the audit surface for "is this darwin-only?".
- **`page.evaluate($X)`** / `page.$eval(...)` shapes when tracing capture-side probes, specific call or JSX shapes, and **codemod-style rewrites** (`ast-grep run -p '<find>' --rewrite '<repl>' src/`).

**`--lang` matters: `tsx` ≠ `ts`** — pick per file extension (`.tsx` lives under `tests/`, `site/`, and a few `src/**/*.tsx`; everything else is `.ts`).

Keep **text search** (ripgrep / the Explore agent) for what it's best at: literal strings (`FEEDBACK NEEDED`, a `DM-` id, a CSS keyword), identifier/symbol lookups, **filenames**, and **non-code files** (markdown / JSON / HAR / logs) — there AST has nothing to match and text is simpler. **Caveat (DM-1338):** plain `grep`/`ripgrep` flag `src/render/text-to-path.ts` as **binary** (high-byte content) and SILENTLY SKIP it — use `grep -a` / `rg -a` for text there. ast-grep parses it as TypeScript regardless, so for that file it's the *more* reliable searcher, not just the structural one.

You have **standing permission to use Playwright freely** for any investigation, debugging, or experimentation — driving live pages, replaying cached HARs (`tests/cache/real-world/*.har`), dumping captured trees with computed styles, comparing painted output against captured rects, or any other interactive probe. Do NOT defer a ticket as "needs DOM access" or "blocked on interactive Playwright session" — write the probe script, run it, and proceed. Probes can land as throwaway scripts or be inlined directly in a Bash invocation; whatever's expedient. **Put reusable-but-uncommitted scratch scripts under `tools/scratch/` — it's gitignored**, so they persist locally without cluttering `git status` or risking an accidental commit (ES imports there are `../../src/...`). A committed, documented probe (referenced from docs/CLAUDE.md) belongs at `tools/` proper.

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

- **`svg-scrubber` (doc 56, DM-1040)** is the 4th published bin (`bin.svg-scrubber` → `src/cli/scrubber.ts`): a local video-style bench for an *animated* SVG — play / pause / speed / manual scrub / mark an in-out range + loop / export the current frame as PNG / export the range as MP4 / trim the range to a new self-contained animated SVG. Reach for it when debugging an animated SVG's timeline (the static-frame analogue is `svg-review`). Server + kerfjs UI live under `src/scrubber/`.

- **`svg-to-image` (doc 78, DM-1353)** is the 5th published bin (`bin.svg-to-image` → `src/cli/svg-to-image.js`): the headless still-image counterpart to `svg-review`'s interactive UI — it rasterizes an SVG (file/stdin) to PNG / JPEG / PDF / WebP / AVIF / TIFF at a chosen scale via the same Playwright path. Reach for it from a probe or the agent review loop when you just need a 1× PNG of the SVG to diff (no browser UI), rather than standing up `svg-review`. (Its animated-SVG sibling is `svg-to-video`.)

## Git

- **Committing is fine; pushing is not.** You may `git add` / `git commit` as needed to land completed, validated work — no need to ask first. **Never `git push` without explicit permission**, and never run other remote-mutating git operations (force-push, branch deletes on the remote, tag pushes, etc.) without the user directly asking. Leave commits local for the user to review and push.

## Ticket-Driven Work

The general create → track → complete ticket workflow lives in the "Ticket-Driven Work" section further down (inserted by Hot Sheet). Two project-specific rules sit on top of it:

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

<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

<!-- hotsheet:begin section=testing-philosophy v=1 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

- **Unit tests** (`src/**/*.test.ts(x)`, `tests/**/*.test.ts(x)`): `vitest` under `vitest.config.ts` (happy-dom environment). Run with `npm test`, which first rebuilds the capture script; `npm run test:watch` for watch mode.
- **E2E tests** (`src/**/*e2e.test.ts`, `tests/**/*e2e.test.ts`): `vitest` under the separate `vitest.e2e.config.ts`, driving real Chromium via Playwright. Run with `npm run test:e2e`.
- **Visual-regression suites** — the primary fidelity signal — are bespoke harnesses under `tests/`, not vitest: `npm run demos:test` (one fixture per CSS feature), `npm run demos:test:html` / `:unicode` (broad html-test sweeps), `npm run demos:test:all` (features + snapshot-isolation + showcase + animate + html + real-world). Each renders a fixture via Chromium and via Domotion and diffs the PNGs through `src/review/compare-pngs.ts`; the shared harness is `tests/runner.ts` / `tests/html-test-suite.tsx`. Review diffs in the browser with `npm run demos:review`.
- **Commands**: unit `npm test` · E2E `npm run test:e2e` · coverage `npm run test:coverage` (v8, via `@vitest/coverage-v8`) · feature regression `npm run demos:test`.
- **Merged coverage** (`npm run test:coverage:all`, DM-1343): `npm run test:coverage` reflects ONLY the vitest unit suite, so the big render modules read as under-covered even though the bespoke visual suites (standalone tsx harnesses, not vitest) exercise them hard. `tools/coverage-all.mjs` runs the unit suite (vitest `--pool=forks`) plus the fast visual suites (features + showcase + snapshot-isolation + animate-examples) under one shared `NODE_V8_COVERAGE` dir, then merges them with `c8` into `coverage/all/`. With the fast visual suites merged in, the render modules show their real coverage (e.g. `element-tree-to-svg.ts` ~74%, `font-resolution.ts` ~76%, `text-to-path.ts` ~77%) rather than the unit-only view. The default intentionally skips the slow/CI-bound sweeps. `npm run test:coverage:full` (`node tools/coverage-all.mjs --full`) ALSO runs the ~277-fixture html-test sweep, the 331-block unicode sweep, and the real-world HAR replays — which push the font/text/render modules higher (they exercise the fallback chains, shaping, and per-block routing the fast suites barely touch) but take the better part of an hour locally (the same reason CLAUDE.md shards those on CI). `--full` runs only the sweeps whose fixture checkouts exist (`external/html-test`, `../html-test/unicode`, `tests/cache/real-world`), skipping any that aren't cloned with a warning. Even `--full` won't reach 100%: platform-specific branches (Linux/Windows font extractors, the `<text>`-fallback path) don't execute on a single macOS run. Note: the merged aggregate uses c8's physical-line accounting over ALL `src` files, so its top-line % is NOT numerically comparable to `test:coverage`'s vitest/istanbul statement count — read the per-module numbers, not the aggregate, when comparing.
- For sweeps over ~50 visual fixtures, dispatch to CI rather than running locally — see "Run large visual sweeps on CI, not locally" above.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

- **Requirements docs** live in `docs/` as numbered Markdown files (`docs/NN-topic.md`, e.g. `docs/01-fidelity.md`, `docs/37-scroll-pattern-grammar.md`). Canonical-reference docs that must stay in lockstep with code are called out under "Always-in-sync docs" above; `docs/reference/` holds cross-cutting indexes (e.g. `raster-image-fallback-cases.md`).
- **Codebase map**: `docs/ai/code-summary.md`.
- **Requirements summary**: `docs/ai/requirements-summary.md`.

Both AI-summary files already exist and are intentionally thin pointers into this file + the numbered docs — keep them in sync per "AI-summary docs" above.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
