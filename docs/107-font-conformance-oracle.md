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
npx tsx tools/font-conformance.ts --sample-byte 00         # every assigned U+…00 codepoint
npx tsx tools/font-conformance.ts --max-stacks 12          # the most-used stacks only
npx tsx tools/font-conformance.ts --shard 2/8              # codepoint shard 2 of 8
npx tsx tools/font-conformance.ts --stack-shard 3/16       # stack shard 3 of 16
npx tsx tools/font-conformance.ts --extract-stacks         # re-derive the stack corpus
```

Exit code is `0` when every comparison agrees or is allowlisted, `1` on any mismatch, `2` on a harness error. That is what makes it usable as a gate.

| Flag | Meaning |
| --- | --- |
| `--stacks <file>` | Stack corpus (default `tools/font-conformance-stacks.<platform>.json` — one per platform, see below; `tools/font-conformance-stacks.synthetic.json` for the [rule-derived sweep](#the-synthetic-stack-corpus--the-axis-the-fixtures-cannot-reach)). |
| `--extract-stacks` | Re-derive the corpus from the fixtures and exit. |
| `--allow-foreign-corpus` | Sweep a corpus extracted on another platform. Refused by default. |
| `--source a,b` | Fixture directories to extract from (default `external/html-test`, `../html-test/unicode`). |
| `--range 0000-2FFF` | Restrict the codepoint universe; repeatable / comma-separated. |
| `--sample-byte 00` | Deterministic 1/256 sample across Unicode: retain assigned codepoints whose low byte is `00`. Accepts `00` through `FF`; mutually exclusive with `--range`. |
| `--no-pua` | Drop `\p{Private_Use}` — 137k of the 292k codepoints. Makes the run a subset; the report records it. |
| `--shard i/N` | Stride shard over codepoints. |
| `--stack-shard i/N` | Stride shard over stacks. |
| `--batch n` | Codepoints per probe page (default 8000). |
| `--concurrency n` | Pipelined CDP calls in flight (default 128). |
| `--max-rows n` | Per-mismatch example rows retained in `report.json` (default 20000). Counts are always exact; only the detail is capped. |
| `--reset-every n` | Drop the font-resolution memos every `n` batches (default 1; `0` disables). Keeps a long sweep inside a bounded heap — see [Memory](#memory-why-the-sweep-resets-its-own-caches). |
| `--strict-alias` | Treat the documented naming aliases as mismatches (see below). |
| `--allowlist <file>` | Accepted-divergence file (default `tools/font-conformance-allowlist.json`). |
| `--lang <tag>` | Default locale for both sides (default `en`): `<html lang>` on the probe page and the resolver's fallback language. A corpus entry's `lang` overrides it on that stack's probe cells and resolver calls. |
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

**Stacks.** Extracted from the fixture corpus rather than invented — inventing them would reintroduce the sampling problem one level up. `--extract-stacks` loads all 1,115 fixtures under `external/html-test/` and `../html-test/unicode/` and records the *computed* `font-family` / `font-size` / `font-weight` / `font-style` / `font-stretch` / `font-variation-settings` / `font-feature-settings` / `font-variant-alternates` / `font-variant-emoji` of every element that directly contains text. On the current corpus that is **450 distinct combinations**, cached with the fixture count and one example fixture per entry, so any disagreement can be reproduced by hand. Re-run `--extract-stacks` when the corpus changes.

Size is part of the key, not collapsed away: macOS optical cuts mean Chrome genuinely reports a different face at 16 px than at 32 px for the same family.

**But the stack axis is bounded by the fixtures in a way the codepoint axis is not**, and that has to be read alongside every number below: "the oracle reports N mismatches" means "…for the 442 stacks we happened to harvest". The second corpus in the next section is the answer to that.

### The synthetic stack corpus — the axis the fixtures cannot reach

`tools/font-conformance-synthetic-stacks.ts` generates a second corpus from a **stated rule** rather than from the fixtures:

| axis | enumeration |
| --- | --- |
| generic families | the 13 CSS Fonts 4 generic-family keywords — `<generic-font-complete>` (`serif`, `sans-serif`, `system-ui`, `cursive`, `fantasy`, `math`, `monospace`) ∪ `<generic-font-incomplete>` (`ui-serif`, `ui-sans-serif`, `ui-monospace`, `ui-rounded`, `emoji`) plus the bare `fangsong` keyword |
| weights | the 9-rung CSS ladder, 100…900 |
| stretches | the 9 CSS `font-stretch` keywords, stored as the percentages Chrome computes them to |
| styles | `normal`, `italic` |
| family spelling | canonical unquoted keyword; quoted lowercase literal plus `Menlo` continuation; quoted case-variant literal plus `Menlo` continuation |
| content language | document default plus `ja`, `ko`, `zh-Hans`, `zh-Hant`, `ru`, `ar`, `el` — the union of Playwright's macOS and Windows `forScripts` tables |

13 × 9 × 9 × 2 × 3 × 8 = **50,544 stacks**, all at 16 px. The same portable corpus runs on Linux deliberately: because Playwright's Linux settings have no `forScripts` table, its language arms are the standing null oracle and must not move a generic-family answer.

Three properties are load-bearing rather than incidental.

**It is generated, and the output is gitignored.** A committed copy is a copy someone can hand-edit, and a hand-edited "synthetic" corpus is a curated list with a misleading name — the same sampled artifact the whole instrument exists to eliminate. Regenerate with `npx tsx tools/font-conformance-synthetic-stacks.ts`; `tests/font-conformance-synthetic-stacks.test.ts` pins the rule.

**Its identity is a digest of the rule's output, not a timestamp.** The baseline comparator refuses to judge across a change in the corpus's `generatedAt` — correct for a harvested corpus, where re-extraction can genuinely produce a different corpus. A rule-derived corpus has no such property, so a wall-clock stamp would invalidate every baseline on every CI run (each job regenerates it). Instead `generatedAt` is `synthetic:v2:<sha256-16>`: regenerating is comparable, changing the rule is not.

**Its ordering is part of the rule**, so a `--max-stacks` prefix is a meaningful slice. Stacks are sorted by distance from the CSS initial/default state (how many of weight / stretch / style / spelling / language differ):

    --max-stacks 13     one stack per generic family, all at CSS initial
    --max-stacks 351    …plus every single-axis departure from it
    (no cap)            the full 50,544-way product

It also declares `platform: "any"`, which the sweep's per-platform corpus guard accepts without `--allow-foreign-corpus`. That exemption is narrow and deliberate: the guard exists because a *harvested* corpus records computed style, and the computed `font-family` of an element that declares none is Chrome's per-platform default preference. This corpus holds only literal CSS keywords. What each keyword resolves to differs per platform — which is the question it asks, not a reason it cannot be asked.

#### Running it

```sh
npx tsx tools/font-conformance-synthetic-stacks.ts                 # generate
npx tsx tools/font-conformance.ts \
  --stacks tools/font-conformance-stacks.synthetic.json \
  --max-stacks 351 --shard 1/200                                  # sweep a slice
