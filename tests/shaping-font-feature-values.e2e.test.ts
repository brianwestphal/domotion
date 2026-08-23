import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeShaping,
  extractRuns,
  ourShaping,
  shapingProbePageHtml,
  type RunCorpus,
  type RunSpec,
} from "../tools/shaping-conformance.js";
import {
  exactFeatureValueSignature,
  exactWebfontFeatureRecord,
} from "../tools/shaping-font-feature-values.js";

const FAMILY = "DM2349 Fancy";
const FAMILY_KEY = FAMILY.toLowerCase();
const LAYERED_FAMILY = "DM2349 Layered";
const SAME_LAYER_FAMILY = "DM2349 Same Layer";
const OUTER_FAMILY = "DM2349 Outer";
const SHADOW_FAMILY = "DM2349 Shadow";
const SHADOW_ONLY_FAMILY = "DM2349 Shadow Only";
const TEXT = "Xnophijklmqrstuvwxyz";
const CASES = [
  ["stylistic(fancy)", ["salt=1"]],
  ["styleset(display)", ["ss01", "ss02", "ss03"]],
  ["character-variant(open)", ["cv01"]],
  ["swash(ornate)", ["swsh=1", "cswh=1"]],
  ["ornaments(fleurons)", ["ornm=1"]],
  ["annotation(circled)", ["nalt=1"]],
] as const;

