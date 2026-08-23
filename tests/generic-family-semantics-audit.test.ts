import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  GENERIC_FAMILY_SEMANTICS_CASES,
  adjudicateGenericFamilySemanticsRow,
  blinkGenericFamilyFromComputedStack,
  classifyGenericFamilySemanticsEvidence,
  keyInferredWinFallbackMode,
  sourceWinFallbackMode,
  splitComputedFontFamily,
  type GenericFamilySemanticsOrder,
  type GenericFamilySemanticsRow,
} from "../tools/generic-family-semantics-audit.js";
import { blinkWinHardcodedFamilies } from "../src/render/win-font-fallback.js";
import {
  __resolveSystemFallbackKeyForCpForTest,
  __systemFallbackKeyCacheSizeForTest,
  blinkGenericFamilyFromDeclaredStack,
  clearFontResolutionCaches,
  declaredFamilyHeadIdentity,
} from "../src/render/font-resolution.js";
import { withHostPlatform } from "../src/render/host-platform.js";

function candidateOrder(codepoint: number, generic: "standard" | "monospace"): string[] {
  return blinkWinHardcodedFamilies(codepoint, { generic, priority: "text" }, () => true);
}

function validRow(
  spec = GENERIC_FAMILY_SEMANTICS_CASES[0],
  order: GenericFamilySemanticsOrder["order"] = "forward",
): GenericFamilySemanticsRow {
  const sourceGeneric = blinkGenericFamilyFromComputedStack(spec.fontFamily);
  const sourceFallbackMode = sourceWinFallbackMode(sourceGeneric);
  const primaryKey = spec.stackId === "arial-then-monospace"
    ? "helvetica"
    : spec.stackId === "serif-then-monospace"
      ? "times"
      : "courier";
  const keyInferredFallbackMode = keyInferredWinFallbackMode(primaryKey);
  return adjudicateGenericFamilySemanticsRow({
    id: spec.id,
    order,
    stackId: spec.stackId,
    scriptId: spec.scriptId,
    lang: spec.lang,
    codepoint: spec.codepoint,
    requestedFontFamily: spec.fontFamily,
    computedFontFamily: spec.fontFamily,
    expectedGeneric: spec.expectedGeneric,
    sourceGeneric,
    sourceFallbackMode,
    productionGeneric: sourceGeneric,
    productionFallbackMode: sourceFallbackMode,
    productionCandidateOrder: candidateOrder(spec.codepoint, sourceFallbackMode),
    primaryKey,
    keyInferredFallbackMode,
    sourceCandidateOrder: candidateOrder(spec.codepoint, sourceFallbackMode),
    keyInferredCandidateOrder: candidateOrder(spec.codepoint, keyInferredFallbackMode),
    semanticLoss: sourceFallbackMode !== keyInferredFallbackMode,
    paintedFaces: [{
      familyName: "Measured Face",
      postScriptName: "MeasuredFace-Regular",
      isCustomFont: false,
      glyphCount: 1,
    }],
  });
}

function validOrders(): GenericFamilySemanticsOrder[] {
  return ["forward", "reverse"].map((order) => ({
    order: order as GenericFamilySemanticsOrder["order"],
    rows: (order === "forward"
      ? GENERIC_FAMILY_SEMANTICS_CASES
      : [...GENERIC_FAMILY_SEMANTICS_CASES].reverse()
    ).map((spec) => validRow(spec, order as GenericFamilySemanticsOrder["order"])),
  }));
}

