/**
 * Stable evidence contract and pure adjudicator for DM-2583.
 *
 * This module is deliberately independent of production capture. It describes
 * the output of the pinned private Blink oracle and rejects any report that
 * retains body facts after an authorization or transaction failure.
 */
import { createHash } from "node:crypto";

export const ANIMATED_IMAGE_TRUTH_PROTOCOL =
  "domotion-animated-image-bytes-v1" as const;
export const ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3" as const;
export const ANIMATED_IMAGE_TRUTH_PATCH_SHA256 =
  "93e150ec097a69dd4ef923bc223570ca7da3c647526cf147b1b3c3b1170e174f" as const;
export const ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256 =
  "3dc66cab6e2982a336eb275cc808a260b590b535ed304a0701c43350f3b838cd" as const;
export const ANIMATED_IMAGE_TRUTH_BROWSER_VERSION = "151.0.7918.0" as const;
export const ANIMATED_IMAGE_TRUTH_SCHEMA_VERSION = 1 as const;
export const ANIMATED_IMAGE_TRUTH_OWNER_SELECTOR_TOKEN =
  /^[A-Za-z0-9._-]{1,128}$/;

export const ANIMATED_IMAGE_TRUTH_LIMITS = Object.freeze({
  maximumTransactions: 128,
  maximumResourceBytes: 64 * 1024 * 1024,
  maximumTransactionBytes: 256 * 1024 * 1024,
  maximumRedirects: 20,
  inspectorTotalBufferBytes: 256 * 1024 * 1024,
  inspectorResourceBufferBytes: 64 * 1024 * 1024,
});

export const ANIMATED_IMAGE_TRUTH_DENIAL_CODES = [
  "strict-owner-not-found",
  "owner-detached",
  "unsupported-owner",
  "unsupported-slot",
  "pseudo-or-shadow-owner-unavailable",
  "stale-document",
  "navigation-drift",
  "candidate-pending",
  "candidate-drift",
  "ambiguous-resource",
  "missing-request-ledger",
  "request-drift",
  "redirect-drift",
  "response-drift",
  "revalidation-in-flight",
  "service-worker-drift",
  "cache-entry-drift",
  "body-evicted",
  "body-limit-exceeded",
  "body-length-mismatch",
  "body-digest-mismatch",
  "cors-denied",
  "opaque-response",
  "credential-mode-mismatch",
  "multiple-security-origins",
  "unsupported-mime",
  "mime-mismatch",
  "multipart-response",
  "data-url-parse-failed",
  "blob-unavailable",
  "unsupported-scheme",
] as const;

export type AnimatedImageTruthDenialCode =
  typeof ANIMATED_IMAGE_TRUTH_DENIAL_CODES[number];

export const ANIMATED_IMAGE_TRUTH_PROPERTIES = [
  "html-current",
  "svg-href",
  "input-src",
  "background-image",
  "content",
  "list-style-image",
  "border-image-source",
  "mask-image",
] as const;

export type AnimatedImageTruthProperty =
  typeof ANIMATED_IMAGE_TRUTH_PROPERTIES[number];

export const ANIMATED_IMAGE_TRUTH_PROBES = [
  "img-src-mutation",
  "picture-srcset-media-dpr-mutation",
  "css-image-set-option-reorder",
  "css-background-layer-reorder",
  "css-mask-layer-reorder",
  "generated-content-item-reorder",
  "same-url-competing-requests",
  "same-url-memory-cache-sharing",
  "redirect-response-mime-drift",
  "settled-304",
  "active-revalidation",
  "service-worker-router-cache-replacement",
  "cors-anonymous-success",
  "cors-credentials-success",
  "cors-failure",
  "paintable-no-cors-denial",
  "data-url-mutation",
  "blob-replacement-revocation",
  "multipart-rejection",
  "shadow-pseudo-slot-collision",
  "owner-adoption-detachment",
  "navigation-stale-backend-node",
] as const;

export type AnimatedImageTruthProbeId =
  typeof ANIMATED_IMAGE_TRUTH_PROBES[number];

export type AnimatedImageTruthExpectedOutcome =
  | "stable-authorized"
  | "stable-denied"
  | "reject-drift";

export interface AnimatedImageTruthCaseRequirement {
  probeId: AnimatedImageTruthProbeId;
  caseId: string;
  expected: AnimatedImageTruthExpectedOutcome;
  property: AnimatedImageTruthProperty;
  index: number;
  pseudoType?: string;
}

export const ANIMATED_IMAGE_TRUTH_CASES:
readonly AnimatedImageTruthCaseRequirement[] = Object.freeze([
  { probeId: "img-src-mutation", caseId: "replace-src", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "img-src-mutation", caseId: "stable-animated-webp", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "img-src-mutation", caseId: "stable-apng", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "picture-srcset-media-dpr-mutation", caseId: "source-order", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "picture-srcset-media-dpr-mutation", caseId: "dpr-change", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "css-image-set-option-reorder", caseId: "selected-option", expected: "reject-drift", property: "background-image", index: 0 },
  { probeId: "css-image-set-option-reorder", caseId: "stable-selected-option", expected: "stable-authorized", property: "background-image", index: 0 },
  { probeId: "css-background-layer-reorder", caseId: "layer-zero", expected: "reject-drift", property: "background-image", index: 0 },
  { probeId: "css-background-layer-reorder", caseId: "layer-one", expected: "stable-authorized", property: "background-image", index: 1 },
  { probeId: "css-background-layer-reorder", caseId: "border-image", expected: "stable-authorized", property: "border-image-source", index: 0 },
  { probeId: "css-mask-layer-reorder", caseId: "mask-zero", expected: "reject-drift", property: "mask-image", index: 0 },
  { probeId: "css-mask-layer-reorder", caseId: "mask-one", expected: "stable-authorized", property: "mask-image", index: 1 },
  { probeId: "generated-content-item-reorder", caseId: "before-item-zero", expected: "reject-drift", property: "content", index: 0, pseudoType: "before" },
  { probeId: "generated-content-item-reorder", caseId: "before-item-one", expected: "stable-authorized", property: "content", index: 1, pseudoType: "before" },
  { probeId: "same-url-competing-requests", caseId: "two-img-owners", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "same-url-memory-cache-sharing", caseId: "css-shared", expected: "stable-authorized", property: "background-image", index: 0 },
  { probeId: "same-url-memory-cache-sharing", caseId: "list-style", expected: "stable-authorized", property: "list-style-image", index: 0 },
  { probeId: "redirect-response-mime-drift", caseId: "redirect-destination", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "redirect-response-mime-drift", caseId: "stable-redirect", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "settled-304", caseId: "settled-cache-entry", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "active-revalidation", caseId: "in-flight-validator", expected: "stable-denied", property: "html-current", index: 0 },
  { probeId: "service-worker-router-cache-replacement", caseId: "stable-cache-route", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "service-worker-router-cache-replacement", caseId: "controller-version", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "cors-anonymous-success", caseId: "anonymous", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "cors-credentials-success", caseId: "credentials", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "cors-failure", caseId: "missing-acao", expected: "stable-denied", property: "html-current", index: 0 },
  { probeId: "paintable-no-cors-denial", caseId: "opaque-paintable", expected: "stable-denied", property: "html-current", index: 0 },
  { probeId: "data-url-mutation", caseId: "stable-data", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "data-url-mutation", caseId: "payload-replacement", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "blob-replacement-revocation", caseId: "stable-blob", expected: "stable-authorized", property: "html-current", index: 0 },
  { probeId: "blob-replacement-revocation", caseId: "revoke-and-replace", expected: "reject-drift", property: "html-current", index: 0 },
  { probeId: "multipart-rejection", caseId: "two-parts", expected: "stable-denied", property: "html-current", index: 0 },
  { probeId: "shadow-pseudo-slot-collision", caseId: "stable-closed-shadow-before", expected: "stable-authorized", property: "content", index: 0, pseudoType: "before" },
  { probeId: "shadow-pseudo-slot-collision", caseId: "closed-shadow-before", expected: "reject-drift", property: "content", index: 0, pseudoType: "before" },
  { probeId: "owner-adoption-detachment", caseId: "stable-svg", expected: "stable-authorized", property: "svg-href", index: 0 },
  { probeId: "owner-adoption-detachment", caseId: "svg-adopt", expected: "reject-drift", property: "svg-href", index: 0 },
  { probeId: "navigation-stale-backend-node", caseId: "stable-input", expected: "stable-authorized", property: "input-src", index: 0 },
  { probeId: "navigation-stale-backend-node", caseId: "input-navigation", expected: "reject-drift", property: "input-src", index: 0 },
]);

export interface AnimatedImageTruthProbeRequirement {
  probeId: AnimatedImageTruthProbeId;
  properties: AnimatedImageTruthProperty[];
  expected: AnimatedImageTruthExpectedOutcome[];
  sourceReferences: string[];
  mutatedFacts: string[];
}

