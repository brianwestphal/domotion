# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Domotion is a DOM-to-animated-SVG renderer. It captures HTML/CSS rendered in Playwright Chromium and converts the captured tree into a self-contained SVG with optional CSS animations. The output is pixel-faithful to Chromium on the host platform, scales crisply at any size, and embeds without external assets — purpose-built for marketing and documentation demos that need to load lazily and look identical across browsers.

The project was originally built inside the `slicekit` monorepo as `tools/svg-demo-gen`; it was extracted in 2026-04 to live as a standalone package so it can be published to npm and consumed by other projects. See `docs/` for full requirements docs covering rendering fidelity, supported CSS features, and known caveats.

## Platform support — macOS, Linux, and Windows first-class; macOS primary

**Domotion ships as an npm package and must FUNCTION on macOS, Linux, and Windows like any normal npm package.** That baseline is non-negotiable on all three: it installs, it runs, it produces a correct SVG, and nothing may crash or hard-fail on a supported platform.

**Font-capture PRECISION is a first-class commitment on all three platforms.** Output is pixel-faithful to Chromium _on the platform the capture is running on_: CoreText on macOS, fontconfig on Linux, and DirectWrite on Windows. Each platform's routing and fallback behavior is calibrated against Chromium, and a platform-specific parity defect is a real defect rather than something to dismiss because of the host OS.

**macOS is always the primary development and testing platform.** Default local validation, broad visual sweeps, and the most frequent calibration work happen on macOS. That is a testing priority, not a higher support tier: Linux and Windows remain first-class and receive platform-native validation whenever a change touches their routing, helpers, metrics, packaging, or known platform-specific behavior. Expensive suites may use representative samples or manual dispatch according to runtime, especially on Windows; reduced frequency does not reduce the correctness contract.

All three platforms are calibrated. `src/render/font-resolution.ts` carries populated `FONT_PATHS` (macOS), `LINUX_FONT_PATHS`, and `WIN32_FONT_PATHS` tables plus three real fallback chains (`darwinFallbackChain` / `linuxFallbackChain` / `win32FallbackChain`), each dispatched by `process.platform`, with per-platform glyph extractors (`tools/{macos,linux,win32}-glyph-extractor`) and CI coverage (`.github/workflows/test-linux.yml`, `windows-fidelity.yml`). macOS is held to pixel-exact parity (`regionCount === 0`); Linux and Windows match Chromium's glyph selection and metrics within a documented native-hinting floor (Linux ≤1%, Windows ≤4% — see `docs/42-cross-platform-fallback-calibration.md`). The residual gap is unhinted-outline-vs-native-raster hinting, not missing calibration — and in the **embedded-font** render mode (the broad html/unicode sweeps) that gap is now largely recovered: the embedded subsets preserve the source font's TrueType hinting program via hb-subset (variable fonts fully instanced at the resolved axis location), default-on — see `docs/99-hinted-embedded-subset.md`. The `paths`-mode floor (feature suite) still stands. The live per-codepoint system-fallback resolver is calibrated and default-on on all three platforms (macOS CoreText, Linux fontconfig, Windows DirectWrite — see `docs/80-cross-platform-system-fallback-resolver.md`). **Caveat worth internalising: "default-on" describes the flag, not necessarily the behavior.** After changing a resolver, disable it and require the answer to move; an unchanged answer means the mechanism may not be in the loop. The **Linux** feature-suite fidelity gate ("Linux fidelity regression") is a required status check on `main`. The Windows workflow remains manual-dispatch because its DirectWrite conformance work is substantially slower, but it is first-class validation: dispatch it for Windows-affecting changes and release validation, and use the routine sampled conformance profile for ordinary regression checks. The broad `html-test` / `unicode` sweeps remain on-demand outside macOS; use them when the affected platform or release risk warrants them.

**Rules for new code**:

- Don't add hardcoded `/System/Library/Fonts/...` paths or other macOS-only literals without flagging the cross-platform gap in the change.
- New font / fallback / metric routing must be designed platform-aware from the start (lookup by `process.platform`, not assumed to be `darwin`).
- When matching Chromium's behavior, verify empirically against Chromium on the target platform — measure `Range.getBoundingClientRect().width` of the rendered glyph in a probe div, then match against candidate font advance widths via fontkit's `glyphForCodePoint`. That probe-and-match approach is how the current macOS fallback chain was reverse-engineered out of Chromium's painted output.

## Stack

- **Runtime**: Node.js 22+, TypeScript 5.8+
- **Capture**: `@playwright/test` (Chromium headless) — the only browser engine we target.
- **Glyph paths**: `fontkit` plus platform-native helpers for shaping and outline extraction from host system fonts; calibrated on macOS, Linux, and Windows.
- **Bidi**: `bidi-js` for paired-bracket mirroring on RTL embedding levels.
- **Optimization**: `svgo` for the optional optimize pass.
- **Tests**: `vitest` for unit tests; bespoke visual-regression harnesses under `tests/`.

## Commands

```bash
npm run build           # tsc compile to dist/
npm test                # vitest run (unit tests in src/**/*.test.ts)
npm run demos:test      # feature visual-regression suite (tests/features.ts)
npm run demos:test:html # html-test-suite vs external/html-test/*.html
npm run demos:test:unicode # html-test-suite vs ../html-test/unicode/*.html (819 per-block fixtures; separate output dir, NOT in :all — slow)
npm run demos:test:all  # features + showcase + html-test-suite
npm run demos:review    # local server to compare expected/actual/diff PNGs
npm run demos:examples  # run the three example demo scripts
npm run test:linux-docker  # run `npm test` inside the Linux container CI uses (reproduce Linux-only failures on a Mac)
```

The unit-test config forces `DOMOTION_HELPER_NO_SERVE=1`. Vitest's `forks`
pool creates short-lived test-file processes, while the persistent glyph helper
is designed for long-lived render and conformance processes: every fork starts
and unrefs its own native child, then Vitest reaps the fork outside Node's normal
`exit` cleanup. On macOS a full run from the main checkout was consequently
killed with exit 144 and no summary. The one-shot transport exercises the same
resolution logic with request-scoped child lifetimes; the focused
`helper-serve-switch.test.ts` test removes the variable to cover and compare the
persistent channel itself. Do not remove the Vitest override to speed up the
unit gate—use the channel in long-lived commands, where its lifecycle matches
the host process.

`npm run test:linux-docker` runs the suite inside `mcr.microsoft.com/playwright:v<locked-version>-noble` — the same Linux image CI's `test` job uses. Because the font-fallback chain is calibrated to the host platform's system fonts, text-rendering tests take a different code path on Linux (no `/System/Library/Fonts/...` → glyph-path rendering falls back to `<text>`), so some failures only surface in CI. This reproduces them without pushing a tag. Pass a file/`-t` filter (`npm run test:linux-docker -- src/scroll/composer.test.ts`) or set `CMD=` to run any other command (e.g. `CMD="npm run typecheck"`) in the container. `node_modules` is isolated in a Docker volume so the container's Linux install never clobbers your host's.

