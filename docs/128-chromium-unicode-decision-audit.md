---
id: "requirements/chromium-unicode-decision-audit"
title: "128 — Chromium Unicode decision audit"
kind: "evidence"
status: "current"
owners: ["text-fonts","platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2310"]
code: []
aliases: ["docs/128-chromium-unicode-decision-audit.md","doc-128"]
---

# 128 — Chromium Unicode decision audit

Status: **supported-path migration complete; cross-platform logical validation complete**. This document is the source inventory for
the helper-backed fidelity requirement introduced before extracting the font
resolver into a package.

## Requirement

The native glyph helper is required for Chromium-fidelity text rendering.
Domotion remains nonfatal when the helper cannot be acquired, but that mode is
best effort and has no logical- or pixel-parity guarantee.

In the supported path, a Unicode/codepoint/font decision may exist only when it
is one of:

1. a cited transcription of a decision Chromium or its pinned HarfBuzz makes;
2. an answer obtained from the same ICU operation Chromium calls; or
3. an answer obtained from the same platform font API Chromium calls.

Probe-generated `Unicode range -> font` tables are not a Chromium mechanism.
They must not participate in helper-backed macOS or Linux resolution. The
Windows hardcoded nomination stage remains because Blink itself contains that
stage; its script/block inputs must come from ICU rather than Domotion-owned
Unicode ranges.

## Pinned upstreams

- Chromium: `external/chromium` revision
  `7d859f271cbda744098ac69f44978d4edfa62be3`.
- ICU4C: Chromium gitlink `d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738`,
  ICU 78.2. The complete little-endian data image is
  `common/icudtl.dat` (10,876,560 bytes).
- HarfBuzz: `external/harfbuzz` revision
  `4de187d` (the version/configuration mirrored by `vendor/harfbuzzjs`).

The ICU revision follows Chromium, not Node. Node 22.14.0 currently exposes
ICU 76.1 / Unicode 16.0 on the development host and its JavaScript API does not
expose all operations Blink calls.

## Existing decision inventory