const base64 = readFileSync(
  "tests/fixtures/shaping/FontWithFancyFeatures.otf.base64",
  "utf8",
).replace(/\s/g, "");
const bytes = Buffer.from(base64, "base64");

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@font-face { font-family: "${FAMILY}"; src: url(data:font/otf;base64,${base64}); }
@font-face { font-family: "${LAYERED_FAMILY}"; src: url(data:font/otf;base64,${base64}); }
@font-face { font-family: "${SAME_LAYER_FAMILY}"; src: url(data:font/otf;base64,${base64}); }
@font-face { font-family: "${OUTER_FAMILY}"; src: url(data:font/otf;base64,${base64}); }
@font-face { font-family: "${SHADOW_FAMILY}"; src: url(data:font/otf;base64,${base64}); }
@font-face { font-family: "${SHADOW_ONLY_FAMILY}"; src: url(data:font/otf;base64,${base64}); }
@font-feature-values "${FAMILY}" {
  @stylistic { fancy: 1; }
  @styleset { display: 1 2 3; }
  @character-variant { open: 1; }
  @swash { ornate: 1; }
  @ornaments { fleurons: 1; }
  @annotation { circled: 1; }
}
/* high sorts after low, even though its rule appears first. */
@layer low, high;
@layer high {
  @font-feature-values "${LAYERED_FAMILY}" { @stylistic { fancy: 1; unioned: 3; } }
}
@layer low {
  @font-feature-values "${LAYERED_FAMILY}" { @stylistic { fancy: 2; } }
}
@layer same {
  @font-feature-values "${SAME_LAYER_FAMILY}" { @stylistic { fancy: 2; } }
  @font-feature-values "${SAME_LAYER_FAMILY}" { @stylistic { fancy: 1; } }
}
@font-feature-values "${OUTER_FAMILY}" { @stylistic { fancy: 1; } }
@layer high { @font-feature-values "${OUTER_FAMILY}" { @stylistic { fancy: 2; } } }
@font-feature-values "${SHADOW_FAMILY}" { @stylistic { fancy: 1; } }
.probe { font-family: "${FAMILY}"; font-size: 32px; line-height: 1; }
.feature-probe { font-size: 32px; line-height: 1; margin: 0; display: inline-block; }
.layered { font-family: "${LAYERED_FAMILY}"; font-variant-alternates: stylistic(fancy); }
.same-layer { font-family: "${SAME_LAYER_FAMILY}"; font-variant-alternates: stylistic(fancy); }
.outer { font-family: "${OUTER_FAMILY}"; font-variant-alternates: stylistic(fancy); }
${CASES.map(([value], index) => `.v${index}{font-variant-alternates:${value};}`).join("\n")}
</style></head><body>
${CASES.map((_, index) => `<p class="probe v${index}">${TEXT}</p>`).join("\n")}
<p id="layered-alias" class="feature-probe layered">${TEXT}</p>
<p id="layered-direct" class="feature-probe" style="font-family:'${LAYERED_FAMILY}';font-feature-settings:'salt' 1">${TEXT}</p>
<p id="layered-source-order" class="feature-probe" style="font-family:'${LAYERED_FAMILY}';font-feature-settings:'salt' 2">${TEXT}</p>
<p class="feature-probe same-layer">${TEXT}</p>
<p class="feature-probe outer">${TEXT}</p>
<div id="shadow-host"></div>
<script>
(() => {
  const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>'
    + '@font-feature-values "${SHADOW_FAMILY}" { @stylistic { fancy: 2; } }'
    + '@font-feature-values "${SHADOW_ONLY_FAMILY}" { @stylistic { fancy: 1; } }'
    + '.p{font-size:32px;line-height:1;margin:0;display:inline-block;font-variant-alternates:stylistic(fancy)}'
    + '.doc{font-family:"${SHADOW_FAMILY}"}.only{font-family:"${SHADOW_ONLY_FAMILY}"}'
    + '.direct1{font-variant-alternates:normal;font-feature-settings:"salt" 1}'
    + '.direct2{font-variant-alternates:normal;font-feature-settings:"salt" 2}'
    + '.normal{font-variant-alternates:normal}'
    + '</style>'
    + '<p id="shadow-document" class="p doc">${TEXT}</p>'
    + '<p id="shadow-document-direct" class="p doc direct1">${TEXT}</p>'
    + '<p id="shadow-document-local" class="p doc direct2">${TEXT}</p>'
    + '<p id="shadow-only" class="p only">${TEXT}</p>'
    + '<p id="shadow-only-normal" class="p only normal">${TEXT}</p>';
})();
</script>
</body></html>`;

function featureSettings(features: readonly string[]): string {
  return features.map((feature) => {
    const disabled = feature.startsWith("-");
    const [rawTag, rawValue] = (disabled ? feature.slice(1) : feature).split("=");
    return `"${rawTag}" ${disabled ? 0 : rawValue ?? 1}`;
  }).join(", ");
}

function directSpec(spec: RunSpec, features: readonly string[]): RunSpec {
  return {
    ...spec,
    fontVariantAlternates: "normal",
    fontFeatureValues: undefined,
    resolvedFontFeatures: undefined,
    fontFeatureSettings: featureSettings(features),
  };
}

function missingRuleSpec(spec: RunSpec): RunSpec {
  return {
    ...spec,
    fontFeatureValues: undefined,
    resolvedFontFeatures: [],
  };
}

async function raster(page: Page, spec: RunSpec): Promise<Buffer> {
  await page.setContent(shapingProbePageHtml([spec]), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return page.locator("#r0").screenshot();
}

let browser: Browser;
let page: Page;
let dir = "";
let corpus: RunCorpus;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dm2349-feature-values-"));
  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, "feature-values.html"), fixture);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 760, height: 180 } });
  corpus = await extractRuns(browser, [fixtures], join(dir, "corpus.json"));
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("doc 204 shaping conformance harvests named feature values", () => {
  it("retains the exact table, resolved lists, and real webfont bytes", () => {
    const rows = corpus.runs.filter((run) => run.fontFamily.toLowerCase().includes(FAMILY_KEY));
    expect(rows).toHaveLength(CASES.length);
    for (const [css, features] of CASES) {
      const row = rows.find((candidate) => candidate.fontVariantAlternates === css);
      expect(row, css).toBeDefined();
      expect(row!.resolvedFontFeatures).toEqual(features);
      expect(row!.fontFeatureValues?.[FAMILY_KEY]).toMatchObject({
        stylistic: { fancy: [1] },
        styleset: { display: [1, 2, 3] },
        characterVariant: { open: [1] },
        swash: { ornate: [1] },
        ornaments: { fleurons: [1] },
        annotation: { circled: [1] },
      });
      expect(row!.webfont?.dataBase64).toBe(base64);
      expect(row!.webfont?.mime).toBe("font/otf");
    }
  });

  it("uses Blink layer postorder, same-layer source order, and implicit-outer priority", () => {
    const named = (family: string) => corpus.runs.find((row) =>
      row.fontFamily.includes(family) && row.fontVariantAlternates === "stylistic(fancy)");
    expect(named(LAYERED_FAMILY)?.resolvedFontFeatures).toEqual(["salt=1"]);
    expect(named(LAYERED_FAMILY)?.fontFeatureValues?.[LAYERED_FAMILY.toLowerCase()]).toEqual({
      stylistic: { fancy: [1], unioned: [3] },
    });
    expect(named(SAME_LAYER_FAMILY)?.resolvedFontFeatures).toEqual(["salt=1"]);
    expect(named(OUTER_FAMILY)?.resolvedFontFeatures).toEqual(["salt=1"]);
  });

  it("applies only document storage to shadow text and keeps a shadow-only alias inert", () => {
    const named = (family: string) => corpus.runs.find((row) =>
      row.fontFamily.includes(family) && row.fontVariantAlternates === "stylistic(fancy)");
    expect(named(SHADOW_FAMILY)?.resolvedFontFeatures).toEqual(["salt=1"]);
    expect(named(SHADOW_FAMILY)?.fontFeatureValues?.[SHADOW_FAMILY.toLowerCase()]?.stylistic)
      .toEqual({ fancy: [1] });
    expect(named(SHADOW_ONLY_FAMILY)?.fontFeatureValues).toBeUndefined();
    expect(named(SHADOW_ONLY_FAMILY)?.resolvedFontFeatures).toEqual([]);
  });

  it("makes wrong source-order and shadow-scope fusion fail the stale-table gate", () => {
    const layered = corpus.runs.find((row) =>
      row.fontFamily.includes(LAYERED_FAMILY) && row.fontVariantAlternates === "stylistic(fancy)")!;
    expect(() => shapingProbePageHtml([{
      ...layered,
      fontFeatureValues: {
        [LAYERED_FAMILY.toLowerCase()]: { stylistic: { fancy: [2] } },
      },
    }])).toThrow(/stale font-feature-values row/);

    const shadow = corpus.runs.find((row) =>
      row.fontFamily.includes(SHADOW_FAMILY) && row.fontVariantAlternates === "stylistic(fancy)")!;
    expect(() => shapingProbePageHtml([{
      ...shadow,
      fontFeatureValues: {
        [SHADOW_FAMILY.toLowerCase()]: { stylistic: { fancy: [2] } },
      },
    }])).toThrow(/stale font-feature-values row/);
  });

  it("matches Chromium's live layered winner and rejects the source-order mutation", async () => {
    await page.setContent(fixture, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const alias = await page.locator("#layered-alias").screenshot();
    const direct = await page.locator("#layered-direct").screenshot();
    const sourceOrder = await page.locator("#layered-source-order").screenshot();
    expect(alias.equals(direct)).toBe(true);
    expect(alias.equals(sourceOrder)).toBe(false);
  });

  it("matches Chromium's live document-only shadow winner and inert shadow-only rule", async () => {
    await page.setContent(fixture, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const shadow = page.locator("#shadow-host");
    const documentAlias = await shadow.locator("#shadow-document").screenshot();
    const documentDirect = await shadow.locator("#shadow-document-direct").screenshot();
    const shadowLocalMutation = await shadow.locator("#shadow-document-local").screenshot();
    const shadowOnly = await shadow.locator("#shadow-only").screenshot();
    const shadowOnlyNormal = await shadow.locator("#shadow-only-normal").screenshot();
    expect(documentAlias.equals(documentDirect)).toBe(true);
    expect(documentAlias.equals(shadowLocalMutation)).toBe(false);
    expect(shadowOnly.equals(shadowOnlyNormal)).toBe(true);
  });

  it.each(CASES)("makes Chromium's %s alias identical to its low-level feature list", async (css, features) => {
    const spec = corpus.runs.find((row) => row.fontVariantAlternates === css)!;
    const direct = directSpec(spec, features);
    const [aliasLogical, directLogical] = await chromeShaping(page, [spec, direct]);
    expect(aliasLogical).toEqual(directLogical);
    expect(aliasLogical.glyphCount).toBe(TEXT.length);
    // OTS deliberately rewrites the WPT fixture's display name to
    // `OTS-derived-font`; CDP's authoritative ownership bit proves it did not
    // fall through to a platform font.
    expect(aliasLogical.customFaces).toEqual([true]);
    expect(aliasLogical.faces.join(" ")).toContain("OTS-derived-font");

    const aliasRaster = await raster(page, spec);
    const directRaster = await raster(page, direct);
    const missingRaster = await raster(page, missingRuleSpec(spec));
    expect(aliasRaster.equals(directRaster)).toBe(true);
    expect(aliasRaster.equals(missingRaster)).toBe(false);
  });

  it.each(CASES)("carries %s through the renderer and exact HarfBuzz cluster record", (css, features) => {
    const spec = corpus.runs.find((row) => row.fontVariantAlternates === css)!;
    const direct = directSpec(spec, features);
    const aliasShaping = ourShaping(spec);
    const directShaping = ourShaping(direct);
    // HarfBuzz accepts both `salt` and `salt=1`; retain Blink's explicit
    // alias-derived value in evidence while comparing the painted result.
    expect({ glyphCount: aliasShaping.glyphCount, xs: aliasShaping.xs, ok: aliasShaping.ok })
      .toEqual({ glyphCount: directShaping.glyphCount, xs: directShaping.xs, ok: directShaping.ok });
    expect(aliasShaping.featureList).toEqual(features);
    expect(aliasShaping.logicalRecord?.features).toEqual(features);
    expect(aliasShaping.logicalRecord?.clusters)
      .toEqual(Array.from({ length: TEXT.length }, (_, index) => index));
    expect(exactFeatureValueSignature(aliasShaping.logicalRecord!))
      .toBe(exactFeatureValueSignature(directShaping.logicalRecord!));

    const aliasRecord = exactWebfontFeatureRecord(bytes, TEXT, [...spec.resolvedFontFeatures!]);
    const directRecord = exactWebfontFeatureRecord(bytes, TEXT, [...features]);
    const missingRecord = exactWebfontFeatureRecord(bytes, TEXT, []);
    expect(aliasRecord.features).toEqual(features);
    expect(aliasRecord.clusters).toEqual(Array.from({ length: TEXT.length }, (_, index) => index));
    expect(exactFeatureValueSignature(aliasRecord)).toBe(exactFeatureValueSignature(directRecord));
    expect(exactFeatureValueSignature(aliasRecord)).not.toBe(exactFeatureValueSignature(missingRecord));
  });

  it("rejects a stale exact feature list instead of silently reinterpreting the corpus", () => {
    const spec = corpus.runs.find((row) => row.fontVariantAlternates === "stylistic(fancy)")!;
    expect(() => shapingProbePageHtml([{ ...spec, resolvedFontFeatures: ["salt=2"] }]))
      .toThrow(/stale font-feature-values row/);
  });
});