**A container run writes its results to `tests/output-linux/`, NOT `tests/output/`** (`DOMOTION_OUTPUT_DIR`, DM-1802 — so a Linux run can't overwrite the host's macOS results and have `demos:review` show them as "Local · macOS"). The script prints the path in its banner. This matters more than it sounds: anything reading `tests/output/features-results.json` after a container run gets the **host's stale file**, and it will look like a perfectly plausible result. Measured cost — a font A/B run in here read the stale path in *both* arms, reported "0 of 114 fixtures moved" for a mechanism that moves exactly one, concluded the mechanism was inert, and produced a bug report against this script. The script was correct throughout. If you need a container run's numbers, read `tests/output-linux/`, and check `generatedAt` in the JSON before trusting it. (Verified: run through this script, `text-font-stretch-underline` reports 0.703% pass with the Linux glyph helper built and 1.989% fail with `DOMOTION_DISABLE_HELPER=1` — matching the x64 CI runner exactly, so this script does reproduce CI.)

### Run large visual sweeps on CI, not locally

**Rule: any time a validation needs to run more than ~50 visual fixtures (e.g. broad `demos:test:html` / `demos:test:unicode` re-validation after a render-pipeline change), run it on CI — do NOT wait ~40-60 min on a local sweep.** The local run blocks for the better part of an hour and only exercises the host's macOS calibration; CI shards across runners (parallel, ~minutes) and can also cross-check the Linux/Windows runners.

CI runs a **pushed git ref**, not your local working tree (`tools/run-ci-visual-tests.mjs` refuses to dispatch unless `origin/<branch>` matches local HEAD). A CI sweep of an in-progress change therefore requires a commit + push. The accepted workflow for that — it does NOT touch `main` and is self-contained:

1. `git checkout -b <topic-branch>` (a throwaway validation branch, never `main`).
2. Commit the working-tree changes to it.
3. `git push -u origin <topic-branch>`.
4. Dispatch the sharded run against that branch, **selecting just what you need** rather than the whole suite: `node tools/run-ci-visual-tests.mjs --suite unicode --only <filter>` (or `--suite html`; default OS macOS, `--os linux`/`windows` only for platform-specific debugging). The `--only` filter takes a fixture-name substring — narrow it to the blocks your change actually touches (e.g. the specific Unicode blocks a shaping change affects) so the run is minutes, not the full sweep.

This is the only case where **pushing** without a separate explicit "push this" request is expected — it's a throwaway validation branch, not `main`. Ordinary completed work is committed locally as described under Git, but never pushed. See the `tests/html-test-suite.tsx` bullet below and `docs/66-ci-visual-tests.md` for the sharding details; a single shard is reproducible locally with `HTML_TEST_SHARD=i/N`.

## Background Tasks

