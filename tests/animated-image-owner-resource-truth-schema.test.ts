import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAnimatedImageOwnerResourceTruthAdjudicator } from
  "../tools/animated-image-owner-resource-truth-adjudicator.js";
import {
  adjudicateAnimatedImageOwnerResourceTruth,
  animatedImageTruthSha256,
  ANIMATED_IMAGE_TRUTH_CASES,
  ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION,
  ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT,
  ANIMATED_IMAGE_TRUTH_PATCH_SHA256,
  ANIMATED_IMAGE_TRUTH_PROBES,
  ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS,
  ANIMATED_IMAGE_TRUTH_PROTOCOL,
  ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256,
  ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256,
  normalizedAnimatedImageTruthRowsSha256,
  validateAnimatedImageTruthRecord,
  type AnimatedImageTruthAuthorizedRecord,
  type AnimatedImageTruthDeniedRecord,
  type AnimatedImageTruthProbeRow,
  type AnimatedImageTruthRunReport,
} from "../tools/animated-image-owner-resource-truth-schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function oracle(sessionId = "session-1") {
  return {
    chromiumRevision: ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION,
    schemaSha256: ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256,
    patchSha256: ANIMATED_IMAGE_TRUTH_PATCH_SHA256,
    rendererProcessId: 701,
    rootFrameId: "root-frame",
    sessionId,
  } as const;
}

function strictRequest() {
  return {
    ownerSelectorToken: "opaque-owner-1",
    requestedFrameIndex: 2,
    limitsFingerprint: ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT,
  };
}

function authorizedRecord(
  overrides: Partial<AnimatedImageTruthAuthorizedRecord> = {},
): AnimatedImageTruthAuthorizedRecord {
  const record: AnimatedImageTruthAuthorizedRecord = {
    protocol: ANIMATED_IMAGE_TRUTH_PROTOCOL,
    outcome: "authorized",
    oracle: oracle(),
    strictRequest: strictRequest(),
    document: {
      targetId: "target-1",
      frameId: "frame-1",
      documentLoaderId: "loader-1",
      documentNonce: "document-1",
      navigationSequence: 1,
      url: "https://127.0.0.1:4401/probe.html",
      origin: "https://127.0.0.1:4401",
    },
    owner: {
      kind: "html-image",
      backendNodeId: 41,
      shadowHostBackendNodeIds: [],
      shadowRootTypes: [],
      pseudo: null,
      slot: {
        property: "html-current",
        index: 0,
        imageSetOptionIndex: null,
      },
      currentSrc: "https://127.0.0.1:4401/animated.webp",
      selectedResourceUrl: "https://127.0.0.1:4401/animated.webp",
      candidateFactsSha256: SHA_A,
      devicePixelRatio: 2,
      viewportSha256: SHA_B,
    },
    resource: {
      contentLogicalId: "content-1",
      resourceLogicalId: "resource-1",
      inspectorRequestId: "request-1",
      requestLoaderId: "loader-1",
      requestFrameId: "frame-1",
      requestMode: "cors",
      credentialsMode: "same-origin",
      redirects: [],
      currentRequestUrl: "https://127.0.0.1:4401/animated.webp",
      responseUrl: "https://127.0.0.1:4401/animated.webp",
      status: 200,
      mimeType: "image/webp",
      rawContentType: "image/webp",
      fetchResponseType: "basic",
      corsSameOrigin: true,
      singleSecurityOrigin: true,
      fromDiskCache: false,
      fromMemoryCache: false,
      memoryCacheHitCount: 0,
      fromServiceWorker: false,
      serviceWorkerControllerVersionId: null,
      serviceWorkerResponseSource: null,
      serviceWorkerRouterSha256: null,
      serviceWorkerUrlList: [],
      cacheStorageCacheName: null,
      responseTime: 1_700_000_000_000,
      originalResponseTime: 1_700_000_000_000,
      revalidationCount: 0,
      lastRevalidationStatus: null,
      networkEncodedDataLength: 121,
    },
    body: {
      transport: "network-get-response-body",
      base64EncodedByProtocol: true,
      byteLength: 113,
      sha256: SHA_A,
      networkLoadingFinished: true,
    },
    epochs: {
      preflightSha256: SHA_B,
      postflightSha256: SHA_B,
      resourceResponseSequence: 1,
      collectedAtMonotonicMs: 20,
    },
  };
  return { ...record, ...overrides };
}

