import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { animatedImageTruthSha256 } from "../tools/animated-image-owner-resource-truth-schema.js";
import {
  adjudicateAnimatedImageStockCdpSupport,
  adjudicateAnimatedImageStockCdpSupportFile,
  ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX,
  ANIMATED_IMAGE_STOCK_CDP_EVIDENCE,
  ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET,
  type AnimatedImageStockCdpAdjudicationArtifact,
} from "../tools/animated-image-stock-cdp-support.js";

function retainedArtifact(): AnimatedImageStockCdpAdjudicationArtifact {
  return {
    schemaVersion: 1,
    ticket: "DM-2583",
    stage: "animated-image-owner-resource-truth-adjudication",
    inputs: ANIMATED_IMAGE_STOCK_CDP_EVIDENCE.inputs.map((input) => ({ ...input })),
    adjudication: {
      schemaVersion: 1,
      ticket: "DM-2583",
      requiredArtifactKeys: [
        "macOS/proposal",
        "macOS/validation",
        "Linux/proposal",
        "Linux/validation",
        "Windows/proposal",
        "Windows/validation",
      ],
      normalizedLogicalSha256: "2af7b4b95aeac7f8bd94c2f619e7b2bbdbb9c7c676a54f0ea8b4e63940eade5a",
      verdict: "proposal-validation-agreement",
      failures: [],
    },
    reportSha256: "4d12957302a310fc83f20ef958afb5d9db10f25d93269e97bbea845b99ac865e",
  };
}

describe("animated-image stock-CDP support adjudicator", () => {
  it("reads current envelope and explicit flat v1 authority, while rejecting version drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "animated-image-truth-"));
    const artifact = retainedArtifact();
    const file = join(dir, "adjudication.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        tool: "animated-image-owner-resource-truth-adjudicator",
        generatedAt: new Date().toISOString(),
        env: {},
        data: { ...artifact, outcome: "pass" },
      }),
    );
    expect(adjudicateAnimatedImageStockCdpSupportFile(file).verdict).toBe("supported-subset-ratified");
    writeFileSync(file, JSON.stringify(artifact));
    expect(adjudicateAnimatedImageStockCdpSupportFile(file).verdict).toBe("supported-subset-ratified");
    writeFileSync(file, JSON.stringify({ ...artifact, schemaVersion: 2 }));
    expect(() => adjudicateAnimatedImageStockCdpSupportFile(file)).toThrow();
    writeFileSync(file, JSON.stringify({ tool: "wrong", data: { ...artifact, outcome: "pass" } }));
    expect(() => adjudicateAnimatedImageStockCdpSupportFile(file)).toThrow();
  });

  it("ratifies the conservative macOS/Linux/Windows subset from the six retained artifacts", () => {
    const report = adjudicateAnimatedImageStockCdpSupport(retainedArtifact());
    expect(report.verdict).toBe("supported-subset-ratified");
    expect(report.failures).toEqual([]);
    expect(report.scope).toBe("macOS-linux-windows");
    expect(report.matrixSha256).toBe("db6e145d373869093018ed7232f70948496aa6409d75e829e471ee051b23118e");
    expect(report.eligibleCaseKeys).toEqual([
      "img-src-mutation/stable-animated-webp",
      "img-src-mutation/stable-apng",
      "css-background-layer-reorder/layer-one",
      "css-background-layer-reorder/border-image",
      "css-mask-layer-reorder/mask-one",
      "redirect-response-mime-drift/stable-redirect",
      "data-url-mutation/stable-data",
      "blob-replacement-revocation/stable-blob",
      "owner-adoption-detachment/stable-svg",
      "navigation-stale-backend-node/stable-input",
    ]);
    expect(ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX).toHaveLength(38);
    expect(ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET.scope).toEqual(["macOS/arm64", "Linux/x64", "Windows/x64"]);
    expect(ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET.globalWindowsVerdict).toBe("ratified");
  });

  it("rejects a rewritten artifact even when its self-hash is recomputed", () => {
    const artifact = retainedArtifact();
    artifact.inputs[5] = { ...artifact.inputs[5], byteLength: 264183 };
    const { reportSha256: _old, ...payload } = artifact;
    artifact.reportSha256 = animatedImageTruthSha256(payload);
    const report = adjudicateAnimatedImageStockCdpSupport(artifact);
    expect(report.verdict).toBe("verdict-withheld");
    expect(report.normalizedLogicalSha256).toBeNull();
    expect(report.failures).toContain("private-truth adjudication authority drift");
    expect(report.failures).toContain("retained proposal/validation artifact identity drift");
  });

  it("rejects the old four-artifact authority even with a valid self-hash", () => {
    const artifact = retainedArtifact();
    artifact.inputs = artifact.inputs.slice(0, 4);
    artifact.adjudication.requiredArtifactKeys = artifact.adjudication.requiredArtifactKeys.slice(0, 4);
    const { reportSha256: _old, ...payload } = artifact;
    artifact.reportSha256 = animatedImageTruthSha256(payload);
    const report = adjudicateAnimatedImageStockCdpSupport(artifact);
    expect(report.verdict).toBe("verdict-withheld");
    expect(report.failures).toContain("retained proposal/validation artifact identity drift");
    expect(report.failures).toContain("macOS/Linux/Windows artifact-key set drift");
  });

  it("rejects an artifact whose report self-hash is invalid", () => {
    const artifact = retainedArtifact();
    artifact.reportSha256 = "0".repeat(64);
    const report = adjudicateAnimatedImageStockCdpSupport(artifact);
    expect(report.verdict).toBe("verdict-withheld");
    expect(report.failures).toContain("private-truth adjudication self-hash mismatch");
  });

  it("ratifies SVG and ordinary CSS URL joins but keeps unavailable identities closed", () => {
    const decisions = new Map(ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX.map((row) => [`${row.probeId}/${row.caseId}`, row]));
    expect(decisions.get("same-url-competing-requests/two-img-owners")).toMatchObject({
      stockDecision: "unsupported",
      reasonCode: "ambiguous-resource",
    });
    expect(decisions.get("settled-304/settled-cache-entry")).toMatchObject({
      stockDecision: "unsupported",
      reasonCode: "ambiguous-resource",
    });
    expect(decisions.get("service-worker-router-cache-replacement/stable-cache-route")).toMatchObject({
      stockDecision: "unsupported",
      reasonCode: "ambiguous-resource",
    });
    expect(decisions.get("cors-anonymous-success/anonymous")).toMatchObject({
      stockDecision: "unsupported",
      reasonCode: "cors-denied",
    });
    expect(decisions.get("owner-adoption-detachment/stable-svg")).toMatchObject({
      stockDecision: "eligible",
      reasonCode: null,
    });
    expect(decisions.get("css-background-layer-reorder/layer-one")).toMatchObject({
      stockDecision: "eligible",
      reasonCode: null,
    });
    expect(decisions.get("css-image-set-option-reorder/stable-selected-option")).toMatchObject({
      stockDecision: "unsupported",
      reasonCode: "unsupported-owner",
    });
    expect(decisions.get("shadow-pseudo-slot-collision/stable-closed-shadow-before")).toMatchObject({
      stockDecision: "unsupported",
      reasonCode: "pseudo-or-shadow-owner-unavailable",
    });
  });
});
