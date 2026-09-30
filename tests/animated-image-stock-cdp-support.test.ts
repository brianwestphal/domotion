import { describe, expect, it } from "vitest";

import { animatedImageTruthSha256 } from "../tools/animated-image-owner-resource-truth-schema.js";
import {
  adjudicateAnimatedImageStockCdpSupport,
  ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX,
  ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET,
  type AnimatedImageStockCdpAdjudicationArtifact,
} from "../tools/animated-image-stock-cdp-support.js";

function retainedArtifact(): AnimatedImageStockCdpAdjudicationArtifact {
  return {
    schemaVersion: 1,
    ticket: "DM-2583",
    stage: "animated-image-owner-resource-truth-adjudication",
    inputs: [
      {
        pathToken: "DM-2589_DM-2589_linux-proposal-93e150ec.json",
        byteLength: 252529,
        sha256: "1218ffadfaed3d1272a79b5681d47f0d4283c5ff4293eae5138d9e813594964b",
      },
      {
        pathToken: "DM-2589_DM-2589_linux-validation-93e150ec.json",
        byteLength: 252574,
        sha256: "51f0455203bb8e5497ed59f4946c6ff651cc015338d0cb84554960294d407f0a",
      },
      {
        pathToken: "DM-2589_macos-proposal-93e150ec.json",
        byteLength: 251695,
        sha256: "53e7a5f8bf43d47545bcf13a5a930a1fbca25e69fdeb6a04143d4eb6f278d61e",
      },
      {
        pathToken: "DM-2589_macos-validation-93e150ec.json",
        byteLength: 252012,
        sha256: "e8333f8e2d19d9cff00eba6e0a4a894f72edc9db48cc935f3ea9a06153c96f08",
      },
      {
        pathToken: "DM-2590_windows-proposal-93e150ec.json",
        byteLength: 251892,
        sha256: "08f5b6e94451059f7c54092cb88b702d7953a2055ce28a22c6566f8664d9496a",
      },
      {
        pathToken: "DM-2590_windows-validation-93e150ec.json",
        byteLength: 251894,
        sha256: "bfcf819316b2c2813dec0bf7db0d7a7a8168fea303247772e17a5ce8669246ce",
      },
    ],
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
    reportSha256: "2c54d2a41a0f50e21dc9ecc2075d5eaaa4d110e534a7f6a3e2de163ddd6892f0",
  };
}

describe("animated-image stock-CDP support adjudicator", () => {
  it("ratifies the conservative macOS/Linux/Windows subset from the six retained artifacts", () => {
    const report = adjudicateAnimatedImageStockCdpSupport(retainedArtifact());
    expect(report.verdict).toBe("supported-subset-ratified");
    expect(report.failures).toEqual([]);
    expect(report.scope).toBe("macOS-linux-windows");
    expect(report.matrixSha256).toBe("a2aac9de58fcfcf095a6c09e48e135ee98fe9b225debaa5833072a242404712a");
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
    artifact.inputs[5] = { ...artifact.inputs[5], byteLength: 251895 };
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
