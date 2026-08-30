---
id: "requirements/font-feature-values-shaping-conformance"
title: "Named font-feature values in the shaping conformance gate"
kind: "evidence"
status: "current"
owners: ["text-fonts","platform-release","product-tooling"]
platforms: []
tickets: []
code: ["src/capture/script/font-feature-values.ts","src/font-feature-values-cascade.ts","tests/fixtures/shaping/FontWithFancyFeatures.otf.base64","tests/font-feature-values.e2e.test.ts","tests/shaping-font-feature-values.e2e.test.ts","tests/shaping-font-feature-values.test.ts","tools/shaping-conformance.ts","tools/shaping-font-feature-values.ts"]
aliases: ["docs/204-font-feature-values-shaping-conformance.md","doc-204"]
---

# Named font-feature values in the shaping conformance gate

**Status:** shipped

**Owners:** `src/font-feature-values-cascade.ts`,
`src/capture/script/font-feature-values.ts`, `tools/shaping-conformance.ts`,
`tools/shaping-font-feature-values.ts`
**Evidence:** `tests/font-feature-values.e2e.test.ts`,
`tests/shaping-font-feature-values.test.ts`, `tests/shaping-font-feature-values.e2e.test.ts`

## The missing half of the question

The shaping corpus already preserved computed `font-variant-alternates`, but a
value such as `stylistic(fancy)` is not an OpenType feature. It is a
document-scoped name whose meaning comes from a matching
`@font-feature-values` rule. The old synthetic probe page carried the computed
token without the rule, so Chrome and Domotion both shaped the name as inert.
That was agreement about a different document.

The extractor now carries three coupled facts for an alternates-bearing run:

1. the computed `font-variant-alternates` value;
2. the relevant family-keyed CSSOM alias table; and
3. the exact resolved feature list, which is recomputed and checked when the
   corpus is consumed.

The synthetic Chrome page re-emits the effective rules before its runs. The
Domotion side resolves the same table with the shipped
`resolveFontVariantAlternates`, merges it with the other feature sources, and
records the final list plus a complete HarfBuzz glyph/cluster/advance/offset
record when exact webfont bytes are available. Probe batches are partitioned by
their document-scoped rule and font environment, so one fixture cannot leak an
alias into another.

## Source ownership

At Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`, Blink's
`CSSFontSelector::GetFontData` resolves alternates against the candidate
family's `FontFeatureValuesStorage`
(`core/css/css_font_selector.cc:192-235`). Same-family author rules are fused by
the scoped style resolver; the resulting `FontVariantAlternates::Resolve`
mapping is in `platform/fonts/font_variant_alternates.cc:100-180`:

| CSS function | HarfBuzz user features |
| --- | --- |
| `stylistic(name)` | `salt=<value>` |
| `styleset(name …)` | `ssNN` for every valid value 1–99 |
| `character-variant(name …)` | `cvNN`, with the optional second integer as its feature value |
| `swash(name)` | `swsh=<value>` and `cswh=<value>` |
| `ornaments(name)` | `ornm=<value>` |
| `annotation(name)` | `nalt=<value>` |

Family matching is case-folded and aliases never cross to another family.
HarfBuzz then appends every exact user tag/value to its feature map
(`external/harfbuzz/src/hb-ot-shape.cc:330-420`, pinned checkout `4de187d`).
No raster threshold is involved in this ownership decision.

### Cascade layers and TreeScopes

Layer ownership follows Blink's storage update, not property-cascade source
order. `CascadeLayerMap` merges named layer trees across active document
stylesheets, assigns postorder numbers, and reserves `UINT16_MAX` for the
implicit outer layer (`core/css/cascade_layer_map.cc:40-80`). Every alias key
retains its own layer number. `FontFeatureValuesStorage::FuseUpdate` replaces a
collision only when the incoming number is greater or equal; equality makes a
later rule in the same layer win while unrelated aliases remain unioned
(`core/css/style_rule_font_feature_values.cc:83-122`). Production capture and
the shaping extractor share that final fusion helper.

The shadow behavior is exact even though it is an upstream limitation. Blink
currently returns before adding feature-value rules from a non-document
TreeScope (`core/css/resolver/scoped_style_resolver.cc:355-386`), and
`CSSFontSelector::GetFontData` consults only the document resolver rather than
walking parent TreeScopes (`core/css/css_font_selector.cc:192-220`). Therefore
document aliases apply to text inside an open shadow root, a conflicting shadow
alias is ignored, and a shadow-only alias is inert. The gate mirrors this
current Chromium behavior; it does not implement the behavior named by Blink's
open scoping TODO.

## Non-vacuous real-font matrix

The retained fixture is Chromium WPT's
`css/css-fonts/support/fonts/FontWithFancyFeatures.otf`, stored as
`tests/fixtures/shaping/FontWithFancyFeatures.otf.base64`. Its SHA-256 is
`0f7e550009d5d7348fdbaf79365e9cdbe010feb04e3af00bacc49f825e1f93f2`.
It contains real `salt`, `ss01`–`ss03`, `cv01`, `swsh`, `cswh`, `ornm`, and
`nalt` substitutions.

For each of the six CSS functions, the browser test requires all of these:

- extraction retains the exact family table, feature list, and font bytes;
- CDP reports one custom webfont face (Chromium's OTS-renamed
  `OTS-derived-font`, not a platform fallback);
- the named alias and its direct low-level feature list have identical Chrome
  glyph counts/geometry and byte-identical same-browser screenshots;
- removing the matching rule changes the screenshot;
- the renderer produces the same glyph count and positions for the named and
  direct forms; and
- the complete HarfBuzz logical record matches the direct form and differs from
  the missing-rule control.

The unit matrix also pins the source index changed by each WPT feature and the
full source-span/cluster records. A stale persisted feature list is a hard
harness error, not an opportunity to reinterpret old evidence.

## Webfont trust boundary

The broad extractor retains only a single self-contained base64 data-URL face
for a family. `local()`, file/remote URLs, and descriptor sets with multiple
face declarations remain excluded: carrying only a family name or arbitrarily
choosing one declaration would let both sides agree on a fallback the fixture
never painted. The retained bytes are declared to Chromium and registered with
Domotion, and CDP's `isCustomFont` bit is the browser ownership proof.

The hostile matrix reverses layer declaration and rule source order, collides
aliases within one layer, places a later explicit-layer rule after an
unlayered rule, and mutates document-versus-shadow ownership. The pinned WPT
font makes `salt=1` and `salt=2` select different logical glyphs. A source-order
or shadow-local implementation therefore fails both the persisted feature-list
check and the same-Chromium direct-feature discriminator.

## Commands

```sh
npx vitest run tests/shaping-font-feature-values.test.ts
npx vitest run --config vitest.e2e.config.ts tests/shaping-font-feature-values.e2e.test.ts
npm run fonts:shaping
```

The dedicated matrix is exact and does not widen the shaping oracle's existing
position tolerance. Its screenshot equality is only an anti-vacuity comparison
between variants rendered by the same pinned Chromium process; it is not a
cross-platform raster envelope.