function deniedRecord(
  denialCode: AnimatedImageTruthDeniedRecord["denialCode"] = "cors-denied",
): AnimatedImageTruthDeniedRecord {
  return {
    protocol: ANIMATED_IMAGE_TRUTH_PROTOCOL,
    outcome: "denied",
    oracle: oracle(),
    strictRequest: strictRequest(),
    denialCode,
    document: {
      targetId: "target-1",
      frameId: "frame-1",
      documentLoaderId: "loader-1",
      documentNonce: "document-1",
      navigationSequence: 1,
    },
    owner: {
      kind: "html-image",
      backendNodeId: 41,
      shadowHostBackendNodeIds: [],
      shadowRootTypes: [],
      pseudo: null,
      slot: {
        property: "html-current",
        index: 0,
        imageSetOptionIndex: null,
      },
    },
    requestIdentity: {
      inspectorRequestId: "request-1",
      requestLoaderId: "loader-1",
      requestFrameId: "frame-1",
      requestMode: "no-cors",
      credentialsMode: "include",
    },
  };
}

function probeRows(): AnimatedImageTruthProbeRow[] {
  const requirements = new Map(
    ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS.map((entry) => [entry.probeId, entry]),
  );
  return ANIMATED_IMAGE_TRUTH_CASES.map((requiredCase) => {
    const caseKey = `${requiredCase.probeId}/${requiredCase.caseId}`;
    let denialCode: AnimatedImageTruthDeniedRecord["denialCode"] = "candidate-drift";
    if (caseKey === "active-revalidation/in-flight-validator") {
      denialCode = "revalidation-in-flight";
    } else if (caseKey === "cors-failure/missing-acao") {
      denialCode = "cors-denied";
    } else if (caseKey === "paintable-no-cors-denial/opaque-paintable") {
      denialCode = "opaque-response";
    } else if (caseKey === "multipart-rejection/two-parts") {
      denialCode = "multipart-response";
    }
    const makeDenied = (): AnimatedImageTruthDeniedRecord => {
      const record = deniedRecord(denialCode);
      if (record.owner) {
        record.owner.kind = requiredCase.property === "html-current"
          ? "html-image"
          : requiredCase.property === "svg-href"
          ? "svg-image"
          : requiredCase.property === "input-src"
          ? "image-input"
          : "css-image";
        record.owner.slot.property = requiredCase.property;
        record.owner.slot.index = requiredCase.index;
        if (requiredCase.pseudoType) {
          record.owner.pseudo = {
            backendNodeId: 92,
            type: requiredCase.pseudoType,
          };
        }
      }
      if (caseKey === "paintable-no-cors-denial/opaque-paintable" &&
          record.requestIdentity) {
        record.requestIdentity.requestMode = "no-cors";
      }
      return record;
    };
    const makeAuthorized = (): AnimatedImageTruthAuthorizedRecord => {
      const record = authorizedRecord();
      record.owner.kind = requiredCase.property === "html-current"
        ? "html-image"
        : requiredCase.property === "svg-href"
        ? "svg-image"
        : requiredCase.property === "input-src"
        ? "image-input"
        : "css-image";
      record.owner.slot.property = requiredCase.property;
      record.owner.slot.index = requiredCase.index;
      if (requiredCase.pseudoType) {
        record.owner.pseudo = {
          backendNodeId: 92,
          type: requiredCase.pseudoType,
        };
      }
      if (caseKey === "img-src-mutation/stable-animated-webp") {
        record.resource.mimeType = "image/webp";
      } else if (caseKey === "img-src-mutation/stable-apng") {
        record.resource.mimeType = "image/png";
        record.resource.rawContentType = "image/png";
      } else if (caseKey ===
          "css-image-set-option-reorder/stable-selected-option") {
        record.owner.slot.imageSetOptionIndex = 0;
      } else if (caseKey.startsWith("same-url-memory-cache-sharing/")) {
        record.resource.memoryCacheHitCount = 1;
      } else if (caseKey === "redirect-response-mime-drift/stable-redirect") {
        record.resource.redirects = [{
          requestUrl: "https://127.0.0.1:4401/redirect.gif",
          responseUrl: "https://127.0.0.1:4401/redirect.gif",
          status: 302,
          responseTime: 1_700_000_000_000,
        }];
      } else if (caseKey === "settled-304/settled-cache-entry") {
        record.resource.revalidationCount = 1;
        record.resource.lastRevalidationStatus = 304;
      } else if (caseKey ===
          "service-worker-router-cache-replacement/stable-cache-route") {
        record.resource.fromServiceWorker = true;
        record.resource.serviceWorkerControllerVersionId = "17";
        record.resource.serviceWorkerResponseSource = "cache-storage";
        record.resource.serviceWorkerRouterSha256 = SHA_B;
        record.resource.serviceWorkerUrlList = [
          "https://127.0.0.1:4401/sw-asset.gif",
        ];
        record.resource.cacheStorageCacheName = "dm2583-a";
      } else if (caseKey === "cors-anonymous-success/anonymous") {
        record.resource.requestMode = "cors";
        record.resource.credentialsMode = "same-origin";
        record.resource.fetchResponseType = "cors";
      } else if (caseKey === "cors-credentials-success/credentials") {
        record.resource.requestMode = "cors";
        record.resource.credentialsMode = "include";
        record.resource.fetchResponseType = "cors";
      } else if (caseKey === "data-url-mutation/stable-data") {
        record.owner.currentSrc = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
        record.owner.selectedResourceUrl = record.owner.currentSrc;
        record.resource.currentRequestUrl = record.owner.currentSrc;
        record.resource.responseUrl = record.owner.currentSrc;
        record.resource.networkEncodedDataLength = -1;
        record.body.transport = "data-url";
        record.body.base64EncodedByProtocol = false;
        record.body.networkLoadingFinished = null;
      } else if (caseKey === "blob-replacement-revocation/stable-blob") {
        const blobUrl =
          "blob:https://127.0.0.1:4401/11111111-1111-1111-1111-111111111111";
        record.owner.currentSrc = blobUrl;
        record.owner.selectedResourceUrl = blobUrl;
        record.resource.currentRequestUrl = blobUrl;
        record.resource.responseUrl = blobUrl;
        record.resource.networkEncodedDataLength = -1;
        record.body.transport = "blob-read";
        record.body.base64EncodedByProtocol = false;
        record.body.networkLoadingFinished = null;
      } else if (caseKey ===
          "shadow-pseudo-slot-collision/stable-closed-shadow-before") {
        record.owner.shadowHostBackendNodeIds = [91];
        record.owner.shadowRootTypes = ["closed"];
        record.owner.pseudo = { backendNodeId: 92, type: "before" };
      } else if (caseKey === "owner-adoption-detachment/stable-svg") {
        record.owner.kind = "svg-image";
      } else if (caseKey === "navigation-stale-backend-node/stable-input") {
        record.owner.kind = "image-input";
      }
      return record;
    };
    const isAuthorized = requiredCase.expected === "stable-authorized";
    const begin = isAuthorized ? makeAuthorized() : makeDenied();
    const finish = isAuthorized ? makeAuthorized() : makeDenied();
    const requirement = requirements.get(requiredCase.probeId)!;
    return {
      probeId: requiredCase.probeId,
      caseId: requiredCase.caseId,
      expected: requiredCase.expected,
      begin,
      finish,
      transactionUnchanged: requiredCase.expected !== "reject-drift",
      publicBody: isAuthorized ? {
        transport: begin.body.transport,
        base64EncodedByProtocol: begin.body.base64EncodedByProtocol,
        byteLength: begin.body.byteLength,
        sha256: begin.body.sha256,
      } : null,
      deniedInspectorBodyDiscarded: !isAuthorized,
      activation: {
        sourceReferences: requirement.sourceReferences,
        mutatedFacts: requirement.mutatedFacts,
        observedFailure: isAuthorized ? null : denialCode,
      },
    };
  });
}

