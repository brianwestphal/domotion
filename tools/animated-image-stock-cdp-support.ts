/**
 * Pure macOS/Linux/Windows adjudicator for the stock-CDP animated-image byte
 * join. This module never launches Chromium or reads response bodies. It
 * reopens the retained six-arm private-truth authority and publishes only the
 * conservative public subset that production may implement.
 */
import {
  animatedImageTruthSha256,
  ANIMATED_IMAGE_TRUTH_CASES,
  type AnimatedImageTruthDenialCode,
} from "./animated-image-owner-resource-truth-schema.js";
import { readAnimatedImageTruthAdjudication } from "./animated-image-owner-resource-truth-report.js";

const RETAINED_LOGICAL_SHA256 = "2af7b4b95aeac7f8bd94c2f619e7b2bbdbb9c7c676a54f0ea8b4e63940eade5a";
const RETAINED_ADJUDICATION_SHA256 = "4d12957302a310fc83f20ef958afb5d9db10f25d93269e97bbea845b99ac865e";

export const ANIMATED_IMAGE_STOCK_CDP_EVIDENCE = Object.freeze({
  chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
  normalizedLogicalSha256: RETAINED_LOGICAL_SHA256,
  adjudicationReportSha256: RETAINED_ADJUDICATION_SHA256,
  requiredArtifactKeys: [
    "macOS/proposal",
    "macOS/validation",
    "Linux/proposal",
    "Linux/validation",
    "Windows/proposal",
    "Windows/validation",
  ],
  inputs: [
    {
      pathToken: "DM-2589_DM-2589_linux-proposal-93e150ec.json",
      byteLength: 264817,
      sha256: "7f22bf80058e4d5725f528f7cdd84482e00d0b981c45bd2f3dd6e0a1fce1b113",
    },
    {
      pathToken: "DM-2589_DM-2589_linux-validation-93e150ec.json",
      byteLength: 264862,
      sha256: "d489dd02dc75a218af94df9c9c455856bd62a69fc4db4864f235e26a64d39721",
    },
    {
      pathToken: "DM-2589_macos-proposal-93e150ec.json",
      byteLength: 263983,
      sha256: "8fde72fed6ea0b2fe3ff64c5f4b600ddc8f18c71b46e1e58262a8175a2a896be",
    },
    {
      pathToken: "DM-2589_macos-validation-93e150ec.json",
      byteLength: 264300,
      sha256: "68ffb9ec048bdfe5a6cef7d380b3c466b771f9dc40cd63d6c31c5a392dcfa1fe",
    },
    {
      pathToken: "DM-2590_windows-proposal-93e150ec.json",
      byteLength: 264180,
      sha256: "6c9bd4d594141b37c80ab043425ce82ab9b339ecef703a201a05a0f8870d4da1",
    },
    {
      pathToken: "DM-2590_windows-validation-93e150ec.json",
      byteLength: 264182,
      sha256: "78217faabf88054449a575d0fb8a4540a65a0556e625363527f0786d52e371cc",
    },
  ],
} as const);

/**
 * The smallest route set for which stock CDP can avoid a URL-only join.
 * DOM.pdl exposes structural backend-node identity but no Network.RequestId;
 * Network.pdl exposes the request/frame/loader ledger and exact response body.
 * Requiring one and only one ledger candidate closes that missing public edge.
 */