```

On CI it has its **own dispatch and its own baselines** — `.github/workflows/font-conformance-synthetic.yml`. Not an input to the default workflow: the cross product multiplies an already expensive sweep, and the two slices measure different questions, so they must not share a baseline. Both dispatches run the same `scripts/ci-font-conformance-shard.sh` so the flags, exit-code discipline and recorded environment cannot drift between them.

Routine synthetic testing uses a **rotating low-byte sample**. The default bucket `00` retains every eligible assigned codepoint for which `cp & 0xFF === 0x00`: `U+0100`, `U+0200`, … through supplementary planes. This is not the contiguous Latin-1 page `U+0000–U+00FF`. A bucket therefore samples scripts, symbol ranges, CJK, emoji, and private-use planes throughout Unicode while reducing the codepoint axis to approximately 1/256. Buckets `00` through `FF` are disjoint and their union is the exhaustive universe, so advancing the focus from `00` to `01` and onward accumulates complete coverage without the probabilistic holes of a random sample.

Each bucket has its own baseline, `tests/baselines/font-conformance-synthetic-<os>-byte-<XX>.json`; unlike buckets are never compared. `sample_byte: all` explicitly selects the exhaustive universe and keeps the established unsuffixed synthetic baseline. A first run of a new bucket is dispatched with `update_baseline` and its artifact is reviewed and committed before that bucket becomes a gate. A contiguous `range` remains available for diagnosis, but requires `sample_byte: all` so two selectors cannot silently intersect; range baselines include a digest of the range spelling and therefore cannot overwrite the exhaustive baseline.

At the default 351-stack slice, one low-byte bucket is roughly 1,100–1,200 codepoints, or about 400,000 comparisons per platform instead of 104 million. Automatic fan-out remains stack-based but is mode-aware. Measured on the byte-`00` validation run, 44-stack macOS shards took 35–49 seconds, 58–59-stack Linux shards took 17–20 seconds, and 21–22-stack Windows shards took 47–61 seconds. Routine samples therefore use **1 macOS, 1 Linux, and 3 Windows** jobs: projected sweep time is about 5–7 minutes on macOS, about 2 minutes plus setup on Linux, and 5–8 minutes on Windows. Windows receives extra shards because its best-effort DirectWrite path is substantially slower; routine parity decisions remain macOS/Linux-first under the project platform policy.

For `sample_byte: all`, automatic fan-out switches back to **8 macOS, 6 Linux, and 16 Windows**. The exhaustive 351-stack rule-v2 runs demonstrated why: individual hosted jobs approached the six-hour ceiling. A positive numeric `shards` input overrides both profiles when deliberately measuring another split. Every sweep log labels the current stack as `stack i/N`, so a live or canceled job exposes its completed prefix instead of showing only per-codepoint progress within an unnamed stack.

#### What it found immediately

Measured on a developer Mac, `--max-stacks 234 --shard 1/200` — 234 stacks × 1,463 codepoints = **342,342 comparisons, 12,051 mismatches (3.520%) across 186 routes** at the time it was added. The same rule at `--max-stacks 13` (one per generic, CSS initial state everywhere) measures **286 mismatches of 19,019 (1.504%) across 37 routes**. Almost everything is in the departures, and the departures are exactly what the harvested corpus does not contain:

| stack | mismatches of 1,463 |
| --- | ---: |
| `fantasy` @16/400/normal/**100%** | 3 |
| `fantasy` @16/400/normal/**50%**, **62.5%**, **75%**, **87.5%** | **1,110** each |
| `serif` @16/**400** | 1 |
| `serif` @16/**700** | 2 |
| `serif` @16/**800**, **900** | **157** each |

Two defects, neither previously measurable — **both now fixed**; the same slice measures **1,105 mismatches (0.323%) across 63 routes**, 10,946 rows fixed and 0 newly broken, 75 stacks improved and none worse:

- **`font-stretch` was not carried into our resolution at all.** Chrome selects `Papyrus-Condensed` for a condensed `fantasy` stack — macOS ships that cut — and we resolved plain `Papyrus`, which for 1,102 of the swept codepoints we could not open at all (`mismatch-we-tofu`). The harvested corpus contains `fantasy` only at 100%, and only 8 of its 434 stacks have any non-100% stretch. Fixed by giving `getFontInstance` a width and passing it to the declared-family style matcher, where Blink turns it into the condensed / expanded symbolic trait: 1,110 → 3 on each of the four stretched `fantasy` stacks.
- **Weight 800/900 took the wrong CJK cut.** Chrome paints Han with `STSongti-SC-Bold`; we resolved `STSongti-SC-Regular` (240 rows) or `STSongti-SC-Black` (70 rows). Identical for eight families, since they all fall through to the same serif CJK route. The harvested corpus has weight 800 in 10 of 434 stacks and weight 900 in 5 — and none of them is a serif-primary stack. The cause was **not** the `cjk-serif` weight ladder: it was the per-codepoint fallback's cascade base, which named the primary family's base entry (`Times-Roman`) instead of the cut the run paints in (`Times-Bold`), and `CTFontCreateForString` nominates a different Songti cut from each. 157 → 36 on `serif` at 800 and 900, and the `cursive` stacks went from ~258 to 3 at every weight.

**What the residual 36 is, and why it is not ours.** All 35 of the per-stack remainder are `STSongti-SC-Bold → STSongti-SC-Black` on ideographs that Songti SC Black *does* cover, and asked in isolation Chrome answers **Black** there too — agreeing with us. The oracle's probe page renders one cell per codepoint, and Blink caches per-character fallback for **ideographic** codepoints keyed on (base font, weight, style, orientation, size) (`mac/font_cache_mac.mm:341-358`), returning the cached face for any later ideograph it covers. Measured directly: U+4E9F alone reports `STSongti-SC-Black`, and on a page of ~600 ideographs at the same style it reports `STSongti-SC-Bold`. We do not model that cache, so a real CJK page at weight 800 would still disagree — tracked separately, and a different mechanism from either defect above.

This is the same failure mode doc 107 already records for the Windows weight-400 sample (*"Do not read that 0.488% as a verdict"*), one axis over: **the stack axis needs sampling too, and a corpus harvested from fixtures samples it very unevenly.** 321 of the harvested corpus's 434 stacks are weight 400, 426 of 434 are 100% stretch, and weight 200 does not occur at all.

### The corpus is per-platform, and this was measured rather than assumed

There is one corpus file per platform — `tools/font-conformance-stacks.darwin.json`, `…linux.json`, `…win32.json` — and the sweep refuses a corpus whose recorded `platform` is not the host's unless `--allow-foreign-corpus` says otherwise.

That is not tidiness. A stack corpus records *computed* style, and the computed `font-family` of an element that declares none is **Chrome's per-platform default-font preference**, not a platform-neutral keyword. Extracting the same 1,115 fixtures on macOS and inside the pinned Linux container produces 434 stacks either way, and three of them differ — including the single largest entry in the whole corpus:

| macOS | Linux | fixtures |
| --- | --- | --- |
| `Times` 16/400/normal | `"Times New Roman"` 16/400/normal | 1,114 |
| `Times` 16/400/italic | `"Times New Roman"` 16/400/italic | 1 |
| `Times` 32/700/normal | `"Times New Roman"` 32/700/normal | 1 |

Sweeping the macOS corpus on Linux would therefore ask Chrome-on-Linux about a stack no page on Linux ever computes, for the stack that covers **1,114 of 1,115 fixtures**. It would not have failed; it would have produced a clean-looking number for the wrong question — the same instrument failure that has already cost this area twice (a table sampled from one machine's font inventory, and a Windows probe that recorded the run's primary font rather than the fallback). The guard exists so a future run cannot make that mistake quietly.

#### The corpus is a function of the PLATFORM, not of the machine — measured

This matters because re-extracting all three corpora otherwise requires three CI runs for every change to the extraction key, and because the reflex elsewhere in this document is to distrust anything measured on a developer machine. Here that reflex is wrong, and the difference is worth being precise about: a *conformance number* depends on the host's installed fonts, but a *corpus entry* is computed style — the declared family list verbatim, or Chrome's per-platform default preference where nothing is declared. Neither reads the font inventory.

Re-extracting the same 1,115 fixtures off-CI and diffing against the committed corpora, which were extracted on the CI runners:

| corpus | re-extracted on | entries only in the CI corpus | entries only in the local one |
| --- | --- | ---: | ---: |
| `linux` | the pinned `playwright:v1.59.1-noble` container, locally under Docker | 0 | 0 |
| `win32` | a local Windows 11 ARM64 VM (a *different* OS edition and arch from the `win25-vs2026-x64` runner) | 0 | 0 |

Compared on the stack key excluding the newly added property, so the comparison measures machine drift and not the change under test. Both reproduce their CI-extracted corpus exactly — including the Windows one, across a Windows 11 / Windows Server 2025 and ARM64 / x64 boundary.

So `--extract-stacks` can be re-run off-CI when the extraction key changes. **Re-seeding a baseline cannot**, and the two must not be confused: a baseline records the mismatch counts, the runner image and the font-inventory digest, all three of which are machine-dependent, so a locally produced baseline is one the comparator will correctly refuse to compare against a CI run.

To re-extract off-CI, place the two fixture trees where the corpus's recorded relative `sources` resolve (`external/html-test` and `../html-test/unicode`) and run `--extract-stacks` from that directory; the recorded `sources` and per-entry `example` labels must come out relative, since the corpus is committed and an absolute path pins one checkout's layout (`tests/font-conformance.test.ts` asserts this).

## How the probe page is built

Correctness constraints, all of which cost throughput and all of which are load-bearing:

- **One cell per codepoint**, each an `inline-block`. An inline-block establishes its own block formatting context, so shaping cannot cross the boundary — a combining mark in one cell can neither attach to nor change the font selected for its neighbor. (Block-level cells isolate equally well but lay out several times slower.)
- **`white-space: pre` on the cell.** Without it a cell holding U+0020 collapses to nothing, Chrome paints no glyph, and the oracle reports a mismatch that exists only because of how the probe page was written.
- **Batched, pipelined CDP.** Each page holds `--batch` cells; all node ids come back from one `DOM.querySelectorAll`, and `CSS.getPlatformFontsForNode` is issued `--concurrency`-at-a-time rather than awaited serially.
- **Cell font faces read as Chrome reports them, not as Chrome ranks them.** Blink accumulates platform-font usage into a hash map before serializing it, so the protocol array's order is not a documented ranking; the oracle takes the entry with the highest glyph count. A one-codepoint cell normally has exactly one entry, and the full list is preserved in `chromeAllFaces` when it does not.
- **On macOS, the sweep is ONE document scope on both sides.** Chrome-on-macOS caches ideograph fallback per (base font, weight, style, size) on the renderer's `FontCache` — first ideograph under a key wins, later covered ideographs reuse its face without re-asking CoreText — and the oracle's single probe page (one renderer, surviving every `setContent`) carries that cache across all batches and stacks. So the Domotion side opens one matching `beginCharacterFallbackDocument()` scope spanning the whole sweep, and both sides ask in the identical (stack, ascending-codepoint) order; the periodic memory reset (`--reset-every`) deliberately does NOT clear it, because Chrome's is not cleared either. Do NOT "fix" an ideograph mismatch by probing the codepoint in isolation — a solo page answers a genuinely different question than a page full of ideographs, in Chrome itself (see doc 80 and `docs/font-resolution-diagram.md` § 8b).

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

- **Variable faces instanced outside the macOS helper path cannot be adjudicated by name.** A variable file instanced through fontkit keeps the base master's PostScript name (`/System/Library/Fonts/SFNS.ttf` reports `.SFNS-Regular` at every weight) while Chrome names the optical/weight cut it selected, and a webfont's axis location is likewise invisible in its name. Those land in `agree-alias` or `same-family-different-cut`; the oracle can prove the FILE and the axis request but not the name. **That remainder is structural and stays** — the name-independent check lives in the sibling shaping oracle ([doc 108](108-shaping-conformance-oracle.md)), which compares painted glyph positions and so discriminates two instances of one name where this tool cannot. That sentence used to be an argument; it is now [measured](#the-variable-axis-blind-spot-measured-rather-than-asserted).

  The slice of this that used to dominate the macOS report is **closed, by naming rather than by allowlisting**: when Blink clones a CoreText fallback face at a non-default axis location (its rule — `opsz` = the CSS specified size, gated per axis on the clamped target differing from the substituted handle's CURRENT position: `VariableAxisChangeEffective`, `mac/font_platform_data_mac.mm:60-102` + `:167-195`, Chromium `7d859f27`), Chrome reports the clone's instantiated PostScript name with the coordinates baked in as hex 16.16 fixed point (`.SFDevanagari-Regular_opsz110000_wght` — 0x110000 / 65536 = opsz 17). The renderer now mirrors both halves for live-resolver faces: the macOS glyph helper reports the substituted handle's variation axes and current position with each fallback answer (CoreText PRE-SETS `opsz` on some handles — `.SFArabic-Regular` arrives from a 13 px cascade already at opsz 17, so Blink never clones it and Chrome keeps the base name, while `.SFDevanagari-Regular` arrives unset and clones), and `darwinCloneInstanceName` in `src/render/font-resolution.ts` runs Blink's gate against that state, then composes CoreText's name (per-axis `_tag` suffix in the face's axis order, hex when off the axis DEFAULT, bare tag at default; the member base name for a named-instance face; a location landing exactly on a named instance takes that instance's name — every form measured against CoreText and confirmed against a route name Chrome actually reported). The result is stamped as `FontInstance.instantiatedPostscriptName` and `faceFor` prefers it, so those rows are adjudicated at the strongest tier — and a genuine axis divergence between the two sides still surfaces, because the two names are composed independently from each side's own coordinates. This removed the ~30 `_opsz…`/`_wght…` routes (~2,400 rows) that the live CoreText resolver's arrival had surfaced on the macOS baseline; the gate's handle-relativity is load-bearing, since a file-default gate measurably manufactured ~3,700 inverse routes (us naming instances Chrome never clones) on a dev-Mac sweep.
- **`font-feature-settings` is extracted and declared, but this oracle deliberately does not adjudicate it** — it is not a face-selection input in Blink, and the shaping consequence belongs to [doc 108](108-shaping-conformance-oracle.md). See [the section below](#font-feature-settings--extracted-because-the-probe-page-needs-it-not-because-this-oracle-can-judge-it) for the citation and the measurement.
- **`font-variant-alternates` is extracted and declared, and — measured — behaves like `font-feature-settings` rather than like a face selector.** It is hashed into `FontDescription::CacheKey` directly (`platform/fonts/font_description.cc:331`, and it really does discriminate: `FontCacheKey::GetHash` index 9 plus `operator==`, `font_cache_key.h:104` and `:126-127`), so two descriptions differing in it resolve to different font *data*. What differs between those objects is the resolved FEATURE list, not the face file: `FontDescription::ResolveFontFeatures` merges `alternates->GetResolvedFontFeatures()` ahead of the `@font-face` descriptor's settings (`font_description.cc:559-578`), and `FontFallbackList::ComputeFontFeatures` says so outright — "Features for `font-variant-alternates` is set in `GetFontData`" (`font_fallback_list.cc:238-239`). Measured on macOS across `system-ui` / Georgia / Times: the reported face does not move. So it is recorded for probe-page fidelity and its consequence belongs to [doc 108](108-shaping-conformance-oracle.md).

  A named alternate carries a **partial-fidelity caveat**: `stylistic()`, `styleset()`, `swash()`, `character-variant()`, `annotation()` and `ornaments()` only resolve against an `@font-feature-values` rule, which the corpus does not harvest and the probe page therefore does not carry. Those values round-trip as computed values and activate no feature on the probe page. `historical-forms` needs no at-rule and is fully faithful.
- **`font-variant-emoji` is extracted and declared, and it genuinely does select a face.** It is the one late addition to the stack key that this oracle can adjudicate in the ordinary sense. Blink packs `variant_emoji_` into the cache key's options word (`font_description.cc:312`) and applies it via `ApplyFontVariantEmojiOnFallbackPriority` (`platform/fonts/shaping/harfbuzz_shaper.cc:184-198`), which overrides the run's `FontFallbackPriority` to `kEmojiEmoji` or `kText` before the fallback iterator is built (`:983-984`) — i.e. it steers the color-emoji-versus-text choice directly. Measured on macOS:

  | codepoint | `normal` | override |
  | --- | --- | --- |
  | U+2764 | `ZapfDingbatsITC` | `AppleColorEmoji` (`emoji`) |
  | U+263A | `Helvetica` | `AppleColorEmoji` (`emoji`) |
  | U+1F600 | `AppleColorEmoji` | `.AppleColorEmojiUI` (`text`) |

  **No fixture in either corpus declares it today**, so the column is `normal` throughout and it currently moves no answer. It is recorded so that a fixture which starts using it is swept under the question it actually asks. Because the corpus cannot supply the usual "at least one non-normal value exists" anti-vacuity guard for this property, the check that the extractor reads it from the right place lives in a browser-backed test that supplies its own fixture (`tests/font-conformance-extraction.e2e.test.ts`).

  **The renderer does not yet honor it.** `isEmojiPresentationCp` (`src/render/font-resolution.ts`) derives presentation from the codepoint's Unicode properties alone and has no path for the CSS override, so a page using `font-variant-emoji` would render with the presentation the codepoint defaults to. That gap is tracked separately.
- **`font-palette` is deliberately NOT extracted, though it is in the same cache key.** It is passed to `FontCacheKey` alongside the other two (`font_description.cc:330`) and hashes/compares like them, so it is a legitimate candidate. It is excluded because neither oracle can see its effect: it selects a color palette *within* a face, so — measured on macOS — it moves neither the reported face nor the painted width, and the shaping oracle compares glyph counts and positions rather than color. Adding it would grow the corpus identity and force a baseline re-seed in exchange for a column that cannot change a verdict.
- **One face per cell.** When a codepoint decomposes across two faces the oracle compares the one with the most glyphs; the full list survives in `chromeAllFaces`.
- **Synthetic vs real cuts are compared by face, not by synthesis.** If Chrome synthesizes bold from a regular face it reports the regular face, so our picking a real bold sibling shows up — correctly — as a mismatch. That is the intended reading, but it means a `same-family-different-cut` row can mean either "we took the wrong cut" or "Chrome faked one".
- **On Linux the `agree-same-file` tier can never fire.** That tier resolves Chrome's reported PostScript name to a file through `resolveInstalledFont`, and the Linux glyph helper implements no `family` query — the function is documented as always returning `null` there. So on Linux every agreement must be proven by name at the strongest tier or it is a mismatch. That makes the Linux number *stricter* than the macOS one in this respect, not weaker, but it is a difference between the platforms' instruments and not only between their fonts.
- **`FACE_ALIASES` is a macOS list.** Its single entry reconciles Chrome's `SF Pro Text` naming with the SFNS file we load. Nothing analogous is claimed for Linux or Windows, so `agree-alias` is structurally zero on those platforms.
- **On Windows, DirectWrite's font SIMULATIONS are invisible to this oracle.** Chrome does not take a simulated face: Skia re-issues the match with the offending style axis reset (`FirstMatchingFontWithoutSimulations`, and the equivalent loop around `MapCharacters`) so Blink receives a clean face and applies its own synthetic bold/oblique. Stripping styling the request forced almost always resolves back to the *same base file*, so the PostScript name and the path coincide on both sides of the difference and every row scores as agreement whether or not the loop is implemented. That is why this divergence was closed by transcription rather than by a score: the oracle cannot see it, and "the sweep agrees" was never evidence about it. Measured on a Win11 host, the loop moves exactly one answer in ~600,000 comparisons (U+2758 at weight 700, `SegoeUI-Light` → `SegoeUI-Semilight`) and zero of 2,268 declared-family rows — a number that would read as "no defect" if the mechanism were the thing being judged instead of the transcription. The face-identity payload the helper reports (`postscriptName` / `familyName` / `path` / `axes`) carries no simulation flag either way, and the renderer's synthetic-bold decision reads `OS/2 fsSelection` out of the returned FILE, which is sim-independent — so no consumer today depends on the flags, and the change is one of parity by construction rather than of observable output. The one place the loop could move a visible answer is a variable face DirectWrite clamps and then simulates, where the reported `axes` pin would differ; no such row appeared on this host's inventory.

### The oracle measures the RESOLVER, not the renderer — and that is where 75% of it sits

The single most important thing to know about this instrument. `ourFaceFor` calls `resolveFontForCodepoint` directly (`tools/font-conformance.ts:523-524`). That function decides *which face covers a codepoint*. It is **not** what the renderer paints with: the emitter in `text-to-path.ts` overrides or bypasses its answer in three places.

| site | what happens to the resolver's answer |
|---|---|
| `clusterRun != null` (`:250`, `:1349`) | **never asked** — `res` is `null` and the cluster run's key is used |
| `emojiToTerminal` (`:256`) | **discarded** for an uncovered emoji, so the raster-overlay path keeps its advance pinning |
| the uncovered terminal (`:288-294`) | **replaced** — paths mode uses the fallback chain's LAST entry, not the primary |

So any defect the emitter introduces after selection is invisible here by construction, and this is not hypothetical: the private-use bug (DM-1905) had the resolver answering `helvetica` / `covered: false` — correct, and what Blink's `kFirstCandidateForNotdefGlyph` produces — while the renderer painted LastResort's box-with-a-`?`, 2253/2048 em against Helvetica's 1298, overhanging the next character. The oracle scored that row **`agree-tofu`**. A fixture caught it; the oracle could not have.

**Now the part that makes this load-bearing rather than a footnote.** `agree-tofu` is defined as *"No font covers the codepoint, so we draw the run primary's `.notdef`"* — a claim about the **emitter**, which the oracle never verifies. On the committed macOS baseline that tier is:

    agree-exact      406,215   23.1%
    agree-alias        1,792    0.1%
    agree-tofu     1,320,164   75.2%
    mismatch          26,625    1.5%

**75.2% of every comparison this instrument makes rests on that unverified claim** — and in `paths` mode the claim is currently false for all of it except private-use and noncharacter codepoints, which are the only ones carved out so far ([doc 106](106-blink-font-parity-inventory.md) §5 item 5; the general terminal still pins the chain tail). Embedded-subset mode does use the primary and matches the tier's description.

Two corrections this forces on numbers quoted elsewhere:

- The recurring "~53% of comparisons are `agree-tofu`" figure predates the current corpus. It is **75.2%** on the committed baseline, so the effective *measured* surface is about a quarter of the headline count, not half.
- That caveat has been read as "legitimate agreement, just a smaller surface". It is stronger than that: `agree-tofu` is exactly the bucket where the resolver has stopped deciding and the emitter takes over, so it is the part of the corpus the oracle is *least* able to speak for, not merely a part it speaks for less precisely.

**Status: closed for the general case, and deliberately NOT closed for emoji.**

The general terminal was the real divergence and it is fixed — the renderer now
paints the primary's `.notdef` for every uncovered codepoint, matching Blink's
`kFirstCandidateForNotdefGlyph` ([doc 106](106-blink-font-parity-inventory.md) §5).
So `agree-tofu`'s description — *"we draw the run primary's `.notdef`"* — is now
a true statement about the renderer rather than an assumption, and the ~75% tier
means what it says.

The one remaining divergence is **uncovered emoji**, where `emojiToTerminal`
routes to the fallback chain's last entry so a captured rasterGlyph PNG overlay
keeps its advance pinning. Mirroring that into the oracle was tried and
**reverted**, because it makes the instrument worse rather than better:

    agree-tofu        882 ->  358   (-524)
    mismatch-we-tofu    0 ->  524   (+524)
    mismatchTotal      15 ->  539

Chrome's side did not move; those 524 rows are the same comparisons reclassified.
And the reclassification is wrong, because **for an uncovered emoji neither side's
reported face is what paints**: ours is a placeholder chosen to pin an advance,
and the actual pixels come from a rasterized PNG overlay, not from a font face at
all. Reporting the placeholder makes the oracle literal about the emitter and
less representative of the paint.

So this is not an unmeasured blind spot — it is an **ill-posed** comparison, and
the honest thing is to say so rather than to score it. A face oracle cannot
adjudicate a raster overlay; that belongs to the shaping/pixel oracle
([doc 108](108-shaping-conformance-oracle.md)) or to a fixture.

The other bypass, `clusterRun` (the resolver is not consulted at all for a
CoreText-shaped cluster run), remains genuinely unmeasured and is the one place
this section still describes a gap rather than a decision.

### `font-stretch` and `font-variation-settings` — closed, and measured (DM-1858)

Both are now part of the stack key, extracted from the computed style and declared on the probe page, and our side honors an author's axis settings through `getFontInstance`. The corpus grew **418 → 434 stacks**, surfacing 8 combinations with non-normal `font-stretch` (the fixtures span 50% → 200%) and 9 with explicit `font-variation-settings`.

Those 17 newly-visible stacks measure **0 mismatches**. That is a real result rather than a vacuous one, and it was checked name-independently rather than trusted:

- Chrome's painted width for `sans-serif` is **identical at every stretch from 50% to 200%** (151.19px, face `Helvetica`). macOS Helvetica has no condensed face and no `wdth` axis, so there is nothing to select and Chrome does not synthesize condensing.
- Chrome's painted width is likewise **unchanged** across `"wght" 100` ↔ `"wght" 900` and `"wdth" 50` ↔ `"wdth" 150` — including on `system-ui`, whose SFNS file *is* variable.

So on this corpus and platform neither axis moves Chrome's output, and agreement is genuine.

**Read that carefully, though: agreement here was genuine but blind.** `font-stretch` reached the *probe page* — so Chrome honored it — and nothing on our side. The 8 harvested stretch stacks could not detect that, because every one of them is a `sans-serif`/`Helvetica` route with no condensed cut to select. It took the synthetic corpus, which asks `fantasy` at 50%, to make the missing parameter visible; see "What it found immediately" above. The corollary that used to sit here — *nothing in the fixture corpus exercises a live variable axis, so the name-blindness is untested rather than passing* — is closed by the next section.

### `font-feature-settings` — extracted because the probe page needs it, not because this oracle can judge it

`font-feature-settings` is now part of the stack key, extracted from the computed style and declared on the probe page. The corpus grew **434 → 442 stacks** on all three platforms, surfacing **9 combinations with a non-normal `font-feature-settings`** (`"dlig"`/`"liga"` on and off, `"zero"`, `"ss01"`, `"ss02"`, `"salt"`, `"tnum"`; all from the `20-deep-font-features` fixture). Adding `font-variant-alternates` and `font-variant-emoji` afterwards took it to **450**, the extra 8 being the alternates values from the `20-deep-font-feature-values` fixture splitting stacks that previously collapsed together.

**This closes a smaller hole than the two properties above it did, and saying which half is closed is the point of this section.** Stretch and variation settings are face-*selection* inputs, so extracting them let our resolver be asked a question it could get wrong. Feature settings are not, and the mechanism is explicit in the source (`external/chromium` at `7d859f27`, 2026-06-27):

- `FontDescription::CacheKey` (`platform/fonts/font_description.cc:308-338`) hashes the creation params, effective size, a packed options word, `size_adjust_`, `variation_settings_`, `font_palette_` and `font_variant_alternates_`. **`feature_settings_` is not among them**, so two font descriptions differing only in their features share one cache key and therefore resolve to the same font data.
- The only reader of `FontDescription::FeatureSettings()` in the tree is `FontFeatureRange::FromFontDescription` (`platform/fonts/shaping/font_features.cc:33`, with the `font-feature-settings` loop at `:203-225`), which appends each setting to the HarfBuzz feature array verbatim — its own TODO at `:205-206` notes that no resolution against the already-pushed `font-variant-*` features happens. Features act at **shaping** time, on which glyphs come out of a face — not on which face is chosen. (Earlier revisions of this doc cited a `FontFeatures::Initialize`; no such symbol exists at checkout `7d859f27`.)

Measured, rather than transcribed and assumed. Asking Chrome by CDP for both the reported face and the painted width of `Waffle 1/2 fi 0123` at 32 px, across 6 families × 8 feature settings:

| | result |
| --- | --- |
| reported face moved with features | **0 of 42** combinations |
| painted width moved with features | **11 of 42** combinations |

`system-ui` is the sharpest case: the face is `.SFNS-Regular` under every setting, while the paint moves from 240.67 px to 189.92 px under `"frac" 1` (−21%), 260.47 px under `"smcp" 1`, and 254.11 px under `"tnum" 1`. `"liga" 0, "dlig" 0` moves Times and Helvetica by a few tenths of a pixel with the face unchanged.

So there is deliberately **no resolver-side hook for it**, because there is nothing on our side for it to change — `getFontInstance` takes an axis map because axes select a face, and an equivalent "features" parameter would be a parameter that could not affect the return value. Adding one to look symmetric with `font-variation-settings` would be an approximation dressed as parity.

What the extraction buys is therefore precise, and worth stating so a later reader does not mistake it for more:

1. **The probe page now renders what the fixture renders.** Before this, a fixture declaring `"tnum"` or `"salt"` was asked about with features off, so Chrome shaped a different glyph run than the page under test. The reported face happened to be the same — but that is a fact about Blink that we now cite, not something the old page's silence established.
2. **The corpus carries the property forward.** The shaping oracle ([doc 108](108-shaping-conformance-oracle.md)) is where a feature-driven glyph substitution can actually be adjudicated, since it compares painted glyph positions rather than face names. Its run corpus (`tools/shaping-conformance-runs.json`) is extracted separately and does **not** yet record feature settings; that gap is real and belongs to doc 108, not here.
3. **The stack label only grows when the value is non-normal**, so all pre-existing `byStack` baseline keys are unchanged and a baseline's per-stack rows stay readable across this change. Only the corpus's `generatedAt` moved.

### The variable-axis blind spot, measured rather than asserted

`tests/fixtures/variable-axis/variable-axis.html` is the fixture the paragraph above asked for: one `@font-face` (a 27 KB hb-subset of variable Open Sans, `fvar`/`gvar` intact, SIL OFL — rebuild with `tools/build-variable-axis-fixture.mjs`), painting the same word at three `font-variation-settings` locations. `tools/variable-axis-oracle-pair.ts` drives it and runs **both oracles' shipped comparison functions** — `identifyFace` from this tool, `compareShaping` from [doc 108](108-shaping-conformance-oracle.md) — over every (Chrome instance × our instance) pair. Our side is the real renderer: the fixture's own font bytes, registered as a webfont, through `renderTextAsPath` at the axis location under test.

First, the axis is genuinely live, which is why a webfont was needed at all:

| instance | Chrome's painted width | Chrome's reported face | our reported face |
| --- | ---: | --- | --- |
| default | 388.48 px | `OpenSans-Regular` | `OpenSans-Regular` |
| `"wght" 800` | 433.39 px | `OpenSansRoman-ExtraBold` | `OpenSans-Regular` |
| `"wdth" 75` | 284.05 px | `OpenSansRoman-CondensedRegular` | `OpenSans-Regular` |

Then the pairing, 9 rows, `max pos delta` from `compareShaping`:

| Chrome | ours | face oracle | shaping oracle | max delta |
| --- | --- | --- | --- | ---: |
| default | default | `agree-exact` | `agree-exact` | 0.01 px |
| default | `wght 800` | `agree-exact` | `agree-count` | 39.56 px |
| default | `wdth 75` | `agree-exact` | `agree-count` | 97.83 px |
| `wght 800` | default | `mismatch` | `agree-count` | 39.56 px |
| `wght 800` | `wght 800` | `mismatch` | `agree-exact` | 0.01 px |
| `wght 800` | `wdth 75` | `mismatch` | `agree-count` | 137.39 px |
| `wdth 75` | default | `mismatch` | `agree-count` | 97.83 px |
| `wdth 75` | `wght 800` | `mismatch` | `agree-count` | 137.39 px |
| `wdth 75` | `wdth 75` | `mismatch` | `agree-exact` | 0.01 px |

**Read the face-oracle column vertically, in groups of three.** Within each group the only thing changing is *our* axis, and the verdict never moves. That is the sharp form of the blindness: the face oracle's answer is a function of Chrome's instance alone and carries **zero information** about whether we honored the author's axis.

And it is blind in *both* directions, which is worse than "lenient" and was not what this document previously implied. Chrome names the named instance it snapped to; our side reports the base master at every location. So the instrument scores an **incorrect** heavy render against Chrome's default as `agree-exact`, and a **correct** heavy render as `mismatch`. Neither is a true statement about our axis handling.

The shaping oracle discriminates exactly: `agree-exact` at 0.01 px if and only if the axes match, `agree-count` at 39–137 px otherwise. For scale, the largest position delta in doc 108's entire macOS baseline is 5.64 px.

Two things this does *not* claim. It is one webfont on one platform, not a sweep — the oracles' corpora still contain no live variable axis, and this fixture is not in either of them. And the 0.01 px on the matching rows is a positive control for our renderer honoring `font-variation-settings` through the webfont path; it says nothing about the system-font paths, where the axes measurably do not move Chrome at all.

Pinned by `tests/variable-axis-fixture.test.ts` (no browser: the subset is still variable, our reported name is constant across axes, our geometry is not) and `tests/variable-axis-oracle-pair.e2e.test.ts` (the live table above).

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

### Verifying the instrument on a new platform

A conformance number is worth exactly as much as the confidence that the sweep exercised the code path it claims to. That confidence is cheap to buy and has twice been skipped at high cost, so it is written down as a procedure rather than left to judgement.

**The A/B: turn the live resolver off and require the number to move.** If disabling the platform's native fallback path leaves the answer unchanged, the sweep was not measuring that path — it was measuring whatever intercepted ahead of it, and a "clean" result says nothing about the resolver.

```sh
# macOS / Windows — the native helper is the live CoreText / DirectWrite path
npx tsx tools/font-conformance.ts --max-stacks 1 --shard 1/50 --out /tmp/on
DOMOTION_DISABLE_HELPER=1 npx tsx tools/font-conformance.ts --max-stacks 1 --shard 1/50 --out /tmp/off
# Linux — fontconfig, gated separately
DOMOTION_SYSTEM_FALLBACK=0 npx tsx tools/font-conformance.ts --max-stacks 1 --shard 1/50 --out /tmp/off
```

**The sibling switch, for the TRANSPORT rather than the answer.** `DOMOTION_HELPER_NO_SERVE=1` keeps the helper and its answers exactly as they are and forces the one-shot `spawnSync` path instead of the persistent channel. Use it when a *throughput* number is in question — `DOMOTION_DISABLE_HELPER` is not a substitute there, because it changes the answers and so compares two different resolvers rather than two transports.

```sh
npx tsx tools/font-conformance.ts --max-stacks 1 --shard 1/40 --out /tmp/on
DOMOTION_HELPER_NO_SERVE=1 npx tsx tools/font-conformance.ts --max-stacks 1 --shard 1/40 --out /tmp/off
```

Measured on macOS over 7,312 codepoints, reports byte-identical:

| | ours | per codepoint | throughput |
| --- | ---: | ---: | ---: |
| channel on | 4.5 s | 0.615 ms | 1,032/s |
| channel off | 179.0 s | 24.480 ms | 40/s |

That 24 ms is one process spawn per codepoint, and 40/s is within noise of the 47/s a Windows sweep measured on a Parallels VM where the same code on a GitHub Windows runner measures 636–695/s — which is what makes a degraded channel the leading explanation for the VM's number rather than a property of the platform.

Run on all three, each on one stack:

| Platform | live resolver on | off | reading |
| --- | ---: | ---: | --- |
| macOS (U+4E00–4FFF + U+0600–06FF + U+0900–097F, 896 comparisons) | 129 mismatches | 645 | CoreText path is in the loop |
| Linux (stride 1/50 of the universe, 5,946 comparisons) | 294 / 9 routes | 123 / **18** routes | fontconfig path is in the loop |
| Windows (stride 1/50, 5,946 comparisons) | 29 / 5 routes | 56 / **15** routes | DirectWrite path is in the loop |

Two of those move in a direction worth pausing on: **turning the resolver OFF lowered Linux's raw mismatch count** (294 → 123) while doubling its distinct routes (9 → 18). Nothing improved — with the resolver off, more codepoints resolve to nothing and land in shared tofu (`agree-tofu` 4,173 → 4,435), which is scored as agreement. It is the same amplification the "read `distinctMismatchPairs` next to `mismatchTotal`" rule exists for, and it is the reason the A/B must be read as *"did the answer move"*, not *"did the number go up"*.

**Sample the whole universe, not a block you chose.** The first Windows attempt at this A/B picked CJK + Arabic + Devanagari + Thai and got *identical* results both ways — 0 mismatches on 983 comparisons with the helper enabled and disabled. That is not evidence the resolver is dead; those blocks are owned outright by the generated per-block win32 table, which intercepts before the live resolver runs. It is evidence that **a hand-picked range can be blind to the thing being tested**. `--shard i/50` strides the entire assigned universe instead, which cannot be chosen to agree.

**Vary the weight, not only the codepoint.** The same session's Windows stride sample measured 0.488% mismatches and the canonical six-stack slice measured 14.77% — on the same platform, days apart in nothing but the stacks swept. The sample used one weight-400 stack, and the defect it missed lives entirely at weight 700, where a family's cut stops being its base entry. A codepoint stride does not help with that: **the stack axis needs sampling too, and it needs to include a bold one.** This is why the canonical slice is defined by corpus stacks rather than by a codepoint range.

**Check that fallback appears at all.** The report's `chromeFaces` list names every face Chrome used. If it contains only the stack's primary, no fallback was exercised and a 0% mismatch rate is vacuous. The Windows probe above listed `MicrosoftYaHei`, `NirmalaUI` and `Tahoma` alongside `TimesNewRomanPSMT`, so fallback was real even though the A/B was inconclusive.

**Check that the corpus is the host's.** `summary.txt` prints the corpus file and the platform it was extracted on; the sweep refuses a foreign one, but the line is there so the check is visible rather than trusted.

### The gate is regression-relative, and can refuse to judge

Two behaviors, both of which exist because the alternative is a confident number about nothing:

**Baseline-relative, not absolute zero.** macOS does not measure zero after years of work; Linux and Windows had never been measured at all. A gate demanding zero fails identically on every run and therefore grades nothing. `scripts/diff-font-conformance-baseline.mjs` fails on a *regression* against the platform's own last recorded measurement — a stack whose mismatch count rose, a stack that newly disagrees, or a new disagreeing route. The absolute count is reported and tracked, never enforced. This is the same model as the per-platform visual-fidelity gates (`tests/baselines/README.md`).

**A run can be refused rather than judged.** The oracle's answers are a function of the runner's installed fonts, the host ICU's codepoint universe, and which stacks were swept. If any of those moved, the two numbers are not measuring the same thing, and comparing them anyway yields a confident regression or a confident all-clear, both meaningless. So the baseline records the runner image, the font-inventory digest (`tools/font-inventory.mjs`), the Unicode/ICU versions, the corpus identity, and the slice — and on any difference the comparator withholds the verdict and says which field moved. A runner image rotation is then a visible environment change to re-seed against, not an unexplained score move.

**A missing shard is fatal, not a log line.** `scripts/merge-font-conformance-shards.mjs` counts the reports it merged against the requested shard count and marks the merge incomplete if any is absent; the comparator refuses to judge an incomplete merge. A shard that dies writes no report, and a total summed over the survivors is smaller — which reads exactly like an improvement.

**The ORACLE ITSELF moves, and that is a third failure — the one a mismatch delta cannot express.** A mismatch count is the distance between Chrome's answer and ours, so it rises when *either* side changes, and for most of this oracle's life the report could not say which. Measured cost: two runs of one commit differed by **+108,464** because Chrome flipped `sans-serif` from `Helvetica-Bold` to `Arial-BoldMT`; a third run on the same commit reproduced the baseline to the row. Separately, a 60-row swing on the same instrument was credited to a code fix that had nothing to do with it — Chrome had simply stopped answering `.PingFangHK-Regular` for those codepoints. Both readings were wrong in the same way, and both cost real investigation.

`chromeFaces` tallies only `primaryChromeFace(...)`, so nothing our resolver does contributes to it: **any movement in it is oracle drift by construction.** The baseline therefore records `chromeFaceCounts` alongside the existing sorted name list, and the comparator reports the per-face deltas. When the oracle moved at least as much as the delta being reported, the verdict is **withheld** — you cannot read a signal smaller than the noise beneath it.

**Detecting the drift was not enough to attribute it.** A withheld verdict says the oracle moved; it does not say *which stack* or *on which machine*, and without those a real occurrence is forensically empty. It cost a wrong regression attribution once: two bistable unicode fixtures were pinned on a specific commit by a four-point CI bisect that was really four single samples of this flip.

Three fields close that, all in the report's `meta`:

| field | why |
| --- | --- |
| `stackPrimaries` | The face Chrome resolves each stack's primary to, asked once with `A` before the sweep. **This is the quantity that flips**, and the tally cannot isolate it: unassigned, private-use and noncharacter codepoints terminate on the primary's `.notdef`, so Chrome reports the *primary* for most of the universe. One `sans-serif` stack contributes ~108k identical answers, and one stack flipping is indistinguishable from a broad drift in the tally alone. |
| `host` | Hostname, CPU count, arch. The workflow shards **one stack per shard**, so a stack that flips wholesale flipped on exactly one machine — and its name is the only handle on that machine afterwards. |
| `fontInventory` | The digest, count and source, **per shard rather than per run**. The answers are a function of the host's fonts, and with one stack per shard those hosts are different machines; a run-level digest asserts a uniformity nothing checks. |

The comparator reads them back and names the stack directly — `` `sans-serif@32/700/normal`: `Helvetica-Bold` → `Arial-BoldMT` `` — plus the machine that measured it. A baseline captured before these existed says so rather than staying silent.

None of it can fail a sweep: `fontInventory` swallows its own errors, because diagnostic metadata that breaks the instrument is worse than no metadata.

The name list alone could not have served, and it is worth knowing why: across the two runs above it was **byte-identical** (291 faces both times), because every face involved was already in use on some other stack. Only the distribution moved. That is also why the original decision to store keys rather than counts — on the reasoning that counts "would churn the diff on every run" — turned out to be the wrong trade: measured, only five faces' counts moved between those runs, and every one was the oracle changing its mind.

**Practical rule this establishes: a single conformance run is not evidence.** Repeat a disagreeing run on the same ref before attributing the delta to a commit.

**A run whose shards disagree is also refused, and that is a different failure.** The environment fields above describe *the run* only if every shard measured in the same one — but a shard is a separate CI job on a separate runner, and they are not guaranteed to match. Measured on the sibling visual sweep: two runs of one commit fifteen minutes apart, and in the first, shard 5 of 5 executed on runner image `20260720.0258` (macOS 26.4) while shards 1–4 were on `20260728.0273` (macOS 26.5.2) — `macos-latest` mid-rollout. Chrome's per-codepoint fallback differs between those, which is precisely what this oracle measures.

The merge previously read `meta` from the first non-null report and the image / inventory from the first shard directory that carried the file, on the stated assumption that shards "differ only in WHICH slice they swept". It now checks agreement across every shard (`environmentConflicts`) on platform, arch, node, Unicode, ICU, corpus `generatedAt`, runner image and font-inventory digest, and records any disagreement as `meta.envConflicts`.

Three consequences, and the second is the load-bearing one:

- the merge prints a warning naming the field and the odd shard;
- `comparability()` refuses to judge a run carrying conflicts — checked **before** the field-by-field comparison, because a blended run presents one shard's environment and would otherwise pass every field;
- `--update-baseline` hard-refuses (exit 1, nothing written). Enshrining a blend poisons every later comparison, invisibly.

`icu` is the sharpest field here: it decides which codepoints exist at all, so a split means the merged totals are quoted against two different denominators.

#### `chromium` — the field that was missing, and what it cost

Everything above describes *our* environment. The Chrome side of every comparison comes out of a browser build, and until 2026-08 that build was not recorded anywhere: `image`, `fontInventory`, `unicode` and `icu` could all match while the two runs asked a different Blink.

What that hid: four `font-variant-emoji: emoji` codepoints — U+00A9 © U+2122 ™ U+203C ‼ U+263A ☺ — where Chrome keeps the run on its primary font while an explicit VS16 moves it to the colour emoji face. That read as a **Windows-specific** divergence for a week, and three separate hypotheses were built and refuted against that framing. It is not platform-specific. Measured on one macOS host, platform held constant, only the browser changed:

| Chromium | divergent codepoints |
| --- | --- |
| 147.0.7727.15 | **0 of 13** |
| 148.0.7778.96 | **4 of 13** |
| 149.0.7827.55 | **4 of 13** |

The Windows VM was simply running 148 while the Mac ran 147. Reproduce with `tools/probe-variation-selector-vs-property.mjs` (`CHROMIUM_EXECUTABLE=<path>` pins the build).

So `meta.chromium` is now recorded from `browser.version()`, checked for agreement across a run's shards, and compared against the baseline — a run under a different browser is **refused, not judged**. Two consequences worth carrying:

- **Read the version from the launched browser, never from the Playwright revision directory.** Both hosts above resolved `chromium-1217` and launched builds a milestone apart, which is precisely where the confusion started.
- **Chromium drift is a first-class explanation for a moved conformance number**, alongside a rotated runner image and a changed font inventory. The standing advice to suspect drift when a transcribed constant disagrees with measured paint applies to *behaviour* too, and the local `external/chromium` checkout (rev `7d859f27`, 2026-06-27) can be older than the browser being measured.

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

#### The reset reached only half of it

The paragraph above was true and incomplete, and the gap only surfaced when the sweep was widened from the canonical slice to the whole corpus. `clearFontResolutionCaches()` drops the memos `font-resolution.ts` owns — including `systemFallbackKeyCache`, its per-codepoint one. But the *answers* that memo caches come from `glyph-helper.ts`, which keeps its own per-codepoint map (`_systemFallbackCache` on macOS/Windows, `_fcFallbackCache` on Linux), keyed on `(base face, codepoint, weight, style, size, locale, …)`. Nothing outside the unit tests had ever cleared it, so it retained one entry per codepoint per distinct base for the life of the process.

That is invisible at the canonical slice and fatal beyond it, for a reason worth stating plainly: **the workflow shards one stack per shard**, so the slice puts ~292k entries in each process. A full-corpus run at 20 shards puts 22 stacks in one process — 6.4M entries. Measured on the first attempt (2026-08-04, `max_stacks=450`, `shards=20`, macOS): **four of twenty shards died with `JavaScript heap out of memory`** about two hours in, a fifth died on a `setContent` timeout, and the aggregate correctly withheld its verdict on 15/20 reports.

Two things follow, and the second is the more useful one:

- `clearFontResolutionCaches()` now also clears the helper's per-codepoint memos (`clearGlyphHelperCodepointMemos()`). They are the same class of state as the memo directly above them, and every entry is a pure function of its key. The cost is near zero at the default `--reset-every 1`: within a batch each codepoint is asked once, and across batches the codepoints are disjoint, so nothing that would have hit is being dropped.
- **Resident size could not have caught this, and the sweep now measures the retained quantity directly.** Per-stack peak RSS across a four-stack local run was **821 / 851 / 881 / 873 MB** — flat, on a run whose memo was growing the whole time, because RSS is dominated by transient allocation and swings by hundreds of MB *within* a single stack. Progress lines and the summary now carry `memo=<entries>` / `peak fallback memo`, which is retained state: bounded by the batch when the reset reaches it, and rising monotonically when it does not.

  Measured A/B, same slice (`--max-stacks 1 --shard 1/6`, 48,745 codepoints, batch 8,000), the fix being the only difference:

  | | memo entries per batch | peak |
  | --- | --- | --- |
  | without the helper-memo clear | 3,200 → 9,893 → 17,660 → 20,556 → 20,556 → 20,556 | **20,556, monotone** |
  | with it | 3,200 → 6,693 → 7,767 → 2,896 → 0 → 0 | **7,767, ≤ batch** |

  Answer-neutral, checked rather than asserted: the two runs' report bodies are **identical** — same 48,745 comparisons, same 12,136 exact agreements, same 10 mismatch rows, same four routes.

The `setContent` failure was the same class of problem — a 30-second default treated as a correctness limit on how long Blink may take to lay out 8,000 cells that drag in fonts from all over the host. It now runs on a 120-second budget with exactly one retry, and re-throws on the second failure; a batch is never skipped, because a hole in a sweep that still reports a codepoint count reads as a complete answer.

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

## First per-platform measurement, 2026-07-30

The canonical baseline slice — **the six most-used corpus stacks, full codepoint universe, one stack per shard**. On the current corpus those six cover 1,114 / 818 / 818 / 818 / 448 / 198 fixtures respectively, i.e. essentially the whole fixture set; the stacks are `Times` (`"Times New Roman"` off macOS) 16/400, `Menlo, Consolas, "DejaVu Sans Mono", monospace` 17/400, `system-ui, -apple-system, sans-serif` at 20/700, 13/400 and 13/400-italic, and `sans-serif` 32/700.

### The committed CI baselines

These are the numbers `tests/baselines/font-conformance-<os>.json` records and the gate compares against. Each is a complete six-stack sweep on the platform's own corpus, all six shards merged, `complete: true`.

**They are first baselines, not achievements.** Two of the three platforms had never been measured at all before this run, and none of the three is anywhere near agreement. The value of writing them down is not that they are good — it is that a later change now has something definite to be worse than, and that the numbers immediately named a specific defect nobody knew about.

> **All three are currently awaiting one re-seed, and the comparator will say so rather than judge.** Adding `font-variant-alternates` and `font-variant-emoji` to the extraction key required re-extracting all three corpora, which moved each corpus's identity — a field `comparability()` checks. The three baselines record `harvested:v1:…`; the corpora now carry `harvested:v2:…` (the identity version is bumped whenever the digest's *inputs* change, which is what happened here). Until each platform's baseline is re-seeded from a fresh CI sweep (`.github/workflows/font-conformance.yml`, then `scripts/diff-font-conformance-baseline.mjs --update-baseline`), every run withholds its verdict and names `stack corpus generatedAt` as the field that moved.
>
> The re-seed has to happen on each platform's own runner, and cannot be shortcut locally: a baseline records machine-dependent counts and a font-inventory digest, so a locally-seeded one would be a baseline the comparator then correctly refuses to compare against every CI run — strictly worse than an honest refusal. Re-*extraction* is a different matter and was done off-CI here (macOS natively, Linux in the pinned `mcr.microsoft.com/playwright:v<locked>-noble` container, Windows in a local VM), because a corpus is a deterministic function of the fixtures and the platform's Chrome rather than of the runner.
>
> This is the intended behavior, not a break: the corpus genuinely changed (434 → 442 stacks). It is worth knowing that the change is *smaller* than the refusal implies — the six canonical baseline stacks are untouched and their `byStack` keys are byte-identical, because the stack label only grows when the new property is non-normal. Re-seeding must happen on each platform's own runner; see [the section above](#the-corpus-is-a-function-of-the-platform-not-of-the-machine--measured) for why re-*extraction* may be done off-CI but re-*seeding* may not.

#### The harvested corpus's identity is a digest now, so this is the LAST such re-seed

`generatedAt` used to be a wall-clock ISO timestamp. That withheld the gate on every re-extraction, including one that produced a byte-identical corpus — and it is what turned the change above into three CI sweeps' worth of re-seeding for a corpus whose swept questions had barely moved.

It is now `harvested:v1:<sha256-16>`, mirroring what the synthetic corpus already did. `harvestedCorpusIdentity()` digests **the questions and the platform**, and deliberately excludes two things:

- `fixtures`, how many corpus files use a stack. A new fixture that uses an existing stack asks nothing new.
- `example`, which fixture is cited for reproduction. Pure provenance.

The keys are sorted before digesting, independently of the corpus's own ordering — which is by fixture count, and therefore *does* move when those counts do. Without that sort a single added fixture would permute the array and move the identity for a corpus asking an identical question set, which is the false invalidation this replaces.

The platform is in the digest for a measured reason rather than a defensive one: the Linux and Windows corpora harvest a **byte-identical question set** (both compute `"Times New Roman"` where macOS computes `Times`), so without it they would share an identity. They are not interchangeable — the same question gets a different answer on each. The comparator's runner-image and font-inventory checks do separate them today, but both are skipped when either side omits the field, which an older baseline does; that is exactly the case where the corpus identity would be the only discriminator left. Folding the platform in removes the dependency rather than relying on it.

What still moves the identity, correctly: a stack appearing or disappearing, or any of its seven matched properties changing. Pinned in `tests/harvested-corpus-identity.test.ts` in both directions, including that each committed corpus's stored identity recomputes from its own stacks — which catches a hand-edited or stale-extractor corpus that would otherwise let the comparator compare two different question sets.

| | macOS | Linux | Windows |
| --- | ---: | ---: | ---: |
| runner image | `macos26-arm64` | `playwright-v1.59.1-noble-x64` | `win25-vs2026-x64` |
| installed fonts | 370 files | 29 families (`fc-list`) | 147 files |
| Node / Unicode / ICU | 22.21.0 / 16.0 / 77.1 | 24.14.1 / **17.0** / 78.2 | 22.21.0 / 16.0 / 77.1 |
| codepoints × stacks | 292,466 × 6 | 297,269 × 6 | 292,466 × 6 |
| comparisons | 1,754,796 | 1,783,614 | 1,754,796 |
| **mismatches** | **202,384 (11.53%)** | **89,344 (5.01%)** | **259,152 (14.77%)** |
| distinct routes | 306 | 49 | 126 |
| `agree-exact` | 230,448 | 440,414 | 727,393 |
| `agree-tofu` | 1,320,164 | 1,253,856 | 768,251 |
| `agree-same-file` | 0 | 0 | 0 |
| `agree-alias` | 1,800 | 0 | 0 |
| different-family / other-cut | 202,255 / 129 | 89,341 / 3 | 36,278 / **222,874** |
| Chrome faces seen | 291 | 18 | 64 |

Four things in that table are load-bearing rather than decorative.

**The Linux column counts a different number of codepoints.** Its container ships a newer Node, so ICU 78.2 defines 297,269 assigned codepoints against the other two platforms' 292,466. Comparing 5.01% to 11.53% is comparing two different denominators over two different font sets under two different Blink code paths. The columns sit next to each other for convenience, and that is all.

**`agree-same-file` is zero everywhere, and only one of those zeroes is interesting.** On Linux it is structural — `resolveInstalledFont` has no implementation there, so the tier cannot fire (see the blind-spot list above). On macOS and Windows it is the tier working as intended after being narrowed: it is consulted only when one side is nameless, and in practice both sides name their face.

**`agree-alias` is 1,800 on the macOS runner against 26,724 on a developer Mac.** The runner has no standalone SF Pro fonts, so the naming alias almost never fires. Same code, same corpus, different font inventory, a materially different answer — which is exactly why a baseline records its inventory digest and the comparator refuses to judge across a change in it.

**Windows is the outlier in shape, not just in size.** 259,152 mismatches over only 126 routes, of which **222,874 (86%) are `same-family-different-cut`** — and per stack the two weight-700 entries own 250,222 of the total while every weight-400 stack is nearly clean:

| mismatches | stack |
| ---: | --- |
| 203,764 | `system-ui, -apple-system, sans-serif` @20/**700** |
| 46,458 | `sans-serif` @32/**700** |
| 2,776 | `system-ui, …` @13/400/italic |
| 2,683 | `Menlo, Consolas, …` @17/400 |
| 1,824 | `system-ui, …` @13/400 |
| 1,647 | `"Times New Roman"` @16/400 |

The top routes are all one shape — `SegoeUI-Bold → SegoeUI` (157,780), `MicrosoftYaHei-Bold → MicrosoftYaHei` (56,176), `MalgunGothicBold → MalgunGothic` (23,478). Reading the retained rows rather than the totals settles what it is: at U+0020, U+0021, U+0022 — ordinary ASCII, `ourCovered: true`, so painted glyphs and not tofu — the `system-ui` stack at weight 700 resolves key `sf-pro` to `C:\Windows\Fonts\segoeui.ttf`, the **regular** file, while Chrome paints `SegoeUI-Bold`.

So the first Windows measurement does **not** validate the transcribed per-script fallback table. It does not really exercise the question: the dominant defect is upstream of fallback, in the cut the *primary* family resolves to at weight 700. Whether the table is right remains unmeasured behind it, and will stay that way until this is fixed. That is a much more useful thing to have learned than a number.

macOS, by contrast, is 202,255 different-family and only 129 wrong-cut — its 306 routes are the per-script chain entries that name a family directly (`.PingFangUIDisplaySC-Bold → PingFangSC-Semibold` at 28,893 rows, `.AppleSDGothicNeoI-Regular → AppleSDGothicNeo-Regular` at 22,934), the residue described under "Where that baseline stands now" below.

### Developer-machine measurements (independent of CI)

These were taken on real hardware rather than on a runner, and are quoted separately because their font inventories are much larger than a runner's — the two are not interchangeable and the comparator will refuse to compare them.

**macOS, developer Mac** (`darwin-local-arm64`, Unicode 16.0, 2,635 installed font files, native CoreText helper present). Full canonical slice, 1,754,796 comparisons:

| stack | mismatches of 292,466 |
| --- | ---: |
| `system-ui, -apple-system, sans-serif` @13/400/italic | 51,542 |
| `system-ui, -apple-system, sans-serif` @20/700/normal | 51,347 |
| `system-ui, -apple-system, sans-serif` @13/400/normal | 51,222 |
| `Menlo, Consolas, "DejaVu Sans Mono", monospace` @17/400 | 26,165 |
| `sans-serif` @32/700 | 25,950 |
| `Times` @16/400 | 21,449 |
| **total** | **227,675 (12.97%), 351 distinct routes** |

**Windows 11 desktop, ARM64 VM** (`win32-local-arm64`, Unicode 17.0, 143 installed font files, DirectWrite helper built from this tree). A 1-in-50 stride of the whole universe on the `"Times New Roman"` stack — 5,946 comparisons — measures **29 mismatches (0.488%) across 5 routes**, with 34 distinct Chrome faces exercised.

**Do not read that 0.488% as a verdict on the transcribed Windows per-script stage — the canonical slice on CI says 14.77% for the same platform.** The sample was not wrong; it was blind, and it is worth understanding exactly how, because this is the failure mode this whole document exists to guard against.

The sampled stack is `"Times New Roman"` at **weight 400**, and at weight 400 the cut a family resolves to IS its base entry. The defect the canonical slice found is a *cut-selection* defect that only appears at weight 700 — where the two heavy stacks contribute 250,222 of Windows's 259,152 mismatches and every weight-400 stack is nearly clean. A one-stack, weight-400 sample is structurally incapable of containing the defect, so it returned a beautiful number for a question that could not have failed.

What the sample does establish is narrower and still worth having: fallback was genuinely exercised (34 distinct Chrome faces, including `MicrosoftYaHei`, `NirmalaUI`, `SimSun-ExtB`, `SegoeUIHistoric`), and the live DirectWrite path was in the loop rather than shadowed, because disabling it moved the answer. Both are instrument checks. Neither is a score.

The equivalent Linux figure was not taken on developer hardware — the container sweep is 5–10× slower per codepoint than macOS (every uncovered codepoint costs an `fc-match` subprocess, measured at ~110–200 comparisons/s versus ~1,070/s on macOS) and the CI runners do it in parallel instead.

Both developer numbers differ from their CI counterparts, and neither is "more correct": the developer Mac has 2,635 font files against the runner's 370, and the Windows VM 143 against the runner's 147 — and it is ARM64 desktop Windows 11 rather than x64 Windows Server. The comparator will refuse to compare either pair, by design.

### Throughput, measured, for planning a sweep

| Host | comparisons/s (one process) | one stack, full universe |
| --- | ---: | ---: |
| developer Mac (M-series, CoreText helper) | ~1,070 | ~4.5 min |
| Linux container (`playwright:v1.59.1-noble`, fontconfig) | ~110–200 | ~25–45 min |
| Windows 11 ARM VM (DirectWrite helper) | ~47 | ~105 min |

The Linux and Windows rates are dominated by one subprocess round trip per first-seen codepoint, not by Chrome. That is why the canonical slice is six stacks fanned one-per-shard rather than the whole 442-stack corpus: a full cross product is ~14 h per platform even on the fastest of the three.

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
