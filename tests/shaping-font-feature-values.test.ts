import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fuseFontFeatureValueRules,
  IMPLICIT_OUTER_LAYER_ORDER,
} from "../src/font-feature-values-cascade.js";
import {
  exactFeatureValueSignature,
  exactWebfontFeatureRecord,
  resolvedFeatureValueList,
  serializeFontFeatureValues,
  type FontFeatureValueTables,
} from "../tools/shaping-font-feature-values.js";

const FAMILY = "dm2349 fancy";
const TEXT = "Xnophijklmqrstuvwxyz";
const TABLES: FontFeatureValueTables = {
  [FAMILY]: {
    stylistic: { fancy: [1] },
    styleset: { display: [1, 2, 3] },
    characterVariant: { open: [1], indexed: [2, 3] },
    swash: { ornate: [1] },
    ornaments: { fleurons: [1] },
    annotation: { circled: [1] },
  },
};

const CASES = [
  ["stylistic(fancy)", ["salt=1"], [1]],
  ["styleset(display)", ["ss01", "ss02", "ss03"], [4, 5, 6]],
  ["character-variant(open)", ["cv01"], [7]],
  ["swash(ornate)", ["swsh=1", "cswh=1"], [10, 13]],
  ["ornaments(fleurons)", ["ornm=1"], [16]],
  ["annotation(circled)", ["nalt=1"], [19]],
] as const;

function fixtureBytes(): Buffer {
  return Buffer.from(
    readFileSync("tests/fixtures/shaping/FontWithFancyFeatures.otf.base64", "utf8").replace(/\s/g, ""),
    "base64",
  );
}

describe("doc 204 named alternates use Blink's exact OpenType feature list", () => {
  it.each(CASES)("resolves %s", (css, expected) => {
    expect(resolvedFeatureValueList(css, `"${FAMILY}", serif`, TABLES)).toEqual(expected);
  });

  it("keeps character-variant's optional value and family ownership exact", () => {
    expect(resolvedFeatureValueList(
      "character-variant(indexed)",
      `"${FAMILY}"`,
      TABLES,
    )).toEqual(["cv02=3"]);
    expect(resolvedFeatureValueList("stylistic(fancy)", "wrong, serif", TABLES)).toEqual([]);
  });

  it("serializes the effective storage back into all six CSS subrules", () => {
    const css = serializeFontFeatureValues(TABLES);
    expect(css).toContain(`@font-feature-values "${FAMILY}"`);
    expect(css).toContain("@stylistic{fancy:1;}");
    expect(css).toContain("@styleset{display:1 2 3;}");
    expect(css).toContain("@character-variant{indexed:2 3;open:1;}");
    expect(css).toContain("@swash{ornate:1;}");
    expect(css).toContain("@ornaments{fleurons:1;}");
    expect(css).toContain("@annotation{circled:1;}");
  });

  it("fuses alias keys by canonical layer order rather than rule source order", () => {
    const fused = fuseFontFeatureValueRules([
      {
        // This higher-priority layer appears first in source order.
        fontFamily: '"Layered, Fancy", serif',
        layerOrder: 3,
        table: { stylistic: { fancy: [1], unioned: [7] } },
      },
      {
        fontFamily: '"Layered, Fancy", serif',
        layerOrder: 1,
        table: { stylistic: { fancy: [2] }, styleset: { display: [2, 3] } },
      },
    ]);

    expect(fused["layered, fancy"]).toEqual({
      stylistic: { fancy: [1], unioned: [7] },
      styleset: { display: [2, 3] },
    });
    expect(fused.serif).toEqual(fused["layered, fancy"]);
  });

  it("lets a later rule win within one layer and the implicit layer win globally", () => {
    const fused = fuseFontFeatureValueRules([
      { fontFamily: "Esc\\61 ped", layerOrder: 4, table: { stylistic: { fancy: [1] } } },
      { fontFamily: "Escaped", layerOrder: 4, table: { stylistic: { fancy: [2] } } },
      {
        fontFamily: "Escaped",
        layerOrder: IMPLICIT_OUTER_LAYER_ORDER,
        table: { stylistic: { fancy: [3] } },
      },
      { fontFamily: "Escaped", layerOrder: 99, table: { stylistic: { fancy: [4] } } },
    ]);
    expect(fused.escaped?.stylistic?.fancy).toEqual([3]);
  });
});

describe("the pinned WPT webfont makes every alias anti-vacuous", () => {
  it("is the exact Chromium-pinned fixture", () => {
    expect(createHash("sha256").update(fixtureBytes()).digest("hex"))
      .toBe("0f7e550009d5d7348fdbaf79365e9cdbe010feb04e3af00bacc49f825e1f93f2");
  });

  it.each(CASES)("moves the logical glyph at the source-owned %s clusters", (_css, features, changed) => {
    const bytes = fixtureBytes();
    const baseline = exactWebfontFeatureRecord(bytes, TEXT, []);
    const selected = exactWebfontFeatureRecord(bytes, TEXT, [...features]);
    const actualChanged = selected.glyphs
      .map((glyph, index) => glyph.id === baseline.glyphs[index].id ? -1 : index)
      .filter((index) => index >= 0);

    expect(selected.features).toEqual(features);
    expect(selected.clusters).toEqual(Array.from({ length: TEXT.length }, (_, index) => index));
    expect(selected.glyphs.map((glyph) => glyph.sourceSpan))
      .toEqual(Array.from({ length: TEXT.length }, (_, index) => [index, index + 1]));
    expect(actualChanged).toEqual(changed);
    expect(exactFeatureValueSignature(selected)).not.toBe(exactFeatureValueSignature(baseline));
  });

  it("is anchored to the pinned Blink resolver and HarfBuzz user-feature path", () => {
    const blink = readFileSync(
      "external/chromium/third_party/blink/renderer/platform/fonts/font_variant_alternates.cc",
      "utf8",
    );
    for (const anchor of ["kSaltTag", "ssTag", "cvTag", "kSwshTag", "kCswhTag", "kOrnmTag", "kNaltTag"]) {
      expect(blink).toContain(anchor);
    }
    const selector = readFileSync(
      "external/chromium/third_party/blink/renderer/core/css/css_font_selector.cc",
      "utf8",
    );
    expect(selector).toContain("FontFeatureValuesForFamily");
    expect(selector).toContain("GetFontVariantAlternates()->Resolve");
    const storage = readFileSync(
      "external/chromium/third_party/blink/renderer/core/css/style_rule_font_feature_values.cc",
      "utf8",
    );
    expect(storage).toContain("other_layer_order >= existing_layer_order");
    const scopedResolver = readFileSync(
      "external/chromium/third_party/blink/renderer/core/css/resolver/scoped_style_resolver.cc",
      "utf8",
    );
    expect(scopedResolver).toContain("Support @font-feature-values in shadow");
    expect(scopedResolver).toContain("if (!GetTreeScope().RootNode().IsDocumentNode())");
    const harfbuzz = readFileSync("external/harfbuzz/src/hb-ot-shape.cc", "utf8");
    expect(harfbuzz).toContain("map->add_feature (feature->tag");
    expect(harfbuzz).toContain("feature->value");
  });
});