function report(
  operatingSystem: AnimatedImageTruthRunReport["operatingSystem"],
  evidenceRole: AnimatedImageTruthRunReport["evidenceRole"],
  identity: number,
): AnimatedImageTruthRunReport {
  const rows = probeRows();
  return {
    schemaVersion: 1,
    ticket: "DM-2583",
    stage: "animated-image-owner-resource-truth",
    operatingSystem,
    architecture: "x64",
    platformRelease: "test-platform-release",
    browserVersion: "151.0.7918.0",
    evidenceRole,
    sourceRevision: ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION,
    sourceManifestSha256: ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256,
    schemaSha256: ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256,
    patchSha256: ANIMATED_IMAGE_TRUTH_PATCH_SHA256,
    buildInvocationId: `build-${identity}`,
    observationId: `observation-${identity}`,
    browserProcessId: 1_000 + identity,
    browserContextId: `context-${identity}`,
    explicitHeadless: true,
    binaries: {
      browser: {
        pathToken: operatingSystem === "Windows"
          ? "headless_shell.exe"
          : "headless_shell",
        byteLength: 100,
        sha256: SHA_A,
      },
      renderer: {
        pathToken: operatingSystem === "Windows"
          ? "headless_shell.exe"
          : "headless_shell",
        byteLength: 100,
        sha256: SHA_A,
      },
      loadedLibraries: [
        { pathToken: "libblink_core", byteLength: 102, sha256: SHA_A },
        { pathToken: "libblink_platform", byteLength: 103, sha256: SHA_A },
      ],
    },
    rows,
    normalizedLogicalSha256: normalizedAnimatedImageTruthRowsSha256(rows),
  };
}

