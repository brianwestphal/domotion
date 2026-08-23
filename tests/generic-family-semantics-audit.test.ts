import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { __skiaLastResortKeysForTest } from "../src/render/cluster-fallback.js";
import {
  __resolveSystemFallbackKeyForCpForTest,
  __systemFallbackKeyCacheSizeForTest,
  blinkGenericFamilyFromDeclaredStack,
  clearFontResolutionCaches,
  createFontFallbackSemanticContext,
  declaredFamilyHeadIdentity,
  skiaLastResortFamilyQuestionOrder,
} from "../src/render/font-resolution.js";
import { withHostPlatform } from "../src/render/host-platform.js";
import {
  GENERIC_FAMILY_SEMANTICS_CASES,
  adjudicateGenericFamilySemanticsRow,
  blinkGenericFamilyFromComputedStack,
  classifyGenericFamilySemanticsEvidence,
  collectGenericFamilySourceFingerprints,
  keyInferredGenericFamily,
  keyInferredWinFallbackMode,
  sourceDeclaredFamilyHeadIdentity,
  sourcePlatformCandidateOrder,
  sourceSemanticCacheIdentity,
  sourceTerminalActivated,
  sourceTerminalOwnerOrder,
  sourceTerminalQuestionOrder,
  sourceWinFallbackMode,
  splitComputedFontFamily,
  type GenericFamilyGatePlatform,
  type GenericFamilySemanticsOrder,
  type GenericFamilySemanticsRow,
} from "../tools/generic-family-semantics-audit.js";

function primaryKeyFor(stackId: string): string {
  if (stackId === "arial-then-monospace") return "helvetica";
  if (stackId === "serif-then-monospace") return "times";
  if (stackId === "system-ui") return "sf-pro";
  if (stackId === "math") return "latin-modern-math";
  return "courier";
}

function validRow(
  spec = GENERIC_FAMILY_SEMANTICS_CASES[0],
  order: GenericFamilySemanticsOrder["order"] = "forward",
  target: GenericFamilyGatePlatform = "win32",
): GenericFamilySemanticsRow {
  const sourceGeneric = blinkGenericFamilyFromComputedStack(spec.fontFamily);
  const primaryKey = primaryKeyFor(spec.stackId);
  const keyDerivedGeneric = keyInferredGenericFamily(primaryKey);
  return adjudicateGenericFamilySemanticsRow({
    id: spec.id,
    order,
    platform: target,
    stackId: spec.stackId,
    scriptId: spec.scriptId,
    lang: spec.lang,
    codepoint: spec.codepoint,
    requestedFontFamily: spec.fontFamily,
    computedFontFamily: spec.fontFamily,
    expectedGeneric: spec.expectedGeneric,
    sourceGeneric,
    productionGeneric: sourceGeneric,
    sourceFallbackMode: sourceWinFallbackMode(sourceGeneric),
    productionFallbackMode: sourceWinFallbackMode(sourceGeneric),
    sourceCandidateOrder: sourcePlatformCandidateOrder(target, spec.scriptId, sourceGeneric),
    productionCandidateOrder: sourcePlatformCandidateOrder(target, spec.scriptId, sourceGeneric),
    sourceTerminalQuestionOrder: sourceTerminalQuestionOrder(target, sourceGeneric),
    productionTerminalQuestionOrder: skiaLastResortFamilyQuestionOrder(sourceGeneric, target),
    sourceTerminalOwnerOrder: sourceTerminalOwnerOrder(target, sourceGeneric),
    productionTerminalOwnerOrder: sourceTerminalOwnerOrder(target, sourceGeneric),
    sourceTerminalActivated: sourceTerminalActivated(target, sourceGeneric),
    productionTerminalActivated: sourceTerminalActivated(target, sourceGeneric),
    sourceCacheIdentity: sourceSemanticCacheIdentity(target, spec.fontFamily, sourceGeneric),
    productionCacheIdentity: sourceSemanticCacheIdentity(target, spec.fontFamily, sourceGeneric),
    primaryKey,
    keyDerivedGeneric,
    keyDerivedCandidateOrder: sourcePlatformCandidateOrder(
      target, spec.scriptId, keyDerivedGeneric,
    ),
    keyDerivedTerminalOwnerOrder: sourceTerminalOwnerOrder(target, keyDerivedGeneric),
    keyDerivedSemanticMismatch: sourceGeneric !== keyDerivedGeneric,
    paintedFaces: [{
      familyName: "Measured Face",
      postScriptName: "MeasuredFace-Regular",
      isCustomFont: false,
      glyphCount: 1,
    }],
  });
}