export const ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET = Object.freeze({
  protocol: "domotion-animated-image-stock-cdp-support-v1",
  scope: ["macOS/arm64", "Linux/x64", "Windows/x64"],
  globalWindowsVerdict: "ratified",
  network: {
    owners: ["img", "picture", "input[type=image]"],
    slots: ["html-current", "input-src"],
    schemes: ["http:", "https:"],
    mimeTypes: ["image/gif", "image/png", "image/webp"],
    authorization: "same-origin-only",
    requestJoin: "unique-selected-url-frame-loader",
    redirects: "settled-all-hops-same-origin",
    requiredFacts: [
      "network-attached-before-navigation",
      "document-loader-and-nonce-stable",
      "backend-owner-and-slot-stable",
      "candidate-dpr-and-viewport-stable",
      "exactly-one-request-ledger-candidate",
      "request-frame-and-loader-match-document",
      "response-and-redirect-ledger-stable",
      "loading-finished-before-get-response-body",
      "decoded-entity-length-and-sha256-stable",
    ],
    rejectedStates: [
      "cross-origin-even-when-cors-approved",
      "same-url-competing-or-shared-resource",
      "memory-or-disk-cache",
      "revalidation-or-304",
      "service-worker-or-cache-storage",
      "multipart",
    ],
  },
  publicOwnerJoin: {
    svgHref: {
      owners: ["svg image"],
      slot: "svg-href",
      selectedUrlFact: "SVGImageElement.href.baseVal resolved against document.baseURI",
      requiredFacts: [
        "unique-selector-and-backend-node",
        "connected-owner-in-stable-document",
        "href-and-resolved-url-stable-before-and-after",
        "exactly-one-selected-url-frame-loader-ledger-candidate",
      ],
    },
    ordinaryCssUrl: {
      owners: ["element computed style"],
      slots: ["background-image", "border-image-source", "mask-image", "list-style-image"],
      selectedUrlFact: "single ordinary url() at an explicit top-level computed-value index",
      requiredFacts: [
        "unique-selector-and-backend-node",
        "property-index-and-serialized-computed-value-stable-before-and-after",
        "url-token-resolved-against-document-base-url",
        "dpr-viewport-frame-loader-document-nonce-stable",
        "exactly-one-selected-url-frame-loader-ledger-candidate",
      ],
      rejectedSyntax: ["image-set()", "cross-fade()", "generated-content", "pseudo", "closed-shadow"],
    },
  },
  dataUrl: {
    owners: ["img"],
    slot: "html-current",
    transport: "parse-selected-url-once-and-hash-twice",
  },
  blobUrl: {
    owners: ["img"],
    slot: "html-current",
    transport: "same-partition-owning-document-read-and-double-hash",
  },
  unsupportedOwners: ["css-image-set-or-non-url-function", "generated-pseudo", "closed-shadow-pseudo"],
  sourceReferences: [
    "third_party/blink/public/devtools_protocol/domains/DOM.pdl:95-180",
    "third_party/blink/public/devtools_protocol/domains/Network.pdl:445-487,1167-1176,1377-1515",
    "third_party/blink/renderer/core/html/html_image_element.cc:475-514,734-750,1002-1029",
    "third_party/blink/renderer/core/loader/image_loader.cc:595-597,646-723",
    "third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc:1655-1660",
  ],
} as const);

type StockDecision = "eligible" | "deny" | "unsupported";

const ELIGIBLE_CASES = new Set([
  "img-src-mutation/stable-animated-webp",
  "img-src-mutation/stable-apng",
  "redirect-response-mime-drift/stable-redirect",
  "data-url-mutation/stable-data",
  "blob-replacement-revocation/stable-blob",
  "navigation-stale-backend-node/stable-input",
  "css-background-layer-reorder/layer-one",
  "css-background-layer-reorder/border-image",
  "css-mask-layer-reorder/mask-one",
  "owner-adoption-detachment/stable-svg",
]);

const UNSUPPORTED_AUTHORIZED_REASONS: Readonly<Record<string, AnimatedImageTruthDenialCode>> = {
  "css-image-set-option-reorder/stable-selected-option": "unsupported-owner",
  "css-background-layer-reorder/layer-one": "unsupported-owner",
  "css-background-layer-reorder/border-image": "unsupported-owner",
  "css-mask-layer-reorder/mask-one": "unsupported-owner",
  "generated-content-item-reorder/before-item-one": "unsupported-owner",
  "same-url-competing-requests/two-img-owners": "ambiguous-resource",
  "same-url-memory-cache-sharing/css-shared": "ambiguous-resource",
  "same-url-memory-cache-sharing/list-style": "ambiguous-resource",
  "settled-304/settled-cache-entry": "ambiguous-resource",
  "service-worker-router-cache-replacement/stable-cache-route": "ambiguous-resource",
  "cors-anonymous-success/anonymous": "cors-denied",
  "cors-credentials-success/credentials": "cors-denied",
  "shadow-pseudo-slot-collision/stable-closed-shadow-before": "pseudo-or-shadow-owner-unavailable",
  "owner-adoption-detachment/stable-svg": "unsupported-owner",
};

const SPECIAL_DENIAL_REASONS: Readonly<Record<string, AnimatedImageTruthDenialCode>> = {
  "active-revalidation/in-flight-validator": "revalidation-in-flight",
  "cors-failure/missing-acao": "cors-denied",
  "paintable-no-cors-denial/opaque-paintable": "opaque-response",
  "multipart-rejection/two-parts": "multipart-response",
  "owner-adoption-detachment/svg-adopt": "unsupported-owner",
  "navigation-stale-backend-node/input-navigation": "stale-document",
  "service-worker-router-cache-replacement/controller-version": "ambiguous-resource",
};

function isUnsupportedOwnerProbe(probeId: string): boolean {
  return (
    probeId.startsWith("css-") ||
    probeId === "generated-content-item-reorder" ||
    probeId === "shadow-pseudo-slot-collision"
  );
}

