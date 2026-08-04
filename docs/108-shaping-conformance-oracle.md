# 108 — Shaping conformance oracle

`tools/shaping-conformance.ts` · `npm run fonts:shaping`

The sibling of the face oracle ([doc 107](107-font-conformance-oracle.md)). That one answers *which font*; this one answers *which glyphs, where*.

## Why it exists

The face oracle is a **face-identity** instrument. It asks "which font did Chrome pick for this codepoint, and did we pick the same" — and nothing else. Everything shaping decides is invisible to it:

- glyph counts (a ligature that forms, or fails to)
- contextual forms and Arabic joining
- Indic reordering and cluster formation
- mark attachment offsets

That gap is not hypothetical. The nukta misplacement fixed in 2026-07 was a real **3px mark offset** that a prior session first dismissed as antialiasing; a face-identity oracle scores it as a clean pass, because the face was right and only the position was wrong.

It also gates the shaping work: replacing fontkit's `layout()` with harfbuzzjs as the single shaper has a strong structural argument (Blink shapes with HarfBuzz everywhere, and `vendor/harfbuzzjs/` is now built with Chromium's own HarfBuzz configuration — same release, same defines, AAT included) and, without this, **no instrument to confirm it**. "Same engine, so it must match" is exactly the kind of claim this project retires.

## What each side is asked

| | source |
| --- | --- |
| **Chrome** | CDP `CSS.getPlatformFontsForNode` → glyph count per face; `Range.getClientRects()` per source character → geometry |
| **Ours** | the `<text x="x0 x1 …">` list `renderTextAsPath` emits — one entry per glyph we actually paint, at the x we paint it |

**Neither side exposes glyph IDs.** There is no glyph-level CDP domain (checked against `Schema.getDomains`), and `getPlatformFontsForNode` carries only `familyName` / `postScriptName` / `isCustomFont` / `glyphCount`. So this compares what both sides *do* expose — which is strictly more than the face oracle, and enough for the classes above: a ligature that fails to form changes the count, and a mark attached wrong changes a position.

Our side is read back off the renderer's **real output** rather than from a fresh shaping call. That is deliberate: the face oracle's own instrument bug was asking a different question than the renderer asks (`resolveFontSpec` vs `getFontInstance`), and reading the emitted markup makes that class of divergence impossible here.

## Tiers

Agreement is tiered, and the tiers are the point — a single pass/fail number would hide both the findings and the blind spots.

| Tier | Meaning |
| --- | --- |
| `agree-exact` | same glyph count, every comparable position within tolerance |
| `agree-count` | same glyph count, comparable positions **differ** — this is the mark-offset tier |
| `agree-count-clustered` | same glyph count, positions **not comparable** (see below) |
| `mismatch-count` | different glyph count — a shaping decision differs |
| `mismatch-unrendered` | we produced nothing for a run Chrome painted |

`agree-count` rows are recorded in full in `report.json`, not merely tallied: it is the tier a 3px mark misplacement lands in, and a tier you can only see the size of is one nobody acts on. The summary also prints the median / p90 / max position delta across it.

### The structural blind spot, stated plainly

Chrome reports one x per **source character**; we report one per **glyph**. Whenever shaping is not 1:1 — any ligature, any Indic or Arabic cluster — the two lists differ in length and **cannot be compared pairwise at all**, even though the counts agree. Those runs get the `agree-count-clustered` tier. Scoring them as position disagreements would invent findings; scoring them as exact would hide that positions went unchecked. This is the same lesson as the face oracle's retired `agree-same-file` tier, which scored different cuts of one `.ttc` as agreement and hid 2,064 real wrong-cut picks.

## Corpus

**Derived, not authored.** `--extract-runs` walks the fixture corpus, and for every text node records `(text, fontFamily, fontSize, fontWeight, fontStyle, fontVariationSettings, fontStretch, fontFeatureSettings)` from the element's **computed** style. A hand-written list of "interesting" strings is precisely the sampled artifact this tool replaces — it would contain only the cases someone already thought of.

