import { describe, expect, it } from "vitest";

import { animatedImageTruthSha256 } from
  "../tools/animated-image-owner-resource-truth-schema.js";
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
      { pathToken: "linux-proposal-93e150ec.json", byteLength: 252529, sha256: "1218ffadfaed3d1272a79b5681d47f0d4283c5ff4293eae5138d9e813594964b" },
      { pathToken: "linux-validation-93e150ec.json", byteLength: 252574, sha256: "51f0455203bb8e5497ed59f4946c6ff651cc015338d0cb84554960294d407f0a" },
      { pathToken: "DM-2589_macos-proposal-93e150ec.json", byteLength: 251695, sha256: "53e7a5f8bf43d47545bcf13a5a930a1fbca25e69fdeb6a04143d4eb6f278d61e" },
      { pathToken: "DM-2589_macos-validation-93e150ec.json", byteLength: 252012, sha256: "e8333f8e2d19d9cff00eba6e0a4a894f72edc9db48cc935f3ea9a06153c96f08" },
    ],
    adjudication: {
      schemaVersion: 1,
      ticket: "DM-2583",
      requiredArtifactKeys: [
        "macOS/proposal",
        "macOS/validation",
        "Linux/proposal",
        "Linux/validation",
      ],
      normalizedLogicalSha256: "2af7b4b95aeac7f8bd94c2f619e7b2bbdbb9c7c676a54f0ea8b4e63940eade5a",
      verdict: "proposal-validation-agreement",
      failures: [],
    },
    reportSha256: "5be4a89902b2eeccd605226dce912be12c83db22e57567a09c63794852dddb38",
  };
}

describe("animated-image stock-CDP support adjudicator", () => {
  it("ratifies only the conservative macOS/Linux subset", () => {
    const report = adjudicateAnimatedImageStockCdpSupport(retainedArtifact());
    expect(report.verdict).toBe("supported-subset-ratified");
    expect(report.failures).toEqual([]);
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
    expect(ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET.globalWindowsVerdict)
      .toBe("withheld");
  });

  it("rejects a rewritten artifact even when its self-hash is recomputed", () => {
    const artifact = retainedArtifact();
    artifact.inputs[0] = { ...artifact.inputs[0], byteLength: 252530 };
    const { reportSha256: _old, ...payload } = artifact;
    artifact.reportSha256 = animatedImageTruthSha256(payload);
    const report = adjudicateAnimatedImageStockCdpSupport(artifact);
    expect(report.verdict).toBe("verdict-withheld");
    expect(report.normalizedLogicalSha256).toBeNull();
    expect(report.failures).toContain(
      "private-truth adjudication authority drift",
    );
    expect(report.failures).toContain(
      "retained proposal/validation artifact identity drift",
    );
  });

  it("ratifies SVG and ordinary CSS URL joins but keeps unavailable identities closed", () => {
    const decisions = new Map(ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX.map((row) =>
      [`${row.probeId}/${row.caseId}`, row]));
    expect(decisions.get("same-url-competing-requests/two-img-owners"))
      .toMatchObject({ stockDecision: "unsupported", reasonCode: "ambiguous-resource" });
    expect(decisions.get("settled-304/settled-cache-entry"))
      .toMatchObject({ stockDecision: "unsupported", reasonCode: "ambiguous-resource" });
    expect(decisions.get("service-worker-router-cache-replacement/stable-cache-route"))
      .toMatchObject({ stockDecision: "unsupported", reasonCode: "ambiguous-resource" });
    expect(decisions.get("cors-anonymous-success/anonymous"))
      .toMatchObject({ stockDecision: "unsupported", reasonCode: "cors-denied" });
    expect(decisions.get("owner-adoption-detachment/stable-svg"))
      .toMatchObject({ stockDecision: "eligible", reasonCode: null });
    expect(decisions.get("css-background-layer-reorder/layer-one"))
      .toMatchObject({ stockDecision: "eligible", reasonCode: null });
    expect(decisions.get("css-image-set-option-reorder/stable-selected-option"))
      .toMatchObject({ stockDecision: "unsupported", reasonCode: "unsupported-owner" });
    expect(decisions.get("shadow-pseudo-slot-collision/stable-closed-shadow-before"))
      .toMatchObject({
        stockDecision: "unsupported",
        reasonCode: "pseudo-or-shadow-owner-unavailable",
      });
  });
});
