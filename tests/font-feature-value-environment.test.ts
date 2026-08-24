import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authenticateFontFeatureEnvironment,
  fontFeatureEnvironmentKey,
  type AuthenticatedFontFeatureEnvironment,
  type RetainedFontSourceKind,
} from "../tools/font-feature-value-environment.js";
import { readFileSync } from "node:fs";

const bytes = Buffer.from("authenticated-font-fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function environment(kind: RetainedFontSourceKind = "data"): AuthenticatedFontFeatureEnvironment {
  return {
    version: "font-feature-values-environment-v2",
    documentId: "document-a",
    selectedFaceId: "face-bold",
    selectedSourceOrder: 1,
    faces: [{
      id: "face-regular",
      family: "Exact Family",
      weightDescriptor: "400",
      styleDescriptor: "normal",
      stretchDescriptor: "100%",
      unicodeRange: "U+0000-00FF",
      sources: [{ kind: "data", cssText: "url(data:font/otf;base64,...)", sourceOrder: 0,
        status: "loaded", bytesBase64: bytes.toString("base64"), sha256, faceIndex: 0 }],
    }, {
      id: "face-bold",
      family: "Exact Family",
      weightDescriptor: "700",
      styleDescriptor: "normal",
      stretchDescriptor: "75% 125%",
      unicodeRange: "U+0000-00FF",
      sources: [
        { kind: "local", cssText: "local(Missing)", sourceOrder: 0, status: "failed", faceIndex: 0 },
        { kind, cssText: `${kind}:fixture`, sourceOrder: 1, status: "loaded",
          bytesBase64: bytes.toString("base64"), sha256, faceIndex: 2 },
      ],
    }],
    effectiveAliasTable: { "exact family": { stylistic: { fancy: [1] } } },
  };
}

describe("authenticated multi-face font-feature-values environments", () => {
  it.each(["data", "file", "local", "remote"] as const)(
    "retains exact bytes, descriptors, face index, and aliases for %s sources",
    (kind) => {
      const selected = authenticateFontFeatureEnvironment(environment(kind));
      expect(selected.face.id).toBe("face-bold");
      expect(selected.face.weightDescriptor).toBe("700");
      expect(selected.face.unicodeRange).toBe("U+0000-00FF");
      expect(selected.source.kind).toBe(kind);
      expect(selected.source.faceIndex).toBe(2);
      expect(selected.bytes).toEqual(bytes);
      expect(selected.environment.effectiveAliasTable["exact family"].stylistic?.fancy).toEqual([1]);
    },
  );

  it("rejects wrong-face and stale-byte mutations", () => {
    expect(() => authenticateFontFeatureEnvironment({ ...environment(), selectedFaceId: "face-regular-x" }))
      .toThrow(/absent or ambiguous/);
    const stale = environment();
    stale.faces[1].sources[1].sha256 = "0".repeat(64);
    expect(() => authenticateFontFeatureEnvironment(stale)).toThrow(/digest mismatch/);
  });

  it("rejects failed loads, unauthenticated remote bytes, and wrong source order", () => {
    const failed = environment("remote");
    failed.faces[1].sources[1].status = "failed";
    expect(() => authenticateFontFeatureEnvironment(failed)).toThrow(/did not load/);

    const unauthenticated = environment("remote");
    delete unauthenticated.faces[1].sources[1].bytesBase64;
    expect(() => authenticateFontFeatureEnvironment(unauthenticated)).toThrow(/unauthenticated remote/);

    const wrongOrder = environment("file");
    wrongOrder.faces[1].sources[0].status = "loaded";
    wrongOrder.faces[1].sources[0].bytesBase64 = bytes.toString("base64");
    wrongOrder.faces[1].sources[0].sha256 = sha256;
    expect(() => authenticateFontFeatureEnvironment(wrongOrder)).toThrow(/source order/);
  });

  it("partitions cache identity by document, selected face, descriptors, aliases, and bytes", () => {
    const base = environment();
    const key = fontFeatureEnvironmentKey(base);
    for (const mutate of [
      (value: AuthenticatedFontFeatureEnvironment) => { value.documentId = "document-b"; },
      (value: AuthenticatedFontFeatureEnvironment) => { value.selectedFaceId = "face-regular"; value.selectedSourceOrder = 0; },
      (value: AuthenticatedFontFeatureEnvironment) => { value.faces[1].weightDescriptor = "600"; },
      (value: AuthenticatedFontFeatureEnvironment) => { value.effectiveAliasTable["exact family"].stylistic!.fancy = [2]; },
    ]) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(fontFeatureEnvironmentKey(changed)).not.toBe(key);
    }
  });

  it("pins Blink selection, Unicode range, cache ownership, and HarfBuzz feature handoff", () => {
    const selector = readFileSync(
      "external/chromium/third_party/blink/renderer/core/css/css_font_selector.cc", "utf8");
    expect(selector).toContain("font_face_cache_->Get(request_description, family_name)");
    expect(selector).toContain("FontFeatureValuesForFamily");
    const range = readFileSync(
      "external/chromium/third_party/blink/renderer/platform/fonts/unicode_range_set.h", "utf8");
    expect(range).toContain("Contains(UChar32");
    const cache = readFileSync(
      "external/chromium/third_party/blink/renderer/core/css/font_face_cache.cc", "utf8");
    expect(cache).toContain("FontSelectionAlgorithm");
    const harfbuzz = readFileSync("external/harfbuzz/src/hb-ot-shape.cc", "utf8");
    expect(harfbuzz).toContain("map->add_feature (feature->tag");
  });
});