Runs are filtered to non-empty, ≤24 characters, and **whitespace-free**. The last is not cosmetic: Chrome's `glyphCount` includes the space glyphs HarfBuzz produced, while our renderer usually emits no position for them (no ink) — but **does** on at least one path (measured: the emoji path emits one entry per character, spaces included). Normalizing by subtracting the whitespace count papers over that with an assumption that is false somewhere, so the corpus excludes the question instead. Nothing is lost for shaping: ligatures, joining, reordering and mark attachment are all *within-word* phenomena, and a space is a word boundary.

A run whose family is defined by an **`@font-face` rule** is dropped as well, and for the same reason rather than a new one. No `@font-face` travels with a run: `chromeShaping` re-declares the run's font *properties* on a synthesized page, so the family name resolves through the stack to whatever the probe page can find, and our side falls through too. The two then agree about a font the fixture never painted — agreement that reads as coverage while measuring nothing. Measured on the corpus's own `20-font-face.html`, whose rules are `src: local(...)` only: the fixture paints `TestSerif` as **Georgia** and `TestMono` as **Menlo**, the probe page paints them as **Times** and **Courier**, and the 32 runs scored 28 `agree-exact` / 4 `agree-count`. Excluding them costs nothing today — the default corpus contained **0** such runs, because all of that fixture's text is multi-word and the whitespace rule had already dropped it — and it keeps the corpus honest the moment either the whitespace split widens or a real webfont fixture lands. Pinned by `tests/shaping-corpus-fontface-exclusion.e2e.test.ts`, which asserts the exclusion **and** a control fixture identical but for the rule, so a extractor that harvested nothing could not pass.

### The variable axis is part of a run's identity

`font-variation-settings` is recorded alongside the other font properties, declared on Chrome's probe page, and parsed into `renderTextAsPath`'s `variationSettings` argument on ours — using the **same** parser the renderer uses on a real capture, so the oracle cannot drift from the shipped parse. One variable face at two axis locations is two different sets of outlines; a corpus that omits the axis sweeps a `wght` 700 run as though it were the face's default instance.

Two measurements shaped this, and the second was the surprise:

- **Most declared axes are inert.** Of the 13 text runs in the fixture corpus rendering under a non-normal axis, 9 resolve to Georgia — not a variable face — and stripping the axis moves nothing. This matches what the face oracle found when stretch and variation settings were added to its stack key: 17 new stacks, 0 mismatches.
- **The movers need no webfont.** The `.var-stack` runs in `20-deep-font-palette.html` declare `font-family: "Inter Variable", system-ui, sans-serif`. "Inter Variable" is not installed, so the stack falls through to `system-ui` — macOS SF, which *is* variable and *does* respond. Stripping the axes moves Chrome's painted width by **76.27px** and **3.56px**.

That second point matters because the expectation going in was that only a webfont could move an axis, which would have made this work depend on webfont support the corpus does not exercise. It does not.

A third obstacle was not anticipated at all: **every one of the 11 axis-declaring text nodes in `external/html-test` contains a space**, so the whitespace filter dropped all of them. Recording the axis alone would have widened the schema and changed nothing — the corpus measured 0 axis-bearing runs. Axis-bearing nodes therefore have their text **split on whitespace** rather than dropped, which preserves the whitespace-free invariant exactly (each word contains no space) and rests on the same word-boundary argument the filter itself does. The split is applied *only* to axis-bearing nodes deliberately: splitting every node grows the corpus 10.95× (2,385 → 26,121 runs), which is a separate question about sweep breadth. The corpus is 2,417 runs, 32 of them axis-bearing.

**The mechanism is confirmed in the loop, not merely enabled.** Per the standing rule that a flag being on is not evidence a mechanism runs, the axis runs were scored twice — once with the axis plumbed through both sides and once with it stripped — and the answer was required to move. It moved on exactly the 12 `system-ui` runs and on none of the 20 Georgia ones, which is the correct partition. Chrome's reported face name is the direct evidence, and it encodes the applied coordinates as **hex 16.16 fixed point**:

| declared | Chrome's face | decoded |
| --- | --- | --- |
| *(none)* | `.SFNS-Regular` | default instance |
| `"opsz" 32, "wdth" 120, "wght" 700` | `.SFNS-Regular_wdth780000_opsz200000_GRAD_wght2BC0000` | wdth 120, opsz 32, wght 700 |
| `"opsz" 14, "wdth" 80, "wght" 300` | `.SFNS-Regular_wdth500000_opsz110000_GRAD_wght12C0000` | wdth 80, opsz **17**, wght 300 |

