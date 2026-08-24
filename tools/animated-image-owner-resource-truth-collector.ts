/**
 * Evidence-only DM-2583 collector for a locally built pinned private Chromium.
 * It never feeds bytes into production capture or an image decoder. Every
 * launch is explicitly headless, and denied/transient bytes are discarded
 * before a row can be retained.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright";

import {
  ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION,
  ANIMATED_IMAGE_TRUTH_CASES,
  ANIMATED_IMAGE_TRUTH_BROWSER_VERSION,
  ANIMATED_IMAGE_TRUTH_LIMITS,
  ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT,
  ANIMATED_IMAGE_TRUTH_OWNER_SELECTOR_TOKEN,
  ANIMATED_IMAGE_TRUTH_PATCH_SHA256,
  ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS,
  ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256,
  ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256,
  normalizedAnimatedImageTruthRowsSha256,
  validateAnimatedImageTruthProbeRow,
  type AnimatedImageTruthBinaryIdentity,
  type AnimatedImageTruthDeniedRecord,
  type AnimatedImageTruthExpectedOutcome,
  type AnimatedImageTruthProbeId,
  type AnimatedImageTruthProbeRow,
  type AnimatedImageTruthProperty,
  type AnimatedImageTruthPublicBodyEvidence,
  type AnimatedImageTruthRecord,
  type AnimatedImageTruthRunReport,
} from "./animated-image-owner-resource-truth-schema.js";

type MutationStep =
  | { kind: "evaluate"; source: string }
  | { kind: "cdp"; method: string; params?: Record<string, unknown> }
  | { kind: "navigate"; url: string; waitUntil?: "load" | "domcontentloaded" }
  | { kind: "wait"; milliseconds: number };

interface ProbePlanRow {
  probeId: AnimatedImageTruthProbeId;
  caseId: string;
  expected: AnimatedImageTruthExpectedOutcome;
  url: string;
  ownerSelectorToken: string;
  property: AnimatedImageTruthProperty;
  index: number;
  requestedFrameIndex: number;
  pseudoType?: string;
  settleMilliseconds?: number;
  mutationSteps: MutationStep[];
  sourceReferences: string[];
  mutatedFacts: string[];
  exerciseDeniedInspectorBody?: boolean;
}

interface ProbePlan {
  schemaVersion: 1;
  ticket: "DM-2583";
  rows: ProbePlanRow[];
}

interface SourceAuthority {
  schemaVersion: 1;
  ticket: "DM-2583";
  sourceRevision: typeof ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION;
  skiaRevision: string;
  depotToolsRevision: string;
  sourceManifestSha256: string;
  patchSha256: string;
  files: Array<{
    path: string;
    byteLength: number;
    sha256: string;
  }>;
}

interface CliOptions {
  browser: string;
  renderer: string;
  loadedLibraries: string[];
  plan: string;
  authority: string;
  out: string;
  operatingSystem: AnimatedImageTruthRunReport["operatingSystem"];
  evidenceRole: AnimatedImageTruthRunReport["evidenceRole"];
  buildInvocationId: string;
  observationId: string;
}

interface PrivateBeginResult {
  transactionId: string;
  record: AnimatedImageTruthRecord;
}

interface PrivateFinishResult {
  unchanged: boolean;
  record: AnimatedImageTruthRecord;
}

const SHA256 = /^[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);
const PRIVATE_PROTOCOL_TIMEOUT_MS = 15_000;
const TEARDOWN_TIMEOUT_MS = 10_000;
const PINNED_SKIA_REVISION =
  "62efacd37737505732dbe3d8daa62abd679626a1";
const PINNED_DEPOT_TOOLS_REVISION =
  "612d70c7ccb01d4a405e822ad0505206de636d7e";
let safeFailureStage = "startup";
const EXPECTED_PATCH_FILES = Object.freeze([
  "third_party/blink/public/devtools_protocol/BUILD.gn",
  "third_party/blink/public/devtools_protocol/browser_protocol.pdl",
  "third_party/blink/public/devtools_protocol/domains/DomotionAnimatedImageTruth.pdl",
  "third_party/blink/renderer/core/css/css_image_set_value.cc",
  "third_party/blink/renderer/core/css/css_image_set_value.h",
  "third_party/blink/renderer/core/css/resolver/element_style_resources.cc",
  "third_party/blink/renderer/core/exported/web_dev_tools_agent_impl.cc",
  "third_party/blink/renderer/core/inspector/BUILD.gn",
  "third_party/blink/renderer/core/inspector/build.gni",
  "third_party/blink/renderer/core/inspector/devtools_session.h",
  "third_party/blink/renderer/core/inspector/inspector_domotion_animated_image_truth_agent.cc",
  "third_party/blink/renderer/core/inspector/inspector_domotion_animated_image_truth_agent.h",
  "third_party/blink/renderer/core/inspector/inspector_network_agent.cc",
  "third_party/blink/renderer/core/inspector/inspector_network_agent.h",
  "third_party/blink/renderer/core/inspector/inspector_protocol_config.json",
  "third_party/blink/renderer/core/inspector/network_resources_data.h",
  "third_party/blink/renderer/core/loader/resource/image_resource.cc",
  "third_party/blink/renderer/core/loader/resource/image_resource.h",
  "third_party/blink/renderer/core/loader/resource/image_resource_content.cc",
  "third_party/blink/renderer/core/loader/resource/image_resource_content.h",
  "third_party/blink/renderer/core/loader/resource/image_resource_info.h",
  "third_party/blink/renderer/core/style/style_image_set.cc",
  "third_party/blink/renderer/core/style/style_image_set.h",
  "third_party/blink/renderer/platform/loader/fetch/resource.cc",
  "third_party/blink/renderer/platform/loader/fetch/resource.h",
  "third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc",
].sort());

async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  safeLabel: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(safeLabel)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function sendPrivate<T>(
  cdp: CDPSession,
  method: "DomotionAnimatedImageTruth.begin" |
    "DomotionAnimatedImageTruth.finish",
  params: Record<string, unknown>,
): Promise<T> {
  return await bounded(
    cdp.send(method as never, params as never) as unknown as Promise<T>,
    PRIVATE_PROTOCOL_TIMEOUT_MS,
    "bounded private protocol timeout",
  );
}

async function boundedTeardown(operation: Promise<unknown>): Promise<void> {
  try {
    await bounded(operation, TEARDOWN_TIMEOUT_MS, "bounded teardown timeout");
  } catch {
    // Teardown diagnostics must not replace the already sealed failure stage,
    // and protocol errors may contain resource facts. Discard them entirely.
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("source authority contains a non-JSON value");
  }
  return serialized;
}

function validateSourceAuthority(authority: SourceAuthority): void {
  const { sourceManifestSha256, ...manifestBody } = authority;
  const reopenedManifestSha256 = sha256Bytes(
    Buffer.from(canonicalJson(manifestBody)),
  );
  const authorityPaths = Array.isArray(authority.files)
    ? authority.files.map((file) => file.path)
    : [];
  if (authority.schemaVersion !== 1 || authority.ticket !== "DM-2583" ||
      authority.sourceRevision !== ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION ||
      authority.skiaRevision !== PINNED_SKIA_REVISION ||
      authority.depotToolsRevision !== PINNED_DEPOT_TOOLS_REVISION ||
      authority.patchSha256 !== ANIMATED_IMAGE_TRUTH_PATCH_SHA256 ||
      sourceManifestSha256 !== ANIMATED_IMAGE_TRUTH_SOURCE_MANIFEST_SHA256 ||
      !SHA256.test(sourceManifestSha256) ||
      sourceManifestSha256 !== reopenedManifestSha256 ||
      !SHA256.test(authority.patchSha256) ||
      authority.patchSha256 === "0".repeat(64) ||
      !Array.isArray(authority.files) ||
      !sameStrings(authorityPaths, EXPECTED_PATCH_FILES) ||
      new Set(authority.files.map((file) => file.path)).size !==
        authority.files.length ||
      authority.files.some((file) =>
        typeof file.path !== "string" || file.path.length === 0 ||
        !Number.isInteger(file.byteLength) || file.byteLength <= 0 ||
        !SHA256.test(file.sha256))) {
    throw new Error("source authority failed to reopen at the pinned toolchain");
  }
}

function requireOracleAuthority(
  record: AnimatedImageTruthRecord,
  expectedPatchSha256: string,
): void {
  if (record.oracle.chromiumRevision !== ANIMATED_IMAGE_TRUTH_CHROMIUM_REVISION ||
      record.oracle.schemaSha256 !== ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256 ||
      record.oracle.patchSha256 !== expectedPatchSha256 ||
      record.oracle.rendererProcessId <= 0 ||
      record.oracle.rootFrameId.length === 0 ||
      record.oracle.sessionId.length === 0) {
    throw new Error("private helper authority mismatch");
  }
}

function requireStrictOwnerRoute(
  record: AnimatedImageTruthRecord,
  plan: ProbePlanRow,
  backendNodeId: number,
): void {
  if (record.strictRequest.ownerSelectorToken !== plan.ownerSelectorToken ||
      record.strictRequest.requestedFrameIndex !== plan.requestedFrameIndex ||
      record.strictRequest.limitsFingerprint !==
        ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT) {
    throw new Error("private helper strict request did not echo the sealed route");
  }
  if (!record.owner) return;
  const nodeMatches = plan.pseudoType
    ? record.owner.pseudo?.backendNodeId === backendNodeId &&
      record.owner.pseudo.type === plan.pseudoType
    : record.owner.backendNodeId === backendNodeId && record.owner.pseudo === null;
  if (!nodeMatches || record.owner.slot.property !== plan.property ||
      record.owner.slot.index !== plan.index) {
    throw new Error("private helper owner/node/slot route mismatch");
  }
}

function sameStrings(left: string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function validateProbePlan(plan: ProbePlan): void {
  if (plan.schemaVersion !== 1 || plan.ticket !== "DM-2583" ||
      !Array.isArray(plan.rows) || plan.rows.length === 0 ||
      plan.rows.length > ANIMATED_IMAGE_TRUTH_LIMITS.maximumTransactions) {
    throw new Error("probe plan envelope or bound is invalid");
  }
  const requirements = new Map(
    ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS.map((row) => [row.probeId, row]),
  );
  const requiredCases = new Map(
    ANIMATED_IMAGE_TRUTH_CASES.map((row) => [
      `${row.probeId}/${row.caseId}`,
      row,
    ]),
  );
  const seenCases = new Set<string>();
  const seenProbes = new Set<AnimatedImageTruthProbeId>();
  for (const row of plan.rows) {
    const requirement = requirements.get(row.probeId);
    const caseKey = `${row.probeId}/${row.caseId}`;
    const requiredCase = requiredCases.get(caseKey);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(row.url);
    } catch {
      throw new Error("probe plan contains an invalid URL");
    }
    if (!requirement || !requiredCase || seenCases.has(caseKey) ||
        row.expected !== requiredCase.expected ||
        row.property !== requiredCase.property || row.index !== requiredCase.index ||
        (row.pseudoType ?? null) !== (requiredCase.pseudoType ?? null) ||
        row.caseId.length === 0 ||
        !ANIMATED_IMAGE_TRUTH_OWNER_SELECTOR_TOKEN.test(
          row.ownerSelectorToken,
        ) || row.index < 0 ||
        row.requestedFrameIndex < 0 ||
        !requirement.properties.includes(row.property) ||
        !requirement.expected.includes(row.expected) ||
        !sameStrings(row.sourceReferences, requirement.sourceReferences) ||
        !sameStrings(row.mutatedFacts, requirement.mutatedFacts) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)) {
      throw new Error("probe plan row drifted from its source-linked requirement");
    }
    seenCases.add(caseKey);
    seenProbes.add(row.probeId);
  }
  if (seenProbes.size !== requirements.size) {
    throw new Error("probe plan does not cover every required source probe");
  }
  if (seenCases.size !== requiredCases.size ||
      [...requiredCases.keys()].some((key) => !seenCases.has(key))) {
    throw new Error("probe plan does not cover the exact required case corpus");
  }
}

function parseCli(): CliOptions {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!flag?.startsWith("--") || value == null) {
      throw new Error("invalid collector arguments");
    }
    values.set(flag.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const operatingSystem = required("os");
  const evidenceRole = required("role");
  if (!["macOS", "Linux", "Windows"].includes(operatingSystem) ||
      !["proposal", "validation"].includes(evidenceRole)) {
    throw new Error("invalid OS or evidence role");
  }
  return {
    browser: resolve(required("browser")),
    renderer: resolve(required("renderer")),
    loadedLibraries: required("loaded-libraries").split(",").map((path) =>
      resolve(path)),
    plan: resolve(required("plan")),
    authority: resolve(required("authority")),
    out: resolve(required("out")),
    operatingSystem: operatingSystem as CliOptions["operatingSystem"],
    evidenceRole: evidenceRole as CliOptions["evidenceRole"],
    buildInvocationId: required("build-invocation-id"),
    observationId: required("observation-id"),
  };
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function binaryIdentity(
  path: string,
  pathToken: string,
): Promise<AnimatedImageTruthBinaryIdentity> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`binary identity unavailable: ${pathToken}`);
  }
  return {
    pathToken,
    byteLength: metadata.size,
    sha256: await sha256File(path),
  };
}

async function mappedFilePaths(processId: number): Promise<string[]> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", "-Fn", "-p", String(processId)],
      { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
    );
    return stdout.split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1));
  }
  if (process.platform === "linux") {
    const maps = await readFile(`/proc/${processId}/maps`, "utf8");
    return maps.split("\n").flatMap((line) => {
      const absolutePath = line.indexOf("/");
      return absolutePath < 0
        ? []
        : [line.slice(absolutePath).replace(/ \(deleted\)$/, "")];
    });
  }
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${processId} -ErrorAction Stop).Modules | ` +
      "ForEach-Object { $_.FileName }";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
    );
    return stdout.split(/\r?\n/).filter((line) => line.length > 0);
  }
  throw new Error("loaded module authentication is unsupported on this host");
}

async function requireMappedFiles(
  expectedPaths: string[],
  processIds: number[],
): Promise<void> {
  const prefix = safeFailureStage;
  const stage = (suffix: string): void => {
    safeFailureStage = `${prefix}: ${suffix}`;
    process.stderr.write(
      `animated-image truth collector at ${safeFailureStage}\n`,
    );
  };
  if (processIds.length === 0) throw new Error("mapped process identity is empty");
  stage("declared path resolution");
  const expectedRealpaths = await Promise.all(
    expectedPaths.map((path) => realpath(path)),
  );
  stage("process mapping read");
  const rawPaths = new Set((await Promise.all(
    processIds.map(mappedFilePaths),
  )).flat());
  stage("mapped path resolution");
  const mappedRealpaths = new Set<string>();
  for (const path of rawPaths) {
    try {
      mappedRealpaths.add(await realpath(path));
    } catch {
      // Anonymous, deleted, and kernel mappings are not binary identities.
    }
  }
  if (expectedRealpaths.some((path) => !mappedRealpaths.has(path))) {
    stage("declared component missing");
    throw new Error("declared browser component was not mapped by its process");
  }
  stage("mapping authenticated");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function percentDecodeDataUrlBody(value: string): Buffer {
  const chunks: Buffer[] = [];
  let literalStart = 0;
  for (let index = 0; index < value.length; ++index) {
    if (value[index] !== "%" || index + 2 >= value.length ||
        !/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      continue;
    }
    if (literalStart < index) {
      chunks.push(Buffer.from(value.slice(literalStart, index), "utf8"));
    }
    chunks.push(Buffer.from([Number.parseInt(value.slice(index + 1, index + 3), 16)]));
    index += 2;
    literalStart = index + 1;
  }
  if (literalStart < value.length) {
    chunks.push(Buffer.from(value.slice(literalStart), "utf8"));
  }
  return Buffer.concat(chunks);
}

function forgivingBase64Decode(bytes: Buffer): Buffer {
  let encoded = bytes.toString("latin1").replace(/[\t\n\f\r ]/g, "");
  if (encoded.length % 4 === 0) encoded = encoded.replace(/={1,2}$/, "");
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(encoded)) {
    throw new Error("data URL has invalid base64 bytes");
  }
  return Buffer.from(encoded, "base64");
}

function dataUrlBytes(value: string): Buffer {
  const withoutFragment = value.split("#", 1)[0];
  if (!withoutFragment.toLowerCase().startsWith("data:")) {
    throw new Error("selected data transport is not a data URL");
  }
  const comma = withoutFragment.indexOf(",", 5);
  if (comma < 0) throw new Error("selected data URL has no body separator");
  const media = withoutFragment.slice(5, comma);
  const decoded = percentDecodeDataUrlBody(withoutFragment.slice(comma + 1));
  if (!/;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i.test(media)) return decoded;
  try {
    return forgivingBase64Decode(decoded);
  } finally {
    decoded.fill(0);
  }
}

async function ownerBackendNodeId(
  cdp: CDPSession,
  token: string,
  pseudoType?: string,
): Promise<number> {
  const flattened = await cdp.send("DOM.getFlattenedDocument", {
    depth: -1,
    pierce: true,
  });
  const nodes = flattened.nodes;
  const host = nodes.find((node) => {
    const attributes = node.attributes ?? [];
    for (let index = 0; index < attributes.length; index += 2) {
      if (attributes[index] === "data-domotion-owner-token" &&
          attributes[index + 1] === token) return true;
    }
    return false;
  });
  if (!host?.backendNodeId) throw new Error("strict owner token not found");
  if (!pseudoType) return host.backendNodeId;
  // CDP nests generated pseudo nodes in the host Node's pseudoElements array;
  // they are not independent entries in getFlattenedDocument().nodes and do
  // not carry parentId. Keep the backend id tied to this exact tokened host.
  const pseudo = host.pseudoElements?.find((node) =>
    node.pseudoType === pseudoType);
  if (!pseudo?.backendNodeId) throw new Error("strict pseudo owner not found");
  return pseudo.backendNodeId;
}

async function browserProcessId(cdp: CDPSession): Promise<number> {
  const result = await cdp.send("SystemInfo.getProcessInfo");
  const browserProcess = result.processInfo.find((entry) =>
    entry.type.toLowerCase() === "browser");
  if (!browserProcess || browserProcess.id <= 0) {
    throw new Error("browser PID unavailable from SystemInfo");
  }
  return browserProcess.id;
}

async function requireLiveRendererProcess(
  browserCdp: CDPSession,
  rendererProcessId: number,
): Promise<void> {
  const result = await browserCdp.send("SystemInfo.getProcessInfo");
  const renderer = result.processInfo.find((entry) =>
    entry.id === rendererProcessId && entry.type.toLowerCase() === "renderer");
  if (!renderer) throw new Error("oracle renderer PID is not a live browser renderer");
}

async function requireTargetFrameRoute(
  cdp: CDPSession,
  record: AnimatedImageTruthRecord,
): Promise<void> {
  const frameTree = await cdp.send("Page.getFrameTree");
  const target = await cdp.send("Target.getTargetInfo");
  if (record.oracle.rootFrameId !== frameTree.frameTree.frame.id) {
    throw new Error("oracle root frame differs from the attached page route");
  }
  if (!record.document) return;
  const pending = [frameTree.frameTree];
  let routedFrame: typeof frameTree.frameTree.frame | null = null;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) break;
    if (entry.frame.id === record.document.frameId) {
      routedFrame = entry.frame;
      break;
    }
    pending.push(...(entry.childFrames ?? []));
  }
  if (!routedFrame || routedFrame.loaderId !== record.document.documentLoaderId ||
      record.document.targetId !== target.targetInfo.targetId) {
    throw new Error("oracle target/frame/loader route is not the attached target");
  }
}

async function owningRealmBytes(
  page: Page,
  url: string,
): Promise<Buffer> {
  const base64 = await page.evaluate(async (selectedUrl) => {
    const response = await fetch(selectedUrl);
    if (!response.ok) throw new Error("owning-realm blob read failed");
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, url);
  return Buffer.from(base64, "base64");
}

async function publicBody(
  page: Page,
  cdp: CDPSession,
  record: Extract<AnimatedImageTruthRecord, { outcome: "authorized" }>,
): Promise<AnimatedImageTruthPublicBodyEvidence> {
  let bytes: Buffer;
  let base64EncodedByProtocol = false;
  if (record.body.transport === "network-get-response-body") {
    const response = await cdp.send("Network.getResponseBody", {
      requestId: record.resource.inspectorRequestId,
    });
    base64EncodedByProtocol = response.base64Encoded;
    bytes = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
  } else if (record.body.transport === "data-url") {
    bytes = dataUrlBytes(record.owner.selectedResourceUrl);
  } else {
    bytes = await owningRealmBytes(page, record.owner.selectedResourceUrl);
    let repeated: Buffer;
    try {
      repeated = await owningRealmBytes(page, record.owner.selectedResourceUrl);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
    const repeatedMatches = bytes.byteLength === repeated.byteLength &&
      sha256Bytes(bytes) === sha256Bytes(repeated);
    repeated.fill(0);
    if (!repeatedMatches) {
      bytes.fill(0);
      throw new Error("owning-realm blob bytes changed between reads");
    }
  }
  const evidence = {
    transport: record.body.transport,
    base64EncodedByProtocol,
    byteLength: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
  bytes.fill(0);
  return evidence;
}

async function discardDeniedInspectorBody(
  cdp: CDPSession,
  record: AnimatedImageTruthDeniedRecord,
): Promise<void> {
  if (!record.requestIdentity?.inspectorRequestId) return;
  try {
    let transient: unknown = await cdp.send("Network.getResponseBody", {
        requestId: record.requestIdentity.inspectorRequestId,
      });
    transient = undefined;
    void transient;
  } catch {
    // Availability is not authorization. Error details are intentionally not
    // logged because this is a denied route.
  }
}

async function mutate(
  page: Page,
  cdp: CDPSession,
  steps: MutationStep[],
): Promise<void> {
  for (const step of steps) {
    if (step.kind === "evaluate") {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          page.evaluate(
            (source) => (0, eval)(`(async () => {\n${source}\n})()`),
            step.source,
          ),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("bounded fixture mutation timeout")),
              15_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } else if (step.kind === "cdp") {
      await cdp.send(step.method as never, (step.params ?? {}) as never);
    } else if (step.kind === "navigate") {
      await page.goto(step.url, { waitUntil: step.waitUntil ?? "load" });
    } else {
      await page.waitForTimeout(step.milliseconds);
    }
  }
}

async function collectRow(
  page: Page,
  cdp: CDPSession,
  browserCdp: CDPSession,
  plan: ProbePlanRow,
  expectedPatchSha256: string,
): Promise<AnimatedImageTruthProbeRow> {
  const stage = (name: string): void => {
    // Stage names and sealed probe ids are safe diagnostics. Never include a
    // caught protocol object or error message here: a denied body may have
    // existed transiently in the collector process.
    safeFailureStage = `probe ${plan.probeId}/${plan.caseId}: ${name}`;
    process.stderr.write(
      `animated-image truth collector at ${safeFailureStage}\n`,
    );
  };
  stage("navigation");
  await page.goto(plan.url, { waitUntil: "load" });
  stage("fixture readiness");
  await page.waitForFunction(() =>
    (globalThis as { __domotionProbeReady?: boolean }).__domotionProbeReady === true,
  );
  if (await page.evaluate(() =>
    (globalThis as { __domotionProbeFailed?: boolean }).__domotionProbeFailed === true,
  )) {
    throw new Error("fixture probe setup failed");
  }
  if (plan.settleMilliseconds) await page.waitForTimeout(plan.settleMilliseconds);
  stage("strict owner lookup");
  const backendNodeId = await ownerBackendNodeId(
    cdp,
    plan.ownerSelectorToken,
    plan.pseudoType,
  );
  stage("private begin");
  const begin = await sendPrivate<PrivateBeginResult>(
    cdp,
    "DomotionAnimatedImageTruth.begin",
    {
      backendNodeId,
      property: plan.property,
      index: plan.index,
      ownerSelectorToken: plan.ownerSelectorToken,
      requestedFrameIndex: plan.requestedFrameIndex,
      limitsFingerprint: ANIMATED_IMAGE_TRUTH_LIMITS_FINGERPRINT,
    },
  );
  stage("begin authority");
  requireOracleAuthority(begin.record, expectedPatchSha256);
  requireStrictOwnerRoute(begin.record, plan, backendNodeId);
  await requireTargetFrameRoute(cdp, begin.record);
  await requireLiveRendererProcess(
    browserCdp,
    begin.record.oracle.rendererProcessId,
  );

  let transientPublicBody: AnimatedImageTruthPublicBodyEvidence | null = null;
  stage("preflight body policy");
  if (begin.record.outcome === "authorized") {
    transientPublicBody = await publicBody(page, cdp, begin.record);
  } else if (plan.exerciseDeniedInspectorBody) {
    await discardDeniedInspectorBody(cdp, begin.record);
  }

  stage("mutation");
  await mutate(page, cdp, plan.mutationSteps);
  stage("private finish");
  const finish = await sendPrivate<PrivateFinishResult>(
    cdp,
    "DomotionAnimatedImageTruth.finish",
    { transactionId: begin.transactionId },
  );
  stage("finish authority");
  requireOracleAuthority(finish.record, expectedPatchSha256);
  requireStrictOwnerRoute(finish.record, plan, backendNodeId);
  await requireTargetFrameRoute(cdp, finish.record);
  if (finish.record.oracle.rendererProcessId !==
      begin.record.oracle.rendererProcessId) {
    throw new Error("renderer process changed inside a truth transaction");
  }
  await requireLiveRendererProcess(
    browserCdp,
    finish.record.oracle.rendererProcessId,
  );

  const retainPublicBody = begin.record.outcome === "authorized" &&
    finish.record.outcome === "authorized" && finish.unchanged;
  stage("outcome policy");
  if (!retainPublicBody && finish.record.outcome !== "denied") {
    throw new Error("failed transaction did not return a sanitized denial");
  }
  // Negative artifacts retain only the helper's sanitized postflight denial.
  // The authorized preflight record and public digest remain process-local and
  // become unreachable before this row is serialized.
  const retainedBegin = retainPublicBody ? begin.record : finish.record;
  const row: AnimatedImageTruthProbeRow = {
    probeId: plan.probeId,
    caseId: plan.caseId,
    expected: plan.expected,
    begin: retainedBegin,
    finish: finish.record,
    transactionUnchanged: finish.unchanged,
    publicBody: retainPublicBody ? transientPublicBody : null,
    deniedInspectorBodyDiscarded: !retainPublicBody,
    activation: {
      sourceReferences: plan.sourceReferences,
      mutatedFacts: plan.mutatedFacts,
      observedFailure: finish.record.outcome === "denied"
        ? finish.record.denialCode
        : null,
    },
  };
  transientPublicBody = null;
  stage("row schema validation");
  const failures = validateAnimatedImageTruthProbeRow(row);
  if (failures.length > 0) {
    // Validator failures are locally generated schema labels only; they never
    // interpolate resource values or protocol payloads. Retaining them in the
    // stage string makes a failed-closed run actionable without exposing data.
    const safeOutcome = (record: AnimatedImageTruthRecord): string =>
      record.outcome === "authorized"
        ? "authorized"
        : `denied:${record.denialCode}`;
    stage(
      `row schema validation [begin=${safeOutcome(row.begin)},` +
      `finish=${safeOutcome(row.finish)},unchanged=${row.transactionUnchanged}] ` +
      `(${failures.join("; ")})`,
    );
    throw new Error(`probe failed closed: ${plan.probeId}/${plan.caseId}`);
  }
  return row;
}

async function main(): Promise<void> {
  const stage = (name: string): void => {
    safeFailureStage = name;
    process.stderr.write(
      `animated-image truth collector at ${safeFailureStage}\n`,
    );
  };
  const options = parseCli();
  const runtimeOperatingSystem = process.platform === "darwin"
    ? "macOS"
    : process.platform === "linux"
    ? "Linux"
    : process.platform === "win32"
    ? "Windows"
    : null;
  if (runtimeOperatingSystem !== options.operatingSystem) {
    throw new Error("declared evidence operating system differs from the host");
  }
  const plan = JSON.parse(await readFile(options.plan, "utf8")) as ProbePlan;
  const authority = JSON.parse(
    await readFile(options.authority, "utf8"),
  ) as SourceAuthority;
  validateProbePlan(plan);
  validateSourceAuthority(authority);
  if (await realpath(options.browser) !== await realpath(options.renderer)) {
    throw new Error("headless_shell browser/renderer executable identity differs");
  }
  const libraryTokens = options.loadedLibraries.map((path) =>
    basename(path).toLowerCase());
  if (new Set(libraryTokens).size !== libraryTokens.length ||
      !libraryTokens.some((token) => token.includes("blink_core")) ||
      !libraryTokens.some((token) => token.includes("blink_platform"))) {
    throw new Error("loaded library authority is duplicate or incomplete");
  }

  const browser = await chromium.launch({
    executablePath: options.browser,
    headless: true,
  });
  const browserCdp = await browser.newBrowserCDPSession();
  try {
    const browserVersion = browser.version();
    if (!browserVersion.endsWith(ANIMATED_IMAGE_TRUTH_BROWSER_VERSION) ||
        !["arm64", "x64"].includes(arch())) {
      throw new Error("launched browser version or architecture is not pinned");
    }
    const processId = await browserProcessId(browserCdp);
    stage("browser process binary authentication");
    await requireMappedFiles([options.browser], [processId]);
    stage("browser context creation");
    const context = await browser.newContext();
    const browserContextId = randomUUID();
    const rows: AnimatedImageTruthProbeRow[] = [];
    const authenticatedRendererProcessIds = new Set<number>();
    let loadedLibraryIdentities: AnimatedImageTruthBinaryIdentity[] = [];
    try {
      stage("page target creation");
      const page = await context.newPage();
      stage("page protocol initialization");
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Network.enable", {
        maxTotalBufferSize: ANIMATED_IMAGE_TRUTH_LIMITS.inspectorTotalBufferBytes,
        maxResourceBufferSize: ANIMATED_IMAGE_TRUTH_LIMITS.inspectorResourceBufferBytes,
        maxPostDataSize: 0,
      });
      for (const row of plan.rows) {
        // Probe/case ids come from the sealed plan and contain no resource or
        // body data, so they are safe diagnostics even for denied routes.
        safeFailureStage = `probe ${row.probeId}/${row.caseId}`;
        process.stderr.write(
          `animated-image truth collector entering ${safeFailureStage}\n`,
        );
        const collectedRow = await collectRow(
          page,
          cdp,
          browserCdp,
          row,
          authority.patchSha256,
        );
        const rendererProcessId = collectedRow.begin.oracle.rendererProcessId;
        if (!authenticatedRendererProcessIds.has(rendererProcessId)) {
          safeFailureStage =
            `probe ${row.probeId}/${row.caseId}: renderer binary authentication`;
          process.stderr.write(
            `animated-image truth collector at ${safeFailureStage}\n`,
          );
          // Authenticate each renderer while the row's own liveness check is
          // still current. Cross-origin navigation may retire historical
          // renderers before a post-run sweep could inspect their mappings.
          await requireMappedFiles(
            [options.renderer, ...options.loadedLibraries],
            [rendererProcessId],
          );
          authenticatedRendererProcessIds.add(rendererProcessId);
        }
        rows.push(collectedRow);
      }
      stage("loaded library digest authentication");
      loadedLibraryIdentities = await Promise.all(
        options.loadedLibraries.map((path) =>
          binaryIdentity(path, basename(path))),
      );
      await boundedTeardown(cdp.detach());
    } finally {
      await boundedTeardown(context.close());
    }

    const report: AnimatedImageTruthRunReport = {
      schemaVersion: 1,
      ticket: "DM-2583",
      stage: "animated-image-owner-resource-truth",
      operatingSystem: options.operatingSystem,
      architecture: arch() as AnimatedImageTruthRunReport["architecture"],
      platformRelease: release(),
      browserVersion,
      evidenceRole: options.evidenceRole,
      sourceRevision: authority.sourceRevision,
      sourceManifestSha256: authority.sourceManifestSha256,
      schemaSha256: ANIMATED_IMAGE_TRUTH_SCHEMA_SHA256,
      patchSha256: authority.patchSha256,
      buildInvocationId: options.buildInvocationId,
      observationId: options.observationId,
      browserProcessId: processId,
      browserContextId,
      explicitHeadless: true,
      binaries: {
        browser: await binaryIdentity(options.browser, basename(options.browser)),
        renderer: await binaryIdentity(options.renderer, basename(options.renderer)),
        loadedLibraries: loadedLibraryIdentities,
      },
      rows,
      normalizedLogicalSha256: normalizedAnimatedImageTruthRowsSha256(rows),
    };
    stage("artifact serialization");
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  } finally {
    try {
      await boundedTeardown(browserCdp.detach());
    } finally {
      await boundedTeardown(browser.close());
    }
  }
}

main().catch(() => {
  // Never serialize a caught protocol object: a denied body may have existed
  // transiently in this process. The detailed failure stays only in memory.
  process.stderr.write(
    `animated-image truth collector failed closed at ${safeFailureStage}\n`,
  );
  process.exitCode = 1;
  // A crashed renderer can leave Playwright's transport handle alive even
  // after bounded teardown. Force only this collector process to terminate;
  // closing its remote-debugging pipe also tears down its headless browser.
  const forcedExit = setTimeout(() => process.exit(1), 1_000);
  forcedExit.unref();
});
