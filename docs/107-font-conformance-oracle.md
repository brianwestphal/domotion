# 107 — Font-resolution conformance oracle

Domotion's font goal is guaranteed parity with Chromium's font-selection mechanism: for any codepoint, in any CSS font stack, we must resolve the face Chromium actually paints with. A visual-regression suite cannot establish that. Fixtures sample, and a wrong-font bug survives comfortably in the codepoints no fixture happens to cover — which is how several of them survived.

`tools/font-conformance.ts` is the instrument that replaces sampling with enumeration. It asks Chrome and Domotion the same question about every assigned Unicode codepoint, crossed with every font stack the fixture corpus actually uses, and fails on any disagreement.

- **Chrome's answer** — CDP `CSS.getPlatformFontsForNode` over a one-codepoint cell. This is the face the engine reports having painted with, not a guess inferred from pixels. Two earlier attempts to identify a face from rendered crops (a hand-rolled shape matcher, and `tools/compare-glyphs.ts` on upscaled 1× captures) both failed their controls; asking the browser is strictly better.
- **Our answer** — `resolveFontForCodepoint` against the same stack's key chain, at the same size, weight and style, materialized through the same call the renderer makes (`res.fontOverride ?? getFontInstance(res.key, weight, size, slant)`), so the face reported is the concrete **cut** the renderer would load and not the family's base entry.

`tools/chrome-font-agreement.ts` is the single-shot diagnostic sibling: it prints `FONTAGREE:` lines into a CI log for a handful of codepoints and never gates. This is the exhaustive, gateable one.

## Running it

```sh
npx tsx tools/font-conformance.ts                          # full sweep, all corpus stacks
npx tsx tools/font-conformance.ts --range 0000-2FFF        # one slice of Unicode
npx tsx tools/font-conformance.ts --max-stacks 12          # the most-used stacks only
npx tsx tools/font-conformance.ts --shard 2/8              # codepoint shard 2 of 8
npx tsx tools/font-conformance.ts --stack-shard 3/16       # stack shard 3 of 16
npx tsx tools/font-conformance.ts --extract-stacks         # re-derive the stack corpus
```

Exit code is `0` when every comparison agrees or is allowlisted, `1` on any mismatch, `2` on a harness error. That is what makes it usable as a gate.