The last row is worth reading carefully: `opsz110000` is 0x110000/65536 = **17.0**, not decimal 11 — and 17 is not what the page asked for. The requested `opsz 14` was clamped up to the bottom of the face's `[17..28]` optical-size range. Skia does that clamp with `SkTPin<double>(position.coordinates[j].value, minDouble, maxDouble)` in `ctvariation_from_SkFontArguments` (`src/ports/SkTypeface_mac_ct.cpp:1147`, checkout `ebf5052`), independently of Blink's own clamp on the way in. Our positions track Chrome's to within **0.01px** on all four instanced runs, so the renderer resolves to the same clamped instance — a parity claim that was previously unmeasured rather than merely unverified.

## Instrument audit

Three defects were found and fixed in this tool **before any of its numbers were quoted**, which is the discipline doc 107 earned the hard way:

1. **Whitespace counting.** The first run reported 25 mismatches on 200 runs. The glyph-count delta was exactly the space count in 24 of them — the instrument disagreeing with itself. Resolved by excluding whitespace runs from the corpus.
2. **Only the first `<text>` element was read.** A run spanning two fonts emits one element per font, so a mixed-font run looked truncated: on `"FIXED → trapped"` our 5 positions were exactly Chrome's first 5, with the other 8 in the second element. Now every element is summed.
3. **The cluster blind spot was scored as a position disagreement**, inflating the interesting tier with cases it had not actually checked. Now its own tier.

Positive control: the tool reports the glyph counts hand-measured against Chrome for `fi` → 1 (Times ligature), `Á` → 1 (precomposed), `क्षि` (4 chars) → 2, `السلام` (6 chars) → 5. Negative control: earlier revisions did report mismatches, so it is not a no-op.

## Baseline (macOS)

Full derived corpus from `external/html-test`:

| | 2026-07-30 | 2026-08-04 | 2026-08-05 |
| --- | ---: | ---: | ---: |
| runs | 2,385 | 2,417 | 2,454 |
| agree exact | 2,023 (84.8%) | 2,387 (98.8%) | 2,424 (98.8%) |
| agree count-only | 348 (14.6%) | 16 (0.7%) | 16 (0.7%) |
| agree clustered | 13 (0.5%) | 13 (0.5%) | 13 (0.5%) |
| MISMATCH count | 1 | 0 | 0 |
| MISMATCH unrendered | 0 | 1 | 1 |
| position deltas across count-only | median 1.20px · p90 2.82px · max 5.64px | median 0.88px · p90 2.57px · max 2.94px | median 0.88px · p90 2.57px · max 2.94px |

The 2026-08-05 column is the committed corpus after the `font-stretch` re-extraction took it from 2,417 to 2,454 runs; the 37 added runs land wholly in `agree-exact` and every other tier is unchanged.

The 348 → 16 collapse is **not** the doing of the axis work in the column beside it; it is the per-script HarfBuzz shaping fixes (Telugu, Hangul, Devanagari, Hebrew, Arabic) that landed in between, which is exactly what this tool was built to grade. Measured as a controlled A/B on one machine at one commit: the 2,385-run corpus scores 2,355 exact / 16 count-only / 13 clustered / 1 unrendered, and adding the 32 axis-bearing runs moves only `agree-exact` (+32) with every other tier byte-identical. The remaining hard mismatch is an emoji run where Chrome produces 1 glyph and we produce 0.

Read the count-only tier first: those runs shape to **visibly different glyph positions** than Chrome, at the same magnitude as the nukta defect that motivated this tool, and every one of them is invisible to the face oracle.

## Covering the face oracle's variable-instance blind spot — measured

Doc 107 has always said that its name-blindness for variable faces is covered here, because one PostScript name spans a variable font's whole design space and only positions can tell two instances apart. That was an argument. Nothing in either corpus drove an axis Chrome honors: macOS Helvetica has no `wdth` axis, so Chrome's painted width for `sans-serif` is identical at every `font-stretch` 50–200% and unchanged across `"wght" 100` ↔ `"wght" 900`.