describe("animated image owner/resource truth schema", () => {
  it("pins the contract and fixed limit fingerprints", () => {
    expect(ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256).toBe(
      "52969c415240f444dde400e0bd6920f0aee0ff2c68787a4edfe204b8c958b2c5",
    );
    expect(ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT).toBe(
      "b020def31cbbf0944279249bbe1f802cb98fc73436a012a57bd854f79d32c195",
    );
    expect(ANIMATED_IMAGE_TRUTH_PATCH_SHA256).toBe(
      "93e150ec097a69dd4ef923bc223570ca7da3c647526cf147b1b3c3b1170e174f",
    );
    expect(ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256).toBe(
      "3dc66cab6e2982a336eb275cc808a260b590b535ed304a0701c43350f3b838cd",
    );
    expect(new Set(ANIMATED_IMAGE_TRUTH_PROBES).size).toBe(22);
    expect(new Set(ANIMATED_IMAGE_TRUTH_CASES.map((row) =>
      `${row.probeId}/${row.caseId}`)).size).toBe(38);
    expect(ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS.map((row) => row.probeId))
      .toEqual(ANIMATED_IMAGE_TRUTH_PROBES);
  });

  it("keeps the evidence browser launch explicitly headless", async () => {
    const source = await readFile(
      new URL("../tools/animated-image-owner-resource-truth-collector.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/chromium\.launch\(/g)).toHaveLength(1);
    expect(source).toMatch(/chromium\.launch\(\{[\s\S]*?headless:\s*true,/);
    expect(source).not.toMatch(/headless:\s*false/);
    expect(source).toMatch(/host\.pseudoElements\?\.find/);
    expect(source).not.toMatch(/node\.parentId\s*===\s*host\.nodeId/);
  });

  it("retains the exact reproducible 26-file private Chromium patch", async () => {
    const source = await readFile(
      new URL(
        "../tools/animated-image-owner-resource-truth-chromium.patch",
        import.meta.url,
      ),
      "utf8",
    );
    const paths = [...source.matchAll(/^diff --git a\/(.+) b\/\1$/gm)]
      .map((match) => match[1]);
    expect(paths).toHaveLength(26);
    expect(new Set(paths).size).toBe(26);
    expect(source).toContain(
      "93e150ec097a69dd4ef923bc223570ca7da3c647526cf147b1b3c3b1170e174f",
    );
    expect(source).toContain("experimental domain DomotionAnimatedImageTruth");
  });

  it("accepts a bounded, origin-clean, exact authorized transaction", () => {
    expect(validateAnimatedImageTruthRecord(authorizedRecord())).toEqual([]);
  });

  it("rejects body or URL facts smuggled into every denied identity level", () => {
    for (const mutate of [
      (record: Record<string, unknown>) => { record.body = { sha256: SHA_A }; },
      (record: Record<string, unknown>) => {
        (record.document as Record<string, unknown>).url = "https://secret.invalid/body";
      },
      (record: Record<string, unknown>) => {
        (record.owner as Record<string, unknown>).selectedResourceUrl =
          "https://secret.invalid/body";
      },
      (record: Record<string, unknown>) => {
        (record.requestIdentity as Record<string, unknown>).byteLength = 113;
      },
    ]) {
      const value = structuredClone(deniedRecord()) as unknown as Record<string, unknown>;
      mutate(value);
      expect(validateAnimatedImageTruthRecord(
        value as unknown as AnimatedImageTruthDeniedRecord,
      ).some((failure) => failure.includes("unsafe or missing keys"))).toBe(true);
    }
  });

  it("rejects unsafe or unbounded owner-selector tokens in denied artifacts", () => {
    for (const token of ["owner/path?secret=1", "x".repeat(129)]) {
      const value = deniedRecord();
      value.strictRequest.ownerSelectorToken = token;
      expect(validateAnimatedImageTruthRecord(value)).toContain(
        "record.strictRequest: opaque owner selector token is missing or unsafe",
      );
    }
  });

  it("rejects unstable, multipart, unbounded, or non-completed authorized bytes", () => {
    const changedEpoch = authorizedRecord({
      epochs: { ...authorizedRecord().epochs, postflightSha256: SHA_A },
    });
    const multipart = authorizedRecord({
      resource: {
        ...authorizedRecord().resource,
        rawContentType: "multipart/x-mixed-replace; boundary=frame",
      },
    });
    const earlyBody = authorizedRecord({
      body: {
        ...authorizedRecord().body,
        networkLoadingFinished: null as unknown as true,
      },
    });
    const oversized = authorizedRecord({
      body: { ...authorizedRecord().body, byteLength: 64 * 1024 * 1024 + 1 },
    });

    for (const record of [changedEpoch, multipart, earlyBody, oversized]) {
      expect(validateAnimatedImageTruthRecord(record).length).toBeGreaterThan(0);
    }
  });

  it("ratifies all six independent fresh OS proposal/validation artifacts", () => {
    const reports = [
      report("macOS", "proposal", 1),
      report("macOS", "validation", 2),
      report("Linux", "proposal", 3),
      report("Linux", "validation", 4),
      report("Windows", "proposal", 5),
      report("Windows", "validation", 6),
    ];
    const result = adjudicateAnimatedImageOwnerResourceTruth(reports);
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe("proposal-validation-agreement");
    expect(result.normalizedLogicalSha256).toBe(reports[0].normalizedLogicalSha256);
  });

  it("withholds a mutually consistent but foreign patch and manifest authority", () => {
    const reports = [
      report("macOS", "proposal", 1),
      report("macOS", "validation", 2),
      report("Linux", "proposal", 3),
      report("Linux", "validation", 4),
      report("Windows", "proposal", 5),
      report("Windows", "validation", 6),
    ];
    for (const candidate of reports) {
      candidate.patchSha256 = SHA_A;
      candidate.sourceManifestSha256 = SHA_B;
      for (const row of candidate.rows) {
        row.begin.oracle.patchSha256 = SHA_A;
        row.finish.oracle.patchSha256 = SHA_A;
      }
      candidate.normalizedLogicalSha256 =
        normalizedAnimatedImageTruthRowsSha256(candidate.rows);
    }

    const result = adjudicateAnimatedImageOwnerResourceTruth(reports);
    expect(result.verdict).toBe("verdict-withheld");
    expect(result.failures).toContain("macOS/proposal: helper patch authority drift");
    expect(result.failures).toContain(
      "Windows/validation: source-manifest authority drift",
    );
  });

  it("seals every reopened input and the persisted adjudication envelope", () => {
    const directory = mkdtempSync(join(tmpdir(), "dm2583-adjudicator-"));
    try {
      const reports = [
        report("macOS", "proposal", 1),
        report("macOS", "validation", 2),
        report("Linux", "proposal", 3),
        report("Linux", "validation", 4),
        report("Windows", "proposal", 5),
        report("Windows", "validation", 6),
      ];
      const paths = reports.map((value, index) => {
        const path = join(directory, `artifact-${index}.json`);
        writeFileSync(path, `${JSON.stringify(value)}\n`);
        return path;
      });
      const artifact = runAnimatedImageOwnerResourceTruthAdjudicator(paths);
      const { reportSha256, ...payload } = artifact;
      expect(artifact.adjudication.verdict).toBe("proposal-validation-agreement");
      expect(artifact.inputs).toHaveLength(6);
      expect(artifact.inputs.every((input) =>
        input.byteLength > 0 && /^[0-9a-f]{64}$/.test(input.sha256))).toBe(true);
      expect(reportSha256).toBe(animatedImageTruthSha256(payload));
      expect(runAnimatedImageOwnerResourceTruthAdjudicator(
        [...paths].reverse(),
      ).reportSha256).toBe(reportSha256);

      const malformedPath = join(directory, "malformed-structural.json");
      writeFileSync(malformedPath, '{"not":"a report"}\n');
      const withheld = runAnimatedImageOwnerResourceTruthAdjudicator([
        paths[0],
        malformedPath,
      ]);
      expect(withheld.adjudication.verdict).toBe("verdict-withheld");
      expect(withheld.adjudication.failures.some((failure) =>
        failure.includes("unsafe or missing keys"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalizes per-context blob tokens without weakening byte identity", () => {
    const left = [probeRows().find((row) =>
      row.probeId === "blob-replacement-revocation" &&
      row.caseId === "stable-blob")!];
    const right = structuredClone(left);
    const bindBlobIdentity = (
      row: AnimatedImageTruthProbeRow,
      blobUrl: string,
      candidateFactsSha256: string,
    ): void => {
      for (const record of [row.begin, row.finish]) {
        if (record.outcome !== "authorized") throw new Error("expected blob authorization");
        record.owner.currentSrc = blobUrl;
        record.owner.selectedResourceUrl = blobUrl;
        record.owner.candidateFactsSha256 = candidateFactsSha256;
        record.resource.currentRequestUrl = blobUrl;
        record.resource.responseUrl = blobUrl;
      }
    };
    bindBlobIdentity(
      left[0],
      "blob:http://localhost:4401/11111111-1111-1111-1111-111111111111",
      SHA_A,
    );
    bindBlobIdentity(
      right[0],
      "blob:http://127.0.0.1:5502/22222222-2222-2222-2222-222222222222",
      SHA_B,
    );
    expect(normalizedAnimatedImageTruthRowsSha256(left)).toBe(
      normalizedAnimatedImageTruthRowsSha256(right),
    );
    const rightRecord = right[0].begin as AnimatedImageTruthAuthorizedRecord;
    rightRecord.body.sha256 = SHA_B;
    expect(normalizedAnimatedImageTruthRowsSha256(left)).not.toBe(
      normalizedAnimatedImageTruthRowsSha256(right),
    );
  });

  it("normalizes memory-cache reuse counts to the authenticated reuse fact", () => {
    const left = [probeRows().find((row) =>
      row.probeId === "same-url-memory-cache-sharing" &&
      row.caseId === "css-shared")!];
    const right = structuredClone(left);
    for (const record of [right[0].begin, right[0].finish]) {
      if (record.outcome === "authorized") record.resource.memoryCacheHitCount = 7;
    }
    expect(normalizedAnimatedImageTruthRowsSha256(left)).toBe(
      normalizedAnimatedImageTruthRowsSha256(right),
    );
    for (const record of [right[0].begin, right[0].finish]) {
      if (record.outcome === "authorized") record.resource.memoryCacheHitCount = 0;
    }
    expect(normalizedAnimatedImageTruthRowsSha256(left)).not.toBe(
      normalizedAnimatedImageTruthRowsSha256(right),
    );
  });

  it("withholds when the browser and renderer executable identities differ", () => {
    const reports = [
      report("macOS", "proposal", 1),
      report("macOS", "validation", 2),
      report("Linux", "proposal", 3),
      report("Linux", "validation", 4),
      report("Windows", "proposal", 5),
      report("Windows", "validation", 6),
    ];
    reports[0].binaries.renderer.sha256 = SHA_B;
    const result = adjudicateAnimatedImageOwnerResourceTruth(reports);
    expect(result.verdict).toBe("verdict-withheld");
    expect(result.failures).toContain(
      "macOS/proposal: multiprocess browser/renderer executable identity differs",
    );

    reports[0].binaries.renderer.sha256 = SHA_A;
    reports[0].binaries.renderer.pathToken = "untrusted-browser";
    reports[0].binaries.loadedLibraries = [
      { pathToken: "unrelated-library", byteLength: 102, sha256: SHA_A },
    ];
    const pathResult = adjudicateAnimatedImageOwnerResourceTruth(reports);
    expect(pathResult.failures).toContain(
      "macOS/proposal: browser/renderer executable path token drift",
    );
    expect(pathResult.failures).toContain(
      "macOS/proposal: loaded-library manifest lacks Blink core/platform",
    );
  });

  it("withholds on a reused process/build/context or a missing OS arm", () => {
    const proposal = report("macOS", "proposal", 1);
    const validation = report("macOS", "validation", 2);
    validation.buildInvocationId = proposal.buildInvocationId;
    validation.browserProcessId = proposal.browserProcessId;
    validation.browserContextId = proposal.browserContextId;
    const result = adjudicateAnimatedImageOwnerResourceTruth([proposal, validation]);
    expect(result.verdict).toBe("verdict-withheld");
    expect(result.failures).toContain(
      "macOS: proposal and validation are not independent fresh builds/processes/contexts",
    );
    expect(result.failures).toContain("Linux/proposal: artifact missing");
  });

  it("withholds and reports malformed nested records instead of throwing", () => {
    const malformed = authorizedRecord() as unknown as Record<string, unknown>;
    malformed.resource = null;
    expect(() => validateAnimatedImageTruthRecord(
      malformed as unknown as AnimatedImageTruthAuthorizedRecord,
    )).not.toThrow();
    expect(validateAnimatedImageTruthRecord(
      malformed as unknown as AnimatedImageTruthAuthorizedRecord,
    ).length).toBeGreaterThan(0);

    const malformedReport = report("macOS", "proposal", 1) as unknown as
      Record<string, unknown>;
    malformedReport.rows = null;
    expect(() => adjudicateAnimatedImageOwnerResourceTruth(
      [malformedReport as unknown as AnimatedImageTruthRunReport],
    )).not.toThrow();
    const adjudication = adjudicateAnimatedImageOwnerResourceTruth(
      [malformedReport as unknown as AnimatedImageTruthRunReport],
    );
    expect(adjudication.verdict).toBe("verdict-withheld");
    expect(adjudication.failures).toContain("macOS/proposal.rows: expected an array");

    const malformedBinaries = report("macOS", "proposal", 2) as unknown as
      Record<string, unknown>;
    const binaries = malformedBinaries.binaries as Record<string, unknown>;
    binaries.browser = null;
    binaries.loadedLibraries = [null];
    expect(() => adjudicateAnimatedImageOwnerResourceTruth(
      [malformedBinaries as unknown as AnimatedImageTruthRunReport],
    )).not.toThrow();
    expect(adjudicateAnimatedImageOwnerResourceTruth(
      [malformedBinaries as unknown as AnimatedImageTruthRunReport],
    ).failures.some((failure) => failure.includes("loaded-library manifest")))
      .toBe(true);
  });
});