| Domotion decision | Current source | Chromium/HarfBuzz source | Classification | Required action |
| --- | --- | --- | --- | --- |
| `isHarfbuzzDefaultIgnorable` | generated ranges decoded from HarfBuzz | `hb-unicode.hh::is_default_ignorable` | Exact HarfBuzz transcription | Keep as generated HarfBuzz data, or ask the pinned HarfBuzz build; do not replace with ICU `Default_Ignorable_Code_Point`, which is a different predicate. |
| `isHarfbuzzSameFontSpaceFallback` | five explicit space ranges | `hb-unicode.hh::space_fallback_type` | Exact HarfBuzz transcription | Keep only while the caller must predict HarfBuzz. Prefer consuming the shaper result directly. |
| `mathAlphaToBase` | handwritten mathematical-alphanumeric mapping | Unicode compatibility mappings plus a renderer fallback workaround | Domotion heuristic | Remove from font resolution. Chromium shapes the original character and walks fallback; compatibility decomposition is valid only where the pinned shaper performs it. |
| `isLegitimatelyInklessCodepoint` | JS Unicode regex plus HarfBuzz table | ICU general category plus HarfBuzz default-ignorable handling | Version-dependent approximation | Replace category tests with pinned ICU `u_charType`; retain HarfBuzz's distinct default-ignorable answer. |
| `isIdeographicCp` | JS `\p{Ideographic}` | `u_hasBinaryProperty(UCHAR_IDEOGRAPHIC)` | Version-dependent approximation | Replace with the pinned ICU binary property. |
| removed `isTrimmableCjkPunct` | no codepoint gate remains | selected-face `halt`/`vhal` shaping result | Exact runtime evidence | Keep activation derived from the shaped glyph/feature result. |
| `isCjkIdeographOrSymbol` | generated `cjk-ideograph-or-symbol-ranges.generated.ts` | Blink base tables + pinned ICU 17 `Emoji_Presentation` + Extended Pictographic RGI ZWJ/modifier members | Complete pinned Chromium transcription | Regenerate with `npm run unicode:cjk-property:generate`; `:check`, exhaustive scalar/digest tests, and mutation controls reject drift. |
| `usesComplexShaperDottedCircle` | hand-maintained script ranges | HarfBuzz shaper selection and its actual shaped output | Predictive heuristic | Remove. Shape the failing cluster through pinned HarfBuzz and observe the inserted dotted-circle glyph/cluster. |
| `usesDedicatedShaper` | hand-maintained script ranges | `hb_ot_shaper_categorize` | Partial HarfBuzz transcription | Replace ranges with ICU script/script-extensions plus the pinned HarfBuzz categorizer, or stop predicting the categorizer by shaping every applicable run with HarfBuzz. |
| `usesHarfbuzzShaping` | selected script ranges discovered by engine disagreement | Chromium always uses HarfBuzz | Domotion routing heuristic | Remove the selection gate; supported rendering should use the Chromium-configured HarfBuzz path consistently. |
| canonical/NFD decomposition helpers | JavaScript `normalize()` and mark regex | pinned HarfBuzz normalization plus ICU normalization/properties | Version-dependent approximation | Prefer the pinned HarfBuzz shaping result. Where decomposition must be queried, use pinned ICU normalization and category data. |
| `isLeftReorderingMatra` | generated HarfBuzz USE-category ranges | HarfBuzz USE shaping output | Exact table used predictively | Remove from emission decisions once dotted-circle fallback consumes actual HarfBuzz positions. |
| `isRtlScriptCodepoint` | hand-maintained ranges transcribed from HarfBuzz | `hb_script_get_horizontal_direction` | Exact but duplicated transcription | Ask the pinned HarfBuzz build, with ICU script as the input where needed. |
| shaping-run primary Script | `unicode-properties` (helper-absent only) / pinned ICU companion | `ScriptRunIterator::ICUScriptData::GetScripts` → `uscript_getScript` | Exact on the supported path | Keep the batched pinned-ICU answer authoritative. A stale primary Script selects a different HarfBuzz complex shaper; do not patch affected codepoints or Unicode blocks. |
| `isStrippableOrphanIgnorable` | HarfBuzz predicate with ZWJ/ZWNJ carve-out | HarfBuzz shaping behavior | Caller-specific heuristic | Replace with the shaped cluster result; never strip a character merely from an independently maintained list. |
| MathML operator properties / vertical stretch routing | generated `mathml-operator-dictionary.ts` | Blink compact operator dictionary + `Character::IsVerticalMathCharacter` | Complete pinned Chromium transcription | Regenerate with `npm run mathml:operator-dictionary:generate`; `:check` and the exhaustive digest reject drift. MathML Core does not dictionary-default legacy `fence`/`separator`, so those metadata fields remain explicitly false. |
| `isCjkIdeographOrSymbol` | copied Blink tables plus JS emoji property | Blink's generated character-property trie | Known incomplete transcription | Generate from Blink's own generator inputs or query an exported Blink-equivalent helper operation; ICU alone is insufficient because Blink adds RGI-sequence members. |
| skip-ink excluded blocks | copied Blink blocks | `Character::CanTextDecorationSkipInk` | Exact Chromium transcription | Keep, but obtain block values through ICU `ublock_getCode` instead of duplicating boundaries. |
| Windows `uscriptGetScript` | handwritten range classifier | ICU `uscript_getScript` | Approximation | Replace with pinned ICU. |
| Windows `ublockGetCode` | handwritten range classifier | ICU `ublock_getCode` | Approximation | Replace with pinned ICU. |
| Windows script/font maps and emoji/math lists | copied Blink tables | `font_fallback_win.cc` | Exact Chromium policy | Keep and drift-test against the pinned Chromium source; feed them ICU answers. |
| macOS/Linux generated font routes | machine-probed Unicode block tables | no corresponding Blink stage | Unsupported-mode compatibility data | Exclude from helper-backed resolution; retain temporarily only as helper-absent best effort. |
| Windows generated font routes | machine-probed Unicode block table | no corresponding Blink stage | Unsupported compatibility data | Exclude from helper-backed resolution after Blink's hardcoded stage and DirectWrite answer are authoritative. |

## Supported-path result

When both native companions validate, every resolved run is shaped through the
pinned HarfBuzz build while glyph outlines remain owned by the selected platform
face. Domotion therefore no longer chooses whether to shape from a script/range
allowlist. HarfBuzz's actual cluster result owns canonical decomposition,
default-ignorable removal, and shaper selection. Explicit dotted-circle
fallback is decided before fallback splitting, while the source-script and
broken-syllable context still exists, and is then shaped by the pinned
HarfBuzz path; it is not selected from a Domotion codepoint list. The
per-codepoint seam retains HarfBuzz's exact generated same-font-space table
because callers without a cluster result must still model that substitution.

The per-codepoint fallback walker now performs literal family coverage and the
cited platform stages only. Mathematical-alphanumeric rewriting, JavaScript NFD
prediction, generated macOS/Linux routes, and the generated Windows DirectWrite
snapshot are helper-absent compatibility behavior. Windows retains Blink's own
hardcoded nomination table, fed by pinned ICU properties, before live
DirectWrite. Skip-ink block decisions and emoji-presentation classification use
pinned ICU; CJK trimming asks the selected face's real `halt` feature before any
degraded geometry fallback.