describe("generic-family semantic ownership audit", () => {
  it("keeps quoted commas and quoted generic-looking names literal", () => {
    expect(splitComputedFontFamily('"A, B", Courier, \'monospace\''))
      .toEqual([
        { value: "A, B", quoted: true },
        { value: "Courier", quoted: false },
        { value: "monospace", quoted: true },
      ]);
    expect(blinkGenericFamilyFromComputedStack('"monospace", Courier')).toBe("none");
  });

  it("models Blink's rightmost enum-bearing generic independently of the resolved face", () => {
    expect(blinkGenericFamilyFromComputedStack("Courier")).toBe("none");
    expect(blinkGenericFamilyFromComputedStack("Courier, MONOSPACE")).toBe("monospace");
    expect(blinkGenericFamilyFromComputedStack("Courier, monospace, serif")).toBe("serif");
    expect(blinkGenericFamilyFromComputedStack("Arial, monospace")).toBe("monospace");
    expect(blinkGenericFamilyFromComputedStack("monospace, serif")).toBe("serif");
    expect(blinkGenericFamilyFromComputedStack("serif, monospace")).toBe("monospace");
    expect(blinkGenericFamilyFromComputedStack("Courier, system-ui")).toBe("none");
    expect(blinkGenericFamilyFromComputedStack("monospace, math")).toBe("monospace");
    expect(sourceWinFallbackMode("none")).toBe("standard");
    expect(sourceWinFallbackMode("serif")).toBe("standard");
    expect(sourceWinFallbackMode("monospace")).toBe("monospace");
  });

  it("keeps the production carrier in exact agreement with the independent source model", () => {
    for (const row of GENERIC_FAMILY_SEMANTICS_CASES) {
      expect(blinkGenericFamilyFromDeclaredStack(row.fontFamily))
        .toBe(blinkGenericFamilyFromComputedStack(row.fontFamily));
    }
  });

  it("keys the system-fallback memo by declared head and node kind", () => {
    expect(declaredFamilyHeadIdentity("monospace")).toBe("generic:monospace");
    expect(declaredFamilyHeadIdentity('"monospace"')).toBe("name:monospace");
    expect(declaredFamilyHeadIdentity("Courier, serif")).toBe("name:courier");
    expect(declaredFamilyHeadIdentity("Arial, monospace")).toBe("name:arial");
  });

  it("does not reuse the process memo across declared heads in either order", () => {
    const ask = (family: string) => withHostPlatform("linux", () =>
      __resolveSystemFallbackKeyForCpForTest(0x10D0, 400, 0, 16, "helvetica", false,
        "ka", 100, undefined, family));
    for (const order of [["Courier", "Arial"], ["Arial", "Courier"]] as const) {
      clearFontResolutionCaches();
      ask(order[0]);
      expect(__systemFallbackKeyCacheSizeForTest()).toBe(1);
      ask(order[1]);
      expect(__systemFallbackKeyCacheSizeForTest()).toBe(2);
      ask(order[0]);
      expect(__systemFallbackKeyCacheSizeForTest()).toBe(2);
    }
  });

  it("freezes the current key-derived seam without treating it as source truth", () => {
    expect(keyInferredWinFallbackMode("courier")).toBe("monospace");
    expect(keyInferredWinFallbackMode("courier-new")).toBe("standard");
    expect(keyInferredWinFallbackMode("times")).toBe("standard");
  });

  it.each([
    ["generic-enum", (row: GenericFamilySemanticsRow) => ({ ...row, sourceGeneric: "monospace" as const })],
    ["fallback-mode", (row: GenericFamilySemanticsRow) => ({ ...row, sourceFallbackMode: "monospace" as const })],
    ["source-candidate-order", (row: GenericFamilySemanticsRow) => ({ ...row, sourceCandidateOrder: ["Wrong"] })],
    ["key-candidate-order", (row: GenericFamilySemanticsRow) => ({ ...row, keyInferredCandidateOrder: ["Wrong"] })],
    ["loss-classification", (row: GenericFamilySemanticsRow) => ({ ...row, semanticLoss: !row.semanticLoss })],
    ["primary-key", (row: GenericFamilySemanticsRow) => ({ ...row, primaryKey: "" })],
    ["painted-face-completeness", (row: GenericFamilySemanticsRow) => ({ ...row, paintedFaces: [] })],
  ])("rejects the %s hostile mutation", (blocker, mutate) => {
    const row = validRow();
    const { pass: _pass, blockers: _blockers, ...input } = mutate(row);
    expect(adjudicateGenericFamilySemanticsRow(input).blockers).toContain(blocker);
  });

  it("requires the complete two-order matrix and the known source discriminator", () => {
    const orders = validOrders();
    expect(classifyGenericFamilySemanticsEvidence(orders, true)).toEqual({
      controls: {
        completeMatrix: true,
        sourceDistinguishesDeclaredFromGeneric: true,
        rightmostGenericWins: true,
        nonOccupyingGenericsPreserveLegacyEnum: true,
        quotedGenericIsLiteral: true,
        currentRoutingLosesDeclaredCourier: true,
        currentRoutingLosesNonCourierMonospace: true,
        forwardReverseStable: true,
      },
      verdict: "confirmed-information-loss",
    });
    expect(classifyGenericFamilySemanticsEvidence(orders, false).verdict).toBe("source-exact");
    expect(classifyGenericFamilySemanticsEvidence([orders[0]], true).verdict).toBe("invalid-evidence");
  });

  it("rejects order-dependent cache evidence", () => {
    const orders = validOrders();
    orders[1].rows[0] = { ...orders[1].rows[0], primaryKey: "mutated" };
    expect(classifyGenericFamilySemanticsEvidence(orders, true).controls.forwardReverseStable)
      .toBe(false);
  });

  it("clears process caches once before both order arms, never between them", () => {
    const source = readFileSync("tools/generic-family-semantics-audit.ts", "utf8");
    expect(source.match(/clearFontResolutionCaches\(\)/g)).toHaveLength(1);
    expect(source.indexOf("clearFontResolutionCaches()"))
      .toBeLessThan(source.indexOf('for (const order of ["forward", "reverse"]'));
  });
});