**Anything that runs longer than a couple of minutes goes through [pueue](https://github.com/Nukesor/pueue), not a bare background shell.** In this repo the archetypes are a **conformance arm** (`tools/font-conformance.ts`, ~6 min for the 6-stack slice and hours for the full corpus), any **container run** through `scripts/test-linux-docker.sh`, `npm run demos:test` (~2 min) and the broader `demos:test:html` / `:unicode` sweeps, and `npm run test:coverage:all`. The rule covers any gate, build, capture or suite — anything you would otherwise start and then poll.

**Every `pueue` or `pueue-wait-cond` invocation needs `dangerouslyDisableSandbox: true`.** Both clients talk to the daemon over a unix socket at `~/Library/Application Support/pueue/`, and a command sandbox refuses it — `Operation not permitted (os error 1)`. It is not worth re-testing: `pueue status` fails sandboxed even once the config exists. Start the daemon once per machine with `(pueued -d >/dev/null 2>&1 &)` — also unsandboxed, since it cannot create its config dir otherwise.

This is the same class as the rest of this repo's tooling: `tsx`, Playwright, `docker`, the `demos:test*` suites and `tools/crop-regions.ts` all fail under the default sandbox (the `tsx` CLI dies on an IPC-pipe `EPERM`), and `git push` fails through the proxy. Queueing them changes nothing about that — see the sandbox bullet at the end of this section.

**Redirect its output and detach it, exactly as written.** A bare `pueued -d` from a tool call leaves the calling shell hung forever: the daemon inherits that shell's stdout, never closes it, and the pipeline never sees EOF. Worse, stopping that hung shell **kills the daemon with it** — it is reparented to init but stays in the shell's process group, so a group signal reaches it. `PPID 1` looks like safety and is not.

**Wait with `pueue-wait-cond`, with an explicit timeout.** Plain `pueue wait` has no timeout, so a missing task or stuck process can hold a session forever. The installed [`pueue-wait-cond`](https://www.npmjs.com/package/pueue-wait-cond) wraps pueue's task status with bounded waits and shell/script conditions. Use `--fail-on-error` when completion must mean success. Use `--until` to stop waiting successfully when an alternate condition becomes true, or `--while` to fail the wait when a required condition stops being true; always single-quote inline conditions so the calling shell does not expand `$PUEUE_WAIT_*` first. An `--until` condition ends the wait — it does **not** stop the queued task, so kill it explicitly if that is the intended outcome.

**The task exit code remains the source of truth.** Do not replace it with a log sentinel. A hand-written `until grep -q "phase summary" out.log; do sleep 5; done` loop once spun for **43 minutes** waiting for a sentinel that `| tail -12` had already truncated out of the file — the condition could never match, and nothing said so. `pueue-wait-cond --fail-on-error` reads pueue's `Success` / `Failed (7)` result directly, while still bounding the wait.

```bash
ID=$(pueue add -p -l dm-gate -- npm run demos:test)   # -p prints the id, -l labels it
pueue-wait-cond "$ID" --timeout 10m --fail-on-error    # bounded; non-zero if the task fails
pueue log "$ID" -l 40                                  # tail; -f for the whole thing

# Wait for completion, but stop early once an alternate result is ready. The task keeps running.
pueue-wait-cond "$ID" --timeout 5m --fail-on-error \
  --until 'test -f /tmp/domotion-ready'

# Give up if a prerequisite disappears while the task runs.
pueue-wait-cond "$ID" --timeout 10m --fail-on-error \
  --while 'test -f /tmp/domotion-release.lock'
```

- **`pueue add` inherits the current directory** (`-w` overrides), so a task sees the repo it was queued from.
- **`--after <id>`** chains without a round trip — queue the gate `--after` the build and let the daemon sequence them.
- **`pueue-wait-cond` durations** are seconds by default and accept `ms`, `s`, `m`, or `h`; its condition subprocesses have their own 30-second default ceiling (`--condition-timeout` overrides it). Use `--json` when a script needs a stable result instead of human progress output.
- **`pueue follow <id>`** is `tail -f`; **`pueue kill <id>`** stops one; **`pueue clean`** clears finished tasks.
- **`pueue status "label %= dm-"`** lists by label prefix, and `status` takes a small query language (`columns=`, filters, `order_by`, `limit`). Label tasks per session so a listing is legible when several are in flight.
- Tasks **outlive the session**, which is the point — but it also means a forgotten one keeps running. Check `pueue status` before assuming the queue is empty.
- **Queued tasks run outside the sandbox, by construction.** The daemon is unsandboxed (it has to be), and every task is its child — so `pueue add` is a sandbox exemption whatever the client needed to reach it. Worth knowing because the call site does not look like one. Queue only what you would have been willing to run with `dangerouslyDisableSandbox` anyway, which for this repo means its own gates and builds.

**Do not use it for short commands.** A `git status` or a single vitest file through pueue is pure overhead and costs a sandbox exemption; run those directly.

**Two failure modes this repo has already paid for, which pueue removes.** A backgrounded A/B once stopped when the agent that started it stopped, stranding a finished arm unread for an hour — a queued task outlives the session by construction. And a `git worktree add … | tail -1` pipeline silently swallowed a fatal error because a pipeline's exit status is the last command's, so `set -e` never fired and three subsequent steps ran against a directory that did not exist; waiting on `pueue`'s own exit code cannot be defeated that way.

**Still check the first lines of a queued task's log rather than only its exit code.** A conformance arm that reports `Success` can have run without the native glyph helper (`glyph helper … unavailable — using fontkit instead`), which silently changes what was measured. The exit code tells you the process finished, not that it measured the right thing.

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
- **`tests/showcase.tsx`** — three full-page integration tests.
- **`tests/html-test-suite.tsx`** — sweeps every `*.html` under `external/html-test/` (clone of `github.com/brianwestphal/html-test`, gitignored) and reports per-tile diff metrics. Bootstrap the clone with `git clone https://github.com/brianwestphal/html-test.git external/html-test`; set the `HTML_TEST_DIR` env var to override the path and `HTML_TEST_OUTPUT_DIR` to redirect the expected/actual/diff triplets so a secondary suite doesn't clobber the canonical results. Capture viewport is 1024 × 768 by default; fixtures whose content runs past 768 px get a per-fixture taller height from the `FIXTURE_HEIGHT_OVERRIDES` map at the top of `tests/html-test-suite.tsx` so the entire painted document is captured (DM-781). When a new fixture is added or grows past its existing entry, re-run `node tools/probe-html-test-heights.mjs` and paste the new entries into the map. `npm run demos:test:unicode` reuses the same harness against the 819 per-Unicode-block fixtures under `../html-test/unicode/` (a SECOND html-test checkout the user maintains separately for broad Unicode coverage); its output lives in `tests/output/html-test-unicode/` and it is intentionally NOT part of `demos:test:all` since the sweep is slow. **For a big sweep (>50 fixtures), distribute it across free public-repo GitHub Actions runners instead of waiting ~1h locally**: `node tools/run-ci-visual-tests.mjs --suite unicode` (default macOS; `--os linux`/`windows` only for platform-specific debugging) dispatches `.github/workflows/visual-tests.yml`, which shards by stride (`HTML_TEST_SHARD=i/N`, `tests/shard.ts`), waits, and merges the per-shard `results.json` — see `docs/66-ci-visual-tests.md`. A single shard is reproducible locally: `HTML_TEST_SHARD=2/5 npm run demos:test:unicode`. **`--only` can HIDE a real failure: some render bugs are order-dependent, so a fixture passes alone and fails in a sweep.** Process-global caches carry state between fixtures in a worker — the one that bit hardest is fontkit's, which memoizes `Glyph` objects by glyph id, so the single shared `.notdef` reports whichever codepoint first missed (nine SMP unicode blocks mis-placed their dotted circles this way, and looked "CI-only" purely because local runs used `--only`). When a fixture fails in CI but passes locally, re-run it as part of a GROUP before concluding the machine is the variable.
- **`tests/runner.tsx`** — shared visual-regression harness used by features.ts and showcase.tsx.
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
- **Decoration geometry is Blink's, transcribed — and gated by the oracle, not pixel-diff**: `getDecorationMetrics()` mirrors `text_decoration_info.cc` / `text_decoration_offset.cc` (rev 7d859f27) — auto thickness `fontSize/10` then `max(1,t)`, auto underline gap `max(1, ceil(t/2))` zeroed by an explicit `text-underline-offset`, line-through `2·FloatAscent/3 − t/2` — anchored on the fragment top via the captured `FloatAscent`, with the paint snap (`SnapYAxis` / `RoundDownThickness`) applied at emit. Blink's `auto` path consults NO font tables; only `from-font` reads the `post` underline metrics and `under` the OS/2 typo metrics. Grade any change here with `npm run decorations:oracle` — whole-fixture pixel-diff structurally rewards constants fitted against the consumer-owned rasterization gap and must not gate decoration geometry.
- **fontkit shaping ≈ HarfBuzz** for the scripts we care about (verified per-fixture in 2026-04). harfbuzzjs is not warranted; the gap is <1% on Arabic/Thai and 0% on Devanagari/CJK ideographs at standard body sizes.

## Quality gates

- **`npm run build`** must succeed (tsc with strict TypeScript). No `any` outside the fontkit/bidi-js boundary types.
- **`npm test`** must pass (unit tests).
- **`npm run lint`** must pass. It is `eslint . --max-warnings 0`, and CI's `lint` job runs that exact command — so a warning fails the build, not just an error. Zero is a fair bar because the tree really does report zero; fix a new warning at its source rather than raising the threshold or reaching for a blanket `eslint-disable`. Note that ESLint flat config does **not** read `.gitignore`, so gitignored-but-lintable trees (`tools/scratch/`, `.tmp/`, the in-repo agent worktrees under `.claude/worktrees/`) are listed explicitly in `eslint.config.js`'s `ignores` — without them a dev machine lints several thousand files CI never sees, and `npm run lint` stops being the same command in the two places.
- **`npm run demos:test`** is the primary regression signal — every feature has a fixture; new features need fixtures.
- The `html-test-suite` against `external/html-test/*.html` is the broad-coverage signal. Some failures are pre-existing and tracked separately; new code shouldn't introduce regressions there.
- **Read the raw `diffPct`, not the pass/fail or the rounded display.** The suites print `0.00% of image` for anything that rounds to zero, and the per-fixture PASS threshold is deliberately lenient — so a real geometry change can move the output while the fixture reads identical in both arms. Measured twice in one session: a decoration fixture PASSED at `0.00%` before AND after a change whose emitted SVG differed by a whole line segment, and a before/after comparison script silently reported "0 of 115 fixtures changed" because it read a `diffPercent` key that does not exist (the field is **`diffPct`**) and compared `None` to `None` 115 times. When comparing runs, assert the field you read is present and non-null before believing a null result.

### JSX Runtime

The project uses [`kerfjs`](https://github.com/brianwestphal/kerf) for JSX. JSX renders to HTML strings via the `SafeHtml` class — same SSR-only contract we used to ship in-repo. Configured via `tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "kerfjs"`); .tsx files outside `src/` (e.g. `tests/`, `site/`) carry a per-file `/** @jsxImportSource kerfjs */` pragma so `tsx`/vitest pick it up.

When writing TSX, components return `SafeHtml` (which is `JSX.Element`). Use `raw()` to inject pre-escaped HTML strings; all string children are auto-escaped. Render to a string with `.toString()`. Import `SafeHtml`, `raw`, and `Fragment` from the `"kerfjs"` barrel. (kerfjs ≤0.1.2 had a duplicate-`SafeHtml` bug between the barrel and the jsx-runtime entry that required importing from `"kerfjs/jsx-runtime"`; fixed in 0.2.0 via a shared chunk — DM-533. `src/kerfjs-imports.test.tsx` pins that contract.)

**Two surfaces use kerf's browser runtime, not just the SSR JSX** — `src/scrubber/client.tsx` (`signal` / `computed` / `effect` / `mount` / `delegate`) and `tests/review-client.tsx` (those plus **`each`**, the keyed list reconciler). They're bundled differently: the scrubber client is pre-bundled into `src/scrubber/client.bundle.generated.ts` by `npm run build:scrubber-client` (so it ships inside `dist/`), while `tests/review-client.tsx` is a local-only harness UI that `tests/review-server.tsx` esbuilds at server start. (`npm run build:review-client` bundles a *third*, non-reactive file — `src/review/client.tsx`, the published `svg-review` page script, which wires `enableRegionOverlays()` imperatively and pulls in no kerf runtime.) When touching either reactive client, the `kerf-app` skill's hard rules apply — in particular: no inline JSX event handlers (use `data-action` + `delegate`), every `each()` row needs a `data-key`, and never `addEventListener` inside a `mount()`-managed tree.

**The vendored kerf AI docs are generated, not hand-written.** `.claude/skills/kerf-app/SKILL.md` and `.cursorrules` are copies of the canonical files kerfjs ships in its own package (`node_modules/kerfjs/ai/{skill.md,cursorrules}`, indexed by `ai/manifest.json`). `eslint-plugin-kerfjs`'s `ai-assistant-configs` rule compares the installed bundle's `kerf-skill-version` against the checked-in copies and warns when they drift, so `eslint --fix` refreshes them (anything below the `KERF-APP-CANONICAL-END` marker is preserved — today there's nothing there). Bump kerfjs, then re-sync these two files in the same change; don't edit the canonical section by hand.

**Prefer the narrow re-sync command** — `npx eslint --fix eslint.config.js`. The rule is a once-per-lint-run project-level check: it fires on the `Program` node of whichever file ESLint lints first, resolves both destinations from the working directory rather than from the linted file, and its fixer writes those two files directly while returning no edit to the linted source. So any single lint target re-syncs exactly as well as a whole-repo sweep, without putting every other file under the autofixer. A full `npx eslint --fix .` also works and is safe — the tree is a fixed point, so a second consecutive run leaves every file byte-identical. That property is now **implied by CI** rather than merely observed: the `lint` job runs `npm run lint` at `--max-warnings 0`, and since `eslint --fix` only applies fixes to problems ESLint *reports*, zero reported problems means zero fixes to apply. A separate "run `--fix` and diff" job would therefore be a job that can never fail while `lint` passes, which is why none exists. If a whole-repo `--fix` ever reports files modified beyond these two, treat that as a separate lint finding to review on its own, not as part of the re-sync.

When the vendored docs go stale, the `lint` job is what tells you: `ai-assistant-configs` is a warning, and at `--max-warnings 0` a warning fails the build. Its message names the destination file and both versions (`… is stale (have X, latest is Y)`), so a red `lint` job for this reason is a genuine "re-sync the vendored kerf docs" finding, not a spurious failure — don't paper over it by relaxing the threshold.

**Enumerated HTML attributes take keyword strings, not booleans (kerfjs 4).** `draggable` / `spellCheck` / `contentEditable` / `writingsuggestions` / `translate` / `autocorrect` are enumerated, not boolean: write `draggable="true"`, `spellCheck="false"`, `translate="no"`, `autocorrect="off"`, and omit the attribute for the default state — the boolean form no longer typechecks, because it used to render markup meaning the opposite of what was written. Real boolean attributes (`hidden`, `checked`, `disabled`, `autofocus`, `required`, `inert`) are unaffected. Also: `<select>` and `<textarea>` have no `value` content attribute, so state goes on `<option selected>` and in the textarea's text content (which is what `src/scrubber/client.tsx` already does).

**The typed `IntrinsicElements` tag table is live — an unknown tag no longer compiles.** The repo used to carry `src/kerf-jsx-augmentation.d.ts`, a permissive `[tag: string]: any` index signature that worked around a self-referential-interface bug in kerfjs 0.5.0's bundled `jsx-runtime.d.ts` (which made `JSX.IntrinsicElements` resolve empty, so every `<div>` failed to typecheck). Upstream fixed it (`interface IntrinsicElements extends KerfBuiltinIntrinsicElements`), so the workaround was removed with the 4.1.0 bump; `tsc --noEmit` now rejects `<dvi>`-style typos in `src/**/*.tsx` instead of silently accepting them. A genuine custom element must therefore be declaration-merged into `kerfjs/jsx-runtime` (never into a global `JSX` namespace) rather than relying on a catch-all.

**kerf does NOT infer development mode (kerfjs 3.x / 4.x).** Diagnostics are opt-in via `import("kerfjs/dev")`, and **this repo deliberately never imports it**: Domotion is a published package, and kerf's dev hooks are process-global, so installing them would force the diagnostics (and their chunk) on every consumer. Production shape is therefore the intended state here. Two consequences worth knowing when debugging: a screened dangerous URL (`javascript:` / script-executing `data:` on `href`/`src`/…) **warns and drops** rather than throwing, and the `KERF_DEV_WARN_*` family is inert. To debug a kerf issue locally, add the import temporarily to the client entry — never commit it.

**Neither browser UI is covered by the server-side e2e tests** (`tests/review-server-e2e.test.ts` and `tests/scrubber-frame-attach.e2e.test.ts` assert HTTP responses only). `tests/kerf-client-uis.e2e.test.ts` is the browser-side guard — it drives both UIs' reactive paths and is the thing to run first after a kerfjs upgrade.

## Language

- **Always use American-English spelling and grammar** in code, comments, docs, commit messages, ticket notes, and UI copy. Prefer `color` over `colour`, `behavior` over `behaviour`, `optimize` over `optimise`, `synthesize` over `synthesise`, `rasterize` over `rasterise`, `center` over `centre`, `gray` over `grey`, `honor` over `honour`, `defense` over `defence`, `labeled` over `labelled`, etc. The one exception is when quoting a CSS keyword that the spec accepts in both forms (e.g. the `grey` color keyword in the CSS color-name map and its parsing regex) — those literals must match what Chromium accepts.

## Investigation

### Chromium parity verification program

**Doc 129 (`docs/129-chromium-parity-verification-program.md`) and
`tools/parity-program.json` are the durable plan for moving fidelity claims
from screenshot confidence to logical proof.** Keep the matrix current whenever
a source audit, stage oracle, generated/adversarial corpus, platform gate, or
known approximation changes; `npm run check:parity-program` verifies its
references in CI.

For parity work, use this order: upstream source decision → Domotion branch
classification → exact intermediate oracle → negative activation control →
generated transition/metamorphic coverage → all-platform visual integration.
Do not skip directly from a screenshot discrepancy to a fitted renderer change.
The broad demo loop remains the final safety net, not the proof of the decision
procedure.

### Try to DISPROVE it cheaply before proving it expensively

**Before running any long test to confirm a change works, run the cheapest experiment that could show it does NOT.** Reach for the expensive suite only once quick falsification has failed.

The long runs here are 2 min (`demos:test`), ~25 min (a conformance arm), ~10+ min (a CI sweep) — and they routinely return a **confident green that means nothing**, because a passing sweep cannot distinguish "the change is correct" from "the change never ran". A disproof attempt distinguishes them in seconds. Ask "what would show this is false?" and do that first:

- *"This sweep exercises my change"* → grep the fixtures for the property under test. Measured: a 154-fixture CI sweep for a skip-ink change returned every tile byte-identical to five decimals, because the 819 `unicode` fixtures carry exactly one underline rule — `p.meta a:hover`, which never applies in a static capture. A 5-second grep would have killed the plan before dispatch.
- *"These two implementations are equivalent"* → diff the emitted markup, not the pixels. One `grep dasharray` showed a single `stroke-dasharray="6 4.2"` line becoming three reading `6 3.6` / `6 2.8` / `6 3.9` — i.e. that splitting a decoration into sub-segments is NOT the same as clipping one line. The feature suite reported the same thing two minutes later, less legibly.
- *"The face reports X"* → print it. `sf-pro` requested at 400/700/900 reports `naturalWeight: 400` every time; that one probe disproved a ticket's premise outright. It was run only AFTER a full suite run showed 7 fixtures regressing — backwards, and the suite run was redundant.
- *"This change can only affect X"* → enumerate the affected set exhaustively, offline. Done in the right order on the primary-decomposition fix: the enumeration took seconds, bounded the blast radius to 5 codepoints on darwin and 11 on linux, and PREDICTED the exact conformance deltas (−45 and −99, both confirmed).

**The order is the point, not just the existence of the probe.** Cheap probe → hypothesis survives → then the long run, now with a prediction to check it against. A long run with no prior prediction can only hand you a number; it cannot tell you whether the number means anything. See also the pass/fail warning under Quality gates — read raw `diffPct`, not the rounded display.

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

### The source in `external/` is the PRIMARY tool. Not probing, not testing, not fixing.

**Match the Chromium stack's logic first. Get every decision to the point where you are extremely confident it is 100% in line with Chromium — then test, and let the tests identify the remaining variances.** Testing is how you find out what you got wrong; it is not how you find out what Chrome does. Reverse that order and you get what this project has repeatedly got: a defect found by probing, a fix fitted to the probe, and a constant that scores well while encoding the wrong rule.

**Pixel differences attributable to rasterization are ACCEPTABLE and expected.** Chrome rasterizes with Skia; our output is rasterized by the consumer's SVG renderer. That gap is the documented hinting floor and is not a defect to chase. What must be identical is everything above it: which font, which glyphs, which positions, which geometry. So a pixel metric moving the wrong way is not, by itself, evidence against a transcribed rule — it was measured against the old fitted behavior. Judge a change by whether it matches the source, then by a purpose-built oracle (`fonts:conformance`, `decorations:oracle`), and only then by pixel diff.

**A corollary about tickets.** A ticket describing a divergence is a *hypothesis*, not a finding, unless it cites source at a stated revision. Validate its premise against `external/` before implementing — cheaply, in minutes. Measured on this backlog: of 18 audit-derived items validated in one pass, **4 were already fixed or simply wrong, 4 prescribed the wrong remedy, and 4 more were correct but inert** on every current corpus. One item's line citations had drifted onto the *correct* Blink transcription, so following them literally would have deleted faithful upstream logic. Working such a queue ticket-by-ticket spends implementation time discovering the queue was wrong.

**THREE upstream checkouts are already cloned under `external/` — Chromium, HarfBuzz and Skia. Between them they contain the answer to essentially every "why does Chrome do X" question this project asks, and there is no reason to fetch, guess, or infer anything they hold.** Confirm the revision before quoting (`git -C external/<repo> log -1 --format='%h %cd' --date=short`); as of writing: chromium `7d859f27` 2026-06-27, harfbuzz `4de187d` 2026-07-31, skia `ebf5052` 2026-07-31.

Read **Skia at the revision Chromium's DEPS pins**, not at our working tree — they differ, and the difference has changed an answer: ours is `ebf5052` while `external/chromium/DEPS:330` pins `62efacd3`, and `src/ports/SkFontConfigInterface_direct.cpp` differs between them by 80 insertions / 57 deletions (`isAcceptableMatch` does not exist as a function at the pin at all). The pinned objects are fetched locally, so read them with `git -C external/skia show 62efacd3:<path>`.

| checkout | contains | ask it about |
| --- | --- | --- |
| `external/chromium` | `third_party/blink/renderer/` | font *selection* and fallback, glyph metrics, paint order, CSS parsing, layout |
| `external/harfbuzz` | HarfBuzz `src/` | *shaping* — clusters, marks, ligatures, reordering, dotted circles |
| `external/skia` | Skia `src/ports/`, `src/core/`, `include/core/` | what Blink *hands off* — typeface cloning, variation-axis application, the platform scaler contexts |

**The rule: when you don't know what Chrome does, read it — do not probe-and-curve-fit, and do not reason by analogy from another platform.** Probing tells you what one machine's fonts produced on one day; the source tells you the decision procedure. This is not a style preference, it is the difference between the two outcomes this project keeps seeing:

- A sampled table froze one Mac's font inventory into source and painted faces Chrome never picks.
- A day was spent designing, scoring and CI-dispatching **three** heuristics for dotted-circle insertion, all approximations of a rule that is three readable lines (`hb-ot-shaper-syllabic.cc:51-53`).
- A Linux "divergence" was argued from a macOS analogy and would have *introduced* a difference from Chrome; the source shows `GetFontForCharacter(c, locale, …)` takes no weight at all.

**Skia is where a Blink answer stops being a decision and becomes a font object.** Blink decides *which* face and *what* axis coordinates; Skia applies them and rasterizes. When a question is "what does the coordinate Blink set actually DO", it is answered in `src/ports/SkTypeface_{mac_ct,win_dw,FreeType}.cpp`, not in Blink. Worked example: Blink clamps an `opsz` request into the axis range (`VariableAxisChangeEffective`), and Skia clamps it *again* independently (`SkTPin` in `ctvariation_from_SkFontArguments`, `SkTypeface_mac_ct.cpp:1147`) before applying it via `CTFontCreateCopyWithAttributes` — so the clamp is the mechanism on both sides of the handoff, which is what makes a 13 px run on a `[17..28]` axis resolve to 17.

No checkout is complete — but **check before believing that of any given path**, because "absent" usually means "not in the sparse set yet". `ui/gfx` was recorded here as absent and is not: `git -C external/chromium sparse-checkout add ui/gfx` fetches it, and `ui/gfx/font_fallback_linux.cc` — the file this note claimed was unreadable, holding `GetFallbackFontForChar`'s actual fontconfig procedure — reads fine. What IS genuinely unavailable is anything behind a **git submodule**: `third_party/emoji-segmenter/src` is one, so the Ragel emoji-segmentation grammar cannot be widened into (fetch the file itself from its upstream repo instead — the raw file is the file; a *summary* of it is not). The browser-side code supplying Windows' menu font is also absent, and the Skia checkout excludes `src/gpu`, `src/pdf` and the rest. When the file you need is missing, say so and mark the claim as un-transcribed rather than filling the gap with a plausible story — `chromium.googlesource.com` / `source.chromium.org` are in the sandbox allowlist for `WebFetch`, but **a fetched summary is not the file** and has already produced a wrong conclusion here.

All three are git checkouts, so always quote the revision beside anything you transcribe:

```sh
git -C external/chromium log -1 --format='%h %cd' --date=short   # 7d859f27, 2026-06-27
git -C external/harfbuzz log -1 --format='%h %cd' --date=short   # 4de187d,  2026-07-31
git -C external/skia     log -1 --format='%h %cd' --date=short   # ebf5052,  2026-07-31
```

To widen the Skia sparse set: `git -C external/skia sparse-checkout add <path>`.

They drift from the Chrome that Playwright ships, and that variance is accepted. When a transcribed constant starts disagreeing with measured paint, suspect drift and re-read before assuming our logic is wrong.

**HarfBuzz is checked out locally at `external/harfbuzz`** (sparse, `src/` only; `git -C external/harfbuzz log -1 --format='%h %cd' --date=short` for the revision — as of writing `4de187d`, 2026-07-31). Blink shapes with HarfBuzz on every platform, so **shaping behavior is decided here, not in the Blink tree** — the Chromium checkout carries `third_party/blink/renderer/` and does NOT vendor HarfBuzz. Read this before reverse-engineering any shaping question: cluster formation, mark positioning, ligature and reordering rules, and dotted-circle insertion all live in `hb-ot-shaper-*.cc`. Worked example: the rule for whether Chrome paints a U+25CC before an orphaned mark is three lines of `hb-ot-shaper-syllabic.cc:51-53` — the shaper inserts one only if **the font used for the run has a glyph for U+25CC** — after a session spent building and scoring three separate heuristics that were all approximations of it.

**The Chromium source is checked out locally at `external/chromium`** — the full `third_party/blink/renderer/` tree. **Read it there first**; it is greppable, complete, and doesn't cost a fetch. `chromium.googlesource.com` and `source.chromium.org` remain in the sandbox allowlist via `WebFetch` for anything the checkout lacks, but prefer the local tree — a fetched *summary* of a file is not the file, and reading locally has already corrected conclusions drawn from one (the Windows fallback order, below).

> The checkout is refreshed periodically and will drift from the Chrome that Playwright ships. That variance is **known and accepted**: the policy is to keep both reasonably recent rather than to pin them together. When a transcribed constant or table starts disagreeing with measured paint, suspect drift and re-read the local source before assuming our logic is wrong.
>
> It is a git checkout, so the revision is always available — `git -C external/chromium log -1 --format='%h %cd' --date=short` (as of writing: `7d859f27`, 2026-06-27). Quote it alongside any constant or table you transcribe, so a later disagreement can be attributed to drift rather than re-investigated from scratch.

**The font goal is GUARANTEED parity with Chromium's mechanism — not less code.** Every decision about *which font* and *which glyphs, where* must be either the same logic Blink runs (transcribed from `external/chromium`, with a cited file + line and the checkout revision) or the same call Blink makes (identical API, identical arguments). Some of this is *additive* — porting Blink's Windows per-script table is more code and is correct. **An approximation that scores well is the thing being removed**, even where it currently passes: "the gap is <1%" is not a defense, it is the defect.

Parity cannot be established by a fixture suite — fixtures sample, and every "wrong font" bug in the 2026-07 cycle hid from exactly that. It is established by a **conformance oracle**: ask Chrome (CDP `CSS.getPlatformFontsForNode`) and ask Domotion the same question exhaustively, require 100% agreement, gate CI on it. That oracle is **`tools/font-conformance.ts`** (`npm run fonts:conformance`, doc 107): every assigned Unicode codepoint × every font stack the fixture corpus actually uses, JSON + text report, non-zero exit on any mismatch, allowlist entries requiring a written reason. `tools/chrome-font-agreement.ts` remains as its single-shot `FONTAGREE:` diagnostic sibling for a CI log.

The oracle runs on **all three platforms**, and three of its properties are load-bearing rather than incidental: (i) the **stack corpus is per-platform** (`tools/font-conformance-stacks.<darwin|linux|win32>.json`) because an element declaring no `font-family` computes to Chrome's per-platform default-font preference — the corpus's largest stack is `Times` on macOS and `"Times New Roman"` on Linux, so a shared corpus would sweep stacks the host's Chrome never computes; (ii) each platform has its **own committed baseline** (`tests/baselines/font-conformance-<os>.json`) recording the runner image, the font-inventory digest, the ICU/Unicode version and the slice, and the comparator **refuses to judge** rather than compare across a change in any of them; (iii) the CI gate is **regression-relative, not absolute zero** — no platform measures zero, and a gate that fails identically every run grades nothing. A number from one platform says nothing about another: Blink runs different code on each.

**A sample can be blind rather than wrong, and it will still score well.** Measured twice on Windows in one session: a 1-in-50 codepoint stride over one weight-400 stack said 0.488% mismatches; the six-stack canonical slice said 14.77%. Nothing changed but which stacks were swept — the defect (the family's regular cut taken where Chrome takes the bold one) lives only at weight 700, where a family's cut stops being its base entry, so a weight-400 sample could not have contained it. Striding the codepoint axis does not rescue this: **the stack axis needs sampling too, and it must include a bold one.** Before quoting any conformance number, check what it could not have caught — and verify the live resolver is actually in the loop by disabling it and requiring the answer to move (`DOMOTION_DISABLE_HELPER=1` on macOS/Windows, `DOMOTION_SYSTEM_FALLBACK=0` on Linux). An unchanged answer means something intercepted ahead of the path you thought you were measuring.

That check was never run on Windows after the DM-1424 flip, and it would have caught DM-1889 immediately: disabling the resolver there moved nothing, because the resolver had been returning nothing since the day it was turned on. **Run it after any flip, not just when a number looks wrong** — the failure it detects is invisible precisely because the numbers look fine.

The honest boundary, worth stating rather than eliding: font selection, glyph choice, and glyph positioning **can** be identical by construction. **Rasterization cannot** — Chrome uses Skia, our output is rasterized by the consumer browser. That is the documented hinting floor, and a different concern from the matching mechanism.

**Mirror Chromium's decision procedure — don't re-derive it, and don't sample it.** Where Chrome's behavior is expressible as an algorithm, port the algorithm from source rather than probing outputs and curve-fitting a table. This is the single most expensive lesson in the font area so far:

- `unicode-font-routing.darwin.generated.ts` was built by **sampling** one Mac's CoreText answers per Unicode block. It froze that machine's font inventory into source (it names `SF Pro Text` — a separate Apple download — for Cyrillic), so every machine without those fonts painted faces Chrome never picks. The bug was never "a table exists"; Blink has one too. The bug was that ours was sampled from a machine instead of transcribed from Chromium.
- A table is **correct** when it is what Blink does. `win/font_fallback_win.cc` is a hardcoded per-script table (74 `USCRIPT_*` → font-list mappings) that Blink consults **before** falling through to DirectWrite — so on Windows, porting that table *is* matching Chrome.

**Per-codepoint font fallback is NOT the same procedure on all three platforms.** Verified against the local checkout; don't assume one shape generalizes:

| Platform | Blink's path | Key detail |
|---|---|---|
| macOS | `font_cache_mac.mm` → `CTFontCreateForString(ct_font, …)` | base is **the run's current font**, and the answer depends on it |
| Linux | `font_cache_linux.cc` → `gfx::GetFallbackFontForChar(c, locale, …)` (or `WebSandboxSupport::GetFallbackFontForCharacter` when sandboxed) | keyed on **locale**; there is no base font |
| Windows | `font_cache_skia_win.cc` → hardcoded table first, `GetDWriteFallbackFamily` as fall-through | the table wins whenever it matches |

Whenever a ticket investigation reaches "I'm not sure why Chrome does X here," go read the source instead of probing-and-curve-fitting.

**Shaping questions go to `external/harfbuzz/src/` first, not to Blink** — Blink delegates all of it, so the Blink tree will only show you the call site:

- `hb-ot-shaper-indic.cc`, `-use.cc`, `-khmer.cc`, `-myanmar.cc`, `-arabic.cc`, `-hangul.cc` — the per-script shapers
- `hb-ot-shaper-syllabic.cc` — dotted-circle insertion for broken clusters
- `hb-ot-shaper-vowel-constraints.cc` — the other dotted-circle path
- `hb-ot-shape.cc` — normalization, the shaping plan, `has_glyph` fallbacks
- `hb-ot-layout-gsub/gpos-table.hh` — how features are actually applied

Everything else goes to Blink (all under `external/chromium/`):

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

- **`tools/compare-glyphs.ts` (doc 98, DM-1686)** answers the question pixel-diff can't: given two PNG crops of the SAME character (expected paint vs rendered SVG), was it rendered with the same font — family, size, weight, style — or not? `npx tsx tools/compare-glyphs.ts expected-crop.png actual-crop.png [--rect-a x,y,w,h] [--rect-b x,y,w,h] [--json]` prints CORRECT/INCORRECT with per-metric typographic reasons (weight, terminal shape, slant, x-height, topology…); exit 0/1/2. Deterministic CV (distance-transform outline agreement + coverage-mass + stroke-width + orientation + topology + local hotspot), calibrated to 353/353 on a real-font corpus including Helvetica-vs-Arial-grade lookalikes. Crop rules: one glyph, solid bg, same nominal scale both sides, ink ≥ 24 px tall (capture at 2×+; use discriminative chars `R a g e t G Q`, not `l o 0`). Use this during text-fidelity tickets instead of eyeballing diff PNGs. Library: `src/review/glyph-compare.ts` (`compareGlyphPngs`); recalibrate with `tools/glyph-compare-calibrate.ts` when metrics/thresholds change and update doc 98's tables.

- **`svg-scrubber` (doc 56, DM-1040)** is the 4th published bin (`bin.svg-scrubber` → `src/cli/scrubber.ts`): a local video-style bench for an *animated* SVG — play / pause / speed / manual scrub / mark an in-out range + loop / export the current frame as PNG / export the range as MP4 / trim the range to a new self-contained animated SVG. Reach for it when debugging an animated SVG's timeline (the static-frame analogue is `svg-review`). Server + kerfjs UI live under `src/scrubber/`.

- **`svg-to-image` (doc 78, DM-1353)** is the 5th published bin (`bin.svg-to-image` → `src/cli/svg-to-image.js`): the headless still-image counterpart to `svg-review`'s interactive UI — it rasterizes an SVG (file/stdin) to PNG / JPEG / PDF / WebP / AVIF / TIFF at a chosen scale via the same Playwright path. Reach for it from a probe or the agent review loop when you just need a 1× PNG of the SVG to diff (no browser UI), rather than standing up `svg-review`. (Its animated-SVG sibling is `svg-to-video`.)

## Git

- **Commit completed work as you go; pushing is not allowed by default.** Once a ticket or other logical unit is complete and its proportionate validation passes, stage and commit it locally without waiting for a separate request. Prefer one coherent commit per completed ticket/unit, and do not leave completed work uncommitted merely because the current session or Hot Sheet pass has ended. Never mix unfinished experiments into that commit; if the worktree contains unrelated user changes, stage only the completed unit's files/hunks. **Never `git push` without explicit permission**, and never run other remote-mutating git operations (force-push, branch deletes on the remote, tag pushes, etc.) without the user directly asking. Leave commits local for the user to review and push.

## Ticket-Driven Work

The general create → track → complete ticket workflow lives in the "Ticket-Driven Work" section further down (inserted by Hot Sheet). Two project-specific rules sit on top of it:

- **Tag reasoning-heavy work `Deep Thought` when creating or triaging it.** Apply the tag when a ticket genuinely warrants GPT-5.6 Sol's Max reasoning effort: multi-subsystem architectural decisions, ambiguous Chromium/Skia/HarfBuzz source reconstruction, competing hypotheses whose tests cannot cheaply distinguish the governing rule, or broad logical-parity audits with material regression risk. The tag activates Hot Sheet's automatic Max-effort context. Do not use it merely because a ticket is large, slow, or test-heavy; routine source transcription with a clear upstream rule stays untagged. Reassess open and newly discovered tickets during prioritization and add the tag before starting when this threshold is met.
- **Deferral is the user's call, not yours.** Never unilaterally mark a ticket as "deferred" or write a note that amounts to "this is too complex / out of session scope / needs broader work — deferred." If you can't finish a ticket in the current session, leave it in `started` status with a `FEEDBACK NEEDED:` note that lays out (i) what you found, (ii) the specific options for how to proceed, (iii) why each option has the cost / risk it does — and then signal channel done. The user decides whether to defer, scope down, escalate, or push you to try harder. "I judged this too big to do now" is not yours to declare.
- **When a ticket carries a `REGIONS:` block** (left by the demos:review tool — see `docs/31-region-feedback.md`), run `npx tsx tools/crop-regions.ts --ticket DM-{id}` before reasoning about the attached screenshots. It crops each rectangle out of the canonical expected/actual/diff triplet and writes them to `tests/output/region-crops/DM-{id}/{noteId}/[{idx}]-{base}.png`. Read those crops as your primary visual evidence in addition to (not instead of) the full PNGs.

## Documentation

Start with one of the six current domain handbooks in `docs/handbook/`; they are the normative entry points for text, layout, paint, media, animation, and platform/release behavior. Detailed numbered documents in `docs/` retain stable requirement, evidence, and historical records. When you change capture, rendering, or animation behavior, update the relevant handbook or numbered record in the same change. Add a new document when a feature area is not covered.

Every handbook and numbered document has structured front matter with a stable ID, lifecycle, owners, platforms, tickets, code paths, and aliases. Edit the canonical Markdown/front matter, then run `npm run docs:index:generate`. That command derives the complete lifecycle index (`docs/index.json`), compact machine manifest (`docs/ai/manifest.json`), current/partial owner packets (`docs/ai/packets/`), and generated current/archive navigation. `npm run docs:index:check` rejects stale generated views and every nonexistent code path declared by a current or partial record; historical records may retain removed paths as evidence.

The `FEATURES.md` checklist tracks per-feature support and links to fixtures; keep it in sync when fixtures land.

### AI-summary docs

`docs/ai/code-summary.md` and `docs/ai/requirements-summary.md` are intentionally thin AI-agent entry points, not a parallel source of truth. The code summary maps source and entry points; the requirements summary states cross-cutting principles and routes work into the domain handbooks. The generated manifest and owner packets provide the exhaustive current/partial inventory. Keep the two hand-written summaries in sync when the structure or principles they describe change.

### Always-in-sync docs

A handful of docs ARE the canonical reference for a user-facing surface — if the code changes and the doc doesn't, consumers get a misleading contract. Update these in the same commit as any change that touches the surface they describe:

- `docs/37-scroll-pattern-grammar.md` is the canonical EBNF + semantics reference for the scroll-pattern language. Any change to `src/scroll/pattern.ts` (tokeniser, parser, AST), `src/scroll/executor.ts` (axis resolution, speed-derived duration, `until` semantics), or scroll-related user-visible flags in `src/cli/capture.ts` / `src/cli/animate.ts` must update doc 37 too. The parser + executor headers carry pointers back to doc 37; keep those accurate as well.
- `docs/reference/raster-image-fallback-cases.md` is the index of every code path that falls back to embedding a raster `<image>` instead of native SVG (color emoji, vertical text, `<textarea>` content, `<canvas>`/`<iframe>`/`<video>` snapshots, conic gradients, mask-image `element()` refs, etc.). When you add a new fallback site, remove one, or change the trigger condition for an existing one, update the matching entry in the same commit — consumers reading the SVG use this doc to figure out "why is this paint a raster?" and a stale entry sends them the wrong direction.
- `docs/font-resolution-diagram.md` is the canonical end-to-end flow diagram (Mermaid) of the **entire font-resolution system** — family-stack→key (`resolveFontKey` / `matchFamilyNameToKey`), key→file platform dispatch (`resolveFontSpec` + the `FONT_PATHS` / `LINUX_FONT_PATHS` / `WIN32_FONT_PATHS` tables), key→`FontInstance` (`getFontInstance` + fontkit/native-helper probe), the per-codepoint resolver (`resolveFontForCodepoint`, the Blink `FontFallbackIterator` mirror), the static per-block fallback chains (`darwinFallbackChain` / `linuxFallbackChain` / `linuxNotoFallbackChain` / `win32FallbackChain`), the live system-fallback resolver (`resolveSystemFallbackKeyForCp` — CoreText / fontconfig / DirectWrite), the webfont + local-alias registries, and glyph extraction/emission. **Any change to font routing, the platform tables, the fallback chains, the family→key map, the per-codepoint resolver, the live-resolver backends, the render-text-mode branch, or the caches/lifecycle must update the diagram + its prose in the same commit.** The authoritative sources are `src/render/font-resolution.ts`, `src/render/glyph-helper.ts`, `src/render/text-to-path.ts`, `src/render/embedded-font-builder.ts`, and `src/capture/index.ts` (`discoverAndRegisterWebfonts`); when code and diagram disagree, the code wins — fix the diagram. The `check-requirements-against-code` skill verifies this diagram as part of its sweep.

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

<!-- hotsheet:begin section=testing-philosophy v=2 -->
## Testing Philosophy

- **Keep automated browser work headless**: tests, probes, visual validation, and agent review loops must use headless Playwright Chromium. Set `DOMOTION_NO_OPEN=1` (or pass `--no-open`) when a command can start SVG Scrubber, SVG Demo Test Review, or another local review server. Do not launch the user's desktop browser unless the user explicitly asks for a headed/interactive run.
- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Coverage is a floor, not a ceiling**: 100% line/branch coverage shows every line *ran*, not that every *behavior* — or every *sequence* of behaviors — is *asserted*. It is structurally blind to a **missing state transition**: a bug living in an untested interaction sails through a green 100% report because the individual lines still get hit by isolated, single-operation tests.
- **Transition-matrix testing for stateful modules**: for anything with modes / multiple code paths / a cache / a state machine, enumerate the states AND the transitions between them, then write tests that walk realistic multi-step sequences crossing state boundaries — not just each operation from a clean initial state.
- **Adversarial pass on stateful changes**: when adding or altering a stateful code path, deliberately try to break it with out-of-order / interleaved / repeated / empty-then-refill sequences; pin any that would have failed as permanent regression tests.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

- **Unit tests** (`src/**/*.test.ts(x)`, `tests/**/*.test.ts(x)`): `vitest` under `vitest.config.ts` (happy-dom environment). Run with `npm test`, which first rebuilds the capture script; `npm run test:watch` for watch mode.
- **E2E tests** (`src/**/*e2e.test.ts`, `tests/**/*e2e.test.ts`): `vitest` under the separate `vitest.e2e.config.ts`, driving real Chromium via Playwright. Run with `npm run test:e2e`.
- **Visual-regression suites** — the primary fidelity signal — are bespoke harnesses under `tests/`, not vitest: `npm run demos:test` (one fixture per CSS feature), `npm run demos:test:html` / `:unicode` (broad html-test sweeps), `npm run demos:test:all` (features + snapshot-isolation + showcase + animate + html + real-world). Each renders a fixture via Chromium and via Domotion and diffs the PNGs through `src/review/compare-pngs.ts`; the shared harness is `tests/runner.tsx` / `tests/html-test-suite.tsx`. Review diffs with `npm run demos:review`, setting `DOMOTION_NO_OPEN=1` for automated runs.
- **Commands**: unit `npm test` · E2E `npm run test:e2e` · coverage `npm run test:coverage` (v8, via `@vitest/coverage-v8`) · feature regression `npm run demos:test`.
- **Merged coverage** (`npm run test:coverage:all`, DM-1343/DM-2646): `npm run test:coverage` reflects ONLY the vitest unit suite, so browser-driven capture/CLI/server code and the big render modules read as under-covered even though the E2E and bespoke visual suites exercise them hard. `tools/coverage-all.mjs` runs the unit suite and ordinary browser E2Es (vitest `--pool=forks`, headless/no-open) plus the fast visual suites (features + showcase + snapshot-isolation + animate-examples) under one shared `NODE_V8_COVERAGE` dir, then merges them with `c8` into `coverage/all/`. The intentionally headed authenticated-profile experiment remains in its dedicated `fonts:generic-profile-target` lane and is excluded from coverage. The merged command prints per-directory metrics and the instrumented files still below 50% statements, and writes the same data to `coverage/all/directory-summary.json`; Chromium-resident review/scrubber clients are listed separately because Node's V8 profiler cannot instrument their generated browser bundles. The default intentionally skips the slow/CI-bound sweeps. `npm run test:coverage:full` (`node tools/coverage-all.mjs --full`) ALSO runs the ~277-fixture html-test sweep, the 819-block unicode sweep, and the real-world HAR replays — which push the font/text/render modules higher (they exercise the fallback chains, shaping, and per-block routing the fast suites barely touch) but take the better part of an hour locally (the same reason CLAUDE.md shards those on CI). `--full` runs only the sweeps whose fixture checkouts exist (`external/html-test`, `../html-test/unicode`, `tests/cache/real-world`), skipping any that aren't cloned with a warning. Even `--full` won't reach 100%: platform-specific branches (Linux/Windows font extractors, the `<text>`-fallback path) don't execute on a single macOS run. Note: the merged aggregate uses c8's physical-line accounting over ALL `src` files, so its top-line % is NOT numerically comparable to `test:coverage`'s vitest/istanbul statement count — read the per-module numbers, not the aggregate, when comparing.
- For sweeps over ~50 visual fixtures, dispatch to CI rather than running locally — see "Run large visual sweeps on CI, not locally" above.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two thin routing docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — cross-cutting principles and routes into the six domain handbooks. The generated manifest and owner packets, not this hand-written page, carry the exhaustive current/partial inventory.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

- **Domain handbooks** live in `docs/handbook/` and are the current normative entry points. Detailed requirements and evidence live in numbered Markdown files under `docs/`; `docs/reference/` holds cross-cutting indexes.
- **Generated discovery views** are `docs/index.json`, `docs/generated-index.md`, `docs/archive/index.md`, `docs/ai/manifest.json`, and `docs/ai/packets/*.md`. Generate them from canonical Markdown/front matter; never hand-edit them.
- **Codebase map**: `docs/ai/code-summary.md`.
- **Requirements summary**: `docs/ai/requirements-summary.md`.

Both AI-summary files already exist and are intentionally thin pointers into this file + the numbered docs — keep them in sync per "AI-summary docs" above.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
