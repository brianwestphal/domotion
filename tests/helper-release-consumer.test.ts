import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  RELEASE_HELPER_ASSETS,
  requireFreshConsumerEnvironment,
  validateNativeBrowserResults,
  validatePublishedBinary,
  validatePublishedProvenance,
} from "../tools/helper-release-consumer.js";

const source = "a".repeat(40),
  tag = "v0.35.0",
  binary = Buffer.from("fixture-native-helper");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  return {
    schemaVersion: 1,
    repository: "brianwestphal/domotion",
    tag,
    sourceCommit: source,
    sourcePackageVersion: "0.35.0",
    targetVersion: "0.35.0",
    versionPolicy: "exact",
    workflowCommit: "b".repeat(40),
    runId: "123",
    assets: Object.fromEntries(
      RELEASE_HELPER_ASSETS.map((name) => [name, { sha256: sha(binary), bytes: binary.length }]),
    ),
  };
}
function read(value: unknown, expectedTag = tag, expectedSource = source) {
  const bytes = Buffer.from(JSON.stringify(value));
  return validatePublishedProvenance(
    bytes,
    `${sha(bytes)}  domotion-helper-provenance.json\n`,
    expectedTag,
    expectedSource,
  );
}
it("binds fetched bytes to an exact-source complete published manifest", () => {
  const p = read(fixture());
  for (const asset of RELEASE_HELPER_ASSETS) expect(validatePublishedBinary(p, asset, binary)).toBe(sha(binary));
  expect(() => validatePublishedBinary(p, RELEASE_HELPER_ASSETS[0], Buffer.from("different"))).toThrow(
    "does not match",
  );
  expect(() => validatePublishedBinary(p, "unrecognized", binary)).toThrow("does not match");
});
it("rejects a changed manifest even when its JSON remains valid", () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  expect(() =>
    validatePublishedProvenance(bytes, `${"0".repeat(64)}  domotion-helper-provenance.json`, tag, source),
  ).toThrow("checksum");
  expect(() => validatePublishedProvenance(bytes, `${sha(bytes)}  another-file.json`, tag, source)).toThrow("checksum");
});
it.each([
  { sourceCommit: "c".repeat(40) },
  { tag: "v0.34.0" },
  { sourcePackageVersion: "0.34.0" },
  { targetVersion: "0.34.0" },
  { repository: "another/repository" },
  { versionPolicy: "default-tag-beta-base" },
])("rejects wrong publication authority or version: %j", (change) => {
  expect(() => read({ ...fixture(), ...change })).toThrow();
});
it("requires every native asset and rejects unknown/empty entries", () => {
  const p = fixture();
  delete p.assets[RELEASE_HELPER_ASSETS[0]];
  expect(() => read(p)).toThrow("all five");
  const extra = fixture();
  extra.assets.extra = { sha256: sha(binary), bytes: binary.length };
  expect(() => read(extra)).toThrow("all five");
  const empty = fixture();
  empty.assets[RELEASE_HELPER_ASSETS[0]].bytes = 0;
  expect(() => read(empty)).toThrow();
});
it.each(["main", "v0.35.0/other", " v0.35.0", "v0.35.0\n"])("rejects ambiguous release input %j", (input) => {
  expect(() => read(fixture(), input)).toThrow("explicit release tag");
});
it("requires a full immutable source and an unused ambient helper environment", () => {
  expect(() => read(fixture(), tag, "a".repeat(7))).toThrow("full source SHA");
  requireFreshConsumerEnvironment({});
  for (const key of [
    "DOMOTION_HELPER_PATH",
    "DOMOTION_ICU_HELPER_PATH",
    "DOMOTION_ICU_DATA",
    "DOMOTION_DISABLE_HELPER",
  ])
    expect(() => requireFreshConsumerEnvironment({ [key]: "inherited" })).toThrow(key);
});

function browserReport() {
  return {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    testResults: [{ status: "passed", assertionResults: [{ status: "passed" }] }],
  };
}
it("requires actual native assertions, complete summary fields and zero skipped/todo controls", () => {
  expect(validateNativeBrowserResults(browserReport(), 1).numPassedTests).toBe(1);
  for (const change of [
    { numPendingTests: 1 },
    { numTodoTests: 1 },
    { numFailedTests: 1 },
    { success: false },
    { numTotalTests: 2 },
    { testResults: [] },
    { numPassedTests: 20, numTotalTests: 20 },
    { testResults: [{ status: "passed", assertionResults: [{ status: "skipped" }] }] },
  ])
    expect(() => validateNativeBrowserResults({ ...browserReport(), ...change }, 1)).toThrow();
  const { numPendingTests: _missing, ...incomplete } = browserReport();
  expect(() => validateNativeBrowserResults(incomplete, 1)).toThrow();
  expect(() => validateNativeBrowserResults(browserReport(), 16)).toThrow("incomplete");
});
