import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuthenticatedFontFeatureEnvironment } from
  "../tools/font-feature-value-environment.js";
import { resolvedFeaturesForRun, shapingProbePageHtml, type RunSpec } from
  "../tools/shaping-conformance.js";
import { exactFeatureValueSignature, exactWebfontFeatureRecord } from
  "../tools/shaping-font-feature-values.js";

const family = "DM2545 Multi Face";
const base64 = readFileSync("tests/fixtures/shaping/FontWithFancyFeatures.otf.base64", "utf8")
  .replace(/\s/g, "");
const bytes = Buffer.from(base64, "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function environment(documentId = "document-a"): AuthenticatedFontFeatureEnvironment {
  return {
    version: "font-feature-values-environment-v2",
    documentId,
    selectedFaceId: "bold-face",
    selectedSourceOrder: 1,
    faces: [{
      id: "regular-face", family, weightDescriptor: "400", styleDescriptor: "normal",
      stretchDescriptor: "100%", unicodeRange: "U+0-10FFFF", sources: [{
        kind: "data", cssText: "url(data:...)", sourceOrder: 0, status: "loaded",
        bytesBase64: base64, sha256, faceIndex: 0,
      }],
    }, {
      id: "bold-face", family, weightDescriptor: "700", styleDescriptor: "normal",
      stretchDescriptor: "100%", unicodeRange: "U+0-10FFFF", sources: [{
        kind: "local", cssText: "local(Missing)", sourceOrder: 0, status: "failed", faceIndex: 0,
      }, {
        kind: "remote", cssText: "url(https://fixture.invalid/font.otf)", sourceOrder: 1,
        status: "loaded", bytesBase64: base64, sha256, faceIndex: 0,
      }],
    }],
    effectiveAliasTable: { [family.toLowerCase()]: { stylistic: { fancy: [1] } } },
  };
}

function spec(documentId = "document-a"): RunSpec {
  return {
    text: "Xnophijklmqrstuvwxyz", fontFamily: `"${family}"`, fontSize: 32,
    fontWeight: 700, fontStyle: "normal", fontVariantAlternates: "stylistic(fancy)",
    resolvedFontFeatures: ["salt=1"], fontFeatureEnvironment: environment(documentId),
    fixtures: 1, example: "dm2545",
  };
}

describe("multi-face font-feature-values exact shaping", () => {
  it("uses the selected bytes and effective alias table for the exact HarfBuzz record", () => {
    const run = spec();
    expect(resolvedFeaturesForRun(run)).toEqual(["salt=1"]);
    const alias = exactWebfontFeatureRecord(bytes, run.text, resolvedFeaturesForRun(run), 32, 0);
    const direct = exactWebfontFeatureRecord(bytes, run.text, ["salt=1"], 32, 0);
    const missing = exactWebfontFeatureRecord(bytes, run.text, [], 32, 0);
    expect(alias.features).toEqual(["salt=1"]);
    expect(exactFeatureValueSignature(alias)).toBe(exactFeatureValueSignature(direct));
    expect(exactFeatureValueSignature(alias)).not.toBe(exactFeatureValueSignature(missing));
  });

  it("emits only authenticated selected bytes and partitions distinct documents", () => {
    const html = shapingProbePageHtml([spec()]);
    expect(html).toContain(`font-weight:700`);
    expect(html).toContain(`unicode-range:U+0-10FFFF`);
    expect(html).toContain(`base64,${base64}`);
    expect(() => shapingProbePageHtml([spec("document-a"), spec("document-b")]))
      .toThrow(/mixes distinct/);
  });

  it("makes stale-table and selected-source cache-order mutations fail closed", () => {
    const stale = spec();
    stale.fontFeatureEnvironment!.effectiveAliasTable[family.toLowerCase()].stylistic!.fancy = [2];
    expect(() => shapingProbePageHtml([stale])).toThrow(/stale font-feature-values row/);
    const reordered = spec();
    reordered.fontFeatureEnvironment!.faces[1].sources[0].status = "loaded";
    reordered.fontFeatureEnvironment!.faces[1].sources[0].bytesBase64 = base64;
    reordered.fontFeatureEnvironment!.faces[1].sources[0].sha256 = sha256;
    expect(() => shapingProbePageHtml([reordered])).toThrow(/source order/);
  });
});