The legacy predicates and generated inventories intentionally remain in source
so helper absence is nonfatal. Their presence is not a claim of Chromium parity:
the helper acquisition path warns loudly and that mode is explicitly best
effort.

Run itemization consumes the same pinned ICU Script answer before fallback and
carries its ISO 15924 tag through the final `FontRun` into HarfBuzz. This matters
even when the selected face has no nominal glyph for the source scalar: the
script chooses the syllabic machine that may insert the selected face's U+25CC
on the source cluster. The helper-absent `unicode-properties` fallback remains
nonfatal but is not a parity claim.

## ICU helper surface

The first helper protocol should batch codepoints and return raw upstream
answers rather than Domotion-specific booleans:

- `u_charType`
- `u_getCombiningClass`
- `u_getIntPropertyValue` for script, block, bidi class, bidi paired-bracket
  type, East Asian width, Indic positional category, Indic syllabic category,
  line break, vertical orientation and any additional property named by a
  cited Blink call site
- `u_hasBinaryProperty` for ideographic, default ignorable, grapheme extend,
  emoji, emoji presentation, emoji modifier base/component and extended
  pictographic
- `uscript_getScriptExtensions`
- canonical normalization through ICU where a Blink decision asks for it

The response carries the ICU version and data version so the Node side can
reject a helper built against a different dataset instead of silently mixing
versions.

## Validation

Release validation is complete only when:

1. helper protocol tests prove the exact ICU version and representative values;
2. exhaustive comparisons show the removed JavaScript/range classifiers agree
   with ICU where they were intended to model ICU;
3. disabling the helper demonstrably moves answers and emits the unsupported-
   mode warning;
4. font and cluster conformance gates show no regression relative to Chromium;
5. all-platform HTML and Unicode visual suites have been generated for review.

Local migration gates on 2026-08-19:

- ICU 78.2 exhaustive digest: 1,114,112 codepoints, 299,382 assigned,
  `6c5c14d607f8d945` (exact expected digest).
- Full unit suite: 3,821 passed, 32 skipped; no failures.
- Cluster face-boundary oracle: 16/16 exact, zero mismatches/skips.
- Representative font-selection oracle: 7,074 comparisons across six corpus
  stacks, zero logical mismatches.
- The composed multilingual corpus subsequently added
  `ui-sans-serif, system-ui, sans-serif`, exposing a missing first-effective-
  family transition outside those six stacks. The corrected single-shot oracle
  now reports 17/17 exact `.SF Arabic` selections for its Arabic discriminator
  set; disabling the `systemUiPrimary` signal moves the same query to Geeza Pro.

The accepted implementation at `0d8a4358376c7debaf5348dc7eae184ed76e2ad9`
completed the all-platform integration gate:

| Suite | Run | macOS | Linux | Windows |
| --- | --- | ---: | ---: | ---: |
| Unicode | `32218321780` | 10 failing (10 baseline) | 31 failing (75 baseline) | 3 failing (650 baseline) |
| HTML | `32218323756` | 74 failing (100 baseline) | 146 failing (165 baseline) | 59 failing (187 baseline) |

Neither suite introduced a newly failing fixture. The macOS Unicode comparison
had four fixtures move above the regression threshold and four become newly
passing. Telugu, Kannada, and Latin Extended-C isolated a post-shaping CFF2
subset/reopen geometry boundary. DM-2310 resolved it with HarfBuzz's
`HB_SUBSET_FLAGS_DOWNGRADE_CFF2` after full axis pinning, which emits the
completed instance as static CFF1 without rebuilding outlines or selecting
particular faces or glyphs. A full local 818-fixture Unicode sweep left Telugu,
Kannada, and Latin Extended-C pixel-clean with no new regression. Superscripts
and Subscripts remains a sparse
mixed-face transition covered by its existing visual work. These residuals do
not contradict the ICU/font-selection stage oracles.

The macOS HTML comparison recorded 18 threshold regressions alongside 44 newly
passing fixtures. Several regression labels are metric artifacts despite lower
total error (for example backdrop-filter and wavy underlines); the remaining
labels are residual paint/layout cases rather than newly selected Unicode
routes. Linux and Windows baselines predate environment recording and therefore
cannot establish strict comparability, but they reported no new failing fixture
and large net reductions. Their apparent regression labels likewise include
unchanged or substantially improved images.

Pixels remain an integration oracle: they exposed the separate CFF2 boundary,
but they do not replace the source-derived ICU/HarfBuzz and platform-resolution
oracles. Future Chromium rolls must rerun both layers and classify any movement
at the earliest divergent logical stage.