export const ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS:
readonly AnimatedImageTruthProbeRequirement[] = Object.freeze([
  { probeId: "img-src-mutation", properties: ["html-current"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/loader/image_loader.cc:595-597,646-723"], mutatedFacts: ["selected content pointer", "currentSrc", "request id"] },
  { probeId: "picture-srcset-media-dpr-mutation", properties: ["html-current"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/html/html_image_element.cc:475-514,734-750,1002-1029"], mutatedFacts: ["source order", "srcset", "sizes", "media", "DPR", "viewport"] },
  { probeId: "css-image-set-option-reorder", properties: ["background-image"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/css/css_image_set_value.cc:46-105,118-122", "third_party/blink/renderer/core/css/resolver/element_style_resources.cc:417-500"], mutatedFacts: ["selected StyleImage", "selected image-set option index"] },
  { probeId: "css-background-layer-reorder", properties: ["background-image", "border-image-source"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/css/resolver/element_style_resources.cc:417-500"], mutatedFacts: ["ordered background layer", "selected content pointer"] },
  { probeId: "css-mask-layer-reorder", properties: ["mask-image"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/css/resolver/element_style_resources.cc:491-500"], mutatedFacts: ["ordered mask layer", "anonymous-CORS selection"] },
  { probeId: "generated-content-item-reorder", properties: ["content"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/css/properties/longhands/longhands_custom.cc:3267-3291", "third_party/blink/renderer/core/style/content_data.h:108-166"], mutatedFacts: ["pseudo identity", "ordered ContentData item"] },
  { probeId: "same-url-competing-requests", properties: ["html-current", "background-image"], expected: ["stable-authorized", "stable-denied"], sourceReferences: ["third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc:1655-1660"], mutatedFacts: ["exact Resource pointer", "inspector request id"] },
  { probeId: "same-url-memory-cache-sharing", properties: ["background-image", "list-style-image"], expected: ["stable-authorized", "stable-denied"], sourceReferences: ["third_party/blink/renderer/core/css/style_image_cache.cc:24-37", "third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc:1655-1660"], mutatedFacts: ["shared content pointer", "memory-cache request relation"] },
  { probeId: "redirect-response-mime-drift", properties: ["html-current"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/platform/loader/fetch/resource.cc:573-605", "third_party/blink/renderer/platform/loader/fetch/resource_response.h:99-130"], mutatedFacts: ["redirect hops", "status", "response URL", "MIME", "body SHA"] },
  { probeId: "settled-304", properties: ["html-current"], expected: ["stable-authorized"], sourceReferences: ["third_party/blink/renderer/platform/loader/fetch/resource.cc:1032-1055", "third_party/blink/renderer/core/inspector/inspector_network_agent.cc:1698-1705"], mutatedFacts: ["revalidation count", "last validation status", "retained body"] },
  { probeId: "active-revalidation", properties: ["html-current"], expected: ["stable-denied", "reject-drift"], sourceReferences: ["third_party/blink/renderer/platform/loader/fetch/resource.cc:1032-1055"], mutatedFacts: ["IsCacheValidator", "response sequence"] },
  { probeId: "service-worker-router-cache-replacement", properties: ["html-current"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/platform/loader/fetch/resource_response.cc:137-166", "third_party/blink/renderer/platform/loader/fetch/resource_response.h:227-280,648-665"], mutatedFacts: ["service-worker source", "router", "URL list", "CacheStorage name"] },
  { probeId: "cors-anonymous-success", properties: ["html-current", "mask-image"], expected: ["stable-authorized"], sourceReferences: ["third_party/blink/renderer/platform/loader/fetch/fetch_parameters.cc:54-87", "third_party/blink/renderer/core/loader/resource/image_resource_content.cc:660-664"], mutatedFacts: ["request mode", "same-origin credentials", "Fetch response type"] },
  { probeId: "cors-credentials-success", properties: ["html-current"], expected: ["stable-authorized"], sourceReferences: ["third_party/blink/renderer/core/loader/image_loader.cc:337-346", "third_party/blink/renderer/platform/loader/fetch/fetch_parameters.cc:54-87"], mutatedFacts: ["include credentials", "origin-clean response"] },
  { probeId: "cors-failure", properties: ["html-current", "mask-image"], expected: ["stable-denied"], sourceReferences: ["third_party/blink/renderer/core/loader/resource/image_resource.cc:689-696"], mutatedFacts: ["failed CORS", "body-free denial"] },
  { probeId: "paintable-no-cors-denial", properties: ["html-current", "background-image"], expected: ["stable-denied"], sourceReferences: ["third_party/blink/renderer/core/inspector/inspector_network_agent.cc:2767-2796", "third_party/blink/renderer/core/loader/resource/image_resource_content.cc:660-664"], mutatedFacts: ["debugger body availability", "corsSameOrigin=false", "discarded body"] },
  { probeId: "data-url-mutation", properties: ["html-current", "background-image"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/loader/resource/image_resource_content.cc:316-319"], mutatedFacts: ["selected data URL", "parsed length", "parsed SHA"] },
  { probeId: "blob-replacement-revocation", properties: ["html-current"], expected: ["stable-authorized", "stable-denied", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/loader/resource/image_resource_content.cc:316-319"], mutatedFacts: ["blob URL", "owning document", "revocation", "double SHA"] },
  { probeId: "multipart-rejection", properties: ["html-current"], expected: ["stable-denied"], sourceReferences: ["third_party/blink/renderer/core/loader/resource/image_resource.cc:609-618,652-686"], mutatedFacts: ["multipart response", "mutable part buffer"] },
  { probeId: "shadow-pseudo-slot-collision", properties: ["content", "background-image"], expected: ["stable-authorized", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/css/properties/longhands/longhands_custom.cc:3267-3291", "third_party/blink/renderer/core/style/content_data.h:108-166"], mutatedFacts: ["shadow host chain", "root mode", "pseudo type", "slot index"] },
  { probeId: "owner-adoption-detachment", properties: ["html-current", "svg-href"], expected: ["stable-authorized", "stable-denied", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/svg/svg_image_element.cc:176-179", "third_party/blink/renderer/core/loader/image_loader.cc:595-597,646-723"], mutatedFacts: ["connected owner", "document", "content pointer"] },
  { probeId: "navigation-stale-backend-node", properties: ["html-current", "input-src"], expected: ["stable-authorized", "stable-denied", "reject-drift"], sourceReferences: ["third_party/blink/renderer/core/dom/dom_node_ids.cc", "third_party/blink/renderer/core/loader/document_loader.cc"], mutatedFacts: ["backend node", "document nonce", "loader id", "navigation sequence"] },
]);

export interface AnimatedImageTruthOracleProvenance {
  chromiumRevision: typeof ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION;
  schemaSha256: string;
  patchSha256: string;
  rendererProcessId: number;
  rootFrameId: string;
  sessionId: string;
}

export interface AnimatedImageTruthStrictRequest {
  ownerSelectorToken: string;
  requestedFrameIndex: number;
  limitsFingerprint: string;
}

export interface AnimatedImageTruthSafeDocumentIdentity {
  targetId: string;
  frameId: string;
  documentLoaderId: string;
  documentNonce: string;
  navigationSequence: number;
}

export interface AnimatedImageTruthDocument
  extends AnimatedImageTruthSafeDocumentIdentity {
  url: string;
  origin: string;
}

export interface AnimatedImageTruthSlot {
  property: AnimatedImageTruthProperty;
  index: number;
  imageSetOptionIndex: number | null;
}

export interface AnimatedImageTruthSafeOwnerIdentity {
  kind: "html-image" | "svg-image" | "image-input" | "css-image";
  backendNodeId: number;
  shadowHostBackendNodeIds: number[];
  shadowRootTypes: Array<"user-agent" | "open" | "closed">;
  pseudo: null | { backendNodeId: number; type: string };
  slot: AnimatedImageTruthSlot;
}

export interface AnimatedImageTruthOwner
  extends AnimatedImageTruthSafeOwnerIdentity {
  currentSrc: string | null;
  selectedResourceUrl: string;
  candidateFactsSha256: string;
  devicePixelRatio: number;
  viewportSha256: string;
}

export interface AnimatedImageTruthRedirect {
  requestUrl: string;
  responseUrl: string;
  status: number;
  responseTime: number;
}

export interface AnimatedImageTruthResource {
  contentLogicalId: string;
  resourceLogicalId: string;
  inspectorRequestId: string;
  requestLoaderId: string;
  requestFrameId: string;
  requestMode: string;
  credentialsMode: string;
  redirects: AnimatedImageTruthRedirect[];
  currentRequestUrl: string;
  responseUrl: string;
  status: number;
  mimeType: string;
  rawContentType: string | null;
  fetchResponseType: string;
  corsSameOrigin: true;
  singleSecurityOrigin: true;
  fromDiskCache: boolean;
  fromMemoryCache: boolean;
  memoryCacheHitCount: number;
  fromServiceWorker: boolean;
  serviceWorkerControllerVersionId: string | null;
  serviceWorkerResponseSource: string | null;
  serviceWorkerRouterSha256: string | null;
  serviceWorkerUrlList: string[];
  cacheStorageCacheName: string | null;
  responseTime: number;
  originalResponseTime: number;
  revalidationCount: number;
  lastRevalidationStatus: number | null;
  networkEncodedDataLength: number;
}

export interface AnimatedImageTruthBody {
  transport: "network-get-response-body" | "data-url" | "blob-read";
  base64EncodedByProtocol: boolean;
  byteLength: number;
  sha256: string;
  networkLoadingFinished: true | null;
}

export interface AnimatedImageTruthEpochs {
  preflightSha256: string;
  postflightSha256: string;
  resourceResponseSequence: number;
  collectedAtMonotonicMs: number;
}

export interface AnimatedImageTruthAuthorizedRecord {
  protocol: typeof ANIMATED_IMAGE_TRUTH_PROTOCOL;
  outcome: "authorized";
  oracle: AnimatedImageTruthOracleProvenance;
  strictRequest: AnimatedImageTruthStrictRequest;
  document: AnimatedImageTruthDocument;
  owner: AnimatedImageTruthOwner;
  resource: AnimatedImageTruthResource;
  body: AnimatedImageTruthBody;
  epochs: AnimatedImageTruthEpochs;
}

/**
 * This intentionally has no URL, response, body, byte-length, or body-digest
 * member. Runtime validation also rejects extra keys, so an `any` cast cannot
 * smuggle denied bytes into a retained artifact.
 */
export interface AnimatedImageTruthDeniedRecord {
  protocol: typeof ANIMATED_IMAGE_TRUTH_PROTOCOL;
  outcome: "denied";
  oracle: AnimatedImageTruthOracleProvenance;
  strictRequest: AnimatedImageTruthStrictRequest;
  denialCode: AnimatedImageTruthDenialCode;
  document: AnimatedImageTruthSafeDocumentIdentity | null;
  owner: AnimatedImageTruthSafeOwnerIdentity | null;
  requestIdentity: {
    inspectorRequestId: string;
    requestLoaderId: string;
    requestFrameId: string;
    requestMode: string;
    credentialsMode: string;
  } | null;
}

export type AnimatedImageTruthRecord =
  | AnimatedImageTruthAuthorizedRecord
  | AnimatedImageTruthDeniedRecord;

export interface AnimatedImageTruthPublicBodyEvidence {
  transport: "network-get-response-body" | "data-url" | "blob-read";
  base64EncodedByProtocol: boolean;
  byteLength: number;
  sha256: string;
}

export interface AnimatedImageTruthProbeRow {
  probeId: AnimatedImageTruthProbeId;
  caseId: string;
  expected: AnimatedImageTruthExpectedOutcome;
  begin: AnimatedImageTruthRecord;
  finish: AnimatedImageTruthRecord;
  transactionUnchanged: boolean;
  publicBody: AnimatedImageTruthPublicBodyEvidence | null;
  deniedInspectorBodyDiscarded: boolean;
  activation: {
    sourceReferences: string[];
    mutatedFacts: string[];
    observedFailure: AnimatedImageTruthDenialCode | null;
  };
}

export interface AnimatedImageTruthBinaryIdentity {
  pathToken: string;
  byteLength: number;
  sha256: string;
}

export interface AnimatedImageTruthRunReport {
  schemaVersion: typeof ANIMATED_IMAGE_TRUTH_SCHEMA_VERSION;
  ticket: "DM-2583";
  stage: "animated-image-owner-resource-truth";
  operatingSystem: "macOS" | "Linux" | "Windows";
  architecture: "arm64" | "x64";
  platformRelease: string;
  browserVersion: string;
  evidenceRole: "proposal" | "validation";
  sourceRevision: typeof ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION;
  sourceManifestSha256: string;
  schemaSha256: string;
  patchSha256: string;
  buildInvocationId: string;
  observationId: string;
  browserProcessId: number;
  browserContextId: string;
  explicitHeadless: true;
  binaries: {
    browser: AnimatedImageTruthBinaryIdentity;
    renderer: AnimatedImageTruthBinaryIdentity;
    loadedLibraries: AnimatedImageTruthBinaryIdentity[];
  };
  rows: AnimatedImageTruthProbeRow[];
  normalizedLogicalSha256: string;
}

export interface AnimatedImageTruthAdjudication {
  schemaVersion: 1;
  ticket: "DM-2583";
  requiredArtifactKeys: string[];
  normalizedLogicalSha256: string | null;
  verdict: "proposal-validation-agreement" | "verdict-withheld";
  failures: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("truth evidence contains a non-finite number");
  }
  return value;
}

export function animatedImageTruthSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export const ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT =
  animatedImageTruthSha256(ANIMATED_IMAGE_TRUTH_LIMITS);

const schemaKeys = (...keys: string[]): readonly string[] =>
  Object.freeze(keys.sort());

const ORACLE_KEYS = schemaKeys(
  "chromiumRevision", "schemaSha256", "patchSha256", "rendererProcessId",
  "rootFrameId", "sessionId",
);
const STRICT_REQUEST_KEYS = schemaKeys(
  "ownerSelectorToken", "requestedFrameIndex", "limitsFingerprint",
);
const SAFE_DOCUMENT_KEYS = schemaKeys(
  "targetId", "frameId", "documentLoaderId", "documentNonce",
  "navigationSequence",
);
const AUTHORIZED_DOCUMENT_KEYS = schemaKeys(...SAFE_DOCUMENT_KEYS, "url", "origin");
const SLOT_KEYS = schemaKeys("property", "index", "imageSetOptionIndex");
const SAFE_OWNER_KEYS = schemaKeys(
  "kind", "backendNodeId", "shadowHostBackendNodeIds", "shadowRootTypes",
  "pseudo", "slot",
);
const AUTHORIZED_OWNER_KEYS = schemaKeys(
  ...SAFE_OWNER_KEYS, "currentSrc", "selectedResourceUrl",
  "candidateFactsSha256", "devicePixelRatio", "viewportSha256",
);
const PSEUDO_KEYS = schemaKeys("backendNodeId", "type");
const REQUEST_IDENTITY_KEYS = schemaKeys(
  "inspectorRequestId", "requestLoaderId", "requestFrameId", "requestMode",
  "credentialsMode",
);
const AUTHORIZED_RECORD_KEYS = schemaKeys(
  "protocol", "outcome", "oracle", "strictRequest", "document", "owner",
  "resource", "body", "epochs",
);
const DENIED_RECORD_KEYS = schemaKeys(
  "protocol", "outcome", "oracle", "strictRequest", "denialCode",
  "document", "owner", "requestIdentity",
);
const REDIRECT_KEYS = schemaKeys(
  "requestUrl", "responseUrl", "status", "responseTime",
);
const RESOURCE_KEYS = schemaKeys(
  "contentLogicalId", "resourceLogicalId", "inspectorRequestId",
  "requestLoaderId", "requestFrameId", "requestMode", "credentialsMode",
  "redirects", "currentRequestUrl", "responseUrl", "status", "mimeType",
  "rawContentType", "fetchResponseType", "corsSameOrigin",
  "singleSecurityOrigin", "fromDiskCache", "fromMemoryCache",
  "memoryCacheHitCount", "fromServiceWorker",
  "serviceWorkerControllerVersionId",
  "serviceWorkerResponseSource", "serviceWorkerRouterSha256",
  "serviceWorkerUrlList", "cacheStorageCacheName", "responseTime",
  "originalResponseTime", "revalidationCount", "lastRevalidationStatus",
  "networkEncodedDataLength",
);
const BODY_KEYS = schemaKeys(
  "transport", "base64EncodedByProtocol", "byteLength", "sha256",
  "networkLoadingFinished",
);
const EPOCH_KEYS = schemaKeys(
  "preflightSha256", "postflightSha256", "resourceResponseSequence",
  "collectedAtMonotonicMs",
);
const PROBE_ROW_KEYS = schemaKeys(
  "probeId", "caseId", "expected", "begin", "finish",
  "transactionUnchanged", "publicBody", "deniedInspectorBodyDiscarded",
  "activation",
);
const ACTIVATION_KEYS = schemaKeys(
  "sourceReferences", "mutatedFacts", "observedFailure",
);
const PUBLIC_BODY_KEYS = schemaKeys(
  "transport", "base64EncodedByProtocol", "byteLength", "sha256",
);
const REPORT_KEYS = schemaKeys(
  "schemaVersion", "ticket", "stage", "operatingSystem", "evidenceRole",
  "architecture", "platformRelease", "browserVersion",
  "sourceRevision", "sourceManifestSha256", "schemaSha256", "patchSha256",
  "buildInvocationId", "observationId", "browserProcessId",
  "browserContextId", "explicitHeadless", "binaries", "rows",
  "normalizedLogicalSha256",
);
const BINARIES_KEYS = schemaKeys("browser", "renderer", "loadedLibraries");
const BINARY_KEYS = schemaKeys("pathToken", "byteLength", "sha256");

const ANIMATED_IMAGE_TRUTH_SCHEMA_DESCRIPTOR = Object.freeze({
  authorizedRecordKeys: AUTHORIZED_RECORD_KEYS,
  deniedRecordKeys: DENIED_RECORD_KEYS,
  oracleKeys: ORACLE_KEYS,
  strictRequestKeys: STRICT_REQUEST_KEYS,
  authorizedDocumentKeys: AUTHORIZED_DOCUMENT_KEYS,
  safeDocumentKeys: SAFE_DOCUMENT_KEYS,
  authorizedOwnerKeys: AUTHORIZED_OWNER_KEYS,
  safeOwnerKeys: SAFE_OWNER_KEYS,
  pseudoKeys: PSEUDO_KEYS,
  slotKeys: SLOT_KEYS,
  requestIdentityKeys: REQUEST_IDENTITY_KEYS,
  resourceKeys: RESOURCE_KEYS,
  redirectKeys: REDIRECT_KEYS,
  bodyKeys: BODY_KEYS,
  epochKeys: EPOCH_KEYS,
  probeRowKeys: PROBE_ROW_KEYS,
  activationKeys: ACTIVATION_KEYS,
  publicBodyKeys: PUBLIC_BODY_KEYS,
  reportKeys: REPORT_KEYS,
  binariesKeys: BINARIES_KEYS,
  binaryKeys: BINARY_KEYS,
  outcomes: ["authorized", "denied"],
  expectedOutcomes: ["stable-authorized", "stable-denied", "reject-drift"],
  ownerKinds: ["html-image", "svg-image", "image-input", "css-image"],
  shadowRootTypes: ["user-agent", "open", "closed"],
  transports: ["network-get-response-body", "data-url", "blob-read"],
  operatingSystems: ["macOS", "Linux", "Windows"],
  evidenceRoles: ["proposal", "validation"],
  reportStage: "animated-image-owner-resource-truth",
  ownerSelectorTokenPolicy: "ascii-alnum-dot-underscore-hyphen-max-128",
  deniedBodyPolicy: "no-url-response-body-byte-length-or-body-digest",
  transactionPolicy: "exact-preflight-postflight-excluding-collection-time",
});

/**
 * Digest of the public contract, not of this source file's formatting.
 * The private helper embeds and returns this value.
 */
export const ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256 = animatedImageTruthSha256({
  schemaVersion: ANIMATED_IMAGE_TRUTH_SCHEMA_VERSION,
  protocol: ANIMATED_IMAGE_TRUTH_PROTOCOL,
  chromiumRevision: ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION,
  browserVersion: ANIMATED_IMAGE_TRUTH_BROWSER_VERSION,
  limits: ANIMATED_IMAGE_TRUTH_LIMITS,
  properties: ANIMATED_IMAGE_TRUTH_PROPERTIES,
  denialCodes: ANIMATED_IMAGE_TRUTH_DENIAL_CODES,
  probes: ANIMATED_IMAGE_TRUTH_PROBES,
  cases: ANIMATED_IMAGE_TRUTH_CASES,
  probeRequirements: ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS,
  descriptor: ANIMATED_IMAGE_TRUTH_SCHEMA_DESCRIPTOR,
});

const SHA256 = /^[0-9a-f]{64}$/;
const DENIAL_CODES = new Set<string>(ANIMATED_IMAGE_TRUTH_DENIAL_CODES);
const PROBE_IDS = new Set<string>(ANIMATED_IMAGE_TRUTH_PROBES);
const CASES_BY_KEY = new Map(ANIMATED_IMAGE_TRUTH_CASES.map((row) => [
  `${row.probeId}/${row.caseId}`,
  row,
]));
const REQUIREMENTS_BY_PROBE = new Map(
  ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS.map((row) => [row.probeId, row]),
);

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
  failures: string[],
): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${label}: expected an object`);
    return false;
  }
  const actual = Object.keys(value as object).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(`${label}: unsafe or missing keys (${actual.join(",")})`);
    return false;
  }
  return true;
}

function validateSha(value: unknown, label: string, failures: string[]): void {
  if (typeof value !== "string" || !SHA256.test(value)) failures.push(`${label}: invalid SHA-256`);
}

function validateOracleProvenance(
  value: unknown,
  label: string,
  failures: string[],
): void {
  if (!exactKeys(value, ORACLE_KEYS, label, failures)) return;
  if (value.chromiumRevision !== ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION) {
    failures.push(`${label}: Chromium revision drift`);
  }
  if (value.schemaSha256 !== ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256) {
    failures.push(`${label}: schema digest drift`);
  }
  validateSha(value.patchSha256, `${label}.patchSha256`, failures);
  if (!Number.isInteger(value.rendererProcessId) || (value.rendererProcessId as number) <= 0) {
    failures.push(`${label}: renderer process identity missing`);
  }
  if (typeof value.rootFrameId !== "string" || value.rootFrameId.length === 0 ||
      typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    failures.push(`${label}: exact target/session route missing`);
  }
}

function validateStrictRequest(
  value: unknown,
  label: string,
  failures: string[],
): void {
  if (!exactKeys(value, STRICT_REQUEST_KEYS, label, failures)) return;
  if (typeof value.ownerSelectorToken !== "string" ||
      !ANIMATED_IMAGE_TRUTH_OWNER_SELECTOR_TOKEN.test(value.ownerSelectorToken)) {
    failures.push(`${label}: opaque owner selector token is missing or unsafe`);
  }
  if (!Number.isInteger(value.requestedFrameIndex) || (value.requestedFrameIndex as number) < 0) {
    failures.push(`${label}: requested frame index is invalid`);
  }
  if (value.limitsFingerprint !== ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT) {
    failures.push(`${label}: limits fingerprint drift`);
  }
}

function validateSafeDocument(
  value: unknown,
  label: string,
  failures: string[],
  authorized: boolean,
): void {
  if (!exactKeys(
    value,
    authorized ? AUTHORIZED_DOCUMENT_KEYS : SAFE_DOCUMENT_KEYS,
    label,
    failures,
  )) return;
  if (!Number.isInteger(value.navigationSequence) || (value.navigationSequence as number) <= 0) {
    failures.push(`${label}: navigation sequence is invalid`);
  }
  for (const key of ["targetId", "frameId", "documentLoaderId", "documentNonce"]) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
      failures.push(`${label}: ${key} missing`);
    }
  }
  if (authorized &&
      (typeof value.url !== "string" || value.url.length === 0 ||
       typeof value.origin !== "string" || value.origin.length === 0)) {
    failures.push(`${label}: authorized URL/origin missing`);
  }
}

function validateSlot(value: unknown, label: string, failures: string[]): void {
  if (!exactKeys(value, SLOT_KEYS, label, failures)) return;
  if (!(ANIMATED_IMAGE_TRUTH_PROPERTIES as readonly string[]).includes(value.property as string)) {
    failures.push(`${label}: unknown property`);
  }
  if (!Number.isInteger(value.index) || (value.index as number) < 0) failures.push(`${label}: invalid slot index`);
  if (value.imageSetOptionIndex != null &&
      (!Number.isInteger(value.imageSetOptionIndex) || (value.imageSetOptionIndex as number) < 0)) {
    failures.push(`${label}: invalid image-set option index`);
  }
}

function validateSafeOwner(
  value: unknown,
  label: string,
  failures: string[],
  authorized: boolean,
): void {
  if (!exactKeys(
    value,
    authorized ? AUTHORIZED_OWNER_KEYS : SAFE_OWNER_KEYS,
    label,
    failures,
  )) return;
  validateSlot(value.slot, `${label}.slot`, failures);
  if (!["html-image", "svg-image", "image-input", "css-image"].includes(
    value.kind as string,
  )) {
    failures.push(`${label}: unsupported owner kind`);
  }
  if (!Number.isInteger(value.backendNodeId) || (value.backendNodeId as number) <= 0) {
    failures.push(`${label}: backend node identity missing`);
  }
  if (value.pseudo != null) {
    if (exactKeys(value.pseudo, PSEUDO_KEYS, `${label}.pseudo`, failures) &&
        (!Number.isInteger(value.pseudo.backendNodeId) ||
         (value.pseudo.backendNodeId as number) <= 0 ||
         typeof value.pseudo.type !== "string" || value.pseudo.type.length === 0)) {
      failures.push(`${label}: pseudo identity is invalid`);
    }
  }
  if (!Array.isArray(value.shadowHostBackendNodeIds) || !Array.isArray(value.shadowRootTypes) ||
      value.shadowHostBackendNodeIds.length !== value.shadowRootTypes.length) {
    failures.push(`${label}: shadow host/type chain is not exact`);
  } else if (value.shadowHostBackendNodeIds.some((entry) =>
    !Number.isInteger(entry) || entry <= 0) || value.shadowRootTypes.some((entry) =>
    !["user-agent", "open", "closed"].includes(entry))) {
    failures.push(`${label}: shadow host/type chain contains invalid identities`);
  }
  if (authorized) {
    if (value.currentSrc !== null && typeof value.currentSrc !== "string") {
      failures.push(`${label}: currentSrc must be a string or null`);
    }
    if (typeof value.selectedResourceUrl !== "string" ||
        value.selectedResourceUrl.length === 0 ||
        typeof value.devicePixelRatio !== "number" ||
        !Number.isFinite(value.devicePixelRatio) || value.devicePixelRatio <= 0) {
      failures.push(`${label}: authorized selection facts are incomplete`);
    }
    validateSha(value.candidateFactsSha256, `${label}.candidateFactsSha256`, failures);
    validateSha(value.viewportSha256, `${label}.viewportSha256`, failures);
  }
}

function validateRequestIdentity(
  value: unknown,
  label: string,
  failures: string[],
): void {
  if (!exactKeys(value, REQUEST_IDENTITY_KEYS, label, failures)) return;
  for (const key of [
    "inspectorRequestId", "requestLoaderId", "requestFrameId",
    "requestMode", "credentialsMode",
  ]) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
      failures.push(`${label}: ${key} missing`);
    }
  }
}

function validateDeniedRecord(
  value: AnimatedImageTruthDeniedRecord,
  label: string,
  failures: string[],
): void {
  if (!exactKeys(value, DENIED_RECORD_KEYS, label, failures)) return;
  if (value.protocol !== ANIMATED_IMAGE_TRUTH_PROTOCOL || value.outcome !== "denied") {
    failures.push(`${label}: denied protocol/outcome drift`);
  }
  validateOracleProvenance(value.oracle, `${label}.oracle`, failures);
  validateStrictRequest(value.strictRequest, `${label}.strictRequest`, failures);
  if (!DENIAL_CODES.has(value.denialCode)) failures.push(`${label}: unknown denial code`);
  if (value.document != null) validateSafeDocument(value.document, `${label}.document`, failures, false);
  if (value.owner != null) validateSafeOwner(value.owner, `${label}.owner`, failures, false);
  if (value.requestIdentity != null) validateRequestIdentity(value.requestIdentity, `${label}.requestIdentity`, failures);
  // No recursive body inspection is necessary: exactKeys rejects every place
  // a URL, response, body, length, or digest could be attached to this branch.
}

function validateAuthorizedRecord(
  value: AnimatedImageTruthAuthorizedRecord,
  label: string,
  failures: string[],
): void {
  if (!exactKeys(value, AUTHORIZED_RECORD_KEYS, label, failures)) return;
  validateOracleProvenance(value.oracle, `${label}.oracle`, failures);
  validateStrictRequest(value.strictRequest, `${label}.strictRequest`, failures);
  validateSafeDocument(value.document, `${label}.document`, failures, true);
  validateSafeOwner(value.owner, `${label}.owner`, failures, true);
  const resourceIsExact = exactKeys(
    value.resource, RESOURCE_KEYS, `${label}.resource`, failures,
  );
  const bodyIsExact = exactKeys(
    value.body, BODY_KEYS, `${label}.body`, failures,
  );
  const epochsAreExact = exactKeys(
    value.epochs, EPOCH_KEYS, `${label}.epochs`, failures,
  );
  if (!resourceIsExact || !bodyIsExact || !epochsAreExact) return;
  let resourceTypesAreSafe = true;
  for (const key of [
    "contentLogicalId", "resourceLogicalId", "inspectorRequestId",
    "requestLoaderId", "requestFrameId", "requestMode", "credentialsMode",
    "currentRequestUrl", "responseUrl", "mimeType", "fetchResponseType",
  ] as const) {
    if (typeof value.resource[key] !== "string" || value.resource[key].length === 0) {
      failures.push(`${label}.resource: ${key} missing`);
      resourceTypesAreSafe = false;
    }
  }
  for (const key of [
    "rawContentType", "serviceWorkerControllerVersionId",
    "serviceWorkerResponseSource", "serviceWorkerRouterSha256",
    "cacheStorageCacheName",
  ] as const) {
    if (value.resource[key] !== null && typeof value.resource[key] !== "string") {
      failures.push(`${label}.resource: ${key} must be a string or null`);
      resourceTypesAreSafe = false;
    }
  }
  for (const key of [
    "corsSameOrigin", "singleSecurityOrigin", "fromDiskCache",
    "fromMemoryCache", "fromServiceWorker",
  ] as const) {
    if (typeof value.resource[key] !== "boolean") {
      failures.push(`${label}.resource: ${key} must be boolean`);
      resourceTypesAreSafe = false;
    }
  }
  for (const key of ["responseTime", "originalResponseTime"] as const) {
    if (typeof value.resource[key] !== "number" ||
        !Number.isFinite(value.resource[key])) {
      failures.push(`${label}.resource: ${key} must be finite`);
      resourceTypesAreSafe = false;
    }
  }
  for (const key of [
    "status", "memoryCacheHitCount", "revalidationCount",
    "networkEncodedDataLength",
  ] as const) {
    if (!Number.isInteger(value.resource[key])) {
      failures.push(`${label}.resource: ${key} must be an integer`);
      resourceTypesAreSafe = false;
    }
  }
  if (value.resource.lastRevalidationStatus !== null &&
      !Number.isInteger(value.resource.lastRevalidationStatus)) {
    failures.push(`${label}.resource: lastRevalidationStatus must be an integer or null`);
    resourceTypesAreSafe = false;
  }
  if (Array.isArray(value.resource.redirects)) {
    value.resource.redirects.forEach((redirect, index) => {
      const redirectLabel = `${label}.resource.redirects[${index}]`;
      if (!exactKeys(redirect, REDIRECT_KEYS, redirectLabel, failures)) return;
      if (typeof redirect.requestUrl !== "string" ||
          typeof redirect.responseUrl !== "string" ||
          !Number.isInteger(redirect.status) ||
          typeof redirect.responseTime !== "number" ||
          !Number.isFinite(redirect.responseTime)) {
        failures.push(`${redirectLabel}: redirect identity is invalid`);
        resourceTypesAreSafe = false;
      }
    });
  } else {
    failures.push(`${label}.resource.redirects: expected an array`);
    resourceTypesAreSafe = false;
  }
  if (!Array.isArray(value.resource.serviceWorkerUrlList) ||
      value.resource.serviceWorkerUrlList.some((entry) => typeof entry !== "string")) {
    failures.push(`${label}.resource.serviceWorkerUrlList: expected strings`);
    resourceTypesAreSafe = false;
  }
  if (!resourceTypesAreSafe) return;
  if (value.outcome !== "authorized") {
    failures.push(`${label}: authorized outcome drift`);
  }
  if (value.protocol !== ANIMATED_IMAGE_TRUTH_PROTOCOL) failures.push(`${label}: protocol drift`);
  validateSha(value.owner.candidateFactsSha256, `${label}.owner.candidateFactsSha256`, failures);
  validateSha(value.owner.viewportSha256, `${label}.owner.viewportSha256`, failures);
  validateSha(value.body.sha256, `${label}.body.sha256`, failures);
  validateSha(value.epochs.preflightSha256, `${label}.epochs.preflightSha256`, failures);
  validateSha(value.epochs.postflightSha256, `${label}.epochs.postflightSha256`, failures);
  if (value.resource.serviceWorkerRouterSha256 !== null) {
    validateSha(
      value.resource.serviceWorkerRouterSha256,
      `${label}.resource.serviceWorkerRouterSha256`,
      failures,
    );
  }
  if (!Number.isInteger(value.epochs.resourceResponseSequence) ||
      value.epochs.resourceResponseSequence <= 0 ||
      typeof value.epochs.collectedAtMonotonicMs !== "number" ||
      !Number.isFinite(value.epochs.collectedAtMonotonicMs) ||
      value.epochs.collectedAtMonotonicMs < 0) {
    failures.push(`${label}: response/collection epoch is invalid`);
  }
  if (value.epochs.preflightSha256 !== value.epochs.postflightSha256) {
    failures.push(`${label}: private pre/post transaction digest changed`);
  }
  if (value.resource.corsSameOrigin !== true || value.resource.singleSecurityOrigin !== true) {
    failures.push(`${label}: unauthorized resource was serialized as authorized`);
  }
  if (value.resource.serviceWorkerControllerVersionId !== null &&
      !/^\d+$/.test(value.resource.serviceWorkerControllerVersionId)) {
    failures.push(`${label}: service-worker controller version is invalid`);
  }
  if (value.resource.fromServiceWorker &&
      value.resource.serviceWorkerControllerVersionId === null) {
    failures.push(`${label}: service-worker response lacks controller identity`);
  }
  if (value.resource.fromServiceWorker !==
      (value.resource.serviceWorkerResponseSource !== null)) {
    failures.push(`${label}: service-worker source flag is inconsistent`);
  }
  if (!Number.isInteger(value.body.byteLength) || value.body.byteLength <= 0 ||
      value.body.byteLength > ANIMATED_IMAGE_TRUTH_LIMITS.maximumResourceBytes) {
    failures.push(`${label}: body length is outside the fixed bounds`);
  }
  if (![
    "network-get-response-body", "data-url", "blob-read",
  ].includes(value.body.transport) ||
      typeof value.body.base64EncodedByProtocol !== "boolean" ||
      (value.body.networkLoadingFinished !== true &&
       value.body.networkLoadingFinished !== null)) {
    failures.push(`${label}: body transport envelope is invalid`);
    return;
  }
  if (value.resource.redirects.length > ANIMATED_IMAGE_TRUTH_LIMITS.maximumRedirects) {
    failures.push(`${label}: redirect count is outside the fixed bounds`);
  }
  const statusIsSuccessful = value.body.transport === "network-get-response-body"
    ? value.resource.status >= 200 && value.resource.status < 300
    : value.resource.status === 0 ||
      (value.resource.status >= 200 && value.resource.status < 300);
  if (!statusIsSuccessful || value.resource.memoryCacheHitCount < 0 ||
      value.resource.revalidationCount < 0 ||
      (value.resource.lastRevalidationStatus !== null &&
       (value.resource.lastRevalidationStatus < 100 ||
        value.resource.lastRevalidationStatus > 599))) {
    failures.push(`${label}: response/revalidation status is invalid`);
  }
  if (value.body.transport === "network-get-response-body" &&
      value.body.networkLoadingFinished !== true) {
    failures.push(`${label}: HTTP(S) body was retained before loadingFinished`);
  }
  if (value.body.transport === "network-get-response-body" &&
      (!value.body.base64EncodedByProtocol ||
       value.resource.networkEncodedDataLength < 0)) {
    failures.push(`${label}: HTTP(S) protocol-body evidence is incomplete`);
  }
  if (value.body.transport !== "network-get-response-body" &&
      value.body.networkLoadingFinished !== null) {
    failures.push(`${label}: data/blob body carries a network completion claim`);
  }
  if (value.body.transport !== "network-get-response-body" &&
      (value.body.base64EncodedByProtocol ||
       value.resource.networkEncodedDataLength !== -1)) {
    failures.push(`${label}: data/blob body carries network-only evidence`);
  }
  if (value.resource.mimeType === "multipart/x-mixed-replace" ||
      value.resource.rawContentType?.toLowerCase().startsWith("multipart/x-mixed-replace")) {
    failures.push(`${label}: multipart response was serialized as stable bytes`);
  }
  if (!["image/gif", "image/png", "image/webp"].includes(value.resource.mimeType.toLowerCase())) {
    failures.push(`${label}: unsupported animated-image MIME was serialized`);
  }
}

export function validateAnimatedImageTruthRecord(
  value: AnimatedImageTruthRecord,
  label = "record",
): string[] {
  const failures: string[] = [];
  if (value == null || typeof value !== "object") return [`${label}: missing record`];
  if (value.outcome === "authorized") validateAuthorizedRecord(value, label, failures);
  else if (value.outcome === "denied") validateDeniedRecord(value, label, failures);
  else failures.push(`${label}: unknown outcome`);
  return failures;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "blob:") {
      try {
        const owningUrl = new URL(url.pathname);
        const owningOrigin = owningUrl.hostname === "127.0.0.1" ||
            owningUrl.hostname === "localhost"
          ? `${owningUrl.protocol}//loopback`
          : owningUrl.origin;
        return `blob:${owningOrigin}/<opaque-token>${url.search}${url.hash}`;
      } catch {
        return `blob:<opaque-origin>/<opaque-token>${url.search}${url.hash}`;
      }
    }
    const originRole = url.hostname === "127.0.0.1" || url.hostname === "localhost"
      ? `${url.protocol}//loopback`
      : url.origin;
    return `${originRole}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function validateRequiredCaseSemantics(
  row: AnimatedImageTruthProbeRow,
  label: string,
  failures: string[],
): void {
  const required = CASES_BY_KEY.get(`${row.probeId}/${row.caseId}`);
  if (!required) return;
  const retainedOwner = row.finish.owner ?? row.begin.owner;
  const requiredOwnerKind = required.property === "html-current"
    ? "html-image"
    : required.property === "svg-href"
    ? "svg-image"
    : required.property === "input-src"
    ? "image-input"
    : "css-image";
  if (retainedOwner &&
      (retainedOwner.slot.property !== required.property ||
       retainedOwner.slot.index !== required.index ||
       retainedOwner.kind !== requiredOwnerKind ||
       (required.pseudoType !== undefined &&
        retainedOwner.pseudo?.type !== required.pseudoType))) {
    failures.push(`${label}: owner kind/slot drifted from the required case`);
  }
  const authorized = row.finish.outcome === "authorized" ? row.finish : null;
  const denied = row.finish.outcome === "denied" ? row.finish : null;
  const requireAuthorized = (
    predicate: (record: AnimatedImageTruthAuthorizedRecord) => boolean,
    message: string,
  ): void => {
    if (!authorized || !predicate(authorized)) failures.push(`${label}: ${message}`);
  };
  const requireDenial = (
    code: AnimatedImageTruthDenialCode,
    message: string,
  ): void => {
    if (!denied || denied.denialCode !== code) failures.push(`${label}: ${message}`);
  };

  switch (`${row.probeId}/${row.caseId}`) {
    case "img-src-mutation/stable-animated-webp":
      requireAuthorized((record) => record.resource.mimeType === "image/webp",
        "animated WebP MIME was not observed");
      break;
    case "img-src-mutation/stable-apng":
      requireAuthorized((record) => record.resource.mimeType === "image/png",
        "APNG MIME was not observed");
      break;
    case "css-image-set-option-reorder/stable-selected-option":
      requireAuthorized((record) => record.owner.slot.imageSetOptionIndex !== null,
        "selected image-set option identity was not observed");
      break;
    case "same-url-memory-cache-sharing/css-shared":
    case "same-url-memory-cache-sharing/list-style":
      requireAuthorized((record) => record.resource.memoryCacheHitCount > 0,
        "memory-cache sharing was not observed");
      break;
    case "redirect-response-mime-drift/stable-redirect":
      requireAuthorized((record) => record.resource.redirects.length > 0,
        "redirect chain was not observed");
      break;
    case "settled-304/settled-cache-entry":
      requireAuthorized((record) =>
        record.resource.revalidationCount > 0 &&
        record.resource.lastRevalidationStatus === 304,
      "settled 304 revalidation was not observed");
      break;
    case "active-revalidation/in-flight-validator":
      requireDenial("revalidation-in-flight",
        "active cache validation was not observed");
      break;
    case "service-worker-router-cache-replacement/stable-cache-route":
      requireAuthorized((record) =>
        record.resource.fromServiceWorker &&
        record.resource.serviceWorkerControllerVersionId !== null &&
        record.resource.serviceWorkerResponseSource === "cache-storage" &&
        record.resource.serviceWorkerRouterSha256 !== null &&
        record.resource.serviceWorkerUrlList.length > 0 &&
        record.resource.cacheStorageCacheName === "dm2583-a",
      "service-worker cache/router/controller facts were not observed");
      break;
    case "cors-anonymous-success/anonymous":
      requireAuthorized((record) =>
        record.resource.requestMode === "cors" &&
        record.resource.credentialsMode === "same-origin" &&
        record.resource.fetchResponseType === "cors",
      "anonymous CORS route facts were not observed");
      break;
    case "cors-credentials-success/credentials":
      requireAuthorized((record) =>
        record.resource.requestMode === "cors" &&
        record.resource.credentialsMode === "include" &&
        record.resource.fetchResponseType === "cors",
      "credentialed CORS route facts were not observed");
      break;
    case "cors-failure/missing-acao":
      requireDenial("cors-denied", "failed CORS denial was not observed");
      break;
    case "paintable-no-cors-denial/opaque-paintable":
      requireDenial("opaque-response", "paintable opaque denial was not observed");
      if (denied?.requestIdentity?.requestMode !== "no-cors") {
        failures.push(`${label}: opaque denial did not retain no-cors request identity`);
      }
      break;
    case "data-url-mutation/stable-data":
      requireAuthorized((record) => record.body.transport === "data-url",
        "data URL transport was not observed");
      break;
    case "blob-replacement-revocation/stable-blob":
      requireAuthorized((record) => record.body.transport === "blob-read",
        "owning-realm blob transport was not observed");
      break;
    case "multipart-rejection/two-parts":
      requireDenial("multipart-response", "multipart rejection was not observed");
      break;
    case "shadow-pseudo-slot-collision/stable-closed-shadow-before":
      requireAuthorized((record) =>
        record.owner.shadowRootTypes.includes("closed") &&
        record.owner.pseudo?.type === "before",
      "closed-shadow pseudo identity was not observed");
      break;
    case "owner-adoption-detachment/stable-svg":
      requireAuthorized((record) => record.owner.kind === "svg-image",
        "SVG image owner was not observed");
      break;
    case "navigation-stale-backend-node/stable-input":
      requireAuthorized((record) => record.owner.kind === "image-input",
        "image input owner was not observed");
      break;
  }
}

function normalizedRecord(value: AnimatedImageTruthRecord): unknown {
  if (value.outcome === "denied") {
    return {
      outcome: value.outcome,
      strictRequest: {
        requestedFrameIndex: value.strictRequest.requestedFrameIndex,
        limitsFingerprint: value.strictRequest.limitsFingerprint,
      },
      denialCode: value.denialCode,
      owner: value.owner == null ? null : {
        kind: value.owner.kind,
        shadowRootTypes: value.owner.shadowRootTypes,
        pseudoType: value.owner.pseudo?.type ?? null,
        slot: value.owner.slot,
      },
      requestIdentity: value.requestIdentity == null ? null : {
        requestMode: value.requestIdentity.requestMode,
        credentialsMode: value.requestIdentity.credentialsMode,
      },
    };
  }
  return {
    outcome: value.outcome,
    strictRequest: {
      requestedFrameIndex: value.strictRequest.requestedFrameIndex,
      limitsFingerprint: value.strictRequest.limitsFingerprint,
    },
    owner: {
      kind: value.owner.kind,
      shadowRootTypes: value.owner.shadowRootTypes,
      pseudoType: value.owner.pseudo?.type ?? null,
      slot: value.owner.slot,
      currentSrc: value.owner.currentSrc == null ? null : normalizeUrl(value.owner.currentSrc),
      selectedResourceUrl: normalizeUrl(value.owner.selectedResourceUrl),
      // This digest intentionally binds the exact source attributes only
      // within one helper transaction. It can include per-context blob UUIDs
      // and loopback ports, so the cross-build logical digest records that the
      // validated epoch exists without comparing its run-local hash value.
      candidateFactsSha256: "<authenticated-per-run>",
      devicePixelRatio: value.owner.devicePixelRatio,
      viewportSha256: value.owner.viewportSha256,
    },
    resource: {
      requestMode: value.resource.requestMode,
      credentialsMode: value.resource.credentialsMode,
      redirects: value.resource.redirects.map((redirect) => ({
        requestUrl: normalizeUrl(redirect.requestUrl),
        responseUrl: normalizeUrl(redirect.responseUrl),
        status: redirect.status,
      })),
      currentRequestUrl: normalizeUrl(value.resource.currentRequestUrl),
      responseUrl: normalizeUrl(value.resource.responseUrl),
      status: value.resource.status,
      mimeType: value.resource.mimeType,
      rawContentType: value.resource.rawContentType,
      fetchResponseType: value.resource.fetchResponseType,
      corsSameOrigin: value.resource.corsSameOrigin,
      singleSecurityOrigin: value.resource.singleSecurityOrigin,
      fromDiskCache: value.resource.fromDiskCache,
      fromMemoryCache: value.resource.fromMemoryCache,
      // The raw artifact retains the exact count. Cross-build adjudication
      // compares the logical fact that an exact memory-cache use occurred;
      // platform cache bookkeeping may perform additional equivalent lookups.
      memoryCacheHitObserved: value.resource.memoryCacheHitCount > 0,
      fromServiceWorker: value.resource.fromServiceWorker,
      serviceWorkerControllerPresent:
        value.resource.serviceWorkerControllerVersionId !== null,
      serviceWorkerResponseSource: value.resource.serviceWorkerResponseSource,
      serviceWorkerRouterSha256: value.resource.serviceWorkerRouterSha256,
      serviceWorkerUrlList: value.resource.serviceWorkerUrlList.map(normalizeUrl),
      cacheStorageCacheName: value.resource.cacheStorageCacheName,
      revalidationCount: value.resource.revalidationCount,
      lastRevalidationStatus: value.resource.lastRevalidationStatus,
      resourceResponseSequence: value.epochs.resourceResponseSequence,
    },
    body: value.body,
  };
}

export function normalizedAnimatedImageTruthRowsSha256(
  rows: AnimatedImageTruthProbeRow[],
): string {
  return animatedImageTruthSha256([...rows]
    .sort((left, right) => `${left.probeId}/${left.caseId}`.localeCompare(`${right.probeId}/${right.caseId}`))
    .map((row) => ({
      probeId: row.probeId,
      caseId: row.caseId,
      expected: row.expected,
      begin: normalizedRecord(row.begin),
      finish: normalizedRecord(row.finish),
      transactionUnchanged: row.transactionUnchanged,
      activation: row.activation,
    })));
}

function validateProbeRow(row: AnimatedImageTruthProbeRow, label: string): string[] {
  const failures: string[] = [];
  if (!exactKeys(row, PROBE_ROW_KEYS, label, failures)) return failures;
  const beginIsRecord = row.begin != null && typeof row.begin === "object" &&
    (row.begin.outcome === "authorized" || row.begin.outcome === "denied");
  const finishIsRecord = row.finish != null && typeof row.finish === "object" &&
    (row.finish.outcome === "authorized" || row.finish.outcome === "denied");
  const recordFailures = [
    ...validateAnimatedImageTruthRecord(row.begin, `${label}.begin`),
    ...validateAnimatedImageTruthRecord(row.finish, `${label}.finish`),
  ];
  failures.push(...recordFailures);
  if (!PROBE_IDS.has(row.probeId)) failures.push(`${label}: unknown probe id`);
  const requiredCase = typeof row.probeId === "string" &&
      typeof row.caseId === "string"
    ? CASES_BY_KEY.get(`${row.probeId}/${row.caseId}`)
    : undefined;
  if (!requiredCase) {
    failures.push(`${label}: unknown or non-required case`);
  } else if (row.expected !== requiredCase.expected) {
    failures.push(`${label}: case expected outcome drift`);
  }
  if (typeof row.caseId !== "string" || row.caseId.length === 0 ||
      !["stable-authorized", "stable-denied", "reject-drift"].includes(row.expected) ||
      typeof row.transactionUnchanged !== "boolean" ||
      typeof row.deniedInspectorBodyDiscarded !== "boolean") {
    failures.push(`${label}: probe envelope is invalid`);
  }
  if (!exactKeys(
    row.activation, ACTIVATION_KEYS, `${label}.activation`, failures,
  )) return failures;
  if (!Array.isArray(row.activation.sourceReferences) ||
      row.activation.sourceReferences.length === 0 ||
      row.activation.sourceReferences.some((entry) =>
        typeof entry !== "string" || entry.length === 0)) {
    failures.push(`${label}: source references missing`);
  }
  if (!Array.isArray(row.activation.mutatedFacts) ||
      row.activation.mutatedFacts.some((entry) => typeof entry !== "string")) {
    failures.push(`${label}: mutation facts are invalid`);
  }
  const requirement = REQUIREMENTS_BY_PROBE.get(row.probeId);
  if (requirement &&
      (JSON.stringify(row.activation.sourceReferences) !==
          JSON.stringify(requirement.sourceReferences) ||
       JSON.stringify(row.activation.mutatedFacts) !==
          JSON.stringify(requirement.mutatedFacts))) {
    failures.push(`${label}: source-linked activation contract drift`);
  }
  if (row.activation.observedFailure != null &&
      !DENIAL_CODES.has(row.activation.observedFailure)) {
    failures.push(`${label}: observed failure is invalid`);
  }
  if (row.publicBody != null) {
    if (exactKeys(
      row.publicBody, PUBLIC_BODY_KEYS, `${label}.publicBody`, failures,
    )) {
      validateSha(row.publicBody.sha256, `${label}.publicBody.sha256`, failures);
      if (!Number.isInteger(row.publicBody.byteLength) ||
          row.publicBody.byteLength <= 0 ||
          row.publicBody.byteLength > ANIMATED_IMAGE_TRUTH_LIMITS.maximumResourceBytes) {
        failures.push(`${label}: public body length is outside the fixed bounds`);
      }
    }
  }
  if (!beginIsRecord || !finishIsRecord || recordFailures.length > 0) {
    return failures;
  }
  if (row.expected === "stable-authorized") {
    if (row.begin.outcome !== "authorized" || row.finish.outcome !== "authorized" ||
        !row.transactionUnchanged) {
      failures.push(`${label}: stable authorized transaction did not remain authorized and exact`);
    } else {
      if (row.publicBody == null) failures.push(`${label}: authenticated public body evidence missing`);
      else if (row.publicBody.byteLength !== row.begin.body.byteLength ||
          row.publicBody.sha256 !== row.begin.body.sha256 ||
          row.publicBody.transport !== row.begin.body.transport ||
          row.publicBody.base64EncodedByProtocol !== row.begin.body.base64EncodedByProtocol) {
        failures.push(`${label}: public body does not equal the private ResourceBuffer`);
      }
      if (row.begin.epochs.preflightSha256 !== row.finish.epochs.postflightSha256) {
        failures.push(`${label}: begin/finish exact digest changed`);
      }
      if (row.deniedInspectorBodyDiscarded) {
        failures.push(`${label}: authorized row claims a denied body discard`);
      }
    }
  } else if (row.expected === "stable-denied") {
    if (row.begin.outcome !== "denied" || row.finish.outcome !== "denied" ||
        !row.transactionUnchanged) {
      failures.push(`${label}: stable denial did not remain exact`);
    }
    if (row.publicBody != null) failures.push(`${label}: denied row retained public body facts`);
    if (!row.deniedInspectorBodyDiscarded) failures.push(`${label}: denied inspector body was not discarded`);
  } else {
    if (row.begin.outcome !== "denied") {
      failures.push(`${label}: rejected transaction retained preflight body facts`);
    }
    if (row.finish.outcome !== "denied" || row.transactionUnchanged ||
        row.activation.observedFailure == null ||
        row.finish.denialCode !== row.activation.observedFailure) {
      failures.push(`${label}: hostile mutation did not fail closed with its observed reason`);
    }
    if (row.publicBody != null) failures.push(`${label}: rejected transaction retained public body facts`);
    if (!row.deniedInspectorBodyDiscarded) failures.push(`${label}: rejected transaction did not discard transient body facts`);
  }
  validateRequiredCaseSemantics(row, label, failures);
  return failures;
}

export function validateAnimatedImageTruthProbeRow(
  row: AnimatedImageTruthProbeRow,
  label = `${row.probeId}/${row.caseId}`,
): string[] {
  return validateProbeRow(row, label);
}

function validateBinary(
  value: unknown,
  label: string,
  failures: string[],
): value is AnimatedImageTruthBinaryIdentity {
  if (!exactKeys(value, BINARY_KEYS, label, failures)) {
    return false;
  }
  if (typeof value.pathToken !== "string" || value.pathToken.length === 0 ||
      !Number.isInteger(value.byteLength) || value.byteLength <= 0) {
    failures.push(`${label}: binary path/length missing`);
  }
  validateSha(value.sha256, `${label}.sha256`, failures);
  return typeof value.pathToken === "string" && value.pathToken.length > 0 &&
    Number.isInteger(value.byteLength) && (value.byteLength as number) > 0 &&
    typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

export function adjudicateAnimatedImageOwnerResourceTruth(
  reports: AnimatedImageTruthRunReport[],
): AnimatedImageTruthAdjudication {
  const failures: string[] = [];
  const operatingSystems = ["macOS", "Linux", "Windows"] as const;
  const evidenceRoles = ["proposal", "validation"] as const;
  const expectedKeys = operatingSystems
    .flatMap((os) => evidenceRoles.map((role) => `${os}/${role}`));
  const reportsByKey = new Map<string, AnimatedImageTruthRunReport>();
  const reportCandidates: unknown[] = Array.isArray(reports) ? reports : [];
  if (!Array.isArray(reports)) failures.push("reports: expected an array");
  for (const [reportIndex, candidate] of reportCandidates.entries()) {
    const candidateLabel = `reports[${reportIndex}]`;
    if (!exactKeys(candidate, REPORT_KEYS, candidateLabel, failures)) continue;
    if (!operatingSystems.includes(
      candidate.operatingSystem as typeof operatingSystems[number],
    ) || !evidenceRoles.includes(
      candidate.evidenceRole as typeof evidenceRoles[number],
    )) {
      failures.push(`${candidateLabel}: invalid operating system or evidence role`);
      continue;
    }
    const report = candidate as unknown as AnimatedImageTruthRunReport;
    const key = `${report.operatingSystem}/${report.evidenceRole}`;
    if (reportsByKey.has(key)) {
      failures.push(`${key}: duplicate artifact`);
      continue;
    }
    reportsByKey.set(key, report);
    if (report.schemaVersion !== ANIMATED_IMAGE_TRUTH_SCHEMA_VERSION ||
        report.ticket !== "DM-2583" || report.stage !== "animated-image-owner-resource-truth") {
      failures.push(`${key}: report envelope drift`);
    }
    if (report.sourceRevision !== ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION) {
      failures.push(`${key}: Chromium source revision drift`);
    }
    if (!["arm64", "x64"].includes(report.architecture) ||
        typeof report.platformRelease !== "string" ||
        report.platformRelease.length === 0 ||
        typeof report.browserVersion !== "string" ||
        !report.browserVersion.endsWith(ANIMATED_IMAGE_TRUTH_BROWSER_VERSION)) {
      failures.push(`${key}: browser/platform provenance drift`);
    }
    if (report.schemaSha256 !== ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256) {
      failures.push(`${key}: schema digest drift`);
    }
    validateSha(report.sourceManifestSha256, `${key}.sourceManifestSha256`, failures);
    validateSha(report.patchSha256, `${key}.patchSha256`, failures);
    if (report.sourceManifestSha256 !==
        ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256) {
      failures.push(`${key}: source-manifest authority drift`);
    }
    if (report.patchSha256 !== ANIMATED_IMAGE_TRUTH_PATCH_SHA256) {
      failures.push(`${key}: helper patch authority drift`);
    }
    validateSha(report.normalizedLogicalSha256, `${key}.normalizedLogicalSha256`, failures);
    if (report.explicitHeadless !== true) failures.push(`${key}: browser launch was not explicitly headless`);
    if (typeof report.buildInvocationId !== "string" ||
        report.buildInvocationId.length === 0 ||
        typeof report.observationId !== "string" || report.observationId.length === 0 ||
        typeof report.browserContextId !== "string" || report.browserContextId.length === 0 ||
        !Number.isInteger(report.browserProcessId) || report.browserProcessId <= 0) {
      failures.push(`${key}: build/process/context provenance incomplete`);
    }
    if (!exactKeys(
      report.binaries, BINARIES_KEYS, `${key}.binaries`, failures,
    )) continue;
    const browserIsValid = validateBinary(
      report.binaries.browser, `${key}.browser`, failures,
    );
    const rendererIsValid = validateBinary(
      report.binaries.renderer, `${key}.renderer`, failures,
    );
    if (browserIsValid && rendererIsValid) {
      if (report.binaries.browser.sha256 !== report.binaries.renderer.sha256 ||
          report.binaries.browser.byteLength !== report.binaries.renderer.byteLength) {
        failures.push(`${key}: multiprocess browser/renderer executable identity differs`);
      }
      const expectedExecutableToken = report.operatingSystem === "Windows"
        ? "headless_shell.exe"
        : "headless_shell";
      if (report.binaries.browser.pathToken !== expectedExecutableToken ||
          report.binaries.renderer.pathToken !== expectedExecutableToken) {
        failures.push(`${key}: browser/renderer executable path token drift`);
      }
    }
    if (!Array.isArray(report.binaries.loadedLibraries)) {
      failures.push(`${key}.loadedLibraries: expected an array`);
      continue;
    }
    const validLibraries = report.binaries.loadedLibraries.flatMap(
      (binary, index) => validateBinary(
        binary, `${key}.loadedLibraries[${index}]`, failures,
      ) ? [binary] : [],
    );
    const libraryTokens = validLibraries.map((binary) =>
      binary.pathToken.toLowerCase());
    if (validLibraries.length !== report.binaries.loadedLibraries.length) {
      failures.push(`${key}: loaded-library manifest contains malformed entries`);
    } else if (new Set(libraryTokens).size !== libraryTokens.length) {
      failures.push(`${key}: loaded-library manifest contains duplicate paths`);
    }
    if (!libraryTokens.some((token) => token.includes("blink_core")) ||
        !libraryTokens.some((token) => token.includes("blink_platform"))) {
      failures.push(`${key}: loaded-library manifest lacks Blink core/platform`);
    }
    if (!Array.isArray(report.rows)) {
      failures.push(`${key}.rows: expected an array`);
      continue;
    }
    const seen = new Set<string>();
    let rowsSafeForNormalization = true;
    for (const [rowIndex, rowCandidate] of report.rows.entries()) {
      const rowObject = rowCandidate != null && typeof rowCandidate === "object" &&
        !Array.isArray(rowCandidate) ? rowCandidate as unknown as Record<string, unknown> : null;
      const rowKey = typeof rowObject?.probeId === "string" &&
        typeof rowObject.caseId === "string"
        ? `${rowObject.probeId}/${rowObject.caseId}`
        : `rows[${rowIndex}]`;
      if (seen.has(rowKey)) {
        failures.push(`${key}: duplicate row ${rowKey}`);
        rowsSafeForNormalization = false;
      }
      seen.add(rowKey);
      const rowFailures = validateProbeRow(
        rowCandidate as AnimatedImageTruthProbeRow,
        `${key}/${rowKey}`,
      );
      failures.push(...rowFailures);
      if (rowFailures.length !== 0) {
        rowsSafeForNormalization = false;
        continue;
      }
      const row = rowCandidate as AnimatedImageTruthProbeRow;
      if (row.begin.oracle.patchSha256 !== report.patchSha256 ||
          row.finish.oracle.patchSha256 !== report.patchSha256) {
        failures.push(`${key}/${rowKey}: helper/report patch identity mismatch`);
      }
    }
    for (const requiredCase of ANIMATED_IMAGE_TRUTH_CASES) {
      const rowKey = `${requiredCase.probeId}/${requiredCase.caseId}`;
      if (!seen.has(rowKey)) failures.push(`${key}: missing case ${rowKey}`);
    }
    if (seen.size !== ANIMATED_IMAGE_TRUTH_CASES.length) {
      failures.push(`${key}: case corpus cardinality drift`);
    }
    if (rowsSafeForNormalization) {
      const reopened = normalizedAnimatedImageTruthRowsSha256(report.rows);
      if (reopened !== report.normalizedLogicalSha256) {
        failures.push(`${key}: normalized logical digest does not reopen`);
      }
    }
  }
  for (const key of expectedKeys) if (!reportsByKey.has(key)) failures.push(`${key}: artifact missing`);

  for (const os of ["macOS", "Linux", "Windows"] as const) {
    const proposal = reportsByKey.get(`${os}/proposal`);
    const validation = reportsByKey.get(`${os}/validation`);
    if (!proposal || !validation) continue;
    if (proposal.buildInvocationId === validation.buildInvocationId ||
        proposal.observationId === validation.observationId ||
        proposal.browserProcessId === validation.browserProcessId ||
        proposal.browserContextId === validation.browserContextId) {
      failures.push(`${os}: proposal and validation are not independent fresh builds/processes/contexts`);
    }
    if (proposal.patchSha256 !== validation.patchSha256 ||
        proposal.sourceManifestSha256 !== validation.sourceManifestSha256) {
      failures.push(`${os}: proposal/validation source or patch authority differs`);
    }
    if (proposal.architecture !== validation.architecture ||
        proposal.platformRelease !== validation.platformRelease ||
        proposal.browserVersion !== validation.browserVersion) {
      failures.push(`${os}: proposal/validation browser or platform differs`);
    }
    if (proposal.normalizedLogicalSha256 !== validation.normalizedLogicalSha256) {
      failures.push(`${os}: proposal/validation logical evidence differs`);
    }
  }

  const logicalDigests = new Set(
    expectedKeys.map((key) => reportsByKey.get(key)?.normalizedLogicalSha256)
      .filter((digest): digest is string => typeof digest === "string"),
  );
  if (reportsByKey.size === expectedKeys.length && logicalDigests.size !== 1) {
    failures.push("exact normalized logical evidence differs across operating systems");
  }
  return {
    schemaVersion: 1,
    ticket: "DM-2583",
    requiredArtifactKeys: expectedKeys,
    normalizedLogicalSha256: failures.length === 0 ? [...logicalDigests][0] ?? null : null,
    verdict: failures.length === 0 ? "proposal-validation-agreement" : "verdict-withheld",
    failures,
  };
}
