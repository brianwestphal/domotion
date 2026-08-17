# 128 — Chromium Unicode decision audit

Status: **migration in progress**. This document is the source inventory for
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
| `isTrimmableCjkPunct` | broad hand-scoped blocks | Blink shaping result/`halt` feature behavior | Domotion probe scope | Remove as a semantic decision; derive availability from the shaped glyph/feature result. |
| `usesComplexShaperDottedCircle` | hand-maintained script ranges | HarfBuzz shaper selection and its actual shaped output | Predictive heuristic | Remove. Shape the failing cluster through pinned HarfBuzz and observe the inserted dotted-circle glyph/cluster. |
| `usesDedicatedShaper` | hand-maintained script ranges | `hb_ot_shaper_categorize` | Partial HarfBuzz transcription | Replace ranges with ICU script/script-extensions plus the pinned HarfBuzz categorizer, or stop predicting the categorizer by shaping every applicable run with HarfBuzz. |
| `usesHarfbuzzShaping` | selected script ranges discovered by engine disagreement | Chromium always uses HarfBuzz | Domotion routing heuristic | Remove the selection gate; supported rendering should use the Chromium-configured HarfBuzz path consistently. |
| canonical/NFD decomposition helpers | JavaScript `normalize()` and mark regex | pinned HarfBuzz normalization plus ICU normalization/properties | Version-dependent approximation | Prefer the pinned HarfBuzz shaping result. Where decomposition must be queried, use pinned ICU normalization and category data. |
| `isLeftReorderingMatra` | generated HarfBuzz USE-category ranges | HarfBuzz USE shaping output | Exact table used predictively | Remove from emission decisions once dotted-circle fallback consumes actual HarfBuzz positions. |
| `isRtlScriptCodepoint` | hand-maintained ranges transcribed from HarfBuzz | `hb_script_get_horizontal_direction` | Exact but duplicated transcription | Ask the pinned HarfBuzz build, with ICU script as the input where needed. |
| `isStrippableOrphanIgnorable` | HarfBuzz predicate with ZWJ/ZWNJ carve-out | HarfBuzz shaping behavior | Caller-specific heuristic | Replace with the shaped cluster result; never strip a character merely from an independently maintained list. |
| stretchy MathML fences | explicit set | Blink MathML operator dictionary | Partial Chromium transcription | Generate/transcribe the operator dictionary or consume captured stretch metrics; do not grow from visual samples. |
| `isCjkIdeographOrSymbol` | copied Blink tables plus JS emoji property | Blink's generated character-property trie | Known incomplete transcription | Generate from Blink's own generator inputs or query an exported Blink-equivalent helper operation; ICU alone is insufficient because Blink adds RGI-sequence members. |
| skip-ink excluded blocks | copied Blink blocks | `Character::CanTextDecorationSkipInk` | Exact Chromium transcription | Keep, but obtain block values through ICU `ublock_getCode` instead of duplicating boundaries. |
| Windows `uscriptGetScript` | handwritten range classifier | ICU `uscript_getScript` | Approximation | Replace with pinned ICU. |
| Windows `ublockGetCode` | handwritten range classifier | ICU `ublock_getCode` | Approximation | Replace with pinned ICU. |
| Windows script/font maps and emoji/math lists | copied Blink tables | `font_fallback_win.cc` | Exact Chromium policy | Keep and drift-test against the pinned Chromium source; feed them ICU answers. |
| macOS/Linux generated font routes | machine-probed Unicode block tables | no corresponding Blink stage | Unsupported-mode compatibility data | Exclude from helper-backed resolution; retain temporarily only as helper-absent best effort. |
| Windows generated font routes | machine-probed Unicode block table | no corresponding Blink stage | Unsupported compatibility data | Exclude from helper-backed resolution after Blink's hardcoded stage and DirectWrite answer are authoritative. |

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

The migration is complete only when:

1. helper protocol tests prove the exact ICU version and representative values;
2. exhaustive comparisons show the removed JavaScript/range classifiers agree
   with ICU where they were intended to model ICU;
3. disabling the helper demonstrably moves answers and emits the unsupported-
   mode warning;
4. font and cluster conformance gates show no regression relative to Chromium;
5. all-platform HTML and Unicode visual suites have been generated for review.