| Flag | Meaning |
| --- | --- |
| `--stacks <file>` | Stack corpus (default `tools/font-conformance-stacks.<platform>.json` — one per platform, see below). |
| `--extract-stacks` | Re-derive the corpus from the fixtures and exit. |
| `--allow-foreign-corpus` | Sweep a corpus extracted on another platform. Refused by default. |
| `--source a,b` | Fixture directories to extract from (default `external/html-test`, `../html-test/unicode`). |
| `--range 0000-2FFF` | Restrict the codepoint universe; repeatable / comma-separated. |
| `--no-pua` | Drop `\p{Private_Use}` — 137k of the 292k codepoints. Makes the run a subset; the report records it. |
| `--shard i/N` | Stride shard over codepoints. |
| `--stack-shard i/N` | Stride shard over stacks. |
| `--batch n` | Codepoints per probe page (default 8000). |
| `--concurrency n` | Pipelined CDP calls in flight (default 128). |
| `--max-rows n` | Per-mismatch example rows retained in `report.json` (default 20000). Counts are always exact; only the detail is capped. |
| `--reset-every n` | Drop the font-resolution memos every `n` batches (default 1; `0` disables). Keeps a long sweep inside a bounded heap — see [Memory](#memory-why-the-sweep-resets-its-own-caches). |
| `--strict-alias` | Treat the documented naming aliases as mismatches (see below). |
| `--allowlist <file>` | Accepted-divergence file (default `tools/font-conformance-allowlist.json`). |
| `--lang <tag>` | Locale for both sides (default `en`): `<html lang>` on the probe page *and* the `lang` our resolver routes Han with. |
| `--out <dir>` | Report directory (default `tests/output/font-conformance`). |

## What it sweeps

**Codepoints.** Every codepoint from the Unicode tables compiled into this Node build (`\p{Assigned}`, Unicode 16.0 on Node 22 / ICU 76) — derived at runtime, never transcribed into a list, because a transcribed list is the same sampled artifact the tool exists to eliminate. Four exclusions, each mechanical rather than convenient:

| Excluded | Why |
| --- | --- |
| unassigned | nothing to paint |
| surrogates U+D800–DFFF | `\p{Assigned}` counts them (gc=Cs), but they are not scalar values |
| `\p{Noncharacter_Code_Point}` | permanently reserved |
| `\p{Cc}` C0/C1 controls | the HTML parser rewrites U+0000 to U+FFFD and folds CR/LF/TAB into whitespace, so Chrome's answer would describe a different codepoint than the one asked about |

That leaves **292,466** codepoints, of which 137,468 are private use.

**Stacks.** Extracted from the fixture corpus rather than invented — inventing them would reintroduce the sampling problem one level up. `--extract-stacks` loads all 1,115 fixtures under `external/html-test/` and `../html-test/unicode/` and records the *computed* `font-family` / `font-size` / `font-weight` / `font-style` / `font-stretch` / `font-variation-settings` of every element that directly contains text. On the current corpus that is **434 distinct combinations**, cached with the fixture count and one example fixture per entry, so any disagreement can be reproduced by hand. Re-run `--extract-stacks` when the corpus changes.

Size is part of the key, not collapsed away: macOS optical cuts mean Chrome genuinely reports a different face at 16 px than at 32 px for the same family.

### The corpus is per-platform, and this was measured rather than assumed

There is one corpus file per platform — `tools/font-conformance-stacks.darwin.json`, `…linux.json`, `…win32.json` — and the sweep refuses a corpus whose recorded `platform` is not the host's unless `--allow-foreign-corpus` says otherwise.

That is not tidiness. A stack corpus records *computed* style, and the computed `font-family` of an element that declares none is **Chrome's per-platform default-font preference**, not a platform-neutral keyword. Extracting the same 1,115 fixtures on macOS and inside the pinned Linux container produces 434 stacks either way, and three of them differ — including the single largest entry in the whole corpus:

| macOS | Linux | fixtures |
| --- | --- | --- |
| `Times` 16/400/normal | `"Times New Roman"` 16/400/normal | 1,114 |
| `Times` 16/400/italic | `"Times New Roman"` 16/400/italic | 1 |
| `Times` 32/700/normal | `"Times New Roman"` 32/700/normal | 1 |

Sweeping the macOS corpus on Linux would therefore ask Chrome-on-Linux about a stack no page on Linux ever computes, for the stack that covers **1,114 of 1,115 fixtures**. It would not have failed; it would have produced a clean-looking number for the wrong question — the same instrument failure that has already cost this area twice (a table sampled from one machine's font inventory, and a Windows probe that recorded the run's primary font rather than the fallback). The guard exists so a future run cannot make that mistake quietly.

## How the probe page is built

Correctness constraints, all of which cost throughput and all of which are load-bearing:

- **One cell per codepoint**, each an `inline-block`. An inline-block establishes its own block formatting context, so shaping cannot cross the boundary — a combining mark in one cell can neither attach to nor change the font selected for its neighbor. (Block-level cells isolate equally well but lay out several times slower.)
- **`white-space: pre` on the cell.** Without it a cell holding U+0020 collapses to nothing, Chrome paints no glyph, and the oracle reports a mismatch that exists only because of how the probe page was written.
- **Batched, pipelined CDP.** Each page holds `--batch` cells; all node ids come back from one `DOM.querySelectorAll`, and `CSS.getPlatformFontsForNode` is issued `--concurrency`-at-a-time rather than awaited serially.
- **Cell font faces read as Chrome reports them, not as Chrome ranks them.** Blink accumulates platform-font usage into a hash map before serializing it, so the protocol array's order is not a documented ranking; the oracle takes the entry with the highest glyph count. A one-codepoint cell normally has exactly one entry, and the full list is preserved in `chromeAllFaces` when it does not.

## How to read the output

Two files land in `--out`:

- `report.json` — machine-readable: run metadata (platform, Unicode version, timings, throughput, shard, stack-corpus timestamp), the summary counters, per-stack mismatch counts, the ranked disagreeing face pairs, the allowlist with per-entry hit counts, and up to `--max-rows` example mismatch rows (`rowsRetained` / `rowsTruncated` say how many were kept).
- `summary.txt` — the same headline numbers as stable text, also printed to stdout.

**Read `distinctMismatchPairs` next to `mismatchTotal`.** One wrong decision does not produce one mismatch row: if a stack's primary family maps to the wrong face, every uncovered codepoint in that stack — around 200,000 of them — becomes a mismatch. A measured run showed 318,978 mismatch rows across three stacks of which **70.7% came from a single route** (`HiraginoSans-W4 → HiraKakuProN-W3`). The raw count measures blast radius; the distinct-route count measures how many decisions are actually wrong. Fix routes, watch rows collapse.

That amplification is also why the per-row detail is capped: an uncapped report from that same run was 224 MB.

Every comparison lands in exactly one bucket:

| Bucket | Meaning |
| --- | --- |
| `agree-exact` | Same PostScript name. The only tier that also proves the weight/style cut. |
| `agree-same-file` | Chrome's PostScript name resolves — through the same platform font matcher Chrome used — to the file we picked. Covers path-table entries that carry no PostScript name of their own, and is consulted **only when one of the two sides is nameless**: a `.ttc` holds several faces behind one path, so a file match between two faces we can both name, whose names differ, is evidence of a shared collection rather than a shared face. |
| `agree-alias` | Reconciled by a documented entry in `FACE_ALIASES`. |
| `agree-tofu` | No font covers the codepoint, so we draw the run primary's `.notdef` — and Chrome, which reports the face it *selected* rather than the face that *covered* the character, names that same primary. The largest bucket by far: most of Unicode is uncovered in any given stack. |
| `agree-not-painted` | Chrome painted nothing and neither would we. |
| `mismatch` | Chrome painted face A, we resolve face B. |
| `mismatch-we-paint` | Chrome painted nothing; we would paint ink. |
| `mismatch-we-tofu` | Chrome selected a face we never found; we would tofu where Chrome paints. |

The three `mismatch*` buckets gate. Each mismatch row also carries a triage `class`:

- `different-family` — we routed the codepoint to a different typeface entirely (Chrome: `.SFDevanagari-Regular`, us: `KohinoorDevanagari-Regular`). A routing defect.
- `same-family-different-cut` — right typeface, wrong weight or optical cut (Chrome: `Arimo-Bold`, us: `Arimo-Regular`). A cut-selection defect — or, for a variable face we instance along `wght` instead of naming a static cut, a name the oracle cannot adjudicate either way.

### What the oracle does not yet compare

The instrument is only worth its exit code if its blind spots are written down rather than discovered later as "the number was wrong all along". Current ones:

- **Variable faces cannot be adjudicated by name.** A variable file instanced along `wght` keeps the base master's PostScript name (`/System/Library/Fonts/SFNS.ttf` reports `.SFNS-Regular` at every weight) while Chrome names the optical/weight cut it selected. Those land in `agree-alias` or `same-family-different-cut`; the oracle can prove the FILE and the axis request but not the name. **This one is structural and stays** — the name-independent check lives in the sibling shaping oracle ([doc 108](108-shaping-conformance-oracle.md)), which compares painted glyph positions and so discriminates two instances of one name where this tool cannot.
- **`font-feature-settings` is still not extracted**, so a fixture using it is swept as though it did not.
- **One face per cell.** When a codepoint decomposes across two faces the oracle compares the one with the most glyphs; the full list survives in `chromeAllFaces`.
- **Synthetic vs real cuts are compared by face, not by synthesis.** If Chrome synthesizes bold from a regular face it reports the regular face, so our picking a real bold sibling shows up — correctly — as a mismatch. That is the intended reading, but it means a `same-family-different-cut` row can mean either "we took the wrong cut" or "Chrome faked one".
- **On Linux the `agree-same-file` tier can never fire.** That tier resolves Chrome's reported PostScript name to a file through `resolveInstalledFont`, and the Linux glyph helper implements no `family` query — the function is documented as always returning `null` there. So on Linux every agreement must be proven by name at the strongest tier or it is a mismatch. That makes the Linux number *stricter* than the macOS one in this respect, not weaker, but it is a difference between the platforms' instruments and not only between their fonts.
- **`FACE_ALIASES` is a macOS list.** Its single entry reconciles Chrome's `SF Pro Text` naming with the SFNS file we load. Nothing analogous is claimed for Linux or Windows, so `agree-alias` is structurally zero on those platforms.

### `font-stretch` and `font-variation-settings` — closed, and measured (DM-1858)

Both are now part of the stack key, extracted from the computed style and declared on the probe page, and our side honors an author's axis settings through `getFontInstance`. The corpus grew **418 → 434 stacks**, surfacing 8 combinations with non-normal `font-stretch` (the fixtures span 50% → 200%) and 9 with explicit `font-variation-settings`.

Those 17 newly-visible stacks measure **0 mismatches**. That is a real result rather than a vacuous one, and it was checked name-independently rather than trusted:

- Chrome's painted width for `sans-serif` is **identical at every stretch from 50% to 200%** (151.19px, face `Helvetica`). macOS Helvetica has no condensed face and no `wdth` axis, so there is nothing to select and Chrome does not synthesize condensing.
- Chrome's painted width is likewise **unchanged** across `"wght" 100` ↔ `"wght" 900` and `"wdth" 50` ↔ `"wdth" 150` — including on `system-ui`, whose SFNS file *is* variable.

So on this corpus and platform neither axis moves Chrome's output, and agreement is genuine. The corollary worth stating: **nothing in the fixture corpus currently exercises a live variable axis**, so the name-blindness above, while real, is presently untested rather than passing. A fixture that drives a `wdth`/`wght` axis Chrome actually honors would be the thing to add.

### Aliases are not exemptions

`FACE_ALIASES` in the tool records the one place where Chrome's name for a face and ours genuinely cannot be reconciled mechanically: the macOS system font, which Chrome reports as `SF Pro Text` / `SFProText-Regular` while painting it out of `/System/Library/Fonts/SFNS.ttf`, whose own PostScript name is `.SFNS-Regular`. Domotion routes its `sf-pro` key to SFNS deliberately, because SFNS is the file whose outlines match Chrome's painted glyphs.

Alias hits are counted and reported in their own bucket so the size of that claim stays visible, and `--strict-alias` re-classifies them as mismatches. Keep the list short: a wrong alias silently converts a real defect into a pass.

One related guard worth knowing about: CoreText refuses to look up Apple's hidden `.`-prefixed system face names and answers with Times New Roman instead of an error. The oracle therefore never file-resolves a name beginning with `.`, and for every other name requires the resolved face's own PostScript name to match what was asked for. Without that, any face that happened to be Times would have manufactured agreement.

### The allowlist

`tools/font-conformance-allowlist.json` records accepted divergences. It ships empty on purpose — an honest failing count is the point of the instrument, and pre-populating it to reach green would destroy the only thing it measures.

```json
{ "entries": [ { "cp": "0x1F16A-0x1F16B", "stack": "…optional exact stack…", "reason": "why living with this is defensible" } ] }
```

`reason` is required and must be a real sentence; the loader throws on a missing or perfunctory one. Every entry's hit count is written to `report.json`, so an entry that has stopped matching shows up as dead and can be deleted.

## Cost, and running it in CI

Measured on an M1 Pro (macOS, Playwright Chromium, native glyph helper present):

| Phase | Rate |
| --- | --- |
| Chrome side alone (`setContent` + pipelined CDP, warm page) | ~11,200 codepoints/s |
| One process, one stack, full universe | 292,466 comparisons in 273 s (~1,070/s) — Chrome 87 s, our resolver 186 s |

Our side dominates, because each first-seen uncovered codepoint costs one CoreText round trip through the glyph helper; those results are memoized per codepoint, so later stacks in the same process are several times faster.

The full cross product — 292,466 codepoints × 418 stacks = **122.2 million comparisons** — is roughly 14 hours in a single process. That is not a per-PR gate, and it should not pretend to be one. Two supported ways to run it:

1. **Sharded on CI.** `--stack-shard i/N` splits the corpus across runners; each runner works one stack at a time with a warm cache. 40 shards puts a full sweep in the ~20-minute range, comparable to the existing sharded visual sweeps (`docs/66-ci-visual-tests.md`). Prefer sharding on stacks over codepoints: a codepoint shard re-pays the cold-cache cost in every shard, a stack shard does not.
2. **Scoped for the change at hand.** `--range` for a routing change confined to a script, `--max-stacks` for a change to a specific family's handling. Both are subsets, and the report says which.

Whatever the scope, the report's `meta` block records exactly what was swept — codepoint count, stack count, ranges, shards, PUA inclusion — so a number can never be quoted without its scope.

## Three platforms, three oracles

Reaching agreement on macOS says nothing about Linux or Windows, because per-codepoint fallback is not one procedure with three font sets behind it. Blink runs different code on each (`external/chromium` at `7d859f27`, 2026-06-27):

| Platform | Blink's path | Shape |
| --- | --- | --- |
| macOS | `platform/fonts/mac/font_cache_mac.mm` → `CTFontCreateForString` | base is the run's current font; the answer depends on it |
| Linux | `platform/fonts/linux/font_cache_linux.cc` → `gfx::GetFallbackFontForChar(c, locale, …)` | keyed on locale; there is no base font |
| Windows | `platform/fonts/win/font_cache_skia_win.cc` → hardcoded per-script table, then `GetDWriteFallbackFamily` | the table wins whenever it matches |

So each platform gets its own sweep job, its own stack corpus, its own font inventory, and its own committed baseline. `.github/workflows/font-conformance.yml` takes an `os` input (`macos` / `linux` / `windows` / `all`); all three run the same `scripts/ci-font-conformance-shard.sh`, so the slice, the exit-code discipline and the recorded environment cannot drift between them.

Per-platform environment notes that the jobs encode:

- **macOS** builds the CoreText helper (`swift build`). Without it the resolver cannot ask CoreText and silently drops to the static chain — answering a different question than the one reported.
- **Windows** builds the DirectWrite helper (`build.ps1`), for the same reason.
- **Linux** builds nothing, deliberately: its per-codepoint resolver shells out to `fc-match`, so there is no helper to fall off. The only cost of the absent helper is `resolveInstalledFont`, hence the dead `agree-same-file` tier noted above.
- **Linux runs in the pinned `mcr.microsoft.com/playwright:v<ver>-noble` container**, not on a bare `ubuntu-latest`. The Linux fallback answer *is* the container's fontconfig set, so a different image is a different oracle — the same reasoning the Linux fidelity suites already run on.

### The gate is regression-relative, and can refuse to judge

Two behaviors, both of which exist because the alternative is a confident number about nothing:

**Baseline-relative, not absolute zero.** macOS does not measure zero after years of work; Linux and Windows had never been measured at all. A gate demanding zero fails identically on every run and therefore grades nothing. `scripts/diff-font-conformance-baseline.mjs` fails on a *regression* against the platform's own last recorded measurement — a stack whose mismatch count rose, a stack that newly disagrees, or a new disagreeing route. The absolute count is reported and tracked, never enforced. This is the same model as the per-platform visual-fidelity gates (`tests/baselines/README.md`).

**A run can be refused rather than judged.** The oracle's answers are a function of the runner's installed fonts, the host ICU's codepoint universe, and which stacks were swept. If any of those moved, the two numbers are not measuring the same thing, and comparing them anyway yields a confident regression or a confident all-clear, both meaningless. So the baseline records the runner image, the font-inventory digest (`tools/font-inventory.mjs`), the Unicode/ICU versions, the corpus identity, and the slice — and on any difference the comparator withholds the verdict and says which field moved. A runner image rotation is then a visible environment change to re-seed against, not an unexplained score move.

**A missing shard is fatal, not a log line.** `scripts/merge-font-conformance-shards.mjs` counts the reports it merged against the requested shard count and marks the merge incomplete if any is absent; the comparator refuses to judge an incomplete merge. A shard that dies writes no report, and a total summed over the survivors is smaller — which reads exactly like an improvement.

### Memory: why the sweep resets its own caches

A sweep is unusual for this codebase in that it drives the resolver across the *entire* codepoint space in one process. The font-resolution memos are keyed by codepoint, and — the part that actually dominates — **fontkit memoizes a `Glyph` object per glyph id for the life of a `Font`**, so every `Font` held in `fontInstanceCache` accumulates one retained `Glyph` for each codepoint ever probed through it. Nothing is collectable, because the cache holds the fonts.

Left alone, that ends the run: `--max-stacks 8 --no-pua` exhausted a default Node heap at **32,000 of 154,998 codepoints** (~3.5 GB, `Ineffective mark-compacts near heap limit`). The consequence is worse than an inconvenient crash — a sweep that dies partway has measured a **prefix of the universe**, and every number it printed on the way describes that prefix while reading like the answer.

So the sweep now calls `clearFontResolutionCaches()` every `--reset-every` batches (default: every batch) and rebuilds the stack, since the `ResolvedStack` owns the primary `FontInstance` and would otherwise keep the largest glyph memo of all alive. On the same run that used to die:

| | before | after |
| --- | --- | --- |
| resident at 32k codepoints | ~3.5 GB, then fatal | ~1.0 GB, still running |
| reached | 32,000 / 154,998 | full sweep |

Correctness is not traded for it: every cleared entry is a pure function of its key, so a cold lookup re-derives the same answer. Verified rather than assumed — the same slice run with `--reset-every 0` and `--reset-every 1` produced identical summaries and **zero row-level differences across all 950 mismatch rows**. `src/render/font-resolution-cache-reset.test.ts` pins the property, including that registries (webfonts, embedded fonts, local aliases, discovered system-fallback paths) deliberately **survive** a reset — those hold caller state, and dropping them would change behavior rather than just cost.

Each batch's resident size is printed alongside progress, and the peak lands in the summary, so a long run can be seen to be bounded rather than merely not-yet-dead.

### The CI gate must not pass by losing data

The sharded workflow (`.github/workflows/font-conformance.yml`) previously ran each shard with `|| true` — intended so one shard's *mismatches* wouldn't cancel its siblings. But a shard that **dies** writes no `report.json`, the aggregate step skipped missing reports with a log line, and the gate then tested a mismatch total summed over the survivors. A run whose mismatch-bearing shards ran out of memory would therefore report zero mismatches and go green.

Two changes close that, and both now live in scripts rather than inline in the workflow so they are unit-tested (`tests/font-conformance-baseline.test.ts`) and identical on all three platforms:

- `scripts/ci-font-conformance-shard.sh` accepts only the exit codes the tool defines — `0` (full agreement) and `1` (mismatches found). Anything else is a dead shard and fails the job.
- `scripts/merge-font-conformance-shards.mjs` counts the reports it merged against the requested shard count and marks the merge `complete: false` if any is absent; `scripts/diff-font-conformance-baseline.mjs` **withholds the verdict** on an incomplete merge, failing on that rather than on a partial total.

## Instrument corrections, 2026-07-29

Every parity fix is scored against this tool, so a defect in the tool corrupts every number measured after it. Three were found and fixed in the first review after the first baseline was taken; the numbers below are quoted before and after so the correction is auditable rather than silent.

1. **Our side named the family, not the cut.** The oracle asked `resolveFontSpec(key)`, which returns the family's base entry in the path table. The renderer asks `getFontInstance(key, weight, size, slant)`, which makes a *second* decision on top of the key — the `-bold` / `-italic` / `-bold-italic` sibling, the sub-bold cut, the Hiragino Sans W0…W9 ladder, `cjk-bold`, `korean-bold`, `lucida-grande-bold`, the PingFang Medium subfont. Chrome's answer is always weight-selected, so the comparison was base-against-cut. On the committed 418-stack corpus, **75 stacks** reported a face other than the one they would render. The oracle now materializes the instance the way the renderer does and reads the identity back off it (fontkit's own `postscriptName` first, so the resolved member of a `.ttc` is named exactly).

   This also silently defeated the previous commit's Hiragino work: `resolveFontSpec("hiragino-jp")` answers `HiraginoSans-W4` at every weight, which happens to be right at 400 and wrong at the other eight rungs of the ladder — so the ladder could be fixed or broken without the instrument moving.

2. **`agree-same-file` could absorb a wrong cut.** Every cut of a `.ttc` family shares one path, so "Chrome's face resolves to the file we picked" was true of Helvetica Regular *and* Helvetica Bold. Combined with (1) that made the base-vs-cut error invisible: the oracle reported the regular face, Chrome reported the bold, and the shared `Helvetica.ttc` reconciled them. The tier is now consulted only when one of the two sides is nameless, which is the case it was written for.

3. **`--lang` moved only Chrome.** The tag went on the probe page's `<html>` element but not into `resolveFontForCodepoint`, whose `fallbackFontChain` routes Han by locale. `--lang ja` would have moved Chrome's answer and not ours. Both sides now receive it. Behavior-neutral at the default (`en` selects no locale-specific Han route), wrong at every other value.

## Baseline, 2026-07-29

First measured run, on a developer Mac (macOS arm64, Unicode 16.0, native glyph helper present, `sf-pro` alias tier enabled). Full 292,466-codepoint universe per stack. These are the numbers the parity work is measured against; every one is a complete sweep of a single corpus stack, not a sample.

| Stack (as the corpus computes it) | size / weight / style | mismatches of 292,466 |
| --- | --- | --- |
| `Times` | 16 / 400 / normal | 26,669 |
| `Menlo, Consolas, "DejaVu Sans Mono", monospace` | 17 / 400 / normal | 26,423 |
| `sans-serif` | 32 / 700 / normal | 46,140 |
| `system-ui, -apple-system, sans-serif` | 13 / 400 / normal | 51,246 |
| `system-ui, -apple-system, sans-serif` | 13 / 400 / italic | 52,526 |
| `system-ui, -apple-system, sans-serif` | 20 / 700 / normal | 52,720 |

A separate three-stack run — `--max-stacks 12 --stack-shard 3/4`, which selects `system-ui …` 20/700 plus the two 32 px CJK stacks the Unicode fixtures use — swept 877,398 comparisons and returned **318,978 mismatches across 153 distinct routes**, 36.4%, with agreement splitting 6.3% exact / 8.2% same-file / 1.2% alias / 48.1% shared tofu. That flag pair is the reproducer for every number in this section.

### Current measured baselines

Same machine, full 292,466-codepoint universe per stack, 877,398 comparisons per run. Both slices are named so a later number can be compared against a like-for-like run — a mismatch count without its slice means nothing.

| Slice | mismatches | distinct routes | same-family-other-cut |
| --- | --- | --- | --- |
| `--max-stacks 12 --stack-shard 3/4` (`system-ui` 20/700, the two 32 px CJK fixture stacks) | 93,553 | 153 | — |
| `Times` 16/400 + `Menlo …` 17/400 + `sans-serif` 32/700 | 99,261 | 211 | 20,136 |

What still disagrees, in descending order of blast radius:

1. **CJK family selection in the static chain.** `PingFangSC-Semibold → PingFangSC-Regular`, `HiraginoSans-W3/W6 → PingFangSC-Regular`, `PingFangSC-Regular → PingFangHK-Regular`, `AppleMyungjo → AppleSDGothicNeo-Regular` — tens of thousands of rows each. These are the hand-tuned per-block CJK routes in `darwinFallbackChain`, which name a family directly and never consult the live resolver, so the family (and, where the route pins a non-regular cut, the cut) is whatever was sampled.
2. **The macOS `.SF*` script faces.** Chrome cascades into the hidden system faces (`.SFDevanagari-Regular`, `.SFArabic-Bold`, `.SFHebrew-Bold`, `.SFArmenian-Bold`, `.SFTamil-Regular`, …) where we route to the Kohinoor / Noto / *SangamMN* families. CoreText refuses by-name lookup of `.`-prefixed faces, so these cannot be reached by asking for them; a per-script family of routing defects, a few hundred codepoints each.
3. **The system-fallback BASE font.** `resolveSystemFallbackKeyForCp` always asks CoreText from Helvetica, where Blink asks from the run's own primary — and the macOS cascade genuinely depends on the base (Han from Times answers Songti SC, from Helvetica answers PingFang SC). Every live-resolver answer for a non-Helvetica-ish primary inherits that.
4. **Latin-Extended and symbol routing in the `Times` stack**: `TimesNewRomanPSMT` → `Helvetica` / `LucidaGrande`, `Kokonor` → `Kailasa` (Tibetan), `ITFDevanagari-Book` → `KohinoorDevanagari-Regular`.

Note the shape of the number: the raw mismatch count is dominated by a handful of primary-family decisions, so it should fall in large steps rather than gradually. Track `distinctMismatchPairs` to see real progress.

### Where that baseline stands now

> **Two independent measurements of `--max-stacks 12 --stack-shard 3/4` disagree, and neither has been reconciled.** The instrument audit recorded 93,553 → 95,617 mismatches / 153 → 171 routes on that slice. The subsequent cut-selection work measured **93,553 / 153** for the same flags and could not reproduce 95,617/171, noting that the slice contains no `Times` stack — so the 29,420-row Songti pair, which drives much of the increase above, cannot arise in it. One of the two runs is mislabelled as to which stacks it actually swept. **Re-derive the slice from `tools/font-conformance-stacks.json` before quoting either number**, and prefer a slice you have selected explicitly (`--stacks <file>`) over a shard index, which is sensitive to corpus ordering.


Two things happened to it. Routing the `hiragino-jp` key to the weight cut Chrome picks removed item 1 above outright. Correcting the instrument (previous section) then re-scored what remained. Same slice, same host, same 877,398 comparisons:

| | quoted baseline | after the Hiragino ladder fix | after the instrument corrections |
| --- | ---: | ---: | ---: |
| mismatch total | 318,978 (36.36%) | 93,553 (10.66%) | **95,617 (10.90%)** |
| distinct routes | 153 | 153 | **171** |
| `agree-exact` | 54,884 | 69,609 | **139,143** |
| `agree-same-file` | 71,598 | 71,598 | **0** |
| `agree-alias` | 10,093 | 10,093 | 10,093 |
| `agree-tofu` | 421,845 | 632,545 | 632,545 |
| `mismatch-we-tofu` | 210,700 | 0 | 0 |

**The last column is higher than the one before it, and that is the point.** The 71,598 comparisons the file tier used to reconcile did not vanish — 69,532 of them turned out to be genuinely the same face and are now proven by name at the strongest tier, and 2,064 turned out not to be. Those 2,064 are real wrong-cut picks that the instrument had been scoring as agreement, and the 18 extra distinct routes name them. A smaller number here would have meant less was being measured, not that more was correct.

The same decomposition on `--max-stacks 3 --no-pua` (464,994 comparisons over the `Times` / `Menlo` / `system-ui` 20/700 stacks) separates the two corrections: naming the cut moves 4,958 comparisons from `agree-same-file` to `agree-exact` and leaves the total at 88,895, because those three stacks' primaries are mostly weight 400 where the cut IS the base entry. Tightening the file tier then converts the remaining 31,484 same-file agreements into mismatches, every one of them a cut disagreement:

| Newly visible route | rows | what it means |
| --- | ---: | --- |
| `STSongti-SC-Regular` → `STSongti-SC-Light` | 29,420 | Chrome paints Han in the `Times` stack with Songti Regular; the `cjk-serif` key resolves to the Light cut. Both live in `Songti.ttc`, so the file tier called it agreement across the whole Han block. |
| `EuphemiaUCAS-Bold` → `EuphemiaUCAS` | 630 | Chrome takes the family's bold cut at weight 700; the key has no `-bold` routing. |
| `KefaIII-Bold` → `KefaIII-Regular` | 495 | same |
| `TamilSangamMN-Bold` → `TamilSangamMN` | 261 | same |
| `NotoSansMyanmar-Bold` → `NotoSansMyanmar-Regular` | 224 | same |
| `Galvji-Bold` → `Galvji` | 172 | same |
| `SinhalaSangamMN-Bold` → `SinhalaSangamMN` | 80 | same |
| `NotoSansSyriac-Regular_Bold` → `NotoSansSyriac-Regular` | 77 | same |
| `Menlo-Bold` → `Menlo-Regular` | 63 | same |
| `MuktaMahee-Bold` → `MuktaMahee-Regular`, `Inter-Regular_Bold` → `Inter-Regular`, `NotoSansNagMundari-Regular_Bold` → …, `NotoSansKannada-Bold` → …, `HelveticaNeue-Bold` → `HelveticaNeue` | 62 | same |

Nothing moved the other way — no route lost agreement for any reason other than a named cut disagreeing with a named cut.

On a slice chosen to match the change instead of the history — the six corpus stacks whose primary IS cut-routed, stride-1/4 universe, 438,702 comparisons — the total falls **116,654 → 71,233** while distinct routes rise **302 → 351**. The fall is one artifact: 53,474 rows of `Arial-BoldMT → arial` where our tofu donor had no name at all, so every uncovered codepoint in that stack scored as `mismatch-we-tofu`. The rise is diagnosis: `PingFangSC-Semibold → PingFangSC-Regular` keeps its 12,861 rows but is really `→ PingFangSC-Medium`, and `.AppleSDGothicNeoI-Bold → AppleSDGothicNeo-Regular` is really `→ AppleSDGothicNeo-Bold`. The old report would have sent a fixer after a decision the renderer never made.

## Related

- `docs/font-resolution-diagram.md` — the end-to-end font-resolution flow this oracle checks.
- `docs/80-cross-platform-system-fallback-resolver.md` — the live per-codepoint system-fallback resolver.
- `docs/42-cross-platform-fallback-calibration.md` — per-platform calibration and the rasterization floor.
- `docs/98-glyph-font-compare.md` — the pixel-side "was this the same font?" tool, for cases where no DOM node exists to ask about.