function validOrders(target: GenericFamilyGatePlatform = "win32"): GenericFamilySemanticsOrder[] {
  return ["forward", "reverse"].map((order) => ({
    order: order as GenericFamilySemanticsOrder["order"],
    rows: (order === "forward"
      ? GENERIC_FAMILY_SEMANTICS_CASES
      : [...GENERIC_FAMILY_SEMANTICS_CASES].reverse()
    ).map((spec) => validRow(spec, order as GenericFamilySemanticsOrder["order"], target)),
  }));
}

describe("exact generic-family semantic ownership gate", () => {
  it("keeps quoted commas and quoted generic-looking names literal", () => {
    expect(splitComputedFontFamily('"A, B", Courier, \'monospace\''))
      .toEqual([
        { value: "A, B", quoted: true },
        { value: "Courier", quoted: false },
        { value: "monospace", quoted: true },
      ]);
    expect(blinkGenericFamilyFromComputedStack('"monospace", Courier')).toBe("none");
    expect(sourceDeclaredFamilyHeadIdentity('"monospace", Courier'))
      .toBe("name:monospace");
  });

  it("models Blink's rightmost enum-bearing generic and non-occupying controls", () => {
    expect(blinkGenericFamilyFromComputedStack("Courier")).toBe("none");
    expect(blinkGenericFamilyFromComputedStack("Courier, MONOSPACE")).toBe("monospace");
    expect(blinkGenericFamilyFromComputedStack("Courier, monospace, serif")).toBe("serif");
    expect(blinkGenericFamilyFromComputedStack("serif, monospace")).toBe("monospace");
    expect(blinkGenericFamilyFromComputedStack("system-ui")).toBe("none");
    expect(blinkGenericFamilyFromComputedStack("math")).toBe("none");
    expect(blinkGenericFamilyFromComputedStack("Courier, system-ui")).toBe("none");
    expect(blinkGenericFamilyFromComputedStack("monospace, system-ui, math"))
      .toBe("monospace");
    expect(sourceWinFallbackMode("serif")).toBe("standard");
    expect(sourceWinFallbackMode("monospace")).toBe("monospace");
  });

  it("transcribes each platform's candidate and terminal ownership order", () => {
    expect(sourcePlatformCandidateOrder("darwin", "arabic", "monospace")).toEqual([]);
    expect(sourcePlatformCandidateOrder("linux", "hebrew", "none")).toEqual([]);
    expect(sourcePlatformCandidateOrder("win32", "arabic", "none")[0]).toBe("Tahoma");
    expect(sourcePlatformCandidateOrder("win32", "hebrew", "none")[0]).toBe("David");
    expect(sourcePlatformCandidateOrder("win32", "arabic", "monospace")[0])
      .toBe("courier new");
    expect(sourcePlatformCandidateOrder("win32", "arabic", "monospace"))
      .toHaveLength(17);

    expect(sourceTerminalQuestionOrder("darwin", "monospace"))
      .toEqual(["Times", "Lucida Grande"]);
    expect(sourceTerminalQuestionOrder("linux", "monospace"))
      .toEqual(["monospace", "Sans", "Arial", "<unnamed>"]);
    expect(sourceTerminalQuestionOrder("win32", "none"))
      .toEqual(expect.arrayContaining(["MS UI Gothic", "Courier New", "<unnamed>"]));
    expect(sourceTerminalOwnerOrder("darwin", "monospace"))
      .toEqual(["times", "lucida-grande"]);
    expect(sourceTerminalOwnerOrder("linux", "none")).toEqual(["helvetica"]);
    expect(sourceTerminalOwnerOrder("linux", "monospace"))
      .toEqual(["courier", "helvetica"]);
    expect(sourceTerminalOwnerOrder("win32", "serif"))
      .toEqual(["times", "arial"]);
  });

  it("keeps the production carrier and terminal adapter source-exact on all platforms", () => {
    for (const row of GENERIC_FAMILY_SEMANTICS_CASES) {
      const productionGeneric = blinkGenericFamilyFromDeclaredStack(row.fontFamily);
      expect(productionGeneric, row.id)
        .toBe(blinkGenericFamilyFromComputedStack(row.fontFamily));
      const context = createFontFallbackSemanticContext(row.fontFamily);
      for (const target of ["darwin", "linux", "win32"] as const) {
        expect(skiaLastResortFamilyQuestionOrder(productionGeneric, target), `${target}:${row.id}`)
          .toEqual(sourceTerminalQuestionOrder(target, productionGeneric));
        expect(__skiaLastResortKeysForTest(context, target), `${target}:${row.id}`)
          .toEqual(sourceTerminalOwnerOrder(target, productionGeneric));
      }
    }
  });

  it("matches independent and production cache identity components", () => {
    for (const stack of [
      "monospace",
      '"monospace"',
      "Courier, serif",
      "Arial, monospace",
      "monospace, system-ui, math",
    ]) {
      expect(declaredFamilyHeadIdentity(stack)).toBe(sourceDeclaredFamilyHeadIdentity(stack));
    }
    expect(sourceSemanticCacheIdentity("linux", "Courier", "none"))
      .toBe("name:courier|initial:<unnamed>");
    expect(sourceSemanticCacheIdentity("linux", "Courier, monospace", "monospace"))
      .toBe("name:courier|initial:monospace");
  });

  it("starts one real process cache, then reads the reverse order without resetting", () => {
    const ask = (family: string) => withHostPlatform("linux", () =>
      __resolveSystemFallbackKeyForCpForTest(
        0x10D0, 400, 0, 16, "helvetica", false, "ka", 100, undefined, family,
      ));
    clearFontResolutionCaches();
    for (const family of ["Courier", "Arial"]) ask(family);
    expect(__systemFallbackKeyCacheSizeForTest()).toBe(2);
    for (const family of ["Arial", "Courier"]) ask(family);
    expect(__systemFallbackKeyCacheSizeForTest()).toBe(2);
  });

  it("retains key-derived false-positive and false-negative hostile states", () => {
    expect(keyInferredGenericFamily("courier")).toBe("monospace");
    expect(keyInferredGenericFamily("courier-new")).toBe("none");
    expect(keyInferredGenericFamily("helvetica")).toBe("none");
    expect(keyInferredWinFallbackMode("courier")).toBe("monospace");
    expect(keyInferredWinFallbackMode("helvetica")).toBe("standard");
  });

  it.each([
    ["source-enum", (row: GenericFamilySemanticsRow) => ({ ...row, sourceGeneric: "monospace" as const })],
    ["production-enum", (row: GenericFamilySemanticsRow) => ({ ...row, productionGeneric: "monospace" as const })],
    ["source-candidate-order", (row: GenericFamilySemanticsRow) => ({ ...row, sourceCandidateOrder: ["Wrong"] })],
    ["production-candidate-order", (row: GenericFamilySemanticsRow) => ({ ...row, productionCandidateOrder: ["Wrong"] })],
    ["source-terminal-question-order", (row: GenericFamilySemanticsRow) => ({ ...row, sourceTerminalQuestionOrder: ["Wrong"] })],
    ["production-terminal-question-order", (row: GenericFamilySemanticsRow) => ({ ...row, productionTerminalQuestionOrder: ["Wrong"] })],
    ["production-terminal-owner-order", (row: GenericFamilySemanticsRow) => ({ ...row, productionTerminalOwnerOrder: ["wrong"] })],
    ["production-terminal-activation", (row: GenericFamilySemanticsRow) => ({ ...row, productionTerminalActivated: !row.productionTerminalActivated })],
    ["production-cache-identity", (row: GenericFamilySemanticsRow) => ({ ...row, productionCacheIdentity: "wrong" })],
    ["key-derived-generic", (row: GenericFamilySemanticsRow) => ({ ...row, keyDerivedGeneric: "none" as const })],
    ["key-derived-loss-classification", (row: GenericFamilySemanticsRow) => ({ ...row, keyDerivedSemanticMismatch: !row.keyDerivedSemanticMismatch })],
    ["painted-face-completeness", (row: GenericFamilySemanticsRow) => ({ ...row, paintedFaces: [] })],
  ])("rejects the %s hostile mutation", (blocker, mutate) => {
    const row = validRow();
    const { pass: _pass, blockers: _blockers, ...input } = mutate(row);
    expect(adjudicateGenericFamilySemanticsRow(input).blockers).toContain(blocker);
  });

  it("requires a complete strict matrix with every semantic discriminator active", () => {
    const result = classifyGenericFamilySemanticsEvidence(validOrders(), true);
    expect(result.verdict).toBe("source-exact");
    expect(result.controls).toEqual({
      completeMatrix: true,
      sourcePinsMatch: true,
      sourceEnumExact: true,
      platformCandidateOrderExact: true,
      terminalQuestionOrderExact: true,
      terminalOwnerOrderExact: true,
      terminalActivationExact: true,
      productionRoutingExact: true,
      cacheIdentityExact: true,
      sourceDistinguishesDeclaredFromGeneric: true,
      rightmostGenericWins: true,
      nonOccupyingGenericsPreserveLegacyEnum: true,
      quotedGenericIsLiteral: true,
      keyDerivedFalsePositiveDetected: true,
      keyDerivedFalseNegativeDetected: true,
      forwardReverseCacheStable: true,
      paintedFaceComplete: true,
    });
    expect(classifyGenericFamilySemanticsEvidence(validOrders(), false).verdict)
      .toBe("source-drift");
    expect(classifyGenericFamilySemanticsEvidence([validOrders()[0]], true).verdict)
      .toBe("invalid-evidence");
  });

  it("rejects reverse-order cache contamination", () => {
    const orders = validOrders();
    orders[1].rows[0] = {
      ...orders[1].rows[0],
      productionCacheIdentity: "stale-forward-answer",
    };
    const result = classifyGenericFamilySemanticsEvidence(orders, true);
    expect(result.controls.forwardReverseCacheStable).toBe(false);
    expect(result.verdict).toBe("invalid-evidence");
  });

  it("authenticates the pinned source checkout and every audited source file", () => {
    const fingerprints = collectGenericFamilySourceFingerprints();
    expect(fingerprints.match).toBe(true);
    expect(Object.values(fingerprints.sourceFiles).every((entry) => entry.match)).toBe(true);
    expect(Object.keys(fingerprints.productionFiles)).toEqual(expect.arrayContaining([
      "src/render/font-resolution.ts",
      "src/render/cluster-fallback.ts",
      "src/render/win-font-fallback.ts",
    ]));
  });

  it("clears once before both orders and accepts only source-exact at the CLI", () => {
    const source = readFileSync("tools/generic-family-semantics-audit.ts", "utf8");
    expect(source.match(/clearFontResolutionCaches\(\)/g)).toHaveLength(1);
    expect(source.indexOf("clearFontResolutionCaches()"))
      .toBeLessThan(source.indexOf('for (const order of ["forward", "reverse"]'));
    expect(source).toContain('report.verdict === "source-exact"');
    expect(source).not.toContain("confirmed-information-loss");
  });
});
