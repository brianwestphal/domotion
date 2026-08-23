# Named font-feature values in the shaping conformance gate

**Status:** shipped

**Owners:** `tools/shaping-conformance.ts`, `tools/shaping-font-feature-values.ts`
**Evidence:** `tests/shaping-font-feature-values.test.ts`, `tests/shaping-font-feature-values.e2e.test.ts`

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

This work intentionally does not claim exact cascade-layer ordering or
shadow-tree rule scoping. Blink itself records a shadow/scoping TODO around the
font-feature-values update path. Those combinations must receive a separate
source-owned discriminator before the conformance gate claims them; the shipped
matrix covers ordinary document-scoped, unlayered author rules.

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