export const ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX = Object.freeze(
  ANIMATED_IMAGE_TRUTH_CASES.map((requiredCase) => {
    const key = `${requiredCase.probeId}/${requiredCase.caseId}`;
    let decision: StockDecision;
    let reasonCode: AnimatedImageTruthDenialCode | null;
    if (requiredCase.expected === "stable-authorized") {
      decision = ELIGIBLE_CASES.has(key) ? "eligible" : "unsupported";
      reasonCode = decision === "eligible" ? null : (UNSUPPORTED_AUTHORIZED_REASONS[key] ?? "ambiguous-resource");
    } else {
      decision = "deny";
      reasonCode =
        SPECIAL_DENIAL_REASONS[key] ??
        (isUnsupportedOwnerProbe(requiredCase.probeId) ? "unsupported-owner" : "candidate-drift");
    }
    return Object.freeze({
      probeId: requiredCase.probeId,
      caseId: requiredCase.caseId,
      privateExpected: requiredCase.expected,
      stockDecision: decision,
      reasonCode,
    });
  }),
);

export interface AnimatedImageStockCdpAdjudicationArtifact {
  schemaVersion: 1;
  ticket: "DM-2583";
  stage: "animated-image-owner-resource-truth-adjudication";
  inputs: Array<{ pathToken: string; byteLength: number; sha256: string }>;
  adjudication: {
    schemaVersion: 1;
    ticket: "DM-2583";
    requiredArtifactKeys: string[];
    normalizedLogicalSha256: string | null;
    verdict: "proposal-validation-agreement" | "verdict-withheld";
    failures: string[];
  };
  reportSha256: string;
}

export interface AnimatedImageStockCdpSupportReport {
  schemaVersion: 1;
  ticket: "DM-2584";
  stage: "animated-image-stock-cdp-support";
  scope: "macOS-linux-windows";
  verdict: "supported-subset-ratified" | "verdict-withheld";
  normalizedLogicalSha256: string | null;
  matrixSha256: string;
  eligibleCaseKeys: string[];
  failures: string[];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function adjudicateAnimatedImageStockCdpSupport(
  artifact: AnimatedImageStockCdpAdjudicationArtifact,
): AnimatedImageStockCdpSupportReport {
  const failures: string[] = [];
  if (
    artifact.schemaVersion !== 1 ||
    artifact.ticket !== "DM-2583" ||
    artifact.stage !== "animated-image-owner-resource-truth-adjudication"
  ) {
    failures.push("private-truth adjudication envelope drift");
  }
  const { reportSha256: _reportedSha256, ...payload } = artifact;
  if (animatedImageTruthSha256(payload) !== artifact.reportSha256) {
    failures.push("private-truth adjudication self-hash mismatch");
  }
  if (artifact.reportSha256 !== RETAINED_ADJUDICATION_SHA256) {
    failures.push("private-truth adjudication authority drift");
  }
  if (!sameJson(artifact.inputs, ANIMATED_IMAGE_STOCK_CDP_EVIDENCE.inputs)) {
    failures.push("retained proposal/validation artifact identity drift");
  }
  if (!sameJson(artifact.adjudication.requiredArtifactKeys, ANIMATED_IMAGE_STOCK_CDP_EVIDENCE.requiredArtifactKeys)) {
    failures.push("macOS/Linux/Windows artifact-key set drift");
  }
  if (
    artifact.adjudication.verdict !== "proposal-validation-agreement" ||
    artifact.adjudication.failures.length !== 0 ||
    artifact.adjudication.normalizedLogicalSha256 !== RETAINED_LOGICAL_SHA256
  ) {
    failures.push("private-truth logical agreement is absent or changed");
  }

  const eligibleCaseKeys = ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX.filter(
    (entry) => entry.stockDecision === "eligible",
  ).map((entry) => `${entry.probeId}/${entry.caseId}`);
  const matrixSha256 = animatedImageTruthSha256({
    evidence: ANIMATED_IMAGE_STOCK_CDP_EVIDENCE,
    supportedSubset: ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET,
    cases: ANIMATED_IMAGE_STOCK_CDP_CASE_MATRIX,
  });
  return {
    schemaVersion: 1,
    ticket: "DM-2584",
    stage: "animated-image-stock-cdp-support",
    scope: "macOS-linux-windows",
    verdict: failures.length === 0 ? "supported-subset-ratified" : "verdict-withheld",
    normalizedLogicalSha256: failures.length === 0 ? RETAINED_LOGICAL_SHA256 : null,
    matrixSha256,
    eligibleCaseKeys,
    failures,
  };
}

/** Reopen a retained adjudication in either the current envelope or explicit v1 flat format. */
export function adjudicateAnimatedImageStockCdpSupportFile(path: string): AnimatedImageStockCdpSupportReport {
  return adjudicateAnimatedImageStockCdpSupport(
    readAnimatedImageTruthAdjudication(path) as unknown as AnimatedImageStockCdpAdjudicationArtifact,
  );
}