> **Correction (2026-08).** This paragraph used to extend that claim with "even on `system-ui`, whose SFNS file *is* variable." **That was wrong, and the way it was wrong is worth keeping.** macOS `system-ui` responds to both axes, and strongly:
>
> | `system-ui`, 26px | width | face |
> | --- | ---: | --- |
> | *(default)* | 192.17 | `.SFNS-Regular` |
> | `"wght" 100` | 181.00 | `.SFNS-Regular_wdth_opsz1A0000_GRAD_wght640000` |
> | `"wght" 900` | 223.02 | `.SFNS-Regular_wdth_opsz1A0000_GRAD_wght3840000` |
> | `font-stretch: 50%` | 133.52 | `.SFNS-Regular_wdth320000_opsz1A0000_GRAD_wght` |
> | `font-stretch: 200%` | 272.70 | `.SFNS-Regular_wdth960000_opsz1A0000_GRAD_wght` |
>
> The original probe almost certainly wrote `font-variation-settings:"wght" 100` straight into an inline `style` attribute. The `"` **terminates the attribute**, so the property never reaches the page — the element renders at the default instance and the probe reports "no response" for every axis value. The same bug was reproduced while writing this section: an unescaped probe said all ten `system-ui` axis cases were inert, and escaping the quotes to `&quot;` moved every one of them. A negative result from a probe is only as good as the proof that the input arrived.
>
> `sans-serif` → Helvetica remains genuinely inert, which is what made the wrong half plausible.

Decoding those names confirms two mechanisms the corpus now depends on. `wght640000` is 0x640000/65536 = **100.0** and `wght3840000` = **900.0**, so both extremes were applied rather than clamped together. `opsz1A0000` = **26.0** — exactly the CSS font size, which is Blink setting `opsz` from the specified size under the default `font-optical-sizing: auto`. And `font-stretch: 200%` lands at `wdth960000` = **150.0**, not 200: the request is clamped to the top of SF's `wdth` range by the same `SkTPin` in `ctvariation_from_SkFontArguments` (`src/ports/SkTypeface_mac_ct.cpp:1147`, checkout `ebf5052`) that clamps `opsz` up from 14 to 17 above.

`tests/fixtures/variable-axis/variable-axis.html` (a subset of variable Open Sans as a webfont, `fvar`/`gvar` intact) supplies the missing case, and `tools/variable-axis-oracle-pair.ts` runs **this tool's own `compareShaping`** and the face oracle's own `identifyFace` over every pair of instances. The full table is in [doc 107](107-font-conformance-oracle.md#the-variable-axis-blind-spot-measured-rather-than-asserted); the part that concerns this tool:

| our instance vs Chrome's | `compareShaping` | max position delta |
| --- | --- | ---: |
| same | `agree-exact` | 0.01 px |
| `wght 800` vs default | `agree-count` | 39.56 px |
| `wdth 75` vs default | `agree-count` | 97.83 px |
| `wdth 75` vs `wght 800` | `agree-count` | 137.39 px |

Two things worth carrying away. The discrimination is not marginal — 0.01 px against 39–137 px, where this tool's whole macOS baseline tops out at 5.64 px — so it is not a threshold-tuning result. And it lands in `agree-count`, the tier this document already argues is the interesting one: same glyph count, positions differ. A wrong variable instance is a *geometry* defect with no shaping decision behind it, which is precisely the shape `agree-count` exists to name.

The corollary for `agree-count` reading generally: a row in that tier can mean a mark attached 3 px wrong **or** the right glyphs painted from the wrong point in a design space. Both are real; they want different fixes.

Pinned by `tests/variable-axis-oracle-pair.e2e.test.ts`.

## Known gaps

- **Glyph IDs are not compared** — neither side exposes them. A run could agree on count and position while painting the wrong glyph. Closing this needs a signal Chrome does not currently offer.
- **Advances are compared only via positions.** A per-glyph advance is inferred from adjacent positions, so the final glyph's advance is unchecked.
- **macOS only**, like the face oracle. Shaping is HarfBuzz on every platform so the results should travel better than face selection does, but that is an expectation, not a measurement.
- Corpus is `external/html-test` only; the unicode fixture set is not yet swept. Deliberately: a re-extraction including `../html-test/unicode` yields **312,822 runs** against the current 2,454, which is a change to the tool's runtime character rather than a coverage tweak, so it is left as its own decision.
- **`font-stretch` is now in the committed corpus.** The field had been modelled by the schema, extractor, probe page and our-side call for a while, but `tools/shaping-conformance-runs.json` predated it and so carried no stretch at all. Re-extraction picked it up: the corpus is now **2,454 runs, 8 of them carrying a non-`100%` stretch** (and 32 axis-bearing, unchanged).
- **Webfont runs still cannot be swept**, and the corpus contains none to sweep. `chromeShaping` synthesizes its probe page with `setContent` and no `@font-face`, and our side has no webfont registered because there is no capture step. Rather than sweep them wrongly the extractor now **excludes** `@font-face`-resolved families outright (see [Corpus](#corpus)). `tests/fixtures/variable-axis/variable-axis.html` is driven by `tools/variable-axis-oracle-pair.ts` instead. Re-measured against the corpus as it stands — see [Webfont sweeping](#webfont-sweeping--measured-and-declined) below: **0** of 8,880 text-bearing elements across all 296 fixtures render in a custom face, so building the plumbing would add coverage for zero runs.
- **Only axis- and feature-bearing text nodes are split on whitespace.** Every other node must be whitespace-free as a whole or it is dropped, so multi-word runs are unswept. Splitting universally grows the corpus 10.65× — **measured, and declined**; see [Universal whitespace splitting](#universal-whitespace-splitting--measured-and-declined) below. The `--split-words` switch keeps the measurement reproducible.
- **Feature DISABLES on webfont-buffer runs remain unexpressed.** The HarfBuzz reroute (`fontFeatureValueShapingOverride`) needs an on-disk file to open; a webfont held only as a buffer keeps its previous shaping, so a `"liga" 0` on a webfont run is still dropped there. Coupled to the webfont-sweep gap above.

## Universal whitespace splitting — measured, and declined

The corpus splits only axis- and feature-bearing nodes on whitespace; every other node must be whitespace-free *as a whole* or it is dropped. `--split-words` widens the split to every node, and exists so this decision is reproducible rather than a number in a changelog.

Measured on macOS against `external/html-test`, both corpora swept at the same commit on the same machine:

| | default | `--split-words` |
| --- | ---: | ---: |
| runs | 2,454 | 26,140 (**10.65×**) |
| sweep wall | 7.3 s | 55.8 s |
| agree exact | 2,424 | 25,453 |
| agree count-only | 16 | 158 |
| agree clustered | 13 | 522 |
| MISMATCH count | 0 | 6 |
| MISMATCH unrendered | 1 | 1 |
| distinct disagreeing routes | 1 | 6 |

Two controls first, because the comparison is worthless without them. The split corpus is a **strict superset** — all 2,454 default runs are present — and every one of them received an **identical verdict** on both sweeps (0 changes). So the instrument is deterministic across the two runs and the added runs are genuinely added, not a reshuffle.

**The new runs concentrate overwhelmingly in `agree-exact`: 23,029 of 23,686, or 97.23%.** The rest:

- **142 new `agree-count`** rows — median **0.59 px**, p90 **1.17 px**, max **4.00 px**. That distribution is *tighter* than the tier the default corpus already reports (median 0.88, p90 2.57, max 2.94), and the nine rows above 2 px are all emoji-adjacent mixed runs (`Times-Roman×n + AppleColorEmoji×1`) — the class the corpus's one pre-existing hard mismatch already names. No new defect class appears.
- **509 new `agree-count-clustered`** rows, whose positions are unchecked by construction.
- **6 new `mismatch-count`** rows across 5 routes the default corpus never sees — and **all six are instrument artifacts, not shaping defects.**

That last point is the finding, and it is what settles the question. The six are `de{U+00AD}spite`, `hand{U+00AD}ling`, `prov{U+00AD}a{U+00AD}tion`, `situa{U+00AD}tion`, `{U+202E}ABCDEFG{U+202C}` and `{U+202D}ABCDEFG{U+202C}` — every one a **Unicode default-ignorable** that Chrome counts a glyph for and we correctly paint nothing for. HarfBuzz retains rather than deletes them: unless `HB_BUFFER_FLAG_REMOVE_DEFAULT_IGNORABLES` is set, `hb_ot_hide_default_ignorables` *replaces* each with a **zero-advance invisible glyph** (`hb-ot-shape.cc:824-847`, checkout `4de187d`), and Blink never calls `hb_buffer_set_flags` at all, so the default applies. Confirmed by probe rather than by reading alone:

| run | Chrome glyphs | ink width |
| --- | ---: | ---: |
| `despite` | 7 | 45.16 |
| `de{U+00AD}spite` | 8 | **45.16** |
| `ABCDEFG` | 7 | 67.69 |
| `{U+202E}ABCDEFG{U+202C}` | 9 | **67.69** |

The extra glyphs sit at width 0 on the same x as their neighbor, and the painted ink is identical. This is precisely the disagreement the whitespace-free rule was invented to exclude — Chrome counts an invisible glyph, we emit no position — leaking back in through a filter whose `/\s/` test does not match default-ignorables. It is **latent, not live**: the default corpus holds exactly one ignorable-bearing run (`☁️`, whose U+FE0F is consumed into the emoji presentation) and that run's `mismatch-unrendered` is a genuine finding, so a blanket ignorable exclusion would *hide* a real result and is deliberately not applied.

**Decision: declined.** A 7.6× longer sweep buys 97.23% restatement, a position tier tighter than the one already reported, and six mismatches that are artifacts of the filter's own known blind spot rather than defects. The switch stays so the measurement can be re-run when the fixture corpus changes character.

## Webfont sweeping — measured, and declined

The other half of the same corpus-breadth question: should the oracle carry `@font-face` into the probe page and register the matching buffer on our side, so webfont runs become sweepable?

Asked of the corpus directly, via Chrome's own `CSS.getPlatformFontsForNode.isCustomFont` on each real fixture page — the only place the answer exists, since the oracle's probe page can never see a webfont:

| | |
| --- | ---: |
| fixtures walked | 296 |
| text-bearing elements probed | 8,880 |
| elements rendering in a **custom** face | **0** |

A zero from a freshly written probe is the shape that hides a dead instrument, so it carries a positive control: the same probe reports **3** custom-font entries on `tests/fixtures/variable-axis/variable-axis.html` (`Open Sans` as `OpenSans-Regular`, `OpenSansRoman-ExtraBold`, `OpenSansRoman-CondensedRegular`). The instrument is live; the zero is real.

The zero is also fully explained rather than merely observed. Exactly one fixture in the corpus declares `@font-face` at all — `20-font-face.html` — and its rules are `src: local(...)` only, no binary download, by its own design ("No binary font download — these `@font-face` rules resolve via `local()` to common system fonts"). Chrome therefore reports `isCustomFont: false`, correctly: the face really is a system face and the rule is only an aliasing layer.

**Decision: declined.** The work the ticket describes — carrying rule text into the probe page (~37 KB of base64 for the one purpose-built fixture) or reworking extraction to navigate fixtures in place and give up the batching that makes the sweep run in seconds — would add coverage for **0** runs in the corpus it sweeps. The one webfont fixture that exists is already driven end-to-end by `tools/variable-axis-oracle-pair.ts` and pinned by `tests/variable-axis-oracle-pair.e2e.test.ts`.

What the measurement *did* justify is the cheap half: the `@font-face`-family **exclusion** described under [Corpus](#corpus). The gap that actually exists in this corpus is not an unsweepable webfont buffer but an `@font-face`-declared family name that fails to survive to the probe page — and the honest response to a question the instrument cannot ask faithfully is to drop the question, not to record a confident wrong answer. This calculus changes the moment a fixture lands that downloads a real font.

## `font-feature-settings` — the property this oracle owns, and a negative result with a control

`font-feature-settings` is the one font property the face oracle deliberately declines to adjudicate: it is absent from `FontDescription::CacheKey`, so it cannot change which face Chrome reports, and its only reader appends it to the HarfBuzz feature array at shaping time (`FontFeatureRange::FromFontDescription`, `platform/fonts/shaping/font_features.cc:33`, the settings loop at `:203-225`, Chromium `7d859f27`). Doc 107 points here for the consequence. Until now the run corpus did not record the property at all, so the one instrument that *can* see a feature-driven substitution had no idea whether a fixture had asked for one — both sides shaped without features and scored agreement that meant nothing.

The property is now extracted, declared on Chrome's probe page, and parsed into `renderTextAsPath`'s `features` argument with the **same** `parseFontFeatureSettings` the renderer uses on a real capture. Feature-bearing nodes get the whitespace split axis-bearing ones already had, for the same reason: the fixtures demonstrate ligatures and numeral styles with multi-word samples, so whole-node filtering would have dropped every one and left the field recorded-but-never-swept.

**Result: 29 feature-bearing runs, 7 distinct feature values, and 0 change in verdict.** Plumbing the features moved our output on 0 of the 29, and both the old and new behavior agree with Chrome on all 29.

That is a negative result, and a negative result from a newly-added mechanism is exactly the shape that hides a dead instrument — so it comes with a control rather than on trust:

- **Our side does respond to features.** `renderTextAsPath` on `Times` and on `Helvetica` with `["smcp"]` produces different `<text>` output than without it. The `features` argument reaches fontkit's `layout()`.
- **Chrome's side does too, and the oracle can see it.** On `system-ui` the verdict moves `agree-exact` → `agree-count` under `"frac" 1`, `"smcp" 1` and `"tnum" 1` — Chrome's painted width for `1/2 3/4` goes 97.86px → 58.66px under `frac`, `hamburgefonstiv` 231.30 → 255.36 under `smcp`, `0123456789` 188.64 → 197.50 under `tnum`.
- **The corpus's own runs land somewhere else.** All 29 resolve to Georgia or Menlo, and those faces do not implement the features the fixtures declare (`liga`/`dlig`, `zero`, `ss01`, `ss02`, `salt`, `tnum`). Chrome's glyph count is unchanged with the features on *and* off, so there is nothing for either side to disagree about.

So the zero is real: the fixtures ask for features from fonts that do not have them. At the time of that measurement the corpus also could not exercise a **known divergence** this instrument exists to grade — `parseFontFeatureSettings` dropped `0`/`off` entries entirely, because fontkit takes an enable-only list and cannot disable a default-on feature. The corpus contained `"dlig" 0, "liga" 0` only on Georgia, whose ligatures do not fire for those samples in Chrome either (`office` and `waffle` are 6 glyphs both ways), so the divergence stayed invisible.

**Both halves are since closed.** The corpus gained an in-repo fixture dir (`tests/fixtures/shaping`, in the extractor's default sources) whose `font-feature-disables.html` disables `liga` on **Times and Helvetica**, faces whose common ligatures do fire (CDP glyphCount for "office waffle affix flight" 24px: Times 22 → 26 under `"liga" 0`). And the renderer now honors the disable: feature-list entries are HarfBuzz feature strings (`liga` / `-liga` / `aalt=2`), and a run whose list carries a disable or an explicit value is shaped by the vendored HarfBuzz with the full list (`fontFeatureValueShapingOverride`), matching Chrome by construction — Blink passes every setting's value to HarfBuzz (`font_features.cc:203-225`, rev `7d859f27`), which honors a zero via the lookup mask (GSUB) or the AAT OFF selector (`hb-aat-map.cc:79`, rev `4de187d`). Measured both ways on the 16-run fixture slice: the pre-fix renderer scores **12 mismatch-count**; the fixed one scores **12 agree-exact** (plus 4 agree-clustered for the normal-ligature control rows, where a formed ligature makes positions per-char-vs-per-glyph incomparable by design).

One reporting wart noticed while measuring, recorded so it is not mistaken for a finding: `ChromeShaping.width` reads `getBoundingClientRect().width` on a block-level `<div>`, so it reports the viewport width rather than the run's. It is carried in the report but not used by `compareShaping`, which compares glyph counts and positions.

## Related

- [107 — font conformance oracle](107-font-conformance-oracle.md) — the face half
- [106 — Blink font parity inventory](106-blink-font-parity-inventory.md) — what Blink runs, per platform
- [font-resolution-diagram.md](font-resolution-diagram.md) — the resolution flow both oracles measure
